import type { ConsultCallResult } from '../types.js';
import { describeConsultSlot } from './script.util.js';

/**
 * The conversational call, as prompt text.
 *
 * Everything in here is pure: context in, strings and validated objects out. The
 * network sits in ConsultCallConversationService, and the webhook glue sits in
 * ConsultCallService, so the words the model is given - and what is made of the
 * words it gives back - can be tested without either.
 *
 * The shape this exists to replace was a classifier: hear a sentence, sort it
 * into one of six buckets, play the bucket's line. That made every sentence a
 * family might say into a branch somebody had to have written. Here the model is
 * handed the facts and the whole transcript and asked what a person would say
 * next, and the only thing the code decides is whether it is still allowed to.
 */

/**
 * What the assistant is allowed to know about the appointment.
 *
 * Deliberately a closed list. The prompt tells the model these are the only
 * facts it has, and that anything else gets "I'm not sure, but someone from the
 * team can help" - so a field left null is a question the call cannot answer,
 * not a field the model should fill in from imagination.
 */
export interface ConsultCallAppointmentContext {
  /** "LogoLife College Counseling" */
  organizationName: string;
  /** "Dawn" - who the family is talking to. */
  callerName: string;
  /** The parent's name, when the booking has one. */
  familyName: string | null;
  startAt: Date;
  /** The booking's displayTimezone. The family hears their clock, not ours. */
  timeZone: string;
  /** "a college counseling consultation" - said as the object of a sentence. */
  purpose: string;
  durationMinutes: number | null;
  /** "a video call on Zoom", "in person at our office", or null when unknown. */
  format: string | null;
  advisorName: string | null;
  /** Anything else production is allowed to say, one plain sentence each. */
  extraFacts: string[];
}

/**
 * What the call decided, in the model's vocabulary.
 *
 * These are outcomes, recorded when the conversation ENDS. They are not the
 * states the conversation moves through: a family who asks a question is not in
 * a "question" state, they are a family who asked a question, and the next turn
 * answers it.
 */
export const CONSULT_CALL_OUTCOMES = [
  'confirmed',
  'declined',
  'reschedule_requested',
  'wrong_number',
  'no_response',
  'unresolved',
] as const;
export type ConsultCallOutcome = (typeof CONSULT_CALL_OUTCOMES)[number];

/** How long to listen after speaking. `hold` is the twenty-second wait. */
export type ConsultCallListen = 'answer' | 'hold';

export interface ConsultCallReply {
  /** The words to speak now. */
  say: string;
  /** Ignored when `endCall` is true. */
  listen: ConsultCallListen;
  endCall: boolean;
  /** Only meaningful when `endCall` is true; null otherwise. */
  outcome: ConsultCallOutcome | null;
  /** A few words for the staff log on what the caller meant this turn. */
  note: string | null;
  /** When the call ends: one or two sentences for the team. */
  summary: string | null;
}

/** One thing the caller did on a turn. All three null is a silence. */
export interface ConsultCallHeard {
  speech: string | null;
  digits: string | null;
  /** Twilio's confidence in the transcript, 0 to 1; null when none was sent. */
  confidence: number | null;
}

/** One completed exchange: what was heard, and what was said back. */
export interface ConsultCallExchange {
  heard: ConsultCallHeard;
  /** What the family heard in reply, including a fixed fallback line. */
  reply: string;
}

export interface ConsultCallConversationInput {
  context: ConsultCallAppointmentContext;
  /** A staff rehearsal. Changes what the model may promise, not how it talks. */
  isTest: boolean;
  /** The scripted opening, so the model knows what has already been said. */
  opening: string;
  /** Every earlier exchange, oldest first. */
  history: ConsultCallExchange[];
  /** What the caller just did. */
  heard: ConsultCallHeard;
  /** 1-based count of caller turns including this one. */
  turnNumber: number;
  maxTurns: number;
  /** The code has decided this is the last turn, whatever the model thinks. */
  mustEnd: boolean;
}

/** Below this the prompt flags the transcript as possibly garbled. */
const LOW_CONFIDENCE = 0.5;

/** Longest line the call will speak. A model that writes an essay gets it cut, not played. */
const MAX_SAY_CHARS = 600;
const MAX_NOTE_CHARS = 300;
const MAX_SUMMARY_CHARS = 500;

