import 'dotenv/config';

/**
 * Every setting the call needs, read once at startup.
 *
 * This replaces Nest's ConfigService. The defaults are copied from the source's
 * `configuration.ts` rather than re-chosen, including the two that surprise
 * people (see `enabled` and `requireRealVoice` below), because a rig that
 * behaves differently from production is not a rig.
 */

const str = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();

const num = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
};

export const config = {
  port: num('PORT', 3000),

  call: {
    /**
     * The kill switch, and it defaults to OFF.
     *
     * Copied from production, where a feature that dials real families is opt-in
     * per deployment. The first thing a new checkout does is refuse to place a
     * call with "Confirmation calling is turned off", which reads as a broken app
     * if you do not know this. Set CONSULT_CALL_ENABLED=true.
     */
    enabled: str('CONSULT_CALL_ENABLED') === 'true',

    /**
     * The public https origin Twilio posts back to - your tunnel, in practice.
     *
     * It has to match what Twilio actually hit, character for character, because
     * signature validation rebuilds the signed URL from this plus the request
     * path. A trailing slash or the wrong subdomain 403s every webhook.
     */
    publicWebhookBaseUrl: str('PUBLIC_WEBHOOK_BASE_URL').replace(/\/+$/, ''),

    /** Inclusive start, exclusive end, on the callee's clock. */
    hoursStart: num('CONSULT_CALL_HOURS_START', 8),
    hoursEnd: num('CONSULT_CALL_HOURS_END', 21),

    /**
     * Whether a call may go out in Twilio's stock voice. Defaults to REFUSING.
     *
     * Only the literal string 'false' turns it off, matching the source. With
     * ElevenLabs unconfigured this means the dial is refused outright rather than
     * quietly degrading to Polly - deliberate, because a stock robot reading a
     * script that introduces itself by name is worse than no call at all.
     */
    requireRealVoice: str('CONSULT_CALL_REQUIRE_REAL_VOICE') !== 'false',

    /** How long a consult runs, said out loud when the caller asks. Null = "not sure". */
    durationMinutes: num('CONSULT_DURATION_MINUTES', 60),

    conversationModel: str('CONSULT_CALL_CONVERSATION_MODEL'),
    conversationEffort: str('CONSULT_CALL_CONVERSATION_EFFORT', 'low'),
    conversationReplyTimeoutMs: num('CONSULT_CALL_CONVERSATION_REPLY_TIMEOUT_MS', 8000),
    conversationVoiceTimeoutMs: num('CONSULT_CALL_CONVERSATION_VOICE_TIMEOUT_MS', 5000),
    conversationMaxTurns: num('CONSULT_CALL_CONVERSATION_MAX_TURNS', 14),
    /** Seconds of silence that end a caller's turn, or 'auto' for Twilio's own model. */
    conversationSpeechTimeout: str('CONSULT_CALL_CONVERSATION_SPEECH_TIMEOUT', '1'),
  },

  openai: {
    apiKey: str('OPENAI_API_KEY'),
    responsesModel: str('OPENAI_RESPONSES_MODEL', 'gpt-5.4'),
    /** Blank falls through to the SDK's own default. */
    baseUrl: str('OPENAI_BASE_URL'),
    timeoutMs: num('OPENAI_TIMEOUT_MS', 30000),
  },

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    /** Also the HMAC key every inbound webhook is checked against. */
    authToken: str('TWILIO_AUTH_TOKEN'),
    voiceFromNumber: str('TWILIO_VOICE_FROM_NUMBER'),
    fromNumber: str('TWILIO_PHONE_NUMBER'),
  },

  elevenLabs: {
    apiKey: str('ELEVENLABS_API_KEY'),
    voiceId: str('ELEVENLABS_VOICE_ID'),
    modelId: str('ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'),
    /** Clamped to 0.7-1.2 at the call site, so a typo slows the voice rather than 422ing. */
    speed: num('ELEVENLABS_SPEED', 0.9),
  },

  s3: {
    region: str('AWS_REGION'),
    bucket: str('AWS_S3_BUCKET'),
    accessKeyId: str('AWS_ACCESS_KEY_ID'),
    secretAccessKey: str('AWS_SECRET_ACCESS_KEY'),
  },
} as const;

export type Config = typeof config;

/**
 * One error type for everything the routes can refuse.
 *
 * Replaces BadRequestException / NotFoundException / ForbiddenException. The
 * message is written to be read by whoever pressed the button, because several
 * of them carry the only instruction that will fix the problem.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
