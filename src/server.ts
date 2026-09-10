import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as calls from './call.service.js';
import { AppError, config } from './config.js';
import { isConversationConfigured } from './conversation.service.js';
import { isElevenLabsConfigured } from './elevenlabs.js';
import { isS3Configured } from './s3.js';
import { startSweep } from './store.js';
import { isVoiceConfigured, validateSignature } from './twilio.js';
import { buildHangupTwiml } from './util/twiml.util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/*
 * Twilio posts application/x-www-form-urlencoded, and the parser has to run
 * before the routes on ALL of them - including /amd, /status and /fallback,
 * which return nothing but still verify their signature. Without a parsed body
 * the HMAC covers only the URL and every webhook 403s.
 *
 * `extended: false` where Nest used `true`. The two differ only for bracketed
 * keys and qs's depth limits, and every Twilio voice parameter is a flat
 * identifier, so they produce the identical object here.
 */
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ------------------------------------------------------------ Twilio webhooks

const webhooks = express.Router();

/**
 * Hands a rejected async handler to Express.
 *
 * Express 4 catches a synchronous throw but not a rejected promise: without
 * this, `verify` throwing inside an async route leaves the request hanging
 * until Twilio's own timeout, which is the worst of both worlds - no 403, and
 * an "application error" recording after fifteen seconds of silence.
 */
type AsyncHandler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction) =>
    handler(req, res).catch(next);

/**
 * Proves the request really came from Twilio, and returns its form body.
 *
 * The URL is rebuilt from the configured PUBLIC origin plus the request path,
 * never from the Host header: behind a tunnel or a load balancer Host is the
 * internal name, while Twilio signed the public one. Validating against Host
 * would reject every genuine request.
 *
 * `req.originalUrl` rather than `req.url`, because this router is mounted and
 * `req.url` has lost the prefix. `req.baseUrl + req.path` would lose the query
 * string instead.
 *
 * The body is handed to the HMAC untouched. Twilio folds empty-valued
 * parameters in as the key plus nothing, so anything that strips empty strings
 * out first breaks every signature.
 */
function verify(req: Request): Record<string, string> {
  const body = (req.body ?? {}) as Record<string, string>;
  const url = `${config.call.publicWebhookBaseUrl}${req.originalUrl}`;
  const signature = String(req.headers['x-twilio-signature'] ?? '');

  if (!validateSignature({ url, params: body, signature })) {
    console.warn(`Rejected an unsigned Twilio webhook for ${req.originalUrl}`);
    throw new AppError('Invalid signature.', 403);
  }
  return body;
}

/**
 * Produces a TwiML document, or hangs up quietly if we cannot.
 *
 * Twilio has no graceful default for a webhook that does not return TwiML. A
 * 500 from a bug, a 404 from an unknown token, an unhandled throw mid-restart -
 * all of them make Twilio play its own recording: "An application error has
 * occurred. Goodbye." Someone who has just said "yes" hears a robot announce
 * that this company's systems are broken.
 *
 * A silent hangup is strictly better: it reads as a dropped call, which is
 * ordinary and forgivable, and the stale sweep marks the record.
 *
 * Only wraps the handler, never `verify` - an unsigned request is a security
 * boundary and must still be refused outright rather than handed a document.
 */
async function speak(
  res: Response,
  token: string,
  route: string,
  handler: () => Promise<string>,
): Promise<void> {
  let xml: string;
  try {
    xml = await handler();
  } catch (error) {
    console.error(
      `Hung up on ${token} because the ${route} webhook failed: ${(error as Error).message}`,
    );
    xml = buildHangupTwiml();
  }
  res.status(200).type('text/xml').send(xml);
}

webhooks.post('/:token/twiml', wrap(async (req, res) => {
  const body = verify(req);
  const token = req.params.token;
  await speak(res, token, 'twiml', () =>
    calls.handleTwiml({ token, answeredBy: body.AnsweredBy ?? null }),
  );
}));

webhooks.post('/:token/gather', wrap(async (req, res) => {
  const body = verify(req);
  const token = req.params.token;
  // Twilio sends Confidence as a form field, so it arrives as a string. An
  // unparseable or absent one becomes null rather than NaN: "no score sent" is
  // a real and common case on some speech models, and is not the same thing as
  // "the recogniser was unsure".
  const confidence = Number(body.Confidence);
  await speak(res, token, 'gather', () =>
    calls.handleGather({
      token,
      digits: body.Digits ?? null,
      speechResult: body.SpeechResult ?? null,
      confidence: body.Confidence && Number.isFinite(confidence) ? confidence : null,
    }),
  );
}));

