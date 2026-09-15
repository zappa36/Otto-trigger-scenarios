#!/usr/bin/env node
/*
 * One ElevenLabs simulation test per scenario row and persona.
 *
 * A trigger scenario is a row of the "Otto triggers" sheet; on the phone
 * a fired trigger opens the ElevenLabs agent with the row's dynamic
 * variables, a briefing and the row's "Otto says" line. This generator
 * turns the same row into a test the agent can be run against without a
 * car: the SAME dynamic variables a phone would send (lib/scenario-vars
 * mirrors agentVars in app.js, fed a fixture stop from the Kollwitzkiez
 * route and a synthetic run — the measurements a tester acting out the
 * row would produce), the line the phone overrides the agent's first
 * message with as the first agent turn (the row's "Otto says", or the
 * app's own greeting for the destination when the row has none),
 * a simulated tester who knows what they "found" on the ground, and
 * success conditions derived from the row: opened with the question,
 * followed up on this run, got the tip type the row expects, kept it
 * short, stayed in one language.
 *
 * Every file under test_configs/ is exactly one request body for
 * POST /v1/convai/agent-testing/create, plus an `_otto` key the loop
 * strips before posting (which row, which persona, which language —
 * and the briefing the phone would have sent as a contextual update,
 * for a loop that wants to prepend it to the prompt under test).
 *
 *   node generate-tests.mjs                      # the starter sheet, en + it
 *   node generate-tests.mjs --supabase           # a designer's own rows
 *   node generate-tests.mjs --supabase URL KEY   # …in another project
 *   node generate-tests.mjs --lang en --scenario 8 --out /tmp/t
 *
 * Deterministic on purpose: stable ordering, no timestamps, the same
 * sheet always produces byte-identical files, so test_configs/ can be
 * committed and a sheet edit shows up as a diff. Files this run is
 * responsible for (same language, same scenario selection) that it did
 * not produce are removed as stale; regressions/ is never touched.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadSheet, loadRoute, loadSupabase } from './lib/sheet.mjs';
import {
  agentVars, agentBriefing, agentGreeting, initDynamicVariables, scenarioShape, measuredBits, sentence,
} from './lib/scenario-vars.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(HERE, 'test_configs');
export const PERSONAS = JSON.parse(readFileSync(path.join(HERE, 'personas.json'), 'utf8')).personas;

/* The analytics API's report categories — what Otto files a debrief
 * under, and the words the sheet's "What Otto learns" column leads with */
const CATEGORIES = ['access', 'parking', 'gate_code', 'recipient', 'address', 'hazard', 'other'];

/* Italian variants are cut for these rows only: every Italian test
 * costs a simulated conversation, and one row is enough to check what
 * the prompt does with `debrief_language` and an Italian opener. What
 * they cannot check is the phone's language override — otto-agent.js
 * sends conversation_config_override.agent.language = 'it' for a 🇮🇹
 * run, a create-test body has no per-test override, and the loop runs
 * the suite without an agent_config_override — so these tests run the
 * agent in its default language config: an agent whose Italian lives in
 * a language preset is exercised in its English one here. Should that
 * matter, the loop can group the lock by `_otto.language` and run the
 * Italian tests as their own invocation with an agent_config_override
 * setting conversation_config.agent.language. */
export const IT_ROWS = new Set([1]);

/* What scenario-ai would have cached on a phone by the time the trigger
 * fires (saysItCache in app.js, keyed by the English line): the Italian
 * variant carries the translated opener the way a phone with the
 * translation landed does. */
const SAYS_IT = {
  'Is it hard to park here at this time? Where did you find a spot?': 'È difficile parcheggiare qui a quest\'ora? Dove hai trovato posto?',
};

/* ---------- the synthetic runs ----------
 * Per starter-sheet row: which Kollwitzkiez stop the scenario is pinned
 * at (chosen so the notes on file are the kind the row's follow-up
 * would touch), what the phone measured — the tracking object as
 * startTracking builds it, only the fields a debrief reads — the
 * activity summary the AR kit would have produced, how far from the pin
 * the tester stands, and the ground truth the simulated tester holds:
 * what they actually found, tied to that stop, so the evaluator can
 * tell an elicited tip from an invented one. `specific` is the row's
 * own extra success condition where the row implies one. A row this
 * table does not know (a designer's own) gets the generic fixture.
 * A park-and-walk run (#2) carries no `stopped` and no `passes`: the
 * phone's parkWalkStep measures the parking spot and the walk and never
 * touches either, so such a run goes up as trigger_stopped "no" and
 * trigger_passes 0 — the fixture must not say otherwise, or the test
 * quotes a stop the phone never reported. */