/**
 * The response shape, as a JSON schema for structured output.
 *
 * Nullable fields use `anyOf` with a null branch because that is the form the
 * other structured-output schemas in this codebase already use against the same
 * client, and a schema the API rejects would fail every turn of every call.
 */
export const CONSULT_CALL_REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    say: {
      type: 'string',
      description: 'The words to speak now. One or two short sentences, as said aloud.',
    },
    listen: {
      type: 'string',
      enum: ['answer', 'hold'],
      description: '"hold" only when you have just agreed to wait for the caller.',
    },
    endCall: {
      type: 'boolean',
      description: 'True only when the conversation is finished and `say` is the goodbye.',
    },
    outcome: {
      anyOf: [{ type: 'string', enum: [...CONSULT_CALL_OUTCOMES] }, { type: 'null' }],
      description: 'Set when endCall is true; null otherwise.',
    },
    note: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Five words at most, for the staff log: what the caller meant this turn.',
    },
    summary: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'When endCall is true: one or two sentences for the team. Null otherwise.',
    },
  },
  required: ['say', 'listen', 'endCall', 'outcome', 'note', 'summary'],
  additionalProperties: false,
};

const TEST_CALL_LIMITS =
  'This is a TEST call: a staff member dialed their own phone to hear how the call sounds. ' +
  'Treat them exactly as you would a family - but nothing you say changes any real appointment. ' +
  "If they ask to move or cancel, note what they'd prefer and tell them plainly that since this " +
  'is a test call nothing is being changed, but someone from the team can follow up. For example: ' +
  "\"Got it - I'll note you'd prefer Tuesday evening. Since this is just a test call it won't " +
  'actually change your appointment, but someone from the team can follow up with you."';

const LIVE_CALL_LIMITS =
  'You cannot change, cancel or rebook appointments yourself. If the family wants a different ' +
  "time, note what they'd prefer and tell them someone from the team will follow up to arrange it.";

function fact(label: string, value: string | null | undefined): string {
  return `- ${label}: ${value && value.trim() ? value.trim() : 'not known'}`;
}

function durationWords(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'about an hour' : `about ${hours} hours`;
  }
  return `about ${minutes} minutes`;
}

/**
 * The system prompt: who the assistant is, what it knows, how it should behave.
 *
 * Constant for the whole call, so it is built once per turn from the same
 * context and reads identically each time - which is also what lets the API
 * cache it across the turns of one call.
 *
 * Written as guidance rather than as a rulebook. The one place it is strict is
 * the facts: the model may say only what is listed, and must say so when asked
 * for anything else. Everything about HOW to talk is the register of a good
 * phone manner, and the model is trusted to apply it to sentences nobody here
 * anticipated - which is the entire point of replacing the phrase lists.
 */
