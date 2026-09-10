import { randomBytes, randomUUID } from 'node:crypto';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { AppError, config } from './config.js';
import * as conversation from './conversation.service.js';
import { synthesizeMany } from './elevenlabs.js';
import * as store from './store.js';
import { endCall, isVoiceConfigured, placeCall } from './twilio.js';
import {
  isTerminalConsultCallStatus,
  type ConsultCallLineName,
  type ConsultCallResult,
  type ConsultCallStatus,
  type ConsultCallTurn,
  type TestCall,
} from './types.js';
import {
  consultCallOutcomeToResult,
  type ConsultCallAppointmentContext,
  type ConsultCallExchange,
  type ConsultCallHeard,
} from './util/conversation.util.js';
import { buildSampleConsultSlot } from './util/sample.util.js';
import {
  CONSULT_CALL_LINES,
  DEFAULT_CALLER,
  DEFAULT_COMPANY,
  buildConsultCallTranscript,
  buildConversationalCallLines,
} from './util/script.util.js';
import {
  CONVERSATION_SPEECH_HINTS,
  buildAskTwiml,
  buildConverseTwiml,
  buildHangupTwiml,
  type SpokenLine,
} from './util/twiml.util.js';
import { isWithinCallingHours } from './util/window.util.js';

/** A call with no Twilio callback for this long is not coming back. */
const STALE_CALL_MS = 10 * 60_000;

const RING_TIMEOUT_SECONDS = 25;

/**
 * The note a turn carries when the model did not answer it.
 *
 * Also how the next turn knows the previous one failed: two of these in a row is
 * the point at which the call stops apologising and closes politely instead.
 */
const ASSISTANT_UNAVAILABLE_NOTE = 'the assistant did not answer in time';

/**
 * Consecutive silences before the call is told to wrap up.
 *
 * One silence is someone who put the phone down for a moment; the model checks
 * they are still there. Two is a phone lying on a counter, or a voicemail that
 * has finished its greeting, and a third listening window would be played to
 * nobody.
 */
const MAX_CONSECUTIVE_SILENCES = 2;

/**
 * Lines identical on every call, so their audio is stored once and reused.
 *
 * `ask` is excluded because it names a particular date and time and would only
 * ever be a cache miss, leaving a dead object behind per call.
 */
const CACHEABLE_LINES: readonly ConsultCallLineName[] = CONSULT_CALL_LINES.filter(
  (line) => line !== 'ask',
);

/**
 * The zone a test call pretends its appointment is in.
 *
 * A rehearsal has no family and so no timezone of its own. Fixed rather than
 * taken from the machine's clock, so the same wording is heard wherever the
 * server happens to be running.
 */
const TEST_CALL_TIMEZONE = 'America/New_York';
const TEST_CALL_PURPOSE = 'a college counseling consultation';
const TEST_CALL_FORMAT = 'a video call on Zoom';

/** The number in E.164, or null if it is not dialable. */
function toE164(raw: string): string | null {
  const parsed = parsePhoneNumberFromString((raw ?? '').trim(), 'US');
  return parsed?.isValid() ? parsed.number : null;
}

export interface PlaceTestCallInput {
  /** Whatever was typed. Your own phone, in practice. */
  toPhone: string;
  overrideHours?: boolean;
  /** Injectable for tests. Production passes nothing. */
  now?: Date;
}

// ------------------------------------------------------------------- placing

/**
 * Rings a number you type so you can hear the call yourself.
 *
 * The same opening, TwiML, gather and machine-detection path as a real
 * confirmation call. After the opening it is a conversation: the model reads
 * what you said and answers it, in words chosen for that sentence, until the
 * exchange is naturally finished. What it never does is touch a booking - there
 * is none to touch, no confirmation is written and nothing is synced, whatever
 * you say or the model concludes.
 */