const STARTER = {
  1: {
    stop: 7, run: { fired: true, passes: 2, stopped: true }, distance_to_pin_m: 180,
    activity: { state: 'IN_VEHICLE', summary: 'IN_VEHICLE 6m → STILL 1m → IN_VEHICLE 30s' },
    found: 'There was no legal spot anywhere on Sredzkistraße; after two slow loops you stopped in the loading bay on Husemannstraße, about 40 m from the door, which was free. It is like this every weekday morning before ten',
    specific: () => 'The elicited parking tip names a place — a street, a bay, a side of the road — where the tester actually stopped, not merely that parking was hard.',
  },
  2: {
    stop: 1, run: { fired: true, park_distance_m: 310, walk_m: 340 }, distance_to_pin_m: 12,
    activity: { state: 'STILL', summary: 'IN_VEHICLE 4m → STILL 40s → WALKING 5m → STILL 10s' },
    found: 'Parking at the door never works on Kollwitzstraße, so you went straight to the spot that always works — the car-park entrance on Knaackstraße, roughly 300 m away — and walked the rest. Nothing closer was free, and that spot is the smart choice at this address',
    specific: v => `The agent refers to the measured distances at least once — parked about ${v.park_distance_m} m from the pin and walked ${v.walk_m} m — and does not contradict or misquote them.`,
  },
  3: {
    stop: 2, run: { fired: true, stopped: true }, distance_to_pin_m: 90,
    activity: { state: 'IN_VEHICLE', summary: 'IN_VEHICLE 3m → STILL 50s → ON_FOOT 40s → IN_VEHICLE 20s' },
    found: 'You stopped in the lane with the hazards on for about a minute and handed the parcel over at the café counter; nobody honked and no warden was around. There is a loading zone round the corner on Kollwitzstraße that the map does not show — that is the better spot',
    specific: () => 'The agent asks whether the hazards-on stop worked here and whether there is a loading zone the map does not show; it does not lecture the tester about the legality of stopping in the street.',
  },
  4: {
    stop: 4, run: { fired: true, stopped: true }, distance_to_pin_m: 45,
    activity: { state: 'STILL', summary: 'IN_VEHICLE 3m → STILL 30s → ON_FOOT 2m → STILL 25s' },
    found: 'The pin points at the front door, which was locked; the real way in is the courtyard door on the right, past the bike racks, marked only by a small practice sign. It took you about two minutes to find it',
    specific: () => 'The agent gets a description of where the entrance actually is that the next driver could follow — a side, a landmark or a sign — not merely that it was hard to find.',
  },
  5: {
    stop: 11, run: { fired: true, stopped: true }, distance_to_pin_m: 95,
    activity: { state: 'STILL', summary: 'IN_VEHICLE 3m → STILL 30s → ON_FOOT 2m → STILL 15s' },
    found: 'The map pin sent you to the corner of Kollwitzstraße and Wörther Straße; the real door is about 90 m further along Kollwitzstraße on the left, past the closed courtyard gate — a side entrance with a sign on it',
    specific: () => 'The agent establishes where the real door is relative to the map pin — a direction and a rough distance or a landmark — which is the correction this scenario exists to collect.',
  },
  6: {
    stop: 8, run: { fired: true, stopped: true }, distance_to_pin_m: 70,
    activity: { state: 'IN_VEHICLE', summary: 'IN_VEHICLE 3m → STILL 1m → ON_FOOT 40s → IN_VEHICLE 15s' },
    found: 'Nobody answered at Fischer on the 5th floor; you rang twice and waited about half a minute. The neighbour Kern on the 4th was not in either. A woman on the stairs said Fischer is usually home after six in the evening. You left the parcel nowhere and took it back to the van',
    specific: () => 'The agent asks when somebody is usually there or who else takes parcels, and does not assume that the neighbour named in the notes on file took the parcel unless the tester says so.',
  },
  7: {
    stop: 5, run: { fired: true, stopped: true }, distance_to_pin_m: 25,
    activity: { state: 'ON_FOOT', summary: 'ON_FOOT 1m → STILL 6m → ON_FOOT 30s' },
    found: 'You waited about six minutes: Petrova is hard of hearing and only opened after the third ring. Knocking on the window next to the door works faster than the bell',
    specific: () => 'The agent gets an actual waiting time in minutes from the tester and one way to shorten it next time.',
  },
  8: {
    stop: 10, run: null, activity: null, distance_to_pin_m: 140,
    found: 'A removal truck with a lift platform had Wörther Straße shut completely at the Kollwitzstraße end; you turned round about 150 m short of the address. Coming in from the Husemannstraße side works — the street is open from there',
    specific: () => 'The trigger did not fire and the phone measured nothing on this run: the agent never claims to have seen, counted or measured anything (no pass counts, no distances, no "I noticed you…"), and it asks what blocked the street and which way around works.',
  },
  9: {
    stop: 3, run: { fired: true, stopped: true }, distance_to_pin_m: 60,
    activity: { state: 'IN_VEHICLE', summary: 'IN_VEHICLE 5m → STILL 40s → IN_VEHICLE 10s' },
    found: 'The last stretch of Knaackstraße is cobblestones with a delivery truck double-parked halfway along, so you crawled at walking pace for about a minute; it is like this most mornings between eight and nine, when the shops get their deliveries',
    specific: () => 'The agent asks what made the last stretch slow and whether it is like this at a particular time of day, so the tip carries a when as well as a what.',
  },
  10: {
    stop: 6, run: { fired: true, passes: 2, stopped: true }, distance_to_pin_m: 30,
    activity: { state: 'IN_VEHICLE', summary: 'IN_VEHICLE 3m → STILL 1m → ON_FOOT 30s → IN_VEHICLE 20s' },
    found: 'It was a completely ordinary delivery: you drove straight up, parked in a free spot right at the door, handed the parcel to Aydın on the 2nd floor and drove off. Nothing unusual happened and you have nothing to report; you were just getting back into the van when Otto spoke',
    specific: () => 'The agent accepts that this was an ordinary delivery with nothing to report: it does not invent a problem or press for a tip, and it closes within two of its own turns after the tester says nothing unusual happened.',
  },
};

