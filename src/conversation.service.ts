import OpenAI from 'openai';
import { config } from './config.js';
import { isElevenLabsConfigured, synthesizeSpeech } from './elevenlabs.js';
import { createJsonStream, type OpenAiReasoningEffort } from './openai.js';
import {
  CONSULT_CALL_REPLY_SCHEMA,
  buildConsultCallConversationInstructions,
  extractClosedSay,
  normalizeConsultCallReply,
  renderConsultCallConversationPrompt,
  type ConsultCallConversationInput,
  type ConsultCallReply,
} from './util/conversation.util.js';
import type { SpeechEndTimeout } from './util/twiml.util.js';
import type { ConsultCallVoiceProvider } from './types.js';

/**
 * Reasoning depth for a turn, when the model is one that reasons.
 *
 * Lowest on purpose. A phone turn is one or two sentences chosen from facts
 * already in the prompt, which is not work that repays thinking time, and every
 * second spent on it is a second of silence on the line. The client drops this
 * field entirely for models that do not reason, so it is safe on all of them.
 */
export const DEFAULT_CONVERSATION_EFFORT: OpenAiReasoningEffort = 'low';

/**
 * How long a turn may wait for the model, and then for the voice.
 *
 * Twilio abandons a webhook after roughly fifteen seconds and plays its own
 * error recording at the caller. Eight for the words and five for the voice
 * leaves a margin for the record writes around them. Both are in config because
 * the right numbers depend on the model and on the vendor, and the wrong ones
 * are a caller hearing dead air.
 *
 * Note these ADD rather than max: the synthesis started mid-stream is awaited
 * after the model deadline, under its own. Worst case is 13s before the TwiML is
 * even built, so raising the reply timeout past ~9s pushes real calls over
 * Twilio's cliff.
 */
export const DEFAULT_REPLY_TIMEOUT_MS = 8_000;
export const DEFAULT_VOICE_TIMEOUT_MS = 5_000;

/**
 * Caller turns before the model is told to wrap up.
 *
 * A guardrail against a voicemail greeting or a hold-music loop keeping the line
 * open, not a length any real conversation approaches: the longest honest path
 * in the brief - a hold, three questions, a confirmation - is six.
 */
export const DEFAULT_MAX_CONVERSATION_TURNS = 14;

/**
 * Seconds of silence that end a caller's turn.
 *
 * Twilio's `auto` is its own end-of-speech model: accurate, and the single
 * largest piece of the gap between someone finishing talking and hearing an
 * answer. A flat second is close to the shortest that does not chop off people
 * who pause to think, and it is the biggest saving available anywhere in the
 * turn, because nothing on our side can shorten what Twilio spends deciding the
 * caller has finished.
 */
export const DEFAULT_SPEECH_END_SECONDS = 1;

/**
 * Room for the JSON reply and any reasoning that precedes it.
 *
 * The reply itself is under a hundred tokens. On a reasoning model the thinking
 * counts against the same ceiling, and a ceiling hit mid-JSON is a parse
 * failure - so this is generous rather than tight.
 */
const REPLY_MAX_OUTPUT_TOKENS = 2_048;

const EFFORTS: readonly OpenAiReasoningEffort[] = ['low', 'medium', 'high'];

/** Longest failure reason kept. It lands in a log line and on the call's `error` field. */
const MAX_FAILURE_CHARS = 300;

/**
 * Milestones of one turn, in milliseconds from the moment the webhook started.
 *
 * Kept because the whole value of this path is a timing claim, and a timing
 * claim that nobody can check rots. `sayClosed` against `llmDone` is the overlap
 * this exists to win: the difference between them is how long synthesis got for
 * free.
 */
export interface ConsultCallTurnTimings {
  firstToken: number | null;
  sayClosed: number | null;
  llmDone: number;
  ttsStarted: number | null;
  ttsDone: number | null;
  total: number;
  /** How much of synthesis was hidden behind the rest of the JSON. */
  overlapSaved: number;
}

export interface ConsultCallSpokenReply {
  audioUrl: string | null;
  /** Which voice this particular line will play in. */
  provider: ConsultCallVoiceProvider;
}

export type ConsultCallSpokenOutcome =
  | {
      ok: true;
      reply: ConsultCallReply;
      voiced: ConsultCallSpokenReply;
      model: string | null;
      timings: ConsultCallTurnTimings;
    }
  | { ok: false; error: string };

