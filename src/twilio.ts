import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Twilio's REST API, over plain fetch.
 *
 * No `twilio` npm package, matching the source: the three things this needs -
 * create a call, end a call, check a signature - are one form POST, one form
 * POST and twenty lines of HMAC. The SMS half of the original service is gone,
 * since nothing here sends messages.
 */

const TWILIO_BASE_URL = 'https://api.twilio.com/2010-04-01';
const REQUEST_TIMEOUT_MS = 8000;

export interface PlaceCallInput {
  to: string;
  /** https URL Twilio fetches TwiML from when the call is answered. */
  url: string;
  from?: string;
  statusCallback?: string;
  /**
   * Where Twilio goes when the TwiML request itself fails.
   *
   * Requested when the primary url cannot be fetched or executed - a request
   * that times out, a network blip, a process that is restarting. Without one,
   * Twilio plays "an application error has occurred" at the recipient and hangs
   * up. Must be https, like the primary; anything else is dropped rather than
   * sent, since a bad fallback is worse than none.
   */
  fallbackUrl?: string;
  /** Answering-machine detection. Synchronous unless `asyncAmdCallback` is given. */
  machineDetection?: boolean;
  /**
   * Run detection ASYNCHRONOUSLY, posting the verdict here instead of holding
   * the TwiML request for it.
   *
   * Synchronous AMD makes Twilio wait until it has decided human-or-machine
   * before it will even ask what to say - three to five seconds during which the
   * person who just picked up hears nothing at all. With a callback, the call
   * starts talking the instant it is answered and the verdict arrives after.
   */
  asyncAmdCallback?: string;
  /** Seconds to let it ring. Twilio's default is 60, a long time to hold a row open. */
  timeoutSeconds?: number;
}

export interface PlaceCallResult {
  ok: boolean;
  sid?: string;
  status?: string;
  error?: string;
}

/** Whether an outbound call could be placed at all. Drives the page's "not configured" panel. */
export function isVoiceConfigured(): boolean {
  const from = config.twilio.voiceFromNumber || config.twilio.fromNumber;
  return Boolean(config.twilio.accountSid && config.twilio.authToken && from);
}

/**
 * Places one outbound call. Never throws - returns a structured result so the
 * caller can record the failure on the call record rather than 500 at whoever
 * pressed the button.
 */
export async function placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
  const { accountSid, authToken } = config.twilio;
  const fromNumber = input.from || config.twilio.voiceFromNumber || config.twilio.fromNumber;

  if (!accountSid || !authToken || !fromNumber) {
    console.warn('Twilio voice is not configured; skipping outbound call');
    return { ok: false, error: 'Twilio voice is not configured' };
  }

  const recipient = (input.to ?? '').trim();
  if (!recipient) return { ok: false, error: 'Missing recipient phone number' };

  // Twilio will not fetch TwiML over plain http, and neither should we ask it to:
  // that document decides what the caller hears.
  const twimlUrl = (input.url ?? '').trim();
  if (!twimlUrl.startsWith('https://')) {
    return { ok: false, error: 'TwiML url must be https' };
  }

  const form = new URLSearchParams();
  form.append('To', recipient);
  form.append('From', fromNumber);
  form.append('Url', twimlUrl);
  form.append('Method', 'POST');
  if (input.statusCallback?.startsWith('https://')) {
    form.append('StatusCallback', input.statusCallback);
    form.append('StatusCallbackMethod', 'POST');
    for (const event of ['initiated', 'ringing', 'answered', 'completed']) {
      form.append('StatusCallbackEvent', event);
    }
  }
  if (input.machineDetection) {
    form.append('MachineDetection', 'Enable');
    if (input.asyncAmdCallback?.startsWith('https://')) {
      // The TwiML request goes out immediately and the verdict follows, so the
      // callee hears the call start rather than several seconds of silence.
      form.append('AsyncAmd', 'true');
      form.append('AsyncAmdStatusCallback', input.asyncAmdCallback);
      form.append('AsyncAmdStatusCallbackMethod', 'POST');
    } else {
      form.append('AsyncAmd', 'false');
    }
  }
  if (input.fallbackUrl?.startsWith('https://')) {
    form.append('FallbackUrl', input.fallbackUrl);
    form.append('FallbackMethod', 'POST');
  }
  if (input.timeoutSeconds) form.append('Timeout', String(input.timeoutSeconds));

  const url = `${TWILIO_BASE_URL}/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const response = await timedFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
    };

    if (!response.ok) {
      const error = payload.message || `Twilio call failed with status ${response.status}`;
      console.warn(`Twilio call failed for ${recipient}: ${error}`);
      return { ok: false, error };
    }

    return { ok: true, sid: payload.sid, status: payload.status || 'queued' };
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`Twilio call errored for ${recipient}: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Hang up a call that is already up.
 *
 * Needed because asynchronous answering-machine detection returns its verdict
 * after the call is already talking: by the time we learn it is a voicemail, the
 * only way to stop is to end the call from this side.
 */
export async function endCall(callSid: string): Promise<{ ok: boolean; error?: string }> {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken) return { ok: false, error: 'Twilio voice is not configured' };
  if (!callSid) return { ok: false, error: 'Missing call sid' };

  const url =
    `${TWILIO_BASE_URL}/Accounts/${encodeURIComponent(accountSid)}` +
    `/Calls/${encodeURIComponent(callSid)}.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const response = await timedFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }).toString(),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      return { ok: false, error: payload.message ?? `Twilio returned ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Twilio's request signature: HMAC-SHA1, keyed by the auth token, over the full
 * request URL with every POST parameter appended as key-then-value, sorted by
 * key. This is what proves an unauthenticated webhook really came from Twilio.
 *
 * Note the `?? ''`: Twilio folds empty-valued parameters into the hash as the
 * key plus nothing. Anything that strips empty values out of the body before
 * this sees it - a schema validator, a "clean the input" helper - breaks every
 * signature, which is why the route hands over `request.body` untouched.
 */
export function validateSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const authToken = config.twilio.authToken;
  if (!authToken || !input.signature) return false;

  const data = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => acc + key + String(input.params[key] ?? ''), input.url);

  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which a forged signature can force.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Wraps fetch with an AbortController to enforce the request timeout.
async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
