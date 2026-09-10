export interface ConsultCallScriptInput {
  startAt: Date;
  /** The booking's own displayTimezone. The family hears their clock, not ours. */
  timeZone: string;
  companyName?: string;
  callerName?: string;
  /**
   * How the consult happens, as the object of a sentence: "a video call on Zoom".
   *
   * Woven into the opening so the first thing the family hears answers "where?"
   * as well as "when?". Omitted when unknown rather than guessed at: a call that
   * promises Zoom to a family booked for a phone consult has done more damage
   * than one that left them to ask.
   */
  format?: string | null;
}

export const DEFAULT_CALLER = 'Dawn';
export const DEFAULT_COMPANY = 'LogoLife College Counseling';

/**
 * The lines of the call.
 *
 * `ask` is the whole opening: a beat to say hello into, then who is calling and
 * the question, in one breath. It is also what a request to repeat replays,
 * because it is the line that answers "who is this?".
 *
 * `reprompt` and `holdOn` continue the call. The last four end it.
 *
 * All of them are synthesized in the same voice, so the family hears one person
 * from hello to goodbye.
 */
export const CONSULT_CALL_LINES = [
  'ask',
  'reprompt',
  'confirmed',
  'declined',
  'wrongNumber',
  'holdOn',
  'noResponse',
] as const;
export type ConsultCallLine = (typeof CONSULT_CALL_LINES)[number];
export type ConsultCallScript = Record<ConsultCallLine, string>;

/**
 * The zone as a person says it mid-sentence: "Eastern".
 *
 * The short form is "EDT", which a speech engine reads out as three letters.
 * The full form is "Eastern Daylight Time", which nobody says on the phone and
 * which makes the caller sound like a machine reading a database. Dropping the
 * Daylight/Standard word gives "Eastern Time"; dropping "Time" as well gives
 * what people actually say.
 *
 * "Time" is only dropped when the Daylight/Standard strip matched, because that
 * match is what proves the name is a US-style two-parter. "British Summer Time"
 * is the real name of that zone, not a seasonal variant of "British Summer", so
 * it keeps every word.
 */
function zoneName(startAt: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'long',
  }).formatToParts(startAt);
  const long = parts.find((part) => part.type === 'timeZoneName')?.value;
  if (!long) return 'Coordinated Universal Time';

  const trimmed = long.replace(/ (?:Daylight|Standard) Time$/, ' Time');
  return trimmed === long ? trimmed : trimmed.replace(/ Time$/, '');
}

/** "4th", not "4". 11th/12th/13th are the exceptions the % 10 rule gets wrong. */
function ordinal(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

export interface ConsultSlotWords {
  /** "Friday" */
  weekday: string;
  /** "Friday, September 4th, at 11 PM Eastern" */
  full: string;
  /** "Eastern" - the zone as a person says it. */
  zone: string;
}

/**
 * When the consult is, in the pieces the script says out loud.
 *
 * A whole hour drops its ":00" because "eleven zero zero PM" is not how anyone
 * says it. An unknown timezone falls back to UTC rather than throwing: a bad
 * displayTimezone must not be the thing that stops a confirmation call.
 *
 * Exported because the conversational call hands the same words to the model as
 * appointment context: the family should hear the slot described one way, in
 * the opening and in every answer after it.
 */
export function describeConsultSlot(startAt: Date, timeZone: string): ConsultSlotWords {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(startAt);
  } catch {
    zone = 'UTC';
  }

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).formatToParts(startAt);
  const datePick = (type: string) => dateParts.find((part) => part.type === type)?.value ?? '';

  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(startAt);
  const timePick = (type: string) => timeParts.find((part) => part.type === type)?.value ?? '';
  const minute = timePick('minute');

  const meridiem = timePick('dayPeriod').toUpperCase();
  const clock =
    minute === '00'
      ? `${timePick('hour')} ${meridiem}`
      : `${timePick('hour')}:${minute} ${meridiem}`;
  const weekday = datePick('weekday');
  const spokenZone = zoneName(startAt, zone);

  return {
    weekday,
    zone: spokenZone,
    full:
      `${weekday}, ${datePick('month')} ${ordinal(Number(datePick('day')))}, ` +
      `at ${clock} ${spokenZone}`,
  };
}

