// ============================================================
// Scenario AI — Supabase Edge Function.
//
// The dashboard's two AI moments (dashboard.js):
//   op:"draft"  — a plain-language description of a trigger scenario in;
//                 a full row of the "Otto triggers" sheet out, every
//                 tunable number extracted as a {key} param with a
//                 slider range.
//   op:"revise" — the current scenario + the tester's feedback notes
//                 (+ recent structured debriefs) in; a proposed next
//                 version out: changed fields, adjusted params, and a
//                 one-line changelog note.
//
// Same conventions as voice-note: the OpenAI key lives ONLY in this
// function's secrets, an origin allow-list stands between the internet
// and the metered account, JSON in and out. Secrets (shared with
// voice-note — set once):
//   OPENAI_API_KEY    required
//   ALLOWED_ORIGINS   comma-separated; defaults to localhost only
//   NOTE_CATEGORIES   comma-separated label set — keep in sync with
//                     voice-note so "learns" matches what Otto files
// ============================================================

const env = (k: string, fallback: string) => (Deno.env.get(k) || '').trim() || fallback;
const csv = (k: string, fallback: string) =>
  env(k, fallback).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_ORIGINS = csv('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:4180');
const CATEGORIES = csv('NOTE_CATEGORIES', 'ACCESS,CLOSURE,HAZARD,ENTRANCE,HOURS,INFO');

// Param keys the phone's live trigger detector consumes directly
// (trigOf in app.js) — the prompt prefers them so a drafted scenario
// is tunable end-to-end from day one.
const DETECTOR_KEYS =
  'radius (m), exit_radius (m), pass_speed_max (m/s), pass_still_max_s (s), ' +
  'passes_needed (×), stop_speed (m/s), stop_dwell_s (s), stop_radius (m), resume_speed (m/s)';

const PARAM_SHAPE = '{"key":string,"label":string,"value":number,"min":number,"max":number,"step":number,"unit":string}';
const FIELDS = 'title, rule, ar_states, signals, timing, otto_says, learns, test_steps';

// One worked example anchors both the JSON shape and — more importantly —
// the fidelity: the output is about exactly what the designer described.
const DRAFT_EXAMPLE =
  'Example. Description: "walking past the destination without finding the entrance — wandering ' +
  'around the building until the side door turns up" → ' +
  '{"fields":{"title":"Entrance hunt — walks past the destination without finding the entrance",' +
  '"rule":"Tester is ON_FOOT within {search_radius} m of the pin for more than {foot_search_s} s ' +
  'without stopping anywhere longer than {stop_dwell_s} s — they are circling the building hunting ' +
  'for the way in.",' +
  '"ar_states":"ON_FOOT (searching) → STILL at the real entrance",' +
  '"signals":"GPS trace on foot vs pin; time on foot near the pin",' +
  '"timing":"Wait — ask once they have stopped at the entrance they found",' +
  '"otto_says":"\\"Was the entrance easy to find? Where is it, exactly?\\"",' +
  '"learns":"ENTRANCE — where the real way in is",' +
  '"test_steps":"Walk past the pin on the wrong side, circle the building for ~2 minutes, stop at ' +
  'the real door, then answer Otto."},' +
  '"params":[' +
  '{"key":"search_radius","label":"Search radius","value":80,"min":20,"max":200,"step":5,"unit":"m"},' +
  '{"key":"foot_search_s","label":"On-foot search time","value":90,"min":20,"max":300,"step":10,"unit":"s"},' +
  '{"key":"stop_dwell_s","label":"Real-stop threshold","value":30,"min":10,"max":120,"step":5,"unit":"s"}]}';

