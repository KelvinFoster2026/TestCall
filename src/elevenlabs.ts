import { createHash } from 'node:crypto';
import { config } from './config.js';
import { callAudioExists, generateSignedUrl, uploadCallAudio } from './s3.js';

/**
 * ElevenLabs text-to-speech, which is what gives the call a real voice.
 *
 * Never throws: a dead key, a bad voice id or a timeout must degrade to Twilio's
 * own <Say> rather than stop the call.
 *
 * Unlike a hosted-audio vendor, ElevenLabs returns raw mp3 bytes, so this stores
 * the result in S3 and hands back a presigned URL - Twilio can only <Play> a URL.
 */

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * The streaming endpoint, used even though we want the whole file.
 *
 * The plain endpoint generates the entire clip before it answers at all. The
 * `/stream` endpoint starts sending bytes as it generates them, and because a
 * chunked response finishes when the last chunk lands rather than when the
 * server decides to reply, the COMPLETE clip arrives sooner - measured on the
 * reply "Of course, what's your question?":
 *
 *   plain endpoint      first byte 527 ms   complete 532 ms
 *   /stream endpoint    first byte 210 ms   complete 282 ms
 *
 * That is 250 ms off every spoken line, for a one-word change to a URL and no
 * change at all to the audio: same voice, same model, same settings, same bytes.
 *
 * Deliberately WITHOUT `optimize_streaming_latency`. Level 4 shaved a further
 * 39 ms and turns off the text normaliser, which is what reads "12 PM" as
 * "twelve PM". This call says times out loud on most turns, so 39 ms is not
 * worth risking how they are pronounced.
 */
const STREAM_SUFFIX = '/stream';

/**
 * Phone audio is 8kHz, so 44.1kHz/128 buys nothing a caller can hear and makes
 * Twilio wait longer to fetch the file when the call connects.
 *
 * Also why this is not ulaw_8000, which would save Twilio a transcode: the same
 * line is 12,260 bytes as ulaw against 7,882 as mp3, and Twilio has to download
 * the whole file before it plays a sound of it.
 */
const OUTPUT_FORMAT = 'mp3_22050_32';

// Synthesis happens while someone waits on a button press, so it fails fast.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Long enough that a redial, or replaying the call from the page, still
 * resolves. Twilio itself fetches within seconds of the call connecting.
 */
const SIGNED_URL_TTL_SECONDS = 86400;

/**
 * How many clips may be in flight at once.
 *
 * ElevenLabs caps CONCURRENT requests by plan - 2 on Free, 3 on Starter, 5 on
 * Creator - and answers the excess with a 429 rather than queueing it. A call
 * needs several clips, so firing them all at once put the opening in the real
 * voice and dropped the closing lines to Twilio's, which is exactly what it
 * sounds like on the phone: a person asks the question and a robot says goodbye.
 *
 * Two is the floor across plans. It costs about a second on the very first dial
 * and nothing after that, since the fixed lines are then served from storage.
 */
const SYNTHESIS_CONCURRENCY = 2;

/**
 * Speaking rate when none is configured, or the configured one is unusable.
 *
 * Below 1 on purpose: the stock rate reads a confirmation at presenter pace,
 * which is fine on a landing page and too fast on a phone, where the listener
 * has no text to follow and has just been surprised by a ringing handset.
 */
const DEFAULT_SPEED = 0.9;

/** Worth one more try: a concurrency rejection or a blip, not a bad key. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 750;

export interface SynthesizeSpeechInput {
  text: string;
  /** Names the line in the logs, so a failing turn is identifiable. */
  label?: string;
  /** Overrides the configured voice. */
  voiceId?: string;
  /**
   * Reuse a clip of this exact text if one was already stored.
   *
   * Only for lines that are the same on every call - the reprompt and the
   * closes. A line carrying a date must not be cached, and the key is
   * content-addressed anyway, so a changed script can never serve stale audio:
   * different words are a different key.
   */
  cacheable?: boolean;
}

export interface SynthesizeSpeechResult {
  ok: boolean;
  audioUrl?: string;
  requestId?: string;
  error?: string;
  /** True when the clip was served from storage without calling the API. */
  cached?: boolean;
}

let warnedMissingCreds = false;

export function isElevenLabsConfigured(): boolean {
  return Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId);
}

/**
 * Synthesize several lines at once, keyed however the caller keyed them.
 *
 * Run in parallel, not in sequence: someone is waiting on a button press, and
 * sequential round trips would turn a one-second wait into several. Each line
 * settles independently, so one failure costs that line its voice and nothing
 * else.
 */