export async function placeTestCall(input: PlaceTestCallInput): Promise<CallView> {
  const now = input.now ?? new Date();

  if (!config.call.enabled) {
    throw new AppError('Confirmation calling is turned off. Set CONSULT_CALL_ENABLED=true.');
  }
  if (!isVoiceConfigured()) {
    throw new AppError(
      'Outbound calling is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and ' +
        'TWILIO_VOICE_FROM_NUMBER.',
    );
  }
  if (!baseUrl().startsWith('https://')) {
    throw new AppError('PUBLIC_WEBHOOK_BASE_URL must be a public https origin Twilio can reach.');
  }
  // Refuses rather than falling back to a scripted flow. Without the model this
  // rig would rehearse a phone menu, and you would reasonably conclude the
  // conversation never shipped.
  if (!conversation.isConversationConfigured()) {
    throw new AppError('The test call needs the conversational assistant: set OPENAI_API_KEY.');
  }

  const toPhone = toE164(input.toPhone);
  if (!toPhone) {
    throw new AppError('Enter a phone number we can dial, including the country code.');
  }

  // A test call rings just as loudly at 2am as a real one, so it gets the same guard.
  const window = isWithinCallingHours({
    now,
    timeZone: TEST_CALL_TIMEZONE,
    startHour: config.call.hoursStart,
    endHour: config.call.hoursEnd,
  });
  if (!window.allowed && !input.overrideHours) {
    throw new AppError(`It is ${window.localLabel} company time. Call anyway to place it now.`);
  }

  const startAt = buildSampleConsultSlot(now, TEST_CALL_TIMEZONE);
  const durationMinutes =
    Number.isFinite(config.call.durationMinutes) && config.call.durationMinutes > 0
      ? config.call.durationMinutes
      : null;

  return dial({
    toPhone,
    lines: buildConversationalCallLines({
      startAt,
      timeZone: TEST_CALL_TIMEZONE,
      format: TEST_CALL_FORMAT,
    }),
    now,
    context: {
      organizationName: DEFAULT_COMPANY,
      callerName: DEFAULT_CALLER,
      familyName: null,
      startAt,
      timeZone: TEST_CALL_TIMEZONE,
      purpose: TEST_CALL_PURPOSE,
      durationMinutes,
      format: TEST_CALL_FORMAT,
      advisorName: null,
      extraFacts: [],
    },
  });
}

/**
 * Synthesize, record, dial.
 *
 * `lines` is partial: a conversational call records only its opening and two
 * fallback lines up front, because everything else it says is written and voiced
 * turn by turn once someone is on the line.
 */
