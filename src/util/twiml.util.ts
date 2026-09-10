/** Amazon Polly neural voice, used for any line ElevenLabs did not produce audio for. */
export const FALLBACK_VOICE = 'Polly.Joanna-Neural';

/**
 * Words handed to Twilio's speech engine as priors. They lift recognition of the
 * short, low-information answers this call actually receives; without them "yep"
 * is routinely transcribed as something else.
 *
 * The list tracks the wording of the question. Since the call asks whether the
 * slot "still works on your end", it hears agreements with a plan far more often
 * than it hears the literal word "yes".
 */
const SPEECH_HINTS = [
  'yes',
  'yeah',
  'yep',
  'correct',
  "that's right",
  'confirmed',
  'that works',
  'works for me',
  'sounds good',
  "we'll be there",
  'see you then',
  'no',
  'nope',
  'cancel',
  'reschedule',
  "doesn't work",
  'something came up',
  'another time',
].join(',');

/**
 * Priors for a call the family can say anything to.
 *
 * The scripted hints lift yes and no because those are the only answers that
 * call can use. A conversational call hears questions, holds and detours as
 * often as it hears agreement, and a recogniser primed for "yep" turns "is this
 * over Zoom" into something no model can answer. Still short answers first: the
 * opening question is the same, and most families still just say yes.
 */
export const CONVERSATION_SPEECH_HINTS = [
  'yes',
  'yeah',
  'that works',
  'sounds good',
  'no',
  'actually',
  'I have a question',
  'can I ask you something',
  'what time',
  'what day',
  'time zone',
  'Eastern',
  'is this virtual',
  'Zoom',
  'how long',
  'who is this',
  "who's calling",
  'what is this about',
  'which appointment',
  'hold on',
  'one second',
  'let me check',
  'reschedule',
  'different day',
  'call me back',
  "I'm not sure",
  'never mind',
  'wrong number',
  'thank you',
  'goodbye',
].join(',');