export function buildConsultCallConversationInstructions(
  input: Pick<ConsultCallConversationInput, 'context' | 'isTest' | 'opening'>,
): string {
  const { context } = input;
  const when = describeConsultSlot(context.startAt, context.timeZone);

  const facts = [
    fact('Organization', context.organizationName),
    fact('Appointment', context.purpose),
    `- When: ${when.full}. That is ${when.zone} time - the family's own time zone.`,
    fact('Length', durationWords(context.durationMinutes)),
    fact('Format', context.format),
    fact('Advisor', context.advisorName),
    fact("Family's name", context.familyName),
    ...context.extraFacts.map((line) => `- ${line.trim()}`),
  ].join('\n');

  return [
    `You are ${context.callerName}, calling on behalf of ${context.organizationName}. ` +
      'You are on a live phone call with a family, and every word you write is spoken aloud ' +
      'to them by a text-to-speech voice.',
    '',
    "# Why you're calling",
    'You opened the call by checking that an appointment the family booked still works for them. ' +
      'Your opening line, already spoken, was:',
    `"${input.opening}"`,
    "Don't recite it again word for word. If they ask who's calling or what this is about, " +
      'answer in a sentence, in your own words.',
    '',
    /*
     * The first-turn rule, and why it overrides "don't say it again".
     *
     * The opening plays INSIDE the listening gather. A family who says "hello?"
     * over it - which is what people do when they pick up a phone - ends the
     * turn before they have taken in a word of it. The transcript then shows an
     * opening that was technically spoken and a caller who plainly did not hear
     * it, and the old blanket instruction had this answering "Does that still
     * work for you?" to someone who had been told nothing.
     *
     * So the first reply has to be able to stand on its own. Not always: a
     * caller who opens with "yes, that's right" or "is it on Zoom?" has clearly
     * heard it, and reciting the whole thing back at them is its own failure.
     * The test is whether their first words engage with the appointment.
     */
    '# Your first reply, if they have not taken the opening in',
    'This applies to the FIRST caller turn ONLY, and only when their words show they took in ' +
      'nothing at all. Exactly these cases: a bare greeting; asking who is calling; asking you ' +
      'to repeat; an unintelligible mumble; or silence. Then assume they talked over the opening ' +
      'and never heard it, and your reply must stand entirely on its own and contain ALL of this ' +
      'in two sentences:',
    '  a greeting; your name; the organization; the day and date; the time WITH the zone or ' +
      '"your local time"; how the consult happens; and the question of whether it still works.',
    'Model it on the opening above - same facts, freshly worded. They should never have to ask ' +
      '"what time?" or "where?" to learn something you were already going to tell them.',
    // Without this boundary the rule swallowed the whole first turn: "I'm not
    // sure" and "sorry, I'm driving" both got the entire appointment read back
    // in four sentences, which is worse than the bug it was added to fix.
    'Anything else means they heard you, and you must NOT restate the appointment. Replying to ' +
      'the question at all counts, however vaguely - "I think so", "I\'m not sure", "maybe", ' +
      '"hold on", "sorry, I\'m driving", a question about the consult. Answer those normally, ' +
      'in your usual sentence or two.',
    '',
    '# What you know',
    'These are the only facts you have. Use them to answer questions. If a question is not ' +
      "covered here, say you're not sure and that someone from the team can help - never guess, " +
      'and never invent details, policies, prices, links or people.',
    facts,
    '',
    '# How to have this conversation',
    'In this order:',
    '1. Understand what the caller just said. Transcripts come from phone speech recognition and ' +
      'can be garbled; read them charitably, as a person would.',
    '2. Respond to that, directly. Their latest words always take priority over whatever you ' +
      'were asking before. Never make them answer your question before you address theirs.',
    '3. Answer their questions from the facts above. Several at once? Answer them together, briefly.',
    '4. Ask a natural follow-up when one is needed.',
    '5. Come back to whether the appointment still works only if that is still open, and only ' +
      'once the conversation has room for it.',
    '6. End the call only when the conversation is genuinely finished.',
    '',
    'Things that come up:',
    '- "Yes, but..." or "Can I ask something first?": they have opened a thread. Follow it - ' +
      '"Of course - what\'s your question?" - and do not treat the yes as the end of the call.',
    "- They're unsure or don't remember the appointment: reassure them and remind them what it " +
      'is. Offer them a moment to check if that would help.',
    '- They want a different time: ask what would work better, note it, and be honest about ' +
      'what you can and cannot do (see below).',
    '- "Hold on" / "one second" / "let me check": say something short like "Sure, take your ' +
      'time." and set listen to "hold". When they come back, pick up where you left off.',
    '- "Who is this?": name yourself and the organization and say what you are calling about, ' +
      'in a sentence. Not the opening line.',
    '- A stranger, or a wrong number: apologize briefly and end the call with outcome wrong_number.',
    '- You genuinely cannot make out what they said: ask them to repeat ONCE, briefly. If the ' +
      'transcript shows you already asked, do not ask again - answer your best reading instead. ' +
      'A low-confidence flag is a hint, not proof: if it reads as a sentence, take it as one.',
    '- Silence: the first time, check they are still there. If you are told this must be your ' +
      'last turn, say a brief goodbye instead.',
    "- They're driving, busy, or ask you to call back: keep it short, respect it, close politely.",
    '',
    '# How you sound',
    '- One or two short sentences per turn. This is a phone call, not a chat window.',
    '- Plain spoken English. No lists, no markdown, no emoji, no stage directions. Write numbers ' +
      'and times the way you would say them.',
    '- Do not repeat the date, the time, the company name, or anything the caller has already ' +
      'acknowledged, unless they ask.',
    '- Do not over-explain. Answer, then stop.',
    '- Remember the conversation. If they have already confirmed, do not ask again.',
    '',
    '# What you must not do',
    `- ${input.isTest ? TEST_CALL_LIMITS : LIVE_CALL_LIMITS}`,
    '- Never claim to have sent, changed, booked, cancelled or confirmed anything. You have no ' +
      'tools; the only thing you can do on this call is talk.',
    '- Never invent appointment details or policies.',
    '',
    '# Ending the call',
    'Close when the caller has nothing pending: they have confirmed and asked nothing more, or ' +
      'their questions are answered and they have signalled they are done ("okay, great", ' +
      '"perfect", "thanks"). A short, warm goodbye - "Perfect - we\'ll see you Friday. Take care!" ' +
      '- with endCall true, an outcome, and a one- or two-sentence summary for the team.',
    'Never close on a turn where the caller has just asked a question or opened a new thread.',
    // Without this the model treats "do not close early" as "never close", and
    // answers a plain "yes, that works" by fishing for more questions. That
    // keeps a family on the phone after they have already said the one thing
    // the call rang to find out, which is its own kind of rude.
    'But a clear yes with nothing else pending IS a finished conversation. Close it, on that ' +
      'turn, with the goodbye. Do not go looking for more: "anything else?" or "any questions ' +
      'before the consult?" asked of someone who has just confirmed and asked nothing is a ' +
      'reason for them to still be on the phone, not a courtesy.',
    '',
    // Deliberately short. The reply schema is enforced by strict structured
    // outputs and carries a description for every field, so restating the shape
    // here bought nothing and cost input tokens on every turn of every call.
    // What is left is the part the schema cannot express: how long `note`
    // should be. It is generated on every turn, and output tokens are the
    // slowest thing in a turn, so five words rather than a sentence is worth
    // saying.
    '# Your reply',
    'Fill in the reply schema. Keep `note` to five words at most; it is a log entry, not prose.',
  ].join('\n');
}