async function dial(input: {
  toPhone: string;
  lines: Partial<Record<ConsultCallLineName, string>>;
  context: ConsultCallAppointmentContext;
  now: Date;
}): Promise<CallView> {
  const spoken = CONSULT_CALL_LINES.filter((line) => typeof input.lines[line] === 'string');

  // Every line is synthesized up front and in parallel, so the whole call is one
  // voice and you wait for the slowest clip rather than the sum. Synthesis stays
  // best effort per line: a dead key costs a line its voice, never the call.
  const speech = await synthesizeMany(
    spoken.map((line) => ({
      key: line,
      text: input.lines[line] as string,
      cacheable: CACHEABLE_LINES.includes(line),
    })),
  );

  const audioUrls: Partial<Record<ConsultCallLineName, string | null>> = {};
  for (const line of spoken) {
    audioUrls[line] = speech[line].ok ? (speech[line].audioUrl ?? null) : null;
  }
  const spoke = spoken.some((line) => speech[line].ok);
  const missing = spoken.filter((line) => !speech[line].ok);
  const requestId = spoken.map((line) => speech[line].requestId).find(Boolean) ?? null;

  /*
   * Every clip exists before the phone rings, or the phone does not ring.
   *
   * This is what makes the voice a guarantee rather than a hope. Synthesis can
   * only fail HERE, before dialing, where it is an error message on a screen;
   * once someone has picked up there is nothing left to fail, because every line
   * the call can reach is already recorded and signed. A stock robot reading a
   * script that introduces itself by name is worse than no call.
   */
  const firstMissing = missing[0];
  if (firstMissing && config.call.requireRealVoice) {
    const reason = speech[firstMissing].error ?? 'no audio was produced';
    console.warn(
      `Refused to dial ${input.toPhone}: ${missing.join(', ')} did not synthesize (${reason})`,
    );
    throw new AppError(
      `The call was not placed: the ${firstMissing} line did not synthesize (${reason}). ` +
        'Run npm run verify to check the ElevenLabs and S3 credentials.',
    );
  }

  const call = store.insert({
    id: randomUUID(),
    webhookToken: randomBytes(16).toString('hex'),
    toPhone: input.toPhone,
    createdAt: input.now,
    status: 'queued',
    isTest: true,
    conversational: true,
    conversationContext: input.context,
    scriptLines: { ...input.lines },
    audioUrls,
    scriptText: buildConsultCallTranscript(input.lines),
    // `elevenlabs` as soon as ANY line has a real clip: the page uses this to
    // warn "fallback voice", and a call that is mostly the real voice should not
    // carry that warning.
    voiceProvider: spoke ? 'elevenlabs' : 'twilio-say',
    audioUrl: audioUrls.ask ?? null,
    twilioCallSid: null,
    answeredBy: null,
    result: null,
    resultAt: null,
    durationSeconds: null,
    summary: null,
    error: null,
    voiceRequestId: requestId,
    turns: [],
  });

  const dialed = await placeCall({
    to: input.toPhone,
    url: webhookUrl(call.webhookToken, 'twiml'),
    statusCallback: webhookUrl(call.webhookToken, 'status'),
    // Where Twilio goes if the TwiML request above fails outright. Without it a
    // failed webhook is an "application error" recording played at the callee.
    fallbackUrl: webhookUrl(call.webhookToken, 'fallback'),
    machineDetection: true,
    // Detection runs alongside the call rather than in front of it, so the
    // callee hears the first line the moment they pick up.
    asyncAmdCallback: webhookUrl(call.webhookToken, 'amd'),
    timeoutSeconds: RING_TIMEOUT_SECONDS,
  });

  const updated = store.update(call.id, {
    set: dialed.ok
      ? { status: 'dialing', twilioCallSid: dialed.sid ?? null }
      : {
          status: 'failed',
          result: 'failed',
          resultAt: new Date(),
          error: dialed.error ?? null,
        },
  });

  return toView(updated ?? call, input.now);
}

// ------------------------------------------------------------------ webhooks

/** The call answered. Decide whether to speak at all. */
export async function handleTwiml(input: {
  token: string;
  answeredBy?: string | null;
}): Promise<string> {
  const call = requireCall(input.token);

  // A replayed webhook on a finished call must not restart the conversation.
  if (isTerminalConsultCallStatus(call.status)) return buildHangupTwiml();

  const answeredBy = (input.answeredBy ?? '').trim();
  if (answeredBy.startsWith('machine_') || answeredBy === 'fax') {
    settle(call, 'voicemail', { answeredBy });
    // Silence on purpose: a synthetic voice on someone's voicemail with no
    // callback path reads badly.
    return buildHangupTwiml();
  }

  store.update(call.id, { set: { status: 'in_progress', answeredBy: answeredBy || null } });

  /*
   * The opening is one document: a beat for the callee to say "hello?" into,
   * then the question, then listening. It used to be two, with a listening
   * gather first - but that bought a webhook round trip in the middle of the
   * call, and the dead air of that round trip is what made people say "hello??"
   * over the question, into the one window where Twilio's speech recogniser is
   * not listening. See buildAskTwiml.
   *
   * The recogniser is primed for questions as well as answers, because after
   * this line the caller can say anything.
   */
  return buildAskTwiml({
    actionUrl: gatherUrl(call.webhookToken),
    hints: CONVERSATION_SPEECH_HINTS,
    speechTimeout: conversation.speechEndTimeout(),
    ...lineFor(call, 'ask'),
  });
}