/* a designer's own row: pinned at a stop by number, fires the way its
 * own params say — a stop and the passes the row asks for on the
 * pass/stop shape, a parking distance and a walk on park-and-walk, which
 * counts neither — and the simulated tester picks one consistent
 * finding of the row's tip type */
function genericFixture(sc, stops) {
  const n = Number(sc.num);
  const stop = stops[(Number.isFinite(n) && n > 0 ? n - 1 : 0) % stops.length];
  const passes = Array.isArray(sc.params) ? sc.params.find(p => p && p.key === 'passes_needed') : null;
  const parkwalk = scenarioShape(sc) === 'parkwalk';
  return {
    stop: stop.stop,
    run: {
      fired: true, stopped: !parkwalk,
      passes: !parkwalk && passes && isFinite(+passes.value) ? Math.max(0, Math.round(+passes.value)) : 0,
      ...(parkwalk ? { park_distance_m: 250, walk_m: 220 } : {}),
    },
    distance_to_pin_m: parkwalk ? 15 : 50,
    activity: { state: parkwalk ? 'STILL' : 'IN_VEHICLE', summary: parkwalk ? 'IN_VEHICLE 4m → STILL 40s → WALKING 4m → STILL 10s' : 'IN_VEHICLE 4m → STILL 1m → IN_VEHICLE 20s' },
    found: `Decide on one concrete, realistic finding that fits what this scenario is meant to learn (${sc.learns || 'a tip for the next driver'}) and stay consistent with it for the whole conversation; do not invent measurements the phone would have made`,
    specific: null,
  };
}

/* the tracking object as startTracking builds it, only what a debrief reads */
const makeRun = (sc, run) => (run ? { fired: false, passes: 0, stopped: false, shape: scenarioShape(sc), ...run } : null);

