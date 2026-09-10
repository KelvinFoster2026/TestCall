/**
 * Preflight: proves every vendor works, without ringing a phone.
 *
 * Ported from the source's `verify-consult-calls.js`. It exists because the
 * failures worth catching all happen before the call connects - a dead
 * ElevenLabs key, a bucket that will not sign, a Twilio number that cannot make
 * voice calls - and finding them by dialing your own phone is a slow way to read
 * an error message.
 *
 * Adds an OPENAI_API_KEY check the original lacks: this rig refuses to dial
 * without the model, so an unset key is a hard failure here rather than a
 * degraded call.
 *
 *   npm run verify
 */
import { config } from '../src/config.js';
import { isElevenLabsConfigured, synthesizeSpeech } from '../src/elevenlabs.js';
import { isOpenAiConfigured, defaultModel } from '../src/openai.js';
import { isS3Configured } from '../src/s3.js';
import { buildConversationalCallLines } from '../src/util/script.util.js';
import { buildSampleConsultSlot } from '../src/util/sample.util.js';

const PASS = '  ok   ';
const FAIL = ' FAIL  ';

let failed = false;

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failed = true;
  console.log(`${ok ? PASS : FAIL} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('\nTestCall preflight\n');

  // ------------------------------------------------------------ configuration
  check(config.call.enabled, 'Calling enabled', config.call.enabled ? '' : 'set CONSULT_CALL_ENABLED=true');
  check(
    config.call.publicWebhookBaseUrl.startsWith('https://'),
    'Public webhook base URL',
    config.call.publicWebhookBaseUrl || 'unset — run a tunnel and set PUBLIC_WEBHOOK_BASE_URL',
  );
  check(isOpenAiConfigured(), 'OPENAI_API_KEY', isOpenAiConfigured() ? defaultModel() : 'unset');
  check(isS3Configured(), 'S3 bucket configured', config.s3.bucket || 'unset');
  check(isElevenLabsConfigured(), 'ElevenLabs configured', config.elevenLabs.voiceId || 'unset');

  // ------------------------------------------------------------------- Twilio
  const { accountSid, authToken } = config.twilio;
  const from = config.twilio.voiceFromNumber || config.twilio.fromNumber;
  if (!accountSid || !authToken || !from) {
    check(false, 'Twilio voice number', 'set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VOICE_FROM_NUMBER');
  } else {
    // Asks Twilio about the number itself: an SMS-only number places no calls,
    // and the error it gives at dial time does not say so clearly.
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}` +
      `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    try {
      const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      const payload = (await response.json()) as {
        incoming_phone_numbers?: Array<{ capabilities?: { voice?: boolean } }>;
        message?: string;
      };
      if (!response.ok) {
        check(false, 'Twilio voice number', payload.message ?? `HTTP ${response.status}`);
      } else {
        const number = payload.incoming_phone_numbers?.[0];
        if (!number) check(false, 'Twilio voice number', `${from} is not on this account`);
        else check(Boolean(number.capabilities?.voice), 'Twilio voice number', `${from} voice-capable`);
      }
    } catch (error) {
      check(false, 'Twilio voice number', (error as Error).message);
    }
  }

  // ------------------------------- ElevenLabs + S3, on the real lines
  if (isElevenLabsConfigured() && isS3Configured()) {
    const lines = buildConversationalCallLines({
      startAt: buildSampleConsultSlot(new Date(), 'America/New_York'),
      timeZone: 'America/New_York',
      format: 'a video call on Zoom',
    });
    for (const [key, text] of Object.entries(lines)) {
      const started = Date.now();
      // Only the fixed lines are cacheable; `ask` names a date and would only
      // ever miss.
      const result = await synthesizeSpeech({ text, label: key, cacheable: key !== 'ask' });
      const took = Date.now() - started;
      check(
        result.ok && Boolean(result.audioUrl),
        `Synthesize "${key}"`,
        result.ok ? `${took}ms${result.cached ? ' (cached)' : ''}` : (result.error ?? 'no audio'),
      );
    }
  } else {
    check(false, 'Synthesis', 'skipped: ElevenLabs or S3 is not configured');
  }

  console.log(
    failed
      ? '\nSomething above needs fixing before a call will work.\n'
      : '\nEverything checks out. Start the server and place a call.\n',
  );
  // exitCode rather than process.exit(): an abrupt exit while tsx's loader
  // thread is still live trips a libuv assertion on Windows. Letting Node
  // unwind on its own reports the same status without the noise.
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