/**
 * The answering-machine verdict, which arrives while the call is already talking.
 *
 * The price of starting to speak immediately: by the time Twilio decides this
 * was a voicemail, a second or two of the opening is already on the tape. That
 * is the trade for someone who picks up hearing a voice rather than silence.
 * Hanging up here at least keeps it to a fragment instead of a whole message.
 *
 * Never throws: this is a callback, and a 500 only makes Twilio retry it.
 */
export async function handleAmd(input: {
  token: string;
  answeredBy?: string | null;
}): Promise<void> {
  const answeredBy = (input.answeredBy ?? '').trim();
  if (!answeredBy.startsWith('machine_') && answeredBy !== 'fax') return;

  const call = store.findByToken(input.token);
  if (!call) return;
  if (!mayRelabelAsVoicemail(call)) return;

  settle(call, 'voicemail', { answeredBy });
  if (call.twilioCallSid) {
    const ended = await endCall(call.twilioCallSid);
    if (!ended.ok) {
      console.warn(`Could not hang up voicemail call ${call.twilioCallSid}: ${ended.error}`);
    }
  }
}

/**
 * The caller answered, or did not.
 *
 * Reached on silence as well as speech: every gather sets `actionOnEmptyResult`,
 * so someone who says nothing arrives here with empty input rather than having
 * the call fall out from under them. Without that attribute Twilio's default is
 * to run off the end of the document and hang up - so a silent answer would
 * produce no turn, no closing line and no result.
 */
export async function handleGather(input: {
  token: string;
  digits?: string | null;
  speechResult?: string | null;
  /** Twilio's confidence in the transcript. Absent on some speech models. */
  confidence?: number | null;
}): Promise<string> {
  const call = requireCall(input.token);
  if (isTerminalConsultCallStatus(call.status)) return buildHangupTwiml();

  return converse(call, {
    speech: input.speechResult || null,
    digits: input.digits || null,
    confidence: typeof input.confidence === 'number' ? input.confidence : null,
  });
}

/**
 * One turn of the conversation.
 *
 * There is no classification here and no branch per thing someone might say. The
 * model is handed the appointment facts, everything said so far and what was
 * just heard, and asked what a person would say next and whether the
 * conversation is over. The code's job is narrower: keep the transcript, hold
 * the deadlines, decide when the call has gone on long enough to be a machine on
 * the other end, and turn the model's answer into one TwiML document.
 *
 * The call ends when the CODE says so - the turn cap and the silence cap - even
 * if the model would have carried on.
 */