/**
 * Runs `work` against a clock. Losing the race does not cancel the work - the
 * request finishes in the background - but the caller stops waiting for it,
 * which is the only thing that matters inside a webhook with a deadline. (The
 * model call also gets a real AbortSignal; see openai.ts.)
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why a turn failed, in words that name the cause.
 *
 * The source unwrapped a Nest HttpException to reach the provider's own
 * sentence; here the SDK's APIError already carries it. Either way the point is
 * the same: an operator reading the log at 9pm needs "exceeded your current
 * quota", not "operation failed".
 */
function describeFailure(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    const body = error.error as { message?: string } | undefined;
    const reason = body?.message || error.message || 'unknown error';
    const status = error.status ? `${error.status}: ` : '';
    return `${status}${reason}`.slice(0, MAX_FAILURE_CHARS);
  }
  return ((error as Error)?.message || 'unknown error').slice(0, MAX_FAILURE_CHARS);
}

/** Whether a conversational call could be placed at all. */
export function isConversationConfigured(): boolean {
  return Boolean(config.openai.apiKey);
}

export function maxTurns(): number {
  const raw = config.call.conversationMaxTurns;
  return Number.isInteger(raw) && raw >= 2 ? raw : DEFAULT_MAX_CONVERSATION_TURNS;
}

/**
 * How long Twilio waits out a silence before handing us the turn.
 *
 * `auto` is available as a setting so a deployment that finds callers being
 * clipped can put the accuracy back without a code change.
 */
export function speechEndTimeout(): SpeechEndTimeout {
  const raw = config.call.conversationSpeechTimeout;
  if (raw === 'auto') return 'auto';
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 1 ? seconds : DEFAULT_SPEECH_END_SECONDS;
}

/**
 * The turn, with synthesis started the instant the words are known.
 *
 * The saving this exists for: `say` is the first field of the schema and lands
 * in the model's first delta, while the fields after it take a few hundred
 * milliseconds more. Waiting for the closing brace before calling ElevenLabs
 * spends that time twice. Here the two run together, and the turn costs
 * whichever is longer instead of both added up.
 *
 * Never throws. A phone call cannot show a stack trace: every failure becomes a
 * result the webhook can turn into something the caller hears, which is either a
 * fixed fallback line or the same words in Twilio's stock voice.
 */