/**
 * The answering-machine verdict, which lands while the call is already talking.
 *
 * A separate route from /twiml because detection runs asynchronously: the TwiML
 * request no longer waits for it, which is what removed several seconds of
 * silence from the start of every call.
 */
webhooks.post('/:token/amd', wrap(async (req, res) => {
  const body = verify(req);
  try {
    await calls.handleAmd({ token: req.params.token, answeredBy: body.AnsweredBy ?? null });
  } catch (error) {
    // A 500 here only makes Twilio retry a callback that cannot now succeed.
    console.warn(`AMD callback failed for ${req.params.token}: ${(error as Error).message}`);
  }
  res.status(200).type('text/xml').send('');
}));

webhooks.post('/:token/status', wrap(async (req, res) => {
  const body = verify(req);
  const raw = body.CallDuration;
  const duration = Number(raw);
  try {
    await calls.handleStatus({
      token: req.params.token,
      callStatus: body.CallStatus ?? '',
      durationSeconds: raw && Number.isFinite(duration) ? duration : null,
    });
  } catch (error) {
    // Swallowed; the stale sweep in getCall covers the missing update.
    console.warn(`Status callback failed for ${req.params.token}: ${(error as Error).message}`);
  }
  res.status(200).type('text/xml').send('');
}));

/**
 * Twilio's last resort: requested when the primary TwiML url could not be
 * fetched or executed at all.
 *
 * Touches NOTHING. No lookup, no service call, no branch that can throw -
 * because by the time Twilio asks for this, something on our side has already
 * failed, and whatever that was is exactly what a lookup here would be likely to
 * hit. The one job is to return a valid document so the callee gets a dropped
 * call instead of "an application error has occurred".
 */
webhooks.post('/:token/fallback', (req, res) => {
  const body = verify(req);
  console.error(
    `Twilio fell back on call ${req.params.token}: error ${body.ErrorCode ?? 'unknown'}`,
  );
  res.status(200).type('text/xml').send(buildHangupTwiml());
});

app.use('/api/v1/consults/calls', webhooks);

// -------------------------------------------------------------------- the API

const admin = express.Router();

/** Whether a call could be placed at all. Drives the page's setup panel. */
admin.get('/config', (_req, res) => {
  res.json({
    enabled: config.call.enabled,
    twilio: isVoiceConfigured(),
    openai: isConversationConfigured(),
    elevenLabs: isElevenLabsConfigured(),
    s3: isS3Configured(),
    publicWebhookBaseUrl: config.call.publicWebhookBaseUrl,
    requireRealVoice: config.call.requireRealVoice,
    hours: { start: config.call.hoursStart, end: config.call.hoursEnd },
  });
});

admin.get('/calls', (_req, res) => {
  res.json({ calls: calls.listCalls() });
});

// The literal routes are registered before the parameterised one, so `/calls`
// and `/config` are not swallowed by `/:callId`.
admin.post('/calls/test', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { toPhone?: unknown; overrideHours?: unknown };
    const toPhone = typeof body.toPhone === 'string' ? body.toPhone.trim() : '';
    if (!toPhone) throw new AppError('Enter a phone number to call.');
    // Accepts the boolean and the string, because a form post sends "true".
    const overrideHours = body.overrideHours === true || body.overrideHours === 'true';
    res.json(await calls.placeTestCall({ toPhone, overrideHours }));
  } catch (error) {
    next(error);
  }
});

admin.get('/calls/:callId', (req, res, next) => {
  try {
    const call = calls.getCall(req.params.callId);
    if (!call) throw new AppError('Unknown call.', 404);
    res.json(call);
  } catch (error) {
    next(error);
  }
});

app.use('/api/v1/consults/admin', admin);

// ---------------------------------------------------------------- the page

app.use(express.static(path.join(here, '..', 'public')));

// --------------------------------------------------------------- errors

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof AppError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  if (status >= 500) console.error(error);
  // `message` rather than a code: several of these carry the only instruction
  // that will fix the problem, and the page renders them verbatim.
  res.status(status).json({ message });
});

// ---------------------------------------------------------------- startup

startSweep();

app.listen(config.port, () => {
  console.log(`\nTestCall listening on http://localhost:${config.port}`);
  console.log(`  Twilio voice   ${isVoiceConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`  OpenAI         ${isConversationConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`  ElevenLabs     ${isElevenLabsConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`  S3             ${isS3Configured() ? 'configured' : 'NOT configured'}`);
  console.log(`  Calling        ${config.call.enabled ? 'enabled' : 'DISABLED (set CONSULT_CALL_ENABLED=true)'}`);
  console.log(
    `  Webhook base   ${config.call.publicWebhookBaseUrl || 'NOT set (run a tunnel and set PUBLIC_WEBHOOK_BASE_URL)'}\n`,
  );
});
