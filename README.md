# TestCall

A standalone rig for the AI confirmation call: it rings your phone, reads out a
sample appointment, and then has an actual conversation with you about it.

Twilio carries the line, the OpenAI Responses API writes each reply, ElevenLabs
speaks it. Lifted out of the LogoLife backend so the voice, the prompt and the
turn latency can be worked on without booting the platform.

## How the call actually works

There is no websocket and no realtime audio stream here, which is worth knowing
before reading the code. It is a plain TwiML request/response call:

1. We POST to Twilio's API to place the call, handing it four callback URLs.
2. On answer, Twilio fetches `/twiml` and gets one `<Gather>`: a two-second
   pause, the opening line as `<Play>`, then it listens.
3. You talk. **Twilio** transcribes it and POSTs the text to `/gather`.
4. That handler asks the model what to say next, gets back structured JSON,
   sends the words to ElevenLabs, stores the mp3 in S3, and answers with another
   `<Gather>` that plays it and listens again.
5. Repeat until the model closes the call, or a cap does.

Twilio abandons a webhook after roughly **fifteen seconds** and plays its own
error recording at you, so step 4 is the whole engineering problem. The main
trick: `say` is the first field in the reply schema, so synthesis starts the
moment that field closes mid-stream, while the rest of the JSON is still
arriving. The per-turn log line reports how much that overlap saved.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in — every key is commented
```

Twilio has to be able to reach you, so you need a public https origin:

```bash
ngrok http 3000
```

Put the https forwarding origin in `PUBLIC_WEBHOOK_BASE_URL`, **without a
trailing slash**, and restart. This one is worth getting exactly right:
signature validation rebuilds the signed URL from it, so a stale tunnel or an
extra slash makes every webhook 403 and the call hangs up in silence.

Then check the vendors without ringing anything:

```bash
npm run verify
```

## Running

```bash
npm start                 # place real calls with this
npm run dev               # watch mode — see the caveat
npm run build             # tsc
```

Open `http://localhost:3000` — the local address, not the tunnel. The tunnel is
for Twilio.

**Watch mode caveat:** calls are held in memory, so saving a file mid-call drops
it. The next webhook 404s and Twilio hangs up on you. Use `npm start` for a call
you care about.

## Two defaults that look like bugs

Both are copied from production rather than re-chosen, because a rig that
behaves differently from the real thing is not a rig.

- **`CONSULT_CALL_ENABLED` defaults to off.** Unset, placing a call fails with
  "Confirmation calling is turned off." A feature that dials real phones is
  opt-in per deployment.
- **`CONSULT_CALL_REQUIRE_REAL_VOICE` defaults to on.** With ElevenLabs
  unconfigured the dial is refused rather than degrading to Twilio's stock
  voice. A robot reading a script that introduces itself by name is worse than
  no call. Set it to `false` to hear the fallback path.

## What this does not do

It is the **test** path only. It is attached to no booking, writes no
confirmation and syncs nothing — whatever you say on the call, and whatever the
model concludes, nothing outside this process changes. The outcome is still
recorded so you can see what it decided.

## Layout

```
src/
  server.ts               express app, the five Twilio webhooks, the admin API
  call.service.ts         place / dial / answer / turn / settle
  conversation.service.ts one turn: the model and the voice, under deadlines
  openai.ts               streamed structured-output JSON
  elevenlabs.ts           text to mp3, with a content-addressed S3 cache
  twilio.ts               place, hang up, and validate the request signature
  s3.ts                   store the mp3, hand back a presigned URL
  store.ts                the in-memory call store
  config.ts               env -> typed config
  types.ts                statuses, results, the turn and call records
  util/                   copied verbatim from the source; see below
public/index.html         the page
scripts/verify.ts         preflight, no dialing
```

`src/util/` is copied byte-for-byte out of the original NestJS module — the
TwiML builder, the prompt, the script, the sample slot and the calling-hours
guard. They had no framework imports to begin with, and they hold most of the
reasoning worth preserving: why the opening pauses for two seconds, why a
request to hold gets a twenty-second listen, why the model is told to restate
the appointment only on the first turn. Read the comments before changing
anything in there.