/** Ampersand first, or the entities emitted after it get escaped a second time. */
export function escapeXml(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function document(body: string): string {
  return `${HEADER}<Response>${body}</Response>`;
}

/** Only an https URL is played; anything else degrades to the spoken fallback. */
function playable(audioUrl: string | null | undefined): string | null {
  const url = String(audioUrl ?? '').trim();
  return url.startsWith('https://') ? url : null;
}

export interface SpokenLine {
  /** The synthesized clip for this line, when one was produced. */
  audioUrl?: string | null;
  /** What the line says, spoken by Twilio when there is no clip. */
  text: string;
}

/**
 * One line of the call, in the real voice where we have it.
 *
 * Every line goes through here - greeting, question, reprompt and all three
 * closes - so the family hears one person for the whole call. Before this, only
 * the opening was synthesized and the goodbye arrived in a different, flatter
 * voice, which undid the effect of the first line being any good.
 */
function voice(line: SpokenLine): string {
  const url = playable(line.audioUrl);
  return url
    ? `<Play>${escapeXml(url)}</Play>`
    : `<Say voice="${FALLBACK_VOICE}">${escapeXml(line.text)}</Say>`;
}

/**
 * The beat before the call says its first word.
 *
 * Carriers commonly clip the start of the audio after an answer is signalled -
 * VoLTE handsets are the worst of it - and "Hi, this is Dawn" arriving as
 * "-s is Dawn" costs the call its introduction. It doubles as the moment the
 * family gets to say "hello?" into, which is the other reason the opening never
 * starts talking immediately.
 */
const OPENING_PAUSE_SECONDS = 2;

/** Same clipping problem, at the other end of the call. One beat is enough here. */
const CLOSING_PAUSE_SECONDS = 1;

/** How long to wait for an answer to a question that has just been asked. */
const ANSWER_TIMEOUT_SECONDS = 6;

/**
 * How long to wait for someone who asked us to hold, in seconds.
 *
 * Long enough to walk to another room, find a spouse and come back, because that
 * is literally what "hold on, let me get my wife" means. Six seconds - what an
 * ordinary answer gets - expires while the phone is still on the kitchen counter,
 * and the reprompt then plays to an empty room.
 *
 * Not unbounded: this is the ceiling for someone who put the phone down and
 * forgot about it, and when it expires the gather posts back and the call closes
 * politely rather than hanging on.
 */
const WAIT_TIMEOUT_SECONDS = 20;

/**
 * Speech and one keypress, always.
 *
 * The keypad is accepted even though no line mentions it: a family who reaches
 * for it should be heard, and announcing it is what would make the call sound
 * like a phone menu.
 *
 * `actionOnEmptyResult` is what makes silence reach us. Twilio's default on a
 * gather that times out with no input is to fall through to the next verb rather
 * than post to the action url - and since every document here is one Gather with
 * nothing after it, the default ends the call outright. A family who answered and
 * said nothing would be hung up on without hearing the closing line, with no
 * attempt counted and no result recorded.
 *
 * `speechModel="phone_call"` because that is what this is. The default model is
 * trained on wideband audio; a phone call is 8 kHz, and the gap between the two
 * shows up precisely on the one-word answers this call exists to collect.
 */
function gather(
  actionUrl: string,
  inner: string,
  timeoutSeconds = ANSWER_TIMEOUT_SECONDS,
  hints = SPEECH_HINTS,
  speechTimeout: SpeechEndTimeout = 'auto',
): string {
  return (
    `<Gather input="speech dtmf" numDigits="1" timeout="${timeoutSeconds}" ` +
    `speechTimeout="${speechTimeout}" language="en-US" speechModel="phone_call" ` +
    `actionOnEmptyResult="true" hints="${escapeXml(hints)}" ` +
    `action="${escapeXml(actionUrl)}" method="POST">${inner}</Gather>`
  );
}

/**
 * How long a caller may go quiet before Twilio decides their turn is over.
 *
 * `auto` is Twilio's own end-of-speech model. It is the accurate choice and the
 * slow one: it is the largest single piece of the gap between a family finishing
 * a sentence and hearing an answer, and it is the one piece no amount of work on
 * our side can shorten.
 *
 * A number is a flat count of seconds of silence. Shorter means a snappier call
 * and a real risk of cutting off anyone who pauses to think mid-sentence, so it
 * belongs in config where it can be tuned against real calls rather than
 * guessed at here.
 */
export type SpeechEndTimeout = 'auto' | number;

export interface LineTwimlInput extends SpokenLine {
  actionUrl: string;
  /** Recogniser priors for what comes next. Defaults to the scripted yes/no list. */
  hints?: string;
  /** Silence that ends a caller's turn. Defaults to Twilio's slower `auto`. */
  speechTimeout?: SpeechEndTimeout;
}

/**
 * The whole opening: a beat to say hello into, then who is calling and the
 * question, then listening. One document, one turn.
 *
 * The pause replaces what used to be a separate listening gather, which existed
 * so the family could say "hello?" before being talked at. Its real cost was a
 * webhook round trip in the middle of the call: the dead air of that round trip
 * is what produced the second "hello??", spoken over the question that followed.
 *
 * A fixed pause is worse than a listening gather in exactly one way: it always
 * costs its full length, where a gather ended as soon as the family stopped
 * talking. It is better in every other way - no round trip, no dead air, no
 * webhook, no database read.
 *
 * The reason the old shape could not simply be kept AND made to hear an early
 * answer: with `input="speech"`, Twilio appears not to begin recognising until
 * the nested verbs have finished playing, so speech over the question is not
 * captured - only a keypress interrupts. That is worth confirming against a real
 * call if this ever gets revisited; the change above stands either way, since
 * everything else it fixes is independent of that behaviour.
 *
 * The audio still sits INSIDE <Gather>, which is what lets a keypress interrupt
 * the question, and what keeps the whole opening in one request.
 */
export function buildAskTwiml(input: LineTwimlInput): string {
  return document(
    gather(
      input.actionUrl,
      `<Pause length="${OPENING_PAUSE_SECONDS}"/>${voice(input)}`,
      ANSWER_TIMEOUT_SECONDS,
      input.hints,
      input.speechTimeout,
    ),
  );
}

export interface ConverseTwimlInput extends LineTwimlInput {
  /** `hold` listens for twenty seconds; `answer` for an ordinary six. */
  listen: 'answer' | 'hold';
}

/**
 * One turn of a conversation: say the model's line, then listen.
 *
 * This is the whole conversational call after the opening - the same document
 * over and over with different words in it, until a turn ends the call and
 * buildHangupTwiml takes over. There is no reprompt shape and no hold shape any
 * more, because the model chooses the words for those moments and the only
 * thing it needs from the code is how long to wait afterwards.
 *
 * No leading pause, for the reason buildWaitTwiml gives: mid-conversation there
 * is no answer-clipping to protect against, and a beat of silence before the
 * reply reads as the line having dropped. The conversational hints ride on every
 * turn, because the family can change the subject on any of them.
 */
export function buildConverseTwiml(input: ConverseTwimlInput): string {
  return document(
    gather(
      input.actionUrl,
      voice(input),
      input.listen === 'hold' ? WAIT_TIMEOUT_SECONDS : ANSWER_TIMEOUT_SECONDS,
      input.hints ?? CONVERSATION_SPEECH_HINTS,
      input.speechTimeout,
    ),
  );
}

/** One retry, then the call gives up. Two is a robot arguing with a parent. */
export function buildRepromptTwiml(input: LineTwimlInput): string {
  return document(gather(input.actionUrl, voice(input)));
}

/**
 * "Hold on, let me get my wife." - one short line, then a long silence.
 *
 * The call could not previously do this at all: a request to hold fell to
 * `unclear`, the reprompt fired straight over a phone lying on a counter, and
 * the call was over before anyone came back to it.
 *
 * No leading pause. The clipping a pause protects against happens when a call is
 * answered; mid-conversation there is nothing to protect against, and a beat of
 * silence before "of course" would read as the line having dropped.
 */
export function buildWaitTwiml(input: LineTwimlInput): string {
  return document(gather(input.actionUrl, voice(input), WAIT_TIMEOUT_SECONDS));
}

/**
 * Terminal document. With no line, hangs up in silence - the voicemail path.
 *
 * The pause exists only when there is something to say. On the voicemail path it
 * would be a beat of recorded silence on someone's tape.
 */
export function buildHangupTwiml(input?: SpokenLine | null): string {
  const say = input?.text ? `<Pause length="${CLOSING_PAUSE_SECONDS}"/>${voice(input)}` : '';
  return document(`${say}<Hangup/>`);
}