export async function synthesizeMany<K extends string>(
  lines: Array<{ key: K; text: string; cacheable?: boolean; voiceId?: string }>,
): Promise<Record<K, SynthesizeSpeechResult>> {
  const results = {} as Record<K, SynthesizeSpeechResult>;
  const queue = [...lines];

  // A fixed pool rather than Promise.all over the whole list: see
  // SYNTHESIS_CONCURRENCY. Each line still settles independently.
  const worker = async () => {
    for (let line = queue.shift(); line; line = queue.shift()) {
      results[line.key] = await synthesizeSpeech({ ...line, label: line.key });
    }
  };

  await Promise.all(Array.from({ length: Math.min(SYNTHESIS_CONCURRENCY, lines.length) }, worker));
  return results;
}

export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
): Promise<SynthesizeSpeechResult> {
  const apiKey = config.elevenLabs.apiKey;
  const voiceId = input.voiceId || config.elevenLabs.voiceId;

  if (!apiKey || !voiceId) {
    if (!warnedMissingCreds) {
      console.warn('ElevenLabs is not configured; falling back to the spoken voice');
      warnedMissingCreds = true;
    }
    return { ok: false, error: 'ElevenLabs is not configured' };
  }

  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, error: 'Missing text to synthesize' };

  const modelId = config.elevenLabs.modelId;
  // Clamped to what the API accepts, so a typo in the env slows the voice down
  // rather than failing every call. NaN is handled in config, because Math.max
  // propagates it and JSON.stringify would then send `speed: null` and 422.
  const configuredSpeed = config.elevenLabs.speed;
  const speed = Number.isFinite(configuredSpeed)
    ? Math.min(1.2, Math.max(0.7, configuredSpeed))
    : DEFAULT_SPEED;

  // Content-addressed, so the key changes the moment the wording, the voice or
  // the model does. A cached hit is the same bytes the API would have returned -
  // which is also why pointing this at the production bucket is safe.
  const cacheKey = input.cacheable
    ? `consult-calls/audio/cached/${createHash('sha256')
        .update(`${voiceId}:${modelId}:${speed}:${text}`)
        .digest('hex')}.mp3`
    : null;

  if (cacheKey && (await callAudioExists(cacheKey))) {
    const signed = await generateSignedUrl(cacheKey, SIGNED_URL_TTL_SECONDS);
    if (signed.success && signed.url) return { ok: true, audioUrl: signed.url, cached: true };
    // A key that exists but will not sign is not worth a second attempt at the
    // cache; fall through and synthesize as though it were a miss.
  }

  const named = input.label ? `${input.label}: ` : '';

  // One retry, and only for the statuses that mean "ask again": a rejected key
  // is rejected twice as fast as it is once.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await timedFetch(
        `${API_BASE}/${encodeURIComponent(voiceId)}${STREAM_SUFFIX}?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: modelId, voice_settings: { speed } }),
        },
      );

      if (!response.ok) {
        const error = await readError(response);
        if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) {
          console.warn(`ElevenLabs ${named}${error}; retrying once`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        console.warn(`ElevenLabs ${named}synthesis failed: ${error}`);
        return { ok: false, error };
      }

      const audio = Buffer.from(await response.arrayBuffer());
      const requestId = response.headers?.get('request-id') ?? undefined;
      return await store(audio, requestId, cacheKey);
    } catch (error) {
      const message = (error as Error).message;
      if (attempt === 0) {
        console.warn(`ElevenLabs ${named}errored: ${message}; retrying once`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      console.warn(`ElevenLabs ${named}synthesis errored: ${message}`);
      return { ok: false, error: message };
    }
  }
}

/** Park the mp3 in S3 and presign it, because <Play> needs a URL, not bytes. */
async function store(
  audio: Buffer,
  requestId?: string,
  cacheKey?: string | null,
): Promise<SynthesizeSpeechResult> {
  const upload = await uploadCallAudio(audio, cacheKey ?? undefined);
  if (!upload.success || !upload.key) {
    const error = upload.error ?? 'Failed to store the call audio';
    console.warn(`ElevenLabs audio upload failed: ${error}`);
    return { ok: false, error };
  }

  const signed = await generateSignedUrl(upload.key, SIGNED_URL_TTL_SECONDS);
  if (!signed.success || !signed.url) {
    const error = signed.error ?? 'Failed to sign the call audio url';
    console.warn(`ElevenLabs audio signing failed: ${error}`);
    return { ok: false, error };
  }

  return { ok: true, audioUrl: signed.url, requestId };
}

/** The API reports failures as JSON even though success is raw audio. */
async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: { message?: string } | string };
    const detail = payload.detail;
    if (typeof detail === 'string') return detail;
    if (detail?.message) return detail.message;
  } catch {
    // Falls through to the status line below.
  }
  return `ElevenLabs speech failed with status ${response.status}`;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