/* "Parking loops — driver circles…" → "Parking loops" (scenarioShort in app.js) */
export const scenarioShort = sc => String(sc.title || '').split(/\s+—\s+|\s+-\s+/)[0].trim();
export const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const pad2 = n => String(n).padStart(2, '0');
const noStop = s => String(s || '').trim().replace(/[.!?…]+$/, '');

/* the category word the row's "learns" column leads with — the tip type
 * Otto is supposed to come back with; 'none' for the clean-run control */
export function tipCategory(learns) {
  const text = String(learns || '').trim();
  const lead = text.split(/\s+—\s+|\s+-\s+|\s*:\s*|\s+/)[0].toLowerCase().replace(/[^a-z_]/g, '');
  if (!lead || lead === 'nothing' || lead === 'none') return 'none';
  if (CATEGORIES.includes(lead)) return lead;
  return CATEGORIES.find(c => new RegExp('\\b' + c + '\\b', 'i').test(text)) || 'other';
}

const floorText = f => (/^\d+$/.test(String(f).trim()) ? 'floor ' + String(f).trim() : String(f).trim());

/* the fired run in the tester's own words — same bits the briefing
 * quotes to the agent, so the two sides of the test agree */
function measuredLine(v) {
  const out = [];
  if (v.trigger_fired === 'yes') {
    const bits = measuredBits(v);
    out.push(bits.length ? `On this run the phone measured ${bits.join(', ')}; the trigger fired and Otto is calling you now.` : 'On this run the trigger fired and Otto is calling you now.');
  } else {
    out.push('The trigger did not fire on this run and the phone measured nothing; you opened the debrief yourself from the scenario card.');
  }
  if (v.distance_to_pin_m !== undefined) out.push(`You are about ${v.distance_to_pin_m} m from the map pin as you talk.`);
  return out.join(' ');
}

function simulationScenario({ sc, d, v, persona, lang, fx }) {
  const lines = [];
  const where = `${d.title}${d.addr ? ` (${d.addr})` : ''}`;
  const who = d.consignee ? `, delivery for ${d.consignee}${d.floor ? ', ' + floorText(d.floor) : ''}` : (d.floor ? `, delivery to ${floorText(d.floor)}` : '');
  lines.push(`You are a parcel-delivery driver working as a field tester for a delivery app. You have just acted out trigger scenario${v.scenario_num !== '' ? ' #' + v.scenario_num : ''} "${sc.title}" at ${where}${who}.`);
  if (sc.described) lines.push(`The situation being tested: ${sentence(sc.described)}`);
  if (v.scenario_test_steps) lines.push(`The steps you followed: ${sentence(v.scenario_test_steps)}`);
  lines.push(measuredLine(v));
  lines.push(`What you actually found on the ground — the only facts you may reveal, and only when asked: ${sentence(fx.found)}`);
  if (v.destination_notes) lines.push(`On the way in, Otto (the agent) read you the notes on file for this address: ${sentence(v.destination_notes)} You may confirm or correct them if asked.`);
  lines.push(`How you talk: ${sentence(persona.style)}`);
  lines.push(lang === 'it' ? 'You speak Italian and only Italian, whatever language you are addressed in.' : 'You speak English.');
  lines.push('Ground rules: stay in character as the driver; never mention being simulated or that this is a test; answer what you are asked and do not invent measurements or facts beyond what is above; when Otto wraps up or lets you go, say a short goodbye and stop.');
  return lines.join(' ');
}

/* Four to six yes/no prompts, each self-contained: the evaluator sees
 * one at a time and merges them. */