async function converse(call: TestCall, heard: ConsultCallHeard): Promise<string> {
  const earlier = (call.turns ?? []).filter((turn) => turn.stage === 'converse');
  const history: ConsultCallExchange[] = earlier
    .filter((turn) => typeof turn.reply === 'string' && turn.reply.trim())
    .map((turn) => ({
      heard: {
        speech: turn.speechResult ?? null,
        digits: turn.digits ?? null,
        confidence: typeof turn.confidence === 'number' ? turn.confidence : null,
      },
      reply: turn.reply as string,
    }));

  const silent = !heard.speech && !heard.digits;
  let silences = silent ? 1 : 0;
  for (let index = earlier.length - 1; silent && index >= 0; index -= 1) {
    if (earlier[index]?.source !== 'none') break;
    silences += 1;
  }

  const turnNumber = earlier.length + 1;
  const maxTurns = conversation.maxTurns();
  const mustEnd = turnNumber >= maxTurns || silences >= MAX_CONSECUTIVE_SILENCES;

  /** Everything about this turn, appended whatever it turns out to mean. */
  const record = (
    said: Pick<ConsultCallTurn, 'reply' | 'note' | 'replyVoice'>,
  ): ConsultCallTurn => ({
    stage: 'converse',
    at: new Date(),
    speechResult: heard.speech,
    confidence: heard.confidence,
    digits: heard.digits,
    answer: null,
    matchedPhrase: null,
    source: heard.digits ? 'digits' : heard.speech ? 'speech' : 'none',
    ...said,
  });

  const context = conversationContextOf(call);
  // One call, not two: synthesis starts inside the stream the moment `say`
  // closes, so the rest of the JSON and the voice are produced together rather
  // than one after the other.
  const outcome = context
    ? await conversation.replyWithVoice(
        {
          context,
          isTest: true,
          opening: lineFor(call, 'ask').text,
          history,
          heard,
          turnNumber,
          maxTurns,
          mustEnd,
        },
        `turn ${turnNumber}`,
      )
    : { ok: false as const, error: 'the call has no appointment context to talk from' };

  if (!outcome.ok) {
    /*
     * The model did not answer. Once, the call asks the caller to repeat, in a
     * fixed line recorded before dialing - a person who missed a sentence says
     * exactly that. Twice in a row, or when the call had to end anyway, it
     * closes politely instead: nobody should be asked to repeat themselves to a
     * line that cannot hear them.
     */
    const lastNote = earlier[earlier.length - 1]?.note ?? null;
    const giveUp = mustEnd || lastNote === ASSISTANT_UNAVAILABLE_NOTE;
    const line = lineFor(call, giveUp ? 'noResponse' : 'reprompt');
    const turn = record({
      reply: line.text,
      note: ASSISTANT_UNAVAILABLE_NOTE,
      replyVoice: line.audioUrl ? 'elevenlabs' : 'twilio-say',
    });

    if (giveUp) {
      settle(
        call,
        'failed',
        { error: `conversation assistant unavailable: ${outcome.error}`.slice(0, 500) },
        turn,
      );
      return buildHangupTwiml(line);
    }

    store.update(call.id, { pushTurn: turn });
    return buildConverseTwiml({
      actionUrl: gatherUrl(call.webhookToken),
      listen: 'answer',
      speechTimeout: conversation.speechEndTimeout(),
      ...line,
    });
  }

  const { reply, voiced } = outcome;
  // The code's decision to end stands even when the model would have gone on.
  const endTheCall = reply.endCall || mustEnd;
  const line: SpokenLine = { text: reply.say, audioUrl: voiced.audioUrl };
  const turn = record({ reply: reply.say, note: reply.note, replyVoice: voiced.provider });

  if (!endTheCall) {
    store.update(call.id, { pushTurn: turn });
    return buildConverseTwiml({
      actionUrl: gatherUrl(call.webhookToken),
      listen: reply.listen,
      speechTimeout: conversation.speechEndTimeout(),
      ...line,
    });
  }

  /*
   * Where a live call would write the confirmation, this writes nothing.
   *
   * The source funnels every confirmation through one method that refuses when
   * `isTest` is set, so the branch exists there and is dead. Here the whole
   * branch is gone, which is the same behaviour stated once instead of guarded
   * twice: this rig cannot change an appointment, whatever the model concludes.
   * The outcome is still recorded, so you can see what it decided.
   */
  const result = consultCallOutcomeToResult(reply.outcome ?? 'unresolved');
  settle(call, result, { summary: reply.summary }, turn);
  return buildHangupTwiml(line);
}

/**
 * The appointment facts the call was placed with.
 *
 * Read back off the record rather than rebuilt, because the sample slot is
 * generated from the clock at dial time: a call placed before midnight and
 * answered after it would otherwise describe a different day on every turn.
 */
