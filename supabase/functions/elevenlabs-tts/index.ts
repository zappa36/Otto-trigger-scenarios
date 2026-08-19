// ============================================================
// ElevenLabs reading voice — Supabase Edge Function.
//
// One-way speech for the phone's pre-arrival notes: the page sends
// the briefing text, this function turns it into a short mp3 clip in
// Otto's ElevenLabs voice and streams it back. One job, deliberately
// not a conversation — a briefing read on approach has no follow-up,
// and opening a metered agent line to read three sentences would be
// waste. The ElevenLabs API key never reaches a phone; it lives only
// in this function's secrets (the same key the elevenlabs-token
// function uses — deploy them together):
//   Dashboard -> Edge Functions -> Secrets -> ELEVENLABS_API_KEY
//   (or CLI: supabase secrets set ELEVENLABS_API_KEY=sk_...)
//
// Secrets:
//   ELEVENLABS_API_KEY    required
//   ELEVENLABS_VOICE_ID   optional — the voice the notes are read in;
//                         set it to your agent's voice so the reading
//                         and the debrief sound like one Otto
//                         (default: "Adam", an ElevenLabs stock voice)
//   ELEVENLABS_TTS_MODEL  optional — default eleven_flash_v2_5 (the
//                         low-latency tier: a reading that arrives
//                         after the driver parked is a reading missed)
//   ALLOWED_ORIGINS       comma-separated; defaults to localhost
// ============================================================

const env = (k: string, fallback = '') => (Deno.env.get(k) || '').trim() || fallback;
const csv = (k: string, fallback: string) =>
  env(k, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_ORIGINS = csv('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:4180');

// Both metered and spoken: a briefing is a handful of sentences, so a
// request far past that is not a briefing. The cap protects the
// ElevenLabs bill the way the origin check protects the door.
const MAX_CHARS = 2000;

const corsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail(405, 'POST only');

  // The anon key is public by design, so it cannot be what stands between
  // the internet and a metered ElevenLabs account. The origin check is.
  if (!origin || !ALLOW_ORIGINS.includes(origin)) return fail(403, 'origin not allowed');

  const key = Deno.env.get('ELEVENLABS_API_KEY');
  if (!key) return fail(501, 'ELEVENLABS_API_KEY secret is not set — the phone falls back to its own voice');

  try {
    const body = await req.json().catch(() => ({}));
    const text = String(body.text || '').trim();
    if (!text) return fail(400, 'no text');
    if (text.length > MAX_CHARS) return fail(400, `text too long (${text.length} > ${MAX_CHARS})`);

    const voice = env('ELEVENLABS_VOICE_ID', 'pNInz6obpgDQGcFmaJgB'); // "Adam" — an ElevenLabs stock voice
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(voice)) return fail(500, 'ELEVENLABS_VOICE_ID looks wrong');
    const model = env('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5');

    // Low-bitrate mp3 on purpose: spoken word over a cell connection in
    // a moving vehicle — small and soon beats big and late.
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      },
    );
    if (!r.ok || !r.body) return fail(502, `tts failed: ${(await r.text()).slice(0, 300)}`);

    // The audio streams straight through — only the clip goes back, the
    // key stays here.
    return new Response(r.body, {
      headers: { ...corsHeaders(origin), 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