/** What the caller did, as a line of transcript. */
function heardWords(heard: ConsultCallHeard): string {
  const digits = (heard.digits ?? '').trim();
  const speech = (heard.speech ?? '').trim();
  if (digits) return `(pressed ${digits} on the keypad)`;
  if (!speech) return '(said nothing)';

  const score = heard.confidence;
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) {
    return `"${speech}"`;
  }
  const percent = Math.round(score * 100);
  return score < LOW_CONFIDENCE
    ? `"${speech}" (speech recognition, LOW confidence ${percent}% - may be garbled)`
    : `"${speech}" (speech recognition, ${percent}% confident)`;
}

/**
 * The user turn: the whole conversation so far, then what just happened.
 *
 * The transcript is rendered into the prompt rather than sent as alternating
 * messages. The existing Responses client takes one user message, the whole
 * exchange is a few hundred words at most, and a rendered transcript lets the
 * prompt annotate each caller line with how sure the recogniser was of it -
 * which a bare message history could not carry.
 */
export function renderConsultCallConversationPrompt(input: ConsultCallConversationInput): string {
  const speaker = input.context.callerName;
  const lines: string[] = ['The conversation so far:', `${speaker}: "${input.opening}"`];
  for (const exchange of input.history) {
    lines.push(`Caller: ${heardWords(exchange.heard)}`);
    lines.push(`${speaker}: "${exchange.reply}"`);
  }

  lines.push('');
  const heard = heardWords(input.heard);
  lines.push(
    heard === '(said nothing)'
      ? 'Just now: the caller said nothing. The line was silent until the listening window closed.'
      : `Just now, the caller: ${heard}`,
  );
  lines.push(`This is caller turn ${input.turnNumber} of at most ${input.maxTurns}.`);
  if (input.turnNumber === 1) {
    // Repeated here, at the end, because this is the last thing the model reads
    // before it answers, and the failure it prevents - a family who heard none
    // of the opening being asked "does that still work?" - happens exactly here.
    lines.push(
      'Their first words. If they gave you nothing to go on - a bare greeting, asking who is ' +
        'calling, asking you to repeat, a mumble, or silence - your reply must stand on its own: ' +
        'greeting, your name, the organization, the day and date, the time with its zone, how ' +
        'the consult happens, and the question. Otherwise they heard you: answer only what they ' +
        'actually said, in a sentence or two, without listing the appointment again - though ' +
        'always give your name if their question is about who is calling.',
    );
  }
  if (input.mustEnd) {
    lines.push(
      'This has to be your last turn: say a brief, warm goodbye, set endCall to true, and ' +
        'choose the outcome that best describes where things stand.',
    );
  }
  lines.push('Reply with the JSON object.');
  return lines.join('\n');
}

