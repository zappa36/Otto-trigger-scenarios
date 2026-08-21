// ============================================================
// Dispatch ask — Supabase Edge Function.
//
// The dispatcher dashboard's conversation with Otto
// (parcelvox-dashboard, Ask view): a question about the stops on
// file — one stop's notes, or a summary of the situation — answered
// ONLY from the store snapshot the dashboard sends along. The
// dashboard serialises destinations + notes + real debriefs into a
// compact STOP DATA block per question, so the answer is grounded in
// exactly what the phone would read aloud, and a keyless dashboard
// can fall back to its deterministic lookup with the same contract.
//
// Same conventions as voice-note / scenario-ai: the OpenAI key lives
// ONLY in this function's secrets, an origin allow-list stands
// between the internet and the metered account, JSON in and out.
// Secrets (shared — set once):
//   OPENAI_API_KEY    required
//   ALLOWED_ORIGINS   comma-separated; defaults to localhost only
// ============================================================

const env = (k: string, fallback: string) => (Deno.env.get(k) || '').trim() || fallback;
const csv = (k: string, fallback: string) =>
  env(k, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_ORIGINS = csv('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:4180');

const SYSTEM =
  "You are Otto, the depot's route-knowledge assistant, talking to a DISPATCHER at a desk (not " +
  'a driver on the road). You answer questions about the stops on file: consignees, pre-arrival ' +
  'notes (what Otto reads aloud to drivers on approach), and the debriefs drivers filed. ' +
  'Answer ONLY from the STOP DATA provided. Never invent stops, notes, codes or events; if ' +
  'nothing is on file for what was asked, say so plainly. ' +
  'Name stops the way the data does — e.g. **Stop 7 · Goltzstraße 13** — and bold stop names. ' +
  'Quote notes faithfully and say who left them (dispatch or a driver). ' +
  'Keep answers short and speakable — they may be read aloud: a lead of one or two sentences, ' +
  'up to 6 bullets only when listing, a short tail only when a next step genuinely helps. ' +
  'For summary or situation questions, lead with the counts (stops, addresses, how many carry ' +
  'notes, how many were debriefed), then bullet the most consequential notes. ' +
  'Return ONLY JSON: {"lead":string,"bullets":[{"text":string,"tone":"honey"|"green"}]?,' +
  '"tail":string?}. tone "honey" = needs attention (a warning, something stale or missing), ' +
  '"green" = confirmed or positive. **bold** spans are allowed in any text.';

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

  // The anon key is public by design, so it cannot be the thing standing
  // between the internet and a metered OpenAI account. The origin check is.
  if (!origin || !ALLOW_ORIGINS.includes(origin)) return fail(403, 'origin not allowed');

  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) return fail(500, 'OPENAI_API_KEY secret is not set');

  try {
    const body = await req.json().catch(() => ({}));
    const context = String(body.context || '').trim().slice(0, 28000);
    if (!context) return fail(400, 'no context');
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: { role?: unknown; content?: unknown }) =>
        (m?.role === 'user' || m?.role === 'assistant') && String(m?.content || '').trim())
      .slice(-10)
      .map((m: { role: string; content: unknown }) => ({
        role: m.role,
        content: String(m.content).slice(0, 1200),
      }));
    if (!history.length || history[history.length - 1].role !== 'user') {
      return fail(400, 'messages must end with the dispatcher question');
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // grounded lookup + summarising over provided data — mini does this
        // well, and a dispatcher conversation is many small calls
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 700,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'STOP DATA (authoritative, current):\n' + context },
          ...history,
        ],
      }),
    });
    if (!r.ok) return fail(502, `ask failed: ${(await r.text()).slice(0, 300)}`);

    let out: unknown;
    try {
      out = JSON.parse((await r.json()).choices[0].message.content);
    } catch {
      return fail(502, 'ask: model returned unparseable JSON — try again');
    }
    return new Response(JSON.stringify(out), { headers });
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
