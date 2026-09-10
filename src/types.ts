/**
 * The call record and its vocabularies, lifted out of the Mongoose document.
 *
 * The original of this file (`consultCall-document.interface.ts`) imports
 * mongoose for `Document` and `Types.ObjectId`, which is the only reason it is
 * not copied here verbatim like the utils are. Everything that matters - the
 * status, result and voice-provider vocabularies, and the shape of a turn - is
 * unchanged, because the TwiML builder, the prompt and the conversation loop all
 * speak them.
 */

/**
 * What decided a turn. On a conversational call this records only what KIND of
 * input arrived, which is what keeps the "a keypress proves a human was on the
 * line" rule working without a classifier.
 *
 * Inlined from `consultCallAnswer.util.ts`, whose 300 lines of phrase matching
 * belong to the scripted call this rig does not run. 'confidence' is unreachable
 * here and kept only so the union matches the source.
 */
export type ConsultCallAnswerSource = 'digits' | 'speech' | 'confidence' | 'none';

/** Scripted-call classification. Always null here; the model classifies nothing. */
export type ConsultCallAnswer =
  | 'confirmed'
  | 'declined'
  | 'wrong_number'
  | 'repeat'
  | 'wait'
  | 'unclear';

export const CONSULT_CALL_VOICE_PROVIDERS = ['elevenlabs', 'twilio-say'] as const;
export type ConsultCallVoiceProvider = (typeof CONSULT_CALL_VOICE_PROVIDERS)[number];

/**
 * One thing the caller said, and what we made of it.
 *
 * Written on every gather POST including the ones that decide nothing, because
 * the turns that decide nothing are where the interesting failures live: a
 * greeting mistaken for an answer, a silence that should have been a voicemail.
 */
export interface ConsultCallTurn {
  /** 'converse' on every turn here. Read by the transcript filter in `converse`. */
  stage: string;
  at: Date;
  /** Exactly what Twilio transcribed. Null when it heard nothing. */
  speechResult: string | null;
  /**
   * Twilio's confidence in that transcript, 0 to 1. Null when it sent no score,
   * which some speech models do not - and which is not the same as being unsure.
   */
  confidence: number | null;
  digits: string | null;
  /** Always null on a conversational turn: the model reads the sentence and answers it. */
  answer: ConsultCallAnswer | null;
  /** Always null here. Kept so the turn shape matches the source. */
  matchedPhrase: string | null;
  /** Load-bearing: the consecutive-silence counter reads this. */
  source: ConsultCallAnswerSource | null;
  /** What the caller heard in reply. */
  reply: string | null;
  /** The model's few-word reading of the turn, for the log. */
  note: string | null;
  /**
   * Which voice the reply played in. A reply is synthesized mid-call against a
   * deadline, so one line can miss the real voice while the call around it does
   * not; the page marks the line rather than the call.
   */
  replyVoice: ConsultCallVoiceProvider | null;
}

/** Our own lifecycle, not Twilio's vocabulary. Twilio's `busy` and `no-answer` are RESULTS. */
export const CONSULT_CALL_STATUSES = [
  'queued',
  'dialing',
  'ringing',
  'in_progress',
  'completed',
  'failed',
] as const;
export type ConsultCallStatus = (typeof CONSULT_CALL_STATUSES)[number];

/** Nothing more will happen to a call in one of these. */
export const CONSULT_CALL_TERMINAL_STATUSES = ['completed', 'failed'] as const;

/**
 * What the call actually achieved.
 *
 * `no_response` and `no_answer` are separate on purpose: the first means someone
 * picked up and said nothing recognisable, the second means the phone was never
 * answered. They lead to different follow-ups.
 */
export const CONSULT_CALL_RESULTS = [
  'confirmed',
  'declined',
  'wrong_number',
  'voicemail',
  'no_response',
  'no_answer',
  'busy',
  'failed',
] as const;
export type ConsultCallResult = (typeof CONSULT_CALL_RESULTS)[number];

export function isTerminalConsultCallStatus(status: ConsultCallStatus): boolean {
  return (CONSULT_CALL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The lines of the call, named.
 *
 * Duplicated from `script.util.ts` rather than imported, so that `script.util.ts`
 * stays a leaf with no imports at all - which is what lets it be copied verbatim
 * and transpiled standalone by the verify script.
 */
export type ConsultCallLineName =
  | 'ask'
  | 'reprompt'
  | 'confirmed'
  | 'declined'
  | 'wrongNumber'
  | 'holdOn'
  | 'noResponse';

/**
 * The stored form of the appointment context.
 *
 * Identical to `ConsultCallAppointmentContext` except that `startAt` may come
 * back as a string. In memory it is always a Date, but the field is round-tripped
 * through JSON by the admin API, and `conversationContextOf` re-hydrates it
 * either way - which is exactly what the original does for Mongo's mixed field.
 */
export interface ConsultCallAppointmentContextRecord {
  organizationName: string;
  callerName: string;
  familyName: string | null;
  startAt: Date | string;
  timeZone: string;
  purpose: string;
  durationMinutes: number | null;
  format: string | null;
  advisorName: string | null;
  extraFacts: string[];
}

/**
 * A placed test call, as the store holds it.
 *
 * Twelve fields lighter than the `consult_calls` schema, and every one of them
 * is dropped because it is provably dead on this path rather than merely unused:
 * `tenant` (one tenant here), `bookingId` / `advisorId` / `triggeredBy` (a test
 * call belongs to no booking and writes no confirmation), `attempts` (the
 * scripted reprompt counter), the top-level `speechResult` / `digits` (written by
 * settle, read by nothing - the turns carry them), `confirmationWritten` and
 * `confirmationSyncError` (permanently false and null once writeConfirmation is
 * gone), and `outsideHoursOverride` (written, never read).
 */
export interface TestCall {
  id: string;
  /** Opaque, single-purpose, in every Twilio-facing URL. */
  webhookToken: string;
  toPhone: string;
  createdAt: Date;

  status: ConsultCallStatus;
  /** Always true. The model is told, and it changes what it may promise. */
  isTest: boolean;
  /** Always true. On the record rather than the URL, so a forged webhook cannot move paths. */
  conversational: boolean;

  /**
   * What the model is allowed to know, frozen at dial time.
   *
   * Frozen because the sample slot is generated from the clock: rebuilt per turn,
   * a call placed before midnight would describe a different day after it.
   */
  conversationContext: ConsultCallAppointmentContextRecord | null;

  /** Every line the call was placed with, and the clip that says each one. */
  scriptLines: Partial<Record<ConsultCallLineName, string>>;
  audioUrls: Partial<Record<ConsultCallLineName, string | null>>;
  /** Every line joined in order, so one field audits the whole thing. */
  scriptText: string;
  audioUrl: string | null;
  voiceProvider: ConsultCallVoiceProvider;

  twilioCallSid: string | null;
  /** Twilio's AMD verdict: human, machine_start, machine_end_beep, fax, unknown. */
  answeredBy: string | null;
  result: ConsultCallResult | null;
  resultAt: Date | null;
  durationSeconds: number | null;
  /** The model's closing note for the log, once the call has ended. */
  summary: string | null;
  error: string | null;
  /** The ElevenLabs request id of the first synthesized line, for support tickets. */
  voiceRequestId: string | null;

  turns: ConsultCallTurn[];
}