/**
 * Every line of the call.
 *
 * Written to be spoken, not read. The tells this wording exists to avoid, all of
 * which were in the version before it: "I see that you booked", which is someone
 * reading a screen aloud; "I am calling to confirm", which nobody says without
 * the contraction; and "Is that accurate?", which asks about a Friday in a word
 * reserved for data. The register matches the closing lines, so the call sounds
 * like one person rather than two scripts.
 *
 * The keypad is never mentioned on any line. `<Gather>` accepts digits whether or
 * not they are announced, so a family who presses 1 is still heard; saying "press
 * 1 for yes" is what makes a call sound like a phone menu rather than a person.
 *
 * No SSML anywhere - a `<break/>` would have to survive XML escaping on the
 * fallback path, and would be read aloud as markup by the other. Pacing comes
 * from the punctuation, which the speech engine honours as breath.
 */
export function buildConsultCallLines(input: ConsultCallScriptInput): ConsultCallScript {
  const caller = input.callerName ?? DEFAULT_CALLER;
  const company = input.companyName ?? DEFAULT_COMPANY;
  const when = describeConsultSlot(input.startAt, input.timeZone);
  // ", which is a video call on Zoom" - or nothing at all when we do not know.
  const format = input.format?.trim() ? `, which is ${input.format.trim()}` : '';

  return {
    /*
     * Everything a family needs in one breath: who is calling, from where, the
     * day, the time in their own zone, how the consult happens, and the question.
     *
     * Self-contained on purpose. The opening plays inside a <Gather>, so a family
     * who says "hello?" over it can end the turn before they have taken any of it
     * in - and the answer to that is a first line worth catching, plus the
     * first-turn rule in the conversation prompt that restates all of this when
     * the caller's first words show they did not hear it.
     */
    ask:
      `Hi, this is ${caller} from ${company}. ` +
      `I'm just calling about the consult you booked with us — ${when.full}${format}. ` +
      'Does that still work for you?',
    // Says the whole slot again, not just the weekday. Whoever needs a reprompt
    // is usually someone who did not catch the details the first time - a clipped
    // line, a noisy room, mid-conversation with someone else - and asking again
    // with LESS information than the first attempt helps none of them.
    reprompt: `Sorry — the consult is ${when.full}. Does that still work?`,
    confirmed: `Perfect, see you ${when.weekday}!`,
    declined: 'No problem — someone will reach out. Take care!',
    // No promise of a follow-up, because there is nobody to follow up with: this
    // branch means we reached a stranger. Staff get a `wrong_number` result and
    // fix the phone on the booking.
    wrongNumber: "Oh — sorry, I think I've got the wrong number. Have a good day!",
    // Said to someone walking off to find their spouse or their calendar. Short
    // on purpose: they are already moving, and anything longer plays to an empty
    // room. The call then listens for twenty seconds rather than six.
    holdOn: 'Of course — take your time.',
    noResponse: "No worries — we'll follow up. Take care!",
  };
}

/** The lines a conversational call has recorded before it dials. */
export type ConversationalCallLines = Pick<ConsultCallScript, 'ask' | 'reprompt' | 'noResponse'>;

/**
 * What a conversational call has on tape before the phone rings.
 *
 * Only the opening is scripted: everything after it is said by the model, in
 * words chosen for whatever the family actually said, and synthesized as the
 * call goes. Two fixed lines ride along for the moments the model cannot answer
 * - a timeout, a bad response - so the call still has a voice when its brain
 * does not. They are stored under the `reprompt` and `noResponse` keys rather
 * than new ones, because those are the roles they play: a request to try again,
 * and a polite way out. Adding line names would ripple through the document
 * schema and the tab for two sentences.
 *
 * Neither fallback names the slot. The scripted reprompt repeats the whole
 * booking because a scripted call has nothing else to say; here the model has
 * usually said something specific already, and "sorry, could you say that
 * again?" is what a person says when they missed a sentence.
 */
export function buildConversationalCallLines(
  input: ConsultCallScriptInput,
): ConversationalCallLines {
  return {
    ask: buildConsultCallLines(input).ask,
    reprompt: 'Sorry — could you say that again?',
    noResponse:
      "Sorry — I'm having trouble hearing you. Someone from the team will follow up. Take care!",
  };
}

/**
 * The whole call as one string, stored on the call document.
 *
 * Kept so that auditing a misread answer still means reading one field and
 * seeing everything the family could have heard, in order. A conversational
 * call stores only its scripted lines here; what the model said lives on the
 * turns.
 */
export function buildConsultCallTranscript(lines: Partial<ConsultCallScript>): string {
  return CONSULT_CALL_LINES.map((line) => lines[line])
    .filter((text): text is string => Boolean(text))
    .join(' ');
}
