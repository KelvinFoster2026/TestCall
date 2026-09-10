/**
 * Renders the same line several ways and hands back links to listen to.
 *
 *   npm run voices
 *   npm run voices -- "any line you want to hear"
 *
 * Exists because delivery is not something anyone can reason their way to. The
 * settings that decide whether the call sounds like a person or an advert are
 * numbers with no meaning until you hear them, and the fastest way to pick them
 * is to hear the same sentence at several values, back to back.
 *
 * Open the URLs in a browser for DELIVERY - pace, warmth, whether a name gets
 * stretched. That judgement carries over to the phone unchanged.
 *
 * It does NOT carry over for artifacts. A browser plays the mp3 directly, while
 * Twilio decodes it and resamples to 8kHz mu-law, and clicks and burbles can be
 * born in that step. The `ulaw-8k` variant is the one that skips it: it is
 * already in Twilio's own format, so Twilio does no conversion at all. To judge
 * that one properly you have to hear it on a call.
 */
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { generateSignedUrl, uploadCallAudio } from '../src/s3.js';

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

const LINE =
  process.argv.slice(2).join(' ').trim() ||
  "Hi, this is Dawn from LogoLife College Counseling. I'm just calling about the consult you booked with us.";

interface Variant {
  name: string;
  note: string;
  model?: string;
  format?: string;
  settings: Record<string, unknown>;
}

const calm = {
  stability: 0.7,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: false,
  speed: 0.9,
};

const VARIANTS: Variant[] = [
  {
    name: 'as-it-was',
    note: 'speed only, everything else left to the voice defaults — the energetic one',
    settings: { speed: 0.9 },
  },
  {
    name: 'current',
    note: 'the new default: stability .7, style 0, no speaker boost',
    settings: calm,
  },
  {
    name: 'calmer',
    note: 'stability .85 — flatter still',
    settings: { ...calm, stability: 0.85 },
  },
  {
    name: 'calmest',
    note: 'stability 1.0 — as even as the voice will go',
    settings: { ...calm, stability: 1.0 },
  },
  {
    name: 'calm-slower',
    note: 'stability .85 at speed 0.85',
    settings: { ...calm, stability: 0.85, speed: 0.85 },
  },
  {
    name: 'turbo-model',
    note: 'eleven_turbo_v2_5 — better prosody than flash, still quick',
    model: 'eleven_turbo_v2_5',
    settings: { ...calm, stability: 0.85 },
  },
  {
    name: 'multilingual-model',
    note: 'eleven_multilingual_v2 — best prosody, slowest. Try if names still stretch',
    model: 'eleven_multilingual_v2',
    settings: { ...calm, stability: 0.85 },
  },
  {
    name: 'hifi-mp3',
    note: 'mp3_44100_64 — rules compression artifacts in or out',
    format: 'mp3_44100_64',
    settings: { ...calm, stability: 0.85 },
  },
  {
    name: 'ulaw-8k',
    note: "mu-law 8kHz as WAV — Twilio's native format, so Twilio transcodes nothing. JUDGE ON A CALL",
    format: 'ulaw_8000',
    settings: { ...calm, stability: 0.85 },
  },
];

/**
 * Wraps raw mu-law samples in a WAV container.
 *
 * ElevenLabs returns ulaw_8000 as bare samples with no header, and Twilio will
 * not play a headerless file - it has no way to know the rate or the encoding.
 * Format tag 7 is mu-law; non-PCM WAV also requires the `fact` chunk, which is
 * why this is not the usual 44-byte header.
 */
function wrapUlawAsWav(samples: Buffer): Buffer {
  const header = Buffer.alloc(58);
  let o = 0;
  header.write('RIFF', o); o += 4;
  header.writeUInt32LE(50 + samples.length, o); o += 4;
  header.write('WAVE', o); o += 4;

  header.write('fmt ', o); o += 4;
  header.writeUInt32LE(18, o); o += 4;        // fmt chunk size for non-PCM
  header.writeUInt16LE(7, o); o += 2;         // 7 = mu-law
  header.writeUInt16LE(1, o); o += 2;         // mono
  header.writeUInt32LE(8000, o); o += 4;      // sample rate
  header.writeUInt32LE(8000, o); o += 4;      // byte rate
  header.writeUInt16LE(1, o); o += 2;         // block align
  header.writeUInt16LE(8, o); o += 2;         // bits per sample
  header.writeUInt16LE(0, o); o += 2;         // cbSize

  header.write('fact', o); o += 4;
  header.writeUInt32LE(4, o); o += 4;
  header.writeUInt32LE(samples.length, o); o += 4;

  header.write('data', o); o += 4;
  header.writeUInt32LE(samples.length, o);

  return Buffer.concat([header, samples]) as Buffer;
}