const DRAFT_SYSTEM =
  'You design field-testable trigger scenarios for Otto, a voice assistant that talks to delivery ' +
  'drivers at exactly the right moment and learns local tips from their answers. A test designer ' +
  'describes a scenario in plain words; you fill one row of the "Otto triggers" sheet. ' +
  'Return ONLY JSON: {"fields":{"title":string,"rule":string,"ar_states":string,"signals":string,' +
  '"timing":string,"otto_says":string,"learns":string,"test_steps":string,"address":string?},' +
  '"params":[' + PARAM_SHAPE + ']}. ' +
  'THE CARDINAL RULE — ground every field in the description. The scenario is exactly what the ' +
  'designer described, never a substituted more-common one: "walk by the address" is about walking ' +
  'past on foot, not about parking. Reuse their key words in the title, make otto_says ask about ' +
  'the situation THEY described, and if the description is short, stay literal and minimal rather ' +
  'than inventing detail. ' +
  'Conventions: ' +
  'title: "Short name — one-line situation", in the designer\'s words. ' +
  'rule: one or two plain-language sentences a tester with a phone can verify in the field — never ' +
  'code, never boolean expressions like "x == y". Write EVERY tunable number as a {key} ' +
  'placeholder, never a literal. ' +
  'params: 2–6 entries, one per placeholder, each with a realistic field-tuning range (min/max/step) ' +
  'around the value. Prefer these canonical keys when they genuinely fit the described movement — ' +
  'the phone\'s live detector reads them directly: ' + DETECTOR_KEYS + '. Otherwise invent ' +
  'snake_case keys. Units: m, s, m/s, ×. ' +
  'ar_states: only IN_VEHICLE, ON_FOOT, WALKING, RUNNING, ON_BICYCLE, STILL, with → for transitions. ' +
  'timing: when Otto may speak — never mid-task, drivers\' hands are full. ' +
  'otto_says: ONE short spoken question, in double quotes, about the described situation. ' +
  `learns: must contain exactly one category word of ${CATEGORIES.join(', ')} plus a short phrase, ` +
  'e.g. "ENTRANCE — where the real way in is". ' +
  'test_steps: concrete numbered steps one tester with one phone can act out safely and legally. ' +
  'address: ONLY if the description contains a concrete street address or named place, copy it ' +
  'verbatim; otherwise omit the key entirely. ' +
  DRAFT_EXAMPLE;

const REVISE_SYSTEM =
  'You tune field-test trigger scenarios for Otto, a voice assistant for delivery drivers. You get ' +
  'the current scenario (fields + tunable params + version), the tester\'s feedback notes from real ' +
  'runs, and recent structured debrief results. Propose the next version. ' +
  'Return ONLY JSON: {"changes":{...},"params":[' + PARAM_SHAPE + '],"note":string}. ' +
  `changes: ONLY the fields (of: ${FIELDS}) whose text should change, with the full new text; keep ` +
  '{key} placeholders intact; {} if none should. ' +
  'params: the FULL updated list in the same shape as given — adjust value where the feedback says ' +
  'so, widen min/max if the window proved wrong, keep keys stable; return the list unchanged if ' +
  'nothing should move. ' +
  'note: one line (max 120 chars) saying what changed and why, grounded in the feedback. ' +
  'Be conservative: change only what the feedback and results actually support.';

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
    const op = String(body.op || '');

    let system: string;
    let user: string;
    if (op === 'draft') {
      const description = String(body.description || '').trim().slice(0, 2000);
      if (!description) return fail(400, 'no description');
      system = DRAFT_SYSTEM;
      user = `Scenario description:\n${description}`;
    } else if (op === 'revise') {
      if (!body.scenario || !Array.isArray(body.feedback) || !body.feedback.length) {
        return fail(400, 'revise needs scenario + feedback');
      }
      system = REVISE_SYSTEM;
      user = JSON.stringify({
        scenario: body.scenario,
        feedback: body.feedback.map((f: unknown) => String(f).slice(0, 1000)).slice(0, 10),
        recent_results: Array.isArray(body.results) ? body.results.slice(0, 5) : [],
      }).slice(0, 12000);
    } else {
      return fail(400, 'op must be "draft" or "revise"');
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // full 4o, not mini: drafting a faithful scenario from two vague
        // sentences is an instruction-following task mini gets wrong
        // (it drifts to the most common scenario instead of the described one)
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!r.ok) return fail(502, `${op} failed: ${(await r.text()).slice(0, 300)}`);

    // The dashboard sanitises hard (cleanParams / cleanProposal), so the
    // model's JSON passes through as-is; only unparseable output fails.
    let out: unknown;
    try {
      out = JSON.parse((await r.json()).choices[0].message.content);
    } catch {
      return fail(502, `${op}: model returned unparseable JSON — try again`);
    }
    return new Response(JSON.stringify(out), { headers });
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
