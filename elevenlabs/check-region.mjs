/*
 * Which ElevenLabs region answers a text-to-speech call from here?
 *
 * One tiny request — the same endpoint, model, voice and mp3 format the
 * phone's reading voice uses (supabase/functions/elevenlabs-tts) — and
 * the raw value of the x-region header ElevenLabs sends back with it.
 * The audio is read and thrown away; the dozen characters of text are
 * billed like any other speech.
 *
 *   ELEVENLABS_API_KEY=sk_... node check-region.mjs
 *
 * The key travels only in the xi-api-key header and is never printed.
 * ELEVENLABS_BASE_URL moves the request to another API host, as it does
 * for the loop. The header names the region that answered THIS request,
 * sent from this machine: a request sent from somewhere else (the
 * Supabase function, a GitHub runner) may be answered by another one.
 */

const key = (process.env.ELEVENLABS_API_KEY || '').trim();
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set, so nothing was sent.');
  process.exit(1);
}
const redact = s => String(s).split(key).join('[redacted]');

const base = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
// elevenlabs-tts's defaults: the stock voice "Adam", the flash model
const url = `${base}/v1/text-to-speech/pNInz6obpgDQGcFmaJgB/stream?output_format=mp3_22050_32`;

let r;
try {
  r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Region check.', model_id: 'eleven_flash_v2_5' }),
  });
} catch (e) {
  console.error(`The request never reached ElevenLabs: ${redact((e.cause && e.cause.message) || e.message)}`);
  process.exit(1);
}
const body = Buffer.from(await r.arrayBuffer());

console.log(`POST ${url}`);
console.log(`HTTP ${r.status}${r.ok ? ` — ${body.length} bytes of audio, thrown away` : ''}`);

// Printed whatever the status: an error reply carries the header too.
const region = r.headers.get('x-region');
if (region === null) {
  console.log('x-region: (no such header in the reply)');
  console.log(`the headers that came back: ${[...r.headers.keys()].join(', ')}`);
} else {
  console.log(`x-region: ${region}`);
}

if (!r.ok) {
  console.log(`ElevenLabs said: ${redact(body.toString('utf8').slice(0, 300))}`);
  process.exit(1);
}