function conversationContextOf(call: TestCall): ConsultCallAppointmentContext | null {
  const stored = call.conversationContext;
  if (!stored || typeof stored !== 'object') return null;
  const startAt = new Date(stored.startAt as string | Date);
  if (!Number.isFinite(startAt.getTime())) return null;
  return {
    organizationName: stored.organizationName || DEFAULT_COMPANY,
    callerName: stored.callerName || DEFAULT_CALLER,
    familyName: stored.familyName ?? null,
    startAt,
    timeZone: stored.timeZone || 'UTC',
    purpose: stored.purpose || 'a consultation',
    durationMinutes: typeof stored.durationMinutes === 'number' ? stored.durationMinutes : null,
    format: stored.format ?? null,
    advisorName: stored.advisorName ?? null,
    extraFacts: Array.isArray(stored.extraFacts)
      ? stored.extraFacts.filter((fact): fact is string => typeof fact === 'string')
      : [],
  };
}

/** Twilio's own lifecycle events. Never throws: a 500 here just makes Twilio retry. */
export async function handleStatus(input: {
  token: string;
  callStatus: string;
  durationSeconds?: number | null;
}): Promise<void> {
  const call = store.findByToken(input.token);
  if (!call) return;

  const patch: Partial<TestCall> = {};
  if (typeof input.durationSeconds === 'number' && !Number.isNaN(input.durationSeconds)) {
    patch.durationSeconds = input.durationSeconds;
  }

  const mapped = mapTwilioStatus(input.callStatus);
  if (mapped) {
    patch.status = mapped.status;
    // The gather webhook already knows what the caller SAID. Twilio only knows
    // the call ended, so it must never overwrite a decided result.
    if (mapped.result && !call.result) {
      patch.result = mapped.result;
      patch.resultAt = new Date();
    }
  }

  if (Object.keys(patch).length === 0) return;
  store.update(call.id, { set: patch });
}

// --------------------------------------------------------------------- reads

export interface CallTurnView {
  stage: string;
  at: string | null;
  speechResult: string | null;
  confidence: number | null;
  digits: string | null;
  source: string | null;
  reply: string | null;
  note: string | null;
  replyVoice: string | null;
}

export interface CallView {
  id: string;
  toPhone: string;
  status: ConsultCallStatus;
  result: ConsultCallResult | null;
  resultAt: string | null;
  summary: string | null;
  voiceProvider: string;
  answeredBy: string | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
  /** The opening, so the page can show what the call led with. */
  opening: string;
  turns: CallTurnView[];
}

export function getCall(callId: string, now = new Date()): CallView | null {
  const call = store.findById(callId);
  return call ? toView(call, now) : null;
}

export function listCalls(now = new Date()): CallView[] {
  return store.list().map((call) => toView(call, now));
}

/**
 * A call whose webhooks never arrived would show "Calling…" forever. Resolved on
 * read rather than by a scheduler: nothing else here needs a job runner.
 */
function isStale(call: TestCall, now: Date): boolean {
  if (isTerminalConsultCallStatus(call.status)) return false;
  return now.getTime() - call.createdAt.getTime() > STALE_CALL_MS;
}

export function toView(call: TestCall, now = new Date()): CallView {
  const stale = isStale(call, now);
  return {
    id: call.id,
    toPhone: call.toPhone,
    status: stale ? 'failed' : call.status,
    result: stale ? 'failed' : (call.result ?? null),
    resultAt: call.resultAt ? call.resultAt.toISOString() : null,
    summary: call.summary ?? null,
    voiceProvider: call.voiceProvider,
    answeredBy: call.answeredBy ?? null,
    durationSeconds: call.durationSeconds ?? null,
    error: stale ? 'no callback received' : (call.error ?? null),
    createdAt: call.createdAt.toISOString(),
    opening: call.scriptLines.ask ?? call.scriptText,
    turns: (call.turns ?? []).map((turn) => ({
      stage: turn.stage,
      at: turn.at ? new Date(turn.at).toISOString() : null,
      speechResult: turn.speechResult ?? null,
      confidence: typeof turn.confidence === 'number' ? turn.confidence : null,
      digits: turn.digits ?? null,
      source: turn.source ?? null,
      reply: turn.reply ?? null,
      note: turn.note ?? null,
      replyVoice: turn.replyVoice ?? null,
    })),
  };
}