export async function replyWithVoice(
  input: ConsultCallConversationInput,
  voiceLabel: string | null,
): Promise<ConsultCallSpokenOutcome> {
  const startedAt = Date.now();
  const since = () => Date.now() - startedAt;

  let firstToken: number | null = null;
  let sayClosed: number | null = null;
  let ttsStarted: number | null = null;
  let ttsDone: number | null = null;
  /** Started mid-stream; awaited after it. Never rejects - `voice` catches. */
  let voicing: Promise<ConsultCallSpokenReply> | null = null;

  try {
    const model = modelOverride();
    const response = await withDeadline(
      createJsonStream<unknown>({
        onPartialText: (buffer) => {
          if (firstToken === null) firstToken = since();
          if (sayClosed !== null) return;
          const say = extractClosedSay(buffer);
          if (say === null) return;
          sayClosed = since();
          if (voiceLabel === null) return;
          // Deliberately not awaited: this runs inside the stream's read loop,
          // and the entire point is that the rest of the JSON keeps arriving
          // while ElevenLabs works.
          ttsStarted = since();
          voicing = voice(say, voiceLabel).then((result) => {
            ttsDone = since();
            return result;
          });
        },
        instructions: buildConsultCallConversationInstructions(input),
        prompt: renderConsultCallConversationPrompt(input),
        schemaName: 'consult_call_reply',
        schemaDescription: 'What to say on the next turn of a phone call, and whether it ends.',
        schema: CONSULT_CALL_REPLY_SCHEMA,
        // Omitted rather than blanked when unset, so the client falls back to
        // the deployment's own default model.
        ...(model ? { model } : {}),
        reasoningEffort: effort(),
        maxOutputTokens: REPLY_MAX_OUTPUT_TOKENS,
        // The client's own timeout, matched to ours: without it a slow turn is
        // abandoned here while the request runs on for the client's default,
        // holding a socket for an answer nobody is waiting for.
        timeoutMs: replyTimeoutMs(),
      }),
      replyTimeoutMs(),
      'the conversation model',
    );

    const llmDone = since();
    const reply = normalizeConsultCallReply(response.json);
    if (!reply) {
      console.warn('The conversation model returned nothing speakable');
      // A synthesis already in flight is abandoned rather than cancelled. It is
      // one short clip against a dead turn, and the caller is about to hear the
      // fallback line instead.
      return { ok: false, error: 'the conversation model returned nothing speakable' };
    }

    /*
     * The one case where the early text and the final text can disagree:
     * `extractClosedSay` cleans with the same function normalisation uses, so
     * they match for every well-formed reply, but a model that somehow closed
     * `say` and then produced an unparseable tail would leave audio saying
     * something the record does not. Re-synthesizing on a mismatch is cheap
     * insurance against the call and its transcript telling different stories.
     */
    let voiced: ConsultCallSpokenReply;
    if (voiceLabel === null) {
      voiced = { audioUrl: null, provider: 'twilio-say' };
    } else if (voicing && sayClosed !== null) {
      voiced = await voicing;
    } else {
      ttsStarted = since();
      voiced = await voice(reply.say, voiceLabel);
      ttsDone = since();
    }

    const total = since();
    const timings: ConsultCallTurnTimings = {
      firstToken,
      sayClosed,
      llmDone,
      ttsStarted,
      ttsDone,
      total,
      // What the overlap bought: synthesis that finished before the JSON did
      // cost this turn nothing at all.
      overlapSaved:
        ttsStarted !== null && ttsDone !== null
          ? Math.max(0, Math.min(ttsDone, llmDone) - ttsStarted)
          : 0,
    };
    console.log(
      `Turn ${voiceLabel ?? 'text-only'}: first token ${firstToken ?? '-'}ms, ` +
        `say closed ${sayClosed ?? '-'}ms, llm done ${llmDone}ms, ` +
        `tts ${ttsStarted ?? '-'}-${ttsDone ?? '-'}ms, total ${total}ms ` +
        `(${timings.overlapSaved}ms of synthesis overlapped)`,
    );

    return { ok: true, reply, voiced, model: response.model, timings };
  } catch (error) {
    const message = describeFailure(error);
    console.warn(`Conversation turn failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * The line in the real voice, if the vendor answers in time.
 *
 * Cacheable, which is not obvious for a line written fresh for one caller's
 * sentence. The reason is that conversational replies repeat far more than they
 * look like they will: "Of course, what's your question?", "Sure, take your
 * time." and a handful of others come back on call after call, because there are
 * only so many ways to say them. The cache key is content-addressed over the
 * exact words, voice, model and speed, so a hit is the same bytes the API would
 * have returned, and a reworded reply is simply a different key.
 *
 * Anything that goes wrong - unconfigured, an error, the deadline - degrades to
 * Twilio's voice for THIS line only, and says so, so the page can mark the line
 * rather than the call.
 */
export async function voice(text: string, label: string): Promise<ConsultCallSpokenReply> {
  if (!isElevenLabsConfigured()) return { audioUrl: null, provider: 'twilio-say' };
  try {
    const result = await withDeadline(
      synthesizeSpeech({ text, label, cacheable: true }),
      voiceTimeoutMs(),
      'speech synthesis',
    );
    if (result.ok && result.audioUrl) return { audioUrl: result.audioUrl, provider: 'elevenlabs' };
    console.warn(`Reply "${label}" fell back to the stock voice: ${result.error ?? 'no audio'}`);
    return { audioUrl: null, provider: 'twilio-say' };
  } catch (error) {
    console.warn(`Reply "${label}" fell back to the stock voice: ${(error as Error).message}`);
    return { audioUrl: null, provider: 'twilio-say' };
  }
}

/**
 * The model for a phone turn, or nothing to take the default.
 *
 * Unset is the normal case. A turn is a sentence or two chosen from facts
 * already in the prompt, which a general-purpose model handles well. The
 * override exists for tuning latency, which is what actually matters here: a
 * reasoning model spends seconds thinking, and those seconds are silence on the
 * line.
 */
function modelOverride(): string | undefined {
  return config.call.conversationModel || undefined;
}

function effort(): OpenAiReasoningEffort {
  const raw = config.call.conversationEffort;
  return (EFFORTS as readonly string[]).includes(raw)
    ? (raw as OpenAiReasoningEffort)
    : DEFAULT_CONVERSATION_EFFORT;
}

function replyTimeoutMs(): number {
  const raw = config.call.conversationReplyTimeoutMs;
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_REPLY_TIMEOUT_MS;
}

function voiceTimeoutMs(): number {
  const raw = config.call.conversationVoiceTimeoutMs;
  return Number.isFinite(raw) && raw >= 500 ? raw : DEFAULT_VOICE_TIMEOUT_MS;
}