/**
 * The reply's `say` value, the moment its closing quote arrives in the stream.
 *
 * `say` is the first property in CONSULT_CALL_REPLY_SCHEMA and the API emits a
 * strict-schema object in schema order, so it closes long before the rest. That
 * gap is worth catching: measured on a real turn, the first token and the end of
 * `say` land within a millisecond of each other, while the remaining fields take
 * a further ~326 ms. Synthesis can start on that first millisecond instead of
 * waiting out the tail.
 *
 * Returns exactly what normalizeConsultCallReply will later put on the turn, by
 * running the same cleaner. That is the point rather than a detail: the audio
 * the family hears and the text recorded against the turn have to be the same
 * words, and they would not be if this returned the raw slice.
 *
 * Null until the value is provably complete. A quote preceded by a backslash is
 * inside the string, and a backslash can itself be escaped, so the scan tracks
 * escaping rather than searching for the next quote.
 */
export function extractClosedSay(buffer: string): string | null {
  const key = '"say"';
  const at = buffer.indexOf(key);
  if (at < 0) return null;

  const colon = buffer.indexOf(':', at + key.length);
  if (colon < 0) return null;
  const open = buffer.indexOf('"', colon + 1);
  if (open < 0) return null;

  for (let i = open + 1; i < buffer.length; i += 1) {
    const char = buffer[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char !== '"') continue;
    try {
      // Re-quoted and parsed rather than hand-unescaped: \n, \" and \uXXXX all
      // have to come out as the characters the model meant, and JSON already
      // knows how to do that.
      const decoded = JSON.parse(buffer.slice(open, i + 1)) as unknown;
      return typeof decoded === 'string' ? cleanText(decoded, MAX_SAY_CHARS) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The model's answer, checked before anyone hears it.
 *
 * Structured output already holds the shape, so this is about meaning: a blank
 * `say` is a turn with nothing to play and is treated as a failure; a call that
 * ends without an outcome ends `unresolved`; a summary on a turn that does not
 * end the call is noise and is dropped. Returns null only when there is nothing
 * speakable, which the caller turns into the fixed fallback line.
 */
export function normalizeConsultCallReply(raw: unknown): ConsultCallReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;

  const say = cleanText(value.say, MAX_SAY_CHARS);
  if (!say) return null;

  const endCall = value.endCall === true;
  const outcomeRaw = typeof value.outcome === 'string' ? value.outcome : null;
  const known = (CONSULT_CALL_OUTCOMES as readonly string[]).includes(outcomeRaw ?? '')
    ? (outcomeRaw as ConsultCallOutcome)
    : null;

  return {
    say,
    listen: value.listen === 'hold' ? 'hold' : 'answer',
    endCall,
    outcome: endCall ? (known ?? 'unresolved') : null,
    note: cleanText(value.note, MAX_NOTE_CHARS),
    summary: endCall ? cleanText(value.summary, MAX_SUMMARY_CHARS) : null,
  };
}

/**
 * The model's outcome in the vocabulary the rest of the system already speaks.
 *
 * `reschedule_requested` lands as `declined` because that is what the scripted
 * call has always recorded for "this slot doesn't work" - the queue, the tab and
 * the follow-up all key off it - and the preferred time the family gave is in
 * the summary. `unresolved` is `no_response`: the call ended without the
 * question being settled, which is what that result has meant since the
 * scripted call gave up after its reprompt.
 */
export function consultCallOutcomeToResult(outcome: ConsultCallOutcome | null): ConsultCallResult {
  switch (outcome) {
    case 'confirmed':
      return 'confirmed';
    case 'declined':
    case 'reschedule_requested':
      return 'declined';
    case 'wrong_number':
      return 'wrong_number';
    case 'no_response':
    case 'unresolved':
    default:
      return 'no_response';
  }
}