// ----------------------------------------------------------------- internals

export function baseUrl(): string {
  return config.call.publicWebhookBaseUrl;
}

/**
 * The URL Twilio calls back on.
 *
 * No query string at all, which is a deliberate change from the source. There it
 * carried `?tenant=`, and the gather URL appended `&stage=` on top of it - so
 * dropping the tenant without noticing would have turned the gather action into
 * `/gather&stage=converse`, a path segment Express does not route. Twilio would
 * sign it, request it, 404, fall through to the fallback URL and hang up on
 * every call right after the opening.
 *
 * `stage` is gone rather than fixed: it was informational even in the source
 * (the path is chosen by the record, never the URL), and this rig runs only the
 * conversational one.
 */
function webhookUrl(token: string, suffix: string): string {
  return `${baseUrl()}/api/v1/consults/calls/${token}/${suffix}`;
}

function gatherUrl(token: string): string {
  return webhookUrl(token, 'gather');
}

/**
 * One line of the call: what it says, and the clip that says it.
 *
 * A call with no stored line falls back to the wording it was placed with, so
 * the branch it reaches still speaks - in Twilio's voice, exactly as that call
 * always would have.
 */
function lineFor(call: TestCall, line: ConsultCallLineName): SpokenLine {
  const text = call.scriptLines?.[line];
  if (text) return { text, audioUrl: call.audioUrls?.[line] ?? null };
  if (line === 'ask') {
    return {
      text: call.scriptText,
      audioUrl: call.voiceProvider === 'twilio-say' ? null : call.audioUrl,
    };
  }
  // Unreachable in practice: a conversational call always records all three of
  // the lines it can reach. Kept so a malformed record still speaks.
  return { text: 'Sorry, something went wrong on our end. Take care!', audioUrl: null };
}

/**
 * Whether a late answering-machine verdict may overwrite what the call decided.
 *
 * The verdict arrives seconds into the call, and after `machine_end_beep` it can
 * be much longer - by which time the conversation has already run its course
 * against a voicemail greeting. Two ways that goes wrong: the greeting is heard
 * as nothing recognisable twice and the call settles `no_response`; or the
 * greeting ANSWERS the question - "we can't take your call right now" - and the
 * call files a decline nobody made.
 *
 * The rule that separates a real answer from a greeting: a KEYPRESS proves a
 * human was on the line, and speech does not. No answering machine presses
 * buttons, and on a transcript Twilio's own machine detector is the better
 * evidence.
 */
function mayRelabelAsVoicemail(call: TestCall): boolean {
  if (call.result === 'voicemail') return false;
  return !(call.turns ?? []).some((turn) => turn.digits);
}

function requireCall(token: string): TestCall {
  const call = store.findByToken(token);
  if (!call) throw new AppError('Unknown call.', 404);
  return call;
}

function settle(
  call: TestCall,
  result: ConsultCallResult,
  extra: Partial<TestCall> = {},
  /** The turn that settled it, appended in the same write. */
  turn?: ConsultCallTurn,
): void {
  store.update(call.id, {
    set: { status: 'completed', result, resultAt: new Date(), ...extra },
    ...(turn ? { pushTurn: turn } : {}),
  });
}

function mapTwilioStatus(
  raw: string,
): { status: ConsultCallStatus; result: ConsultCallResult | null } | null {
  switch ((raw ?? '').trim()) {
    case 'queued':
    case 'initiated':
      return { status: 'dialing', result: null };
    case 'ringing':
      return { status: 'ringing', result: null };
    case 'in-progress':
      return { status: 'in_progress', result: null };
    case 'completed':
      return { status: 'completed', result: null };
    case 'no-answer':
      return { status: 'failed', result: 'no_answer' };
    case 'busy':
      return { status: 'failed', result: 'busy' };
    case 'failed':
    case 'canceled':
      return { status: 'failed', result: 'failed' };
    default:
      return null;
  }
}