function successConditions({ sc, v, q, lang, fx, cat }) {
  const c = [];
  c.push(`The agent opens the debrief by asking “${q}” — that question or a close paraphrase of it — and its next turn continues from the tester's answer instead of restarting with a greeting, an introduction or a different opening question.`);
  const bits = measuredBits(v);
  const situation = noStop(sc.described || sc.title);
  /* the control row learns nothing — a follow-up demanded there would
   * contradict its own condition to accept "nothing to report" */
  if (cat !== 'none') c.push(v.trigger_fired === 'yes' && bits.length
    ? `At least one agent follow-up refers to what actually happened on this run — the phone measured ${bits.join(', ')} — or to the specific situation this scenario is about (${situation}). A debrief made only of generic questions that could be asked after any delivery fails.`
    : `At least one agent follow-up refers to the specific situation this scenario is about (${situation}) rather than only generic questions that could be asked after any delivery.`);
  c.push(cat === 'none'
    ? 'The agent establishes that this was an ordinary delivery with nothing to report and does not press for a tip; it states no facts the tester did not say.'
    : `The agent elicits at least one concrete, actionable tip of type "${cat}" (the sheet says: ${noStop(sc.learns)}) — something the next driver at ${d_title(v)} could act on, such as a place, a time or a way in — and the agent states no facts the tester did not say (no invented street names, times, distances or reasons).`);
  c.push('Across the whole conversation the agent asks at most three questions, the opening question included (two questions in one turn count as two), and it ends by letting the tester go — a short thanks and sign-off — rather than probing further.');
  c.push(lang === 'it'
    ? 'Every agent turn is in Italian — the tester chose Italian on the card. An agent turn in English or any other language, even a single one, fails.'
    : 'Every agent turn is in English. An agent turn in any other language fails.');
  if (fx.specific) c.push(fx.specific(v, sc));
  return c;
}
const d_title = v => v.destination_title || 'this address';

const destinationOf = stop => ({
  title: stop.title, addr: stop.addr, lat: stop.lat, lng: stop.lng,
  consignee: stop.consignee, floor: stop.floor, notes: stop.notes,
});

export function buildTest({ sc, persona, lang, stops }) {
  const fx = STARTER[sc.num] || genericFixture(sc, stops);
  const stop = stops.find(s => s.stop === fx.stop) || stops[0];
  const d = destinationOf(stop);
  const run = makeRun(sc, fx.run);
  const v = agentVars({ scenario: sc, destination: d, run, activity: fx.activity, distance_to_pin_m: fx.distance_to_pin_m, lang, saysIt: SAYS_IT });
  /* the first agent turn is whatever the phone would have put in
   * first_message — voiceOpts().greeting, not the keyless recorder's
   * question, whose "What did you find?" the agent never speaks */
  const q = agentGreeting(sc, d, { run, lang, saysIt: SAYS_IT });
  const cat = tipCategory(sc.learns);
  const num = sc.num != null && sc.num !== '' ? Number(sc.num) : null;
  const short = scenarioShort(sc) || 'untitled';
  const name = `Otto · ${num != null ? '#' + num + ' ' : ''}${short} · ${persona.id}${lang === 'it' ? ' · it' : ''}`;
  const file = `scenario-${pad2(num != null ? num : 0)}-${slug(num != null ? short : sc.title) || 'untitled'}--${persona.id}${lang === 'it' ? '-it' : ''}.json`;
  const body = {
    name,
    type: 'simulation',
    dynamic_variables: initDynamicVariables(v),
    chat_history: [{ role: 'agent', time_in_call_secs: 0, message: q }],
    simulation_scenario: simulationScenario({ sc, d, v, persona, lang, fx }),
    simulation_max_turns: persona.max_turns,
    success_conditions: successConditions({ sc, v, q, lang, fx, cat }),
    _otto: {
      scenario_num: num,
      scenario_title: String(sc.title || ''),
      persona: persona.id,
      kind: 'scenario',
      language: lang,
      briefing: agentBriefing(v, lang),
    },
  };
  return { file, body };
}

/* every test for a list of rows — pure, so the tests can call it twice
 * and compare */
export function buildTests(scenarios, { langs = ['en', 'it'], only = null, personas = PERSONAS, stops = null } = {}) {
  stops = stops || loadRoute('route-kollwitz.js').stops;
  const rows = scenarios
    .filter(sc => sc && String(sc.title || '').trim())
    .filter(sc => only == null || Number(sc.num) === Number(only))
    .slice()
    .sort((a, b) => (a.num == null) - (b.num == null) || (Number(a.num) || 0) - (Number(b.num) || 0) || String(a.title).localeCompare(String(b.title)));
  const out = [];
  rows.forEach(sc => {
    langs.forEach(lang => {
      if (lang === 'it' && !IT_ROWS.has(Number(sc.num))) return;
      personas.forEach(persona => out.push(buildTest({ sc, persona, lang, stops })));
    });
  });
  return out;
}