/** Collected so the run can end with one page holding every player. */
const rendered: Array<{ v: Variant; url: string; bytes: number; ms: number; model: string; format: string }> = [];

async function render(v: Variant): Promise<void> {
  const format = v.format ?? 'mp3_22050_32';
  const model = v.model ?? config.elevenLabs.modelId;
  const started = Date.now();

  const response = await fetch(
    `${API_BASE}/${encodeURIComponent(config.elevenLabs.voiceId)}?output_format=${format}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenLabs.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: LINE, model_id: model, voice_settings: v.settings }),
    },
  );
  if (!response.ok) {
    console.log(`\n${v.name}\n  FAILED ${response.status} ${(await response.text()).slice(0, 160)}`);
    return;
  }

  let audio: Buffer = Buffer.from(await response.arrayBuffer());
  const isUlaw = format.startsWith('ulaw');
  if (isUlaw) audio = wrapUlawAsWav(audio);
  const took = Date.now() - started;

  // A fresh key per run, so a browser never replays a previous render.
  const key = `consult-calls/audio/lab/${Date.now()}-${v.name}.${isUlaw ? 'wav' : 'mp3'}`;
  const up = await uploadCallAudio(audio, key);
  if (!up.success || !up.key) {
    console.log(`\n${v.name}\n  upload failed: ${up.error}`);
    return;
  }
  const signed = await generateSignedUrl(up.key, 86400);

  console.log(
    `  ${v.name.padEnd(20)} ${String(audio.length).padStart(6)}B ${String(took).padStart(5)}ms  ` +
      `${model} ${format}`,
  );
  if (signed.url) {
    rendered.push({ v, url: signed.url, bytes: audio.length, ms: took, model, format });
  }
}

/**
 * One page holding every variant, so they can be compared back to back.
 *
 * Presigned S3 URLs run to several hundred characters each, which makes a list
 * of nine of them unreadable and effectively unclickable. A page with the
 * players already in it is the difference between comparing these properly and
 * not bothering to.
 */
function writePage(line: string): string {
  const rows = rendered
    .map(
      (r) => `    <div class="v">
      <div class="n">${r.v.name}</div>
      <div class="d">${r.v.note}</div>
      <audio controls preload="none" src="${r.url.replace(/&/g, '&amp;')}"></audio>
      <div class="m">${r.model} &middot; ${r.format} &middot; ${r.bytes} bytes &middot; ${r.ms}ms</div>
    </div>`,
    )
    .join('\n');

  writeFileSync(
    'voice-lab.html',
    `<!doctype html>
<meta charset="utf-8"><title>Voice lab</title>
<style>
  body{font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f7f7f6;
       color:#1f2328;margin:0;padding:40px 20px 80px}
  .w{max-width:680px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .line{color:#8b9198;margin:0 0 6px}
  .warn{background:#fdf3ef;border:1px solid #f0d7cb;color:#8f4223;padding:11px 13px;
        border-radius:9px;font-size:13.5px;margin:16px 0 26px}
  .v{background:#fff;border:1px solid #e4e6e9;border-radius:12px;padding:16px;margin-bottom:14px}
  .n{font-weight:600;margin-bottom:2px}
  .d{color:#8b9198;font-size:13.5px;margin-bottom:10px}
  .m{color:#a8adb3;font-size:12px;margin-top:8px;font-variant-numeric:tabular-nums}
  audio{width:100%}
</style>
<div class="w">
  <h1>Voice lab</h1>
  <p class="line">&ldquo;${line.replace(/</g, '&lt;')}&rdquo;</p>
  <div class="warn">
    Judge <strong>delivery</strong> here &mdash; pace, warmth, whether the name gets stretched.
    That carries over to the phone unchanged. Do <strong>not</strong> judge clicks or burbles
    here: your browser plays the mp3 directly, while Twilio decodes it and resamples to 8kHz,
    and artifacts can be born in that step. <strong>ulaw-8k</strong> is the variant that skips
    that step entirely, and it can only be judged on a real call.
  </div>
${rows}
</div>
`,
  );
  return 'voice-lab.html';
}

async function main(): Promise<void> {
  console.log(`\nLine: "${LINE}"`);
  console.log(`Voice: ${config.elevenLabs.voiceId}\n`);
  for (const v of VARIANTS) await render(v);
  const page = writePage(LINE);
  console.log(
    `\nOpen ${page} — every variant in order, flattest last. Links live 24h.\n\n` +
      `Then set the winner in .env and restart the server:\n` +
      `  ELEVENLABS_STABILITY, ELEVENLABS_STYLE, ELEVENLABS_SPEED,\n` +
      `  ELEVENLABS_MODEL_ID, ELEVENLABS_SIMILARITY_BOOST, ELEVENLABS_SPEAKER_BOOST\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
