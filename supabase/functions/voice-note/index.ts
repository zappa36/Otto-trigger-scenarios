// ============================================================
// Voice note — Supabase Edge Function.
//
// The browser records a short clip and posts it here. This function:
//   1. transcribes it with OpenAI speech-to-text,
//   2. asks a small model to structure it into a title + category
//      and a short spoken-style reply,
//   3. returns { transcript, reply, note: { title, category } }.
//
// The OpenAI key lives ONLY in this function's secrets — it is never
// shipped to the browser or committed. Set it once:
//   Dashboard -> Edge Functions -> Secrets -> add OPENAI_API_KEY
//   (or CLI: supabase secrets set OPENAI_API_KEY=sk-...)
//
// Everything domain-specific is configurable through secrets, so this
// file should not need editing:
//   ALLOWED_ORIGINS   comma-separated; defaults to localhost only
//   NOTE_CATEGORIES   comma-separated label set
//   ASSISTANT_NAME    the persona's name
//   ASSISTANT_BRIEF   one line describing what people report about
// ============================================================

const env = (k: string, fallback: string) => (Deno.env.get(k) || '').trim() || fallback;
const csv = (k: string, fallback: string) =>
  env(k, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_ORIGINS = csv('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:4180');
const CATEGORIES = csv('NOTE_CATEGORIES', 'ACCESS,CLOSURE,HAZARD,ENTRANCE,HOURS,INFO');
const ASSISTANT = env('ASSISTANT_NAME', 'Otto');
const BRIEF = env('ASSISTANT_BRIEF', 'short observations about a place (broken lift, closed road, moved entrance, opening hours)');

const MAX_CLIP_BYTES = 8_000_000; // ~60 seconds — a cost backstop, not a quality limit

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
    const form = await req.formData();
    const audio = form.get('audio');
    const context = String(form.get('context') || 'this place').slice(0, 120);
    if (!(audio instanceof File)) return fail(400, 'no audio clip');
    if (audio.size > MAX_CLIP_BYTES) return fail(413, 'clip too long — keep it under ~60 seconds');

    // 1) speech -> text
    const tf = new FormData();
    tf.append('file', audio, audio.name || 'clip.webm');
    tf.append('model', 'gpt-4o-mini-transcribe'); // 'whisper-1' also works here
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: tf,
    });
    if (!tr.ok) return fail(502, `transcription failed: ${(await tr.text()).slice(0, 300)}`);
    // The widget ends a clip on a pause and tells people they may say
    // "stop" — that closing word is a control signal, not content.
    const transcript = String((await tr.json()).text || '').trim()
      .replace(/[,.!?\s]*\b(stop|stopp|basta)\b[.!?\s]*$/i, '').trim();
    if (!transcript) return fail(422, 'heard nothing — try again closer to the mic');

    // 2) structure the observation + the assistant's reply
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              `You are ${ASSISTANT}, a friendly field assistant. ` +
              `People speak ${BRIEF}. ` +
              'Return ONLY JSON: {"reply": string, "note": {"title": string, "category": string}}. ' +
              'reply: one warm spoken-style sentence acknowledging what they said, plus at most one short follow-up question if something useful is missing. ' +
              'note.title: an actionable summary for the next person, max 60 characters, e.g. "Lift broken — take the stairs". ' +
              `note.category: exactly one of ${CATEGORIES.join(', ')}.`,
          },
          { role: 'user', content: `Context: ${context}\nTranscribed voice note: "${transcript}"` },
        ],
      }),
    });
    if (!cr.ok) return fail(502, `structuring failed: ${(await cr.text()).slice(0, 300)}`);

    // The transcript is the valuable part and it already succeeded — a model
    // that returns unparseable JSON must not cost the person their recording.
    let reply = 'Noted — saved for the next visitor.';
    let note = { title: transcript.slice(0, 60), category: CATEGORIES[CATEGORIES.length - 1] };
    try {
      const parsed = JSON.parse((await cr.json()).choices[0].message.content);
      if (parsed.reply) reply = String(parsed.reply).slice(0, 300);
      if (parsed.note && parsed.note.title) {
        note = {
          title: String(parsed.note.title).slice(0, 60),
          category: CATEGORIES.includes(parsed.note.category) ? parsed.note.category : note.category,
        };
      }
    } catch { /* keep the safe defaults */ }

    return new Response(JSON.stringify({ transcript, reply, note }), { headers });
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