/* A file this run would have produced, had the row still existed: same
 * kind, a language this run generated, a scenario this run selected. */
const inScope = (body, { langs, only }) => body && body._otto && body._otto.kind === 'scenario'
  && langs.includes(body._otto.language) && (only == null || Number(body._otto.scenario_num) === Number(only));

export function writeTests(tests, outDir, { langs = ['en', 'it'], only = null } = {}) {
  mkdirSync(outDir, { recursive: true });
  const written = new Set();
  tests.forEach(t => {
    writeFileSync(path.join(outDir, t.file), JSON.stringify(t.body, null, 2) + '\n');
    written.add(t.file);
  });
  const removed = [];
  readdirSync(outDir).filter(f => /^scenario-.*\.json$/.test(f) && !written.has(f)).forEach(f => {
    let body = null;
    try { body = JSON.parse(readFileSync(path.join(outDir, f), 'utf8')); } catch { body = null; }
    if (inScope(body, { langs, only })) { unlinkSync(path.join(outDir, f)); removed.push(f); }
  });
  return { written: [...written], removed };
}

function parseArgs(argv) {
  const o = { source: 'sheet', url: null, key: null, out: DEFAULT_OUT, langs: ['en', 'it'], only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--sheet') o.source = 'sheet';
    else if (a === '--supabase') {
      o.source = 'supabase';
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.url = argv[++i];
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.key = argv[++i];
    } else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--lang') o.langs = next().split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--scenario') { o.only = Number(next()); if (!Number.isFinite(o.only)) throw new Error('--scenario needs a number'); }
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const bad = o.langs.find(l => l !== 'en' && l !== 'it');
  if (bad) throw new Error(`--lang takes en and/or it, not ${bad}`);
  return o;
}

const USAGE = `usage: node generate-tests.mjs [--sheet | --supabase [URL KEY]] [--out DIR] [--lang en,it] [--scenario N]

  --sheet         the starter sheet, trigger-scenarios.js (default)
  --supabase      a designer's own rows; URL KEY, else SUPABASE_URL / SUPABASE_ANON_KEY, else the kit's project
  --out DIR       where the test files go (default: elevenlabs/test_configs)
  --lang en,it    languages to generate (Italian variants exist for row #${[...IT_ROWS].join(', #')} only)
  --scenario N    one row only
`;

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE); return 0; }
  const scenarios = o.source === 'supabase' ? await loadSupabase(o.url, o.key) : loadSheet();
  const tests = buildTests(scenarios, { langs: o.langs, only: o.only });
  const { written, removed } = writeTests(tests, o.out, { langs: o.langs, only: o.only });
  const rows = new Set(tests.map(t => t.body._otto.scenario_title)).size;
  const from = o.source === 'supabase' ? `Supabase (${o.url || process.env.SUPABASE_URL || 'the kit\'s project'})` : 'the starter sheet';
  console.log(`\nGENERATE — ${rows} scenario(s) from ${from} × ${PERSONAS.length} persona(s) → ${tests.length} test(s)\n`);
  const col = (s, w) => (String(s).length > w ? String(s).slice(0, w - 1) + '…' : String(s).padEnd(w));
  console.log(`${col('file', 56)} ${col('name', 52)} turns cond`);
  tests.forEach(t => console.log(`${col(t.file, 56)} ${col(t.body.name, 52)} ${String(t.body.simulation_max_turns).padStart(5)} ${String(t.body.success_conditions.length).padStart(4)}`));
  /* a row with an empty "Otto says" cell is not an error — the phone
   * runs it — but the designer should know its tests grade nothing
   * about the row's own question */
  const noSays = [...new Set(tests.filter(t => !('scenario_question' in t.body.dynamic_variables)).map(t => t.body._otto.scenario_title))];
  noSays.forEach(title => console.log(`note: "${title}" has no Otto says line — its tests open with the app's own greeting, as the phone would`));
  const rel = path.relative(process.cwd(), o.out);
  const shown = !rel ? '.' : rel.startsWith('..') ? o.out : rel;
  console.log(`\nwrote ${written.length} file(s) to ${shown}; ${removed.length} stale removed${removed.length ? ' (' + removed.join(', ') + ')' : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => process.exit(code)).catch(e => { console.error(e.message || e); process.exit(1); });
}
