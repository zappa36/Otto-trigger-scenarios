// ============================================================
// ElevenLabs conversation token — Supabase Edge Function.
//
// A PUBLIC ElevenLabs agent needs none of this: the browser opens
// wss://api.elevenlabs.io/v1/convai/conversation?agent_id=... with
// the id alone, and the id is not a secret.
//
// A PRIVATE agent has to be authorised, and authorising means the
// ElevenLabs API key — which must never reach a phone. So the
// browser asks here instead, and gets back a short-lived signed
// URL for one conversation. The key lives only in this function's
// secrets:
//   Dashboard -> Edge Functions -> Secrets -> ELEVENLABS_API_KEY
//   (or CLI: supabase secrets set ELEVENLABS_API_KEY=sk_...)
//
// Secrets:
//   ELEVENLABS_API_KEY    required for private agents
//   ELEVENLABS_AGENT_ID   optional — pins the agent server-side, so
//                         the page cannot ask for a signed URL to
//                         somebody else's agent on your key
//   ALLOWED_ORIGINS       comma-separated; defaults to localhost
// ============================================================

const env = (k: string, fallback = '') => (Deno.env.get(k) || '').trim() || fallback;
const csv = (k: string, fallback: string) =>
  env(k, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_ORIGINS = csv('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:4180');

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
  if (!key) return fail(501, 'ELEVENLABS_API_KEY secret is not set — public agents connect without this function');

  try {
    const body = await req.json().catch(() => ({}));
    // A pinned agent id wins: with one set, this function can only ever
    // sign conversations for that agent, whatever the page asks for.
    const agentId = env('ELEVENLABS_AGENT_ID') || String(body.agent_id || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(agentId)) return fail(400, 'no usable agent_id');

    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': key } },
    );
    if (!r.ok) return fail(502, `signing failed: ${(await r.text()).slice(0, 300)}`);

    const d = await r.json();
    if (!d.signed_url) return fail(502, 'no signed_url in the ElevenLabs response');

    // Only the URL goes back — it is scoped to one conversation and
    // expires on its own; the key stays here.
    return new Response(JSON.stringify({ signed_url: d.signed_url, agent_id: agentId }), { headers });
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
