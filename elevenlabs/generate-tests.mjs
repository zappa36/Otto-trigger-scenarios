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
 * The SECOND suite in here is the one the pilot actually runs. In the
 * pilot nothing triggers: the driver presses the big REPORT button and
 * says what they found, so there is no rule, no measurement and no
 * "Otto says" line to open with — Otto opens with his own first message
 * and everything after that is the conversation. A situation row
 * (situations-starter.js, and the situations table the dashboard
 * edits) carries the driver's first words, what the driver knows if
 * asked, what a fitting follow-up is about, what would be off topic,
 * and the one-line tip Otto should end up confirming. --situations
 * turns each row into four simulated drivers (the personas, vague
 * included) and six yes/no conditions on Otto's side of it: relevance,
 * no repetition, natural speech, no invention, length, and the close.
 * Those files are generated from the LIVE rows at run time and are not
 * committed (test_configs/situations/ is gitignored) — the dashboard's
 * rows are the sheet, not this repository.
 *
 *   node generate-tests.mjs                      # the starter sheet, en + it
 *   node generate-tests.mjs --supabase           # a designer's own rows
 *   node generate-tests.mjs --supabase URL KEY   # …in another project
 *   node generate-tests.mjs --lang en --scenario 8 --out /tmp/t
 *   node generate-tests.mjs --situations         # the situation suite, from the live rows
 *   node generate-tests.mjs --situations --sheet # …from situations-starter.js
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
import { loadSheet, loadSituationsSheet, loadRoute, loadSupabase, loadSituationsSupabase } from './lib/sheet.mjs';
import {
  agentVars, agentBriefing, agentGreeting, initDynamicVariables, scenarioShape, measuredBits, sentence,
} from './lib/scenario-vars.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(HERE, 'test_configs');
/* generated from the live rows on every run, so never committed */
export const DEFAULT_SITUATION_OUT = path.join(DEFAULT_OUT, 'situations');
export const PERSONAS = JSON.parse(readFileSync(path.join(HERE, 'personas.json'), 'utf8')).personas;
/* a persona says which suites it is cut for; no `suites` means both.
 * The vague driver only makes sense where the DRIVER opens the
 * conversation — a trigger scenario opens with Otto's own question and
 * there is nothing vague left to be. */
const forSuite = suite => PERSONAS.filter(p => !Array.isArray(p.suites) || p.suites.includes(suite));
export const TRIGGER_PERSONAS = forSuite('triggers');
export const SITUATION_PERSONAS = forSuite('situations');

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
export function buildTests(scenarios, { langs = ['en', 'it'], only = null, personas = TRIGGER_PERSONAS, stops = null } = {}) {
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
 * kind, a language this run generated, a row this run selected. */
const inScope = (body, { langs, only, kind }) => {
  const o = body && body._otto;
  if (!o || o.kind !== kind) return false;
  if (kind === 'situation') return only == null || Number(o.situation_num) === Number(only);
  return langs.includes(o.language) && (only == null || Number(o.scenario_num) === Number(only));
};

export function writeTests(tests, outDir, { langs = ['en', 'it'], only = null, kind = 'scenario' } = {}) {
  mkdirSync(outDir, { recursive: true });
  const written = new Set();
  tests.forEach(t => {
    writeFileSync(path.join(outDir, t.file), JSON.stringify(t.body, null, 2) + '\n');
    written.add(t.file);
  });
  const removed = [];
  const mine = new RegExp(`^${kind}-.*\\.json$`);
  readdirSync(outDir).filter(f => mine.test(f) && !written.has(f)).forEach(f => {
    let body = null;
    try { body = JSON.parse(readFileSync(path.join(outDir, f), 'utf8')); } catch { body = null; }
    if (inScope(body, { langs, only, kind })) { unlinkSync(path.join(outDir, f)); removed.push(f); }
  });
  return { written: [...written], removed };
}

/* ============================================================
 * The situation suite — what the driver reports, and what Otto asks back
 * ============================================================ */

/* The turn cap. Eight turns is a whole situation debrief with room to
 * spare: Otto's opener, the report, two or three questions with their
 * answers, the tip, a goodbye. The vague driver spends the first
 * exchange saying nothing in particular, so that one gets two more
 * rather than a rushed close — which would fail the close condition for
 * a reason that is the test's fault, not the prompt's. */
const situationTurns = persona => (persona.id === 'vague' ? 10 : 8);

/* follow_up / off_topic are jsonb lists from Supabase, plain arrays
 * from the starter sheet, and a string when someone hand-feeds a row */
export function listOf(x) {
  let v = x;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { v = JSON.parse(t); } catch { return [t]; } } else return [t];
  }
  return Array.isArray(v) ? v.map(s => String(s == null ? '' : s).trim()).filter(Boolean) : [];
}

/* The control row: its follow_up column says a follow-up is not wanted
 * here (the delivery was ordinary). The three conditions that demand
 * one would contradict the row itself, so they are replaced — a suite
 * that never accepts "nothing happened" teaches the prompt to invent
 * problems, which is the one failure mode a driver would notice. */
export const needsNoFollowUp = row => {
  const items = listOf(row && row.follow_up);
  return !items.length || (items.length === 1 && /^(nothing|none|no follow)\b/i.test(items[0]));
};

/* the stop the situation is set at: the row's own, else one of the
 * twelve by position, so a sheet of rows without stops still spreads
 * across the route instead of piling onto the first door */
function situationStop(row, stops, index) {
  const want = Number(row && row.stop);
  const found = Number.isFinite(want) ? stops.find(s => s.stop === want) : null;
  if (found) return found;
  const n = Number(row && row.num);
  const i = Number.isFinite(n) && n > 0 ? n - 1 : index;
  return stops[((i % stops.length) + stops.length) % stops.length];
}

/* What the phone sends when the driver presses REPORT and no scenario
 * and no trigger are involved: the stop it is standing at, the
 * language, and trigger_fired "no". agentVars with a null scenario and
 * a null run already produces exactly this — everything else comes out
 * '' and initDynamicVariables drops it, the way initPayload does on the
 * phone — but the list is spelled out, because it is the contract the
 * test asserts and a new variable on the phone must not leak into a
 * suite that is meant to run without one. */
export const SITUATION_VARS = [
  'destination_title', 'destination_address', 'destination_lat', 'destination_lng',
  'destination_consignee', 'destination_floor', 'destination_notes', 'debrief_language', 'trigger_fired',
];
function situationVars(d) {
  const v = agentVars({ scenario: null, destination: d, run: null, activity: null, lang: 'en' });
  return initDynamicVariables(Object.fromEntries(SITUATION_VARS.map(k => [k, v[k]])));
}

/* The driver, in the first person. Everything the simulated driver may
 * say comes from the row: the opening line it reports with, and the
 * facts it is allowed to give up — only when asked, or the test grades
 * nothing about Otto's questions. */
function situationScenario({ row, d, persona }) {
  const lines = [];
  const who = d.consignee ? `, the delivery for ${d.consignee}${d.floor ? ', ' + floorText(d.floor) : ''}` : '';
  lines.push(`You are a parcel-delivery driver on a round in Berlin. You have just finished at ${d.title}${d.addr ? ` (${d.addr})` : ''}${who}, and you have pressed the big REPORT button in the app to tell the office what you found there. Otto, the voice from the office, answers.`);
  lines.push(`Otto speaks first. If he asks what happened, that is when you say it; if he only greets you, say it straight away. The first thing you say about this stop is “${String(row.driver_says || '').trim()}” — in your own words is fine.`);
  lines.push(`What you know if Otto asks, and only when he asks: ${sentence(row.driver_knows)}`);
  lines.push(`How you talk: ${sentence(persona.style)}`);
  lines.push('You speak English.');
  lines.push('Ground rules: stay in character as the driver; never mention being simulated or that this is a test; '
    + `do not volunteer anything beyond your first line until Otto asks for it${persona.id === 'cooperative' ? ' — you may add one useful detail of your own to an answer, no more' : ''}; `
    + 'never invent facts beyond what is above; when Otto confirms a tip that matches what you said, agree in a few words; when his tip gets it wrong, correct it briefly; when Otto lets you go, say a short goodbye and stop.');
  return lines.join(' ');
}

/* Six yes/no prompts (seven for the vague driver), each self-contained:
 * the evaluator sees one at a time and merges them, so each one has to
 * carry its own situation. In this order — relevance first, because a
 * follow-up that fits THAT report is the whole point, and the close
 * last, because it is what the next driver ends up reading. */
function situationConditions({ row, d, persona }) {
  const says = `“${String(row.driver_says || '').trim()}”`;
  const followUp = listOf(row.follow_up);
  const offTopic = listOf(row.off_topic);
  const control = needsNoFollowUp(row);
  const where = d.title || 'this address';
  const c = [];
  c.push(control
    ? `RELEVANCE — the driver reported ${says}: nothing went wrong at this stop. Otto asks at most one short question to confirm that and does not go looking for a problem (for example ${offTopic.join(', ')}). Probing for something that was not there fails.`
    : `RELEVANCE — Otto's first follow-up question is about what the driver reported (${says}) and asks about at least one of these: ${followUp.join('; ')}. A first follow-up about something else (for example ${offTopic.join(', ')}), or a generic question that could follow any report at all ("anything else?", "how did it go?"), fails.`);
  c.push(`NO REPETITION — Otto never asks the driver for something the driver has already said in this conversation; every question adds something the driver has not given yet. Asking again for a detail that was already in the driver's own words — reworded, or as a check — fails.`);
  c.push('NATURAL — Otto sounds like a colleague on the phone: a short, natural acknowledgement of what the driver just said before the next question, plain spoken language, one thing at a time. Lecturing the driver about procedure, form-filling phrasing ("please state the nature of…", "can you confirm the following"), or reading the whole report back in the middle of the conversation fails.');
  c.push(`NO INVENTION — Otto states no fact the driver did not say: no invented times, names, distances, reasons or outcomes, and nothing about ${where} that came from neither the driver nor the notes on file. Asking about any of that is fine; asserting it is not.`);
  c.push(control
    ? 'LENGTH — after his opening message Otto asks at most one question, then closes. Two or more questions fails.'
    : 'LENGTH — after the driver has said what happened, Otto asks two or three follow-up questions in total, one at a time (two questions in one turn count as two), and then he closes. His opening greeting — “Hello! How can I help you today?” or similar — is not a follow-up and does not count. Four or more follow-up questions fails.');
  c.push(control
    ? `CLOSE — Otto ends by confirming that there is nothing to note about ${where} and lets the driver go with a short goodbye. Inventing a tip for a stop where nothing happened fails.`
    : `CLOSE — Otto ends by confirming the tip in one line — what the next driver should know about ${where} — and it is consistent with what the driver said (for this situation something like: “${noStop(row.tip)}”; equivalent wording is fine, the facts are what count). Then he lets the driver go with a short goodbye.`);
  if (persona.id === 'vague') {
    c.push('OPEN QUESTION FIRST — the driver\'s first words do not say what happened, so before asking anything specific Otto asks one open question to find out ("What happened?", "What did you run into?"). Guessing at a problem, or asking a specific question about something the driver has not described yet, fails.');
  }
  return c;
}

export function buildSituationTest({ row, persona, stops, index = 0 }) {
  const d = destinationOf(situationStop(row, stops, index));
  const num = row.num != null && row.num !== '' ? Number(row.num) : null;
  const short = scenarioShort(row) || 'untitled';
  const name = `Otto · situation ${num != null ? '#' + num + ' ' : ''}${short} · ${persona.id}`;
  const file = `situation-${pad2(num != null ? num : 0)}-${slug(num != null ? short : row.title) || 'untitled'}--${persona.id}.json`;
  const body = {
    name,
    type: 'simulation',
    dynamic_variables: situationVars(d),
    /* No chat_history on purpose: in the pilot the driver presses
     * REPORT and Otto opens with his own first message from the agent
     * config. A chat_history here would put words in his mouth that the
     * button flow never does, and the opener is part of what the suite
     * is judging. */
    simulation_scenario: situationScenario({ row, d, persona }),
    simulation_max_turns: situationTurns(persona),
    success_conditions: situationConditions({ row, d, persona }),
    _otto: {
      kind: 'situation',
      situation_num: num,
      situation_title: String(row.title || ''),
      persona: persona.id,
      language: 'en',
      scenario_num: null,
      scenario_title: null,
    },
  };
  return { file, body };
}

/* every situation test for a list of rows — pure, so the tests can call
 * it twice and compare */
export function buildSituationTests(rows, { only = null, personas = SITUATION_PERSONAS, stops = null } = {}) {
  stops = stops || loadRoute('route-kollwitz.js').stops;
  const chosen = (rows || [])
    .filter(r => r && String(r.title || '').trim() && r.active !== false)
    .filter(r => only == null || Number(r.num) === Number(only))
    .slice()
    .sort((a, b) => (a.num == null) - (b.num == null) || (Number(a.num) || 0) - (Number(b.num) || 0) || String(a.title).localeCompare(String(b.title)));
  const out = [];
  chosen.forEach((row, i) => personas.forEach(persona => out.push(buildSituationTest({ row, persona, stops, index: i }))));
  return out;
}

function parseArgs(argv) {
  const o = { situations: false, source: null, url: null, key: null, file: null, out: null, langs: ['en', 'it'], only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--situations') o.situations = true;
    else if (a === '--sheet') o.source = 'sheet';
    else if (a === '--supabase') {
      o.source = 'supabase';
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.url = argv[++i];
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.key = argv[++i];
    } else if (a === '--file') { o.source = 'file'; o.file = path.resolve(next()); }
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--lang') { o.langs = next().split(',').map(s => s.trim().toLowerCase()).filter(Boolean); o.langGiven = true; }
    else if (a === '--scenario') { o.only = Number(next()); o.onlyFlag = a; if (!Number.isFinite(o.only)) throw new Error('--scenario needs a number'); }
    else if (a === '--situation') { o.only = Number(next()); o.onlyFlag = a; if (!Number.isFinite(o.only)) throw new Error('--situation needs a number'); }
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const bad = o.langs.find(l => l !== 'en' && l !== 'it');
  if (bad) throw new Error(`--lang takes en and/or it, not ${bad}`);
  /* the two suites take different rows from different places; a flag
   * from the other one is a mistake worth naming, not one to guess at */
  if (o.situations && o.langGiven) throw new Error('the situation suite is English only — the pilot is; drop --lang');
  if (o.situations && o.onlyFlag === '--scenario') throw new Error('--scenario picks a trigger row; with --situations use --situation N');
  if (!o.situations && o.onlyFlag === '--situation') throw new Error('--situation picks a situation row; without --situations use --scenario N');
  if (!o.situations && o.source === 'file') throw new Error('--file is the situation suite\'s (a JSON list of rows); the trigger suite reads --sheet or --supabase');
  /* triggers come from the committed sheet unless asked otherwise;
   * situations come from the live rows the dashboard edits, because
   * the sheet is only their starting twenty */
  o.source = o.source || (o.situations ? 'supabase' : 'sheet');
  o.out = o.out || (o.situations ? DEFAULT_SITUATION_OUT : DEFAULT_OUT);
  return o;
}

const USAGE = `usage: node generate-tests.mjs [--sheet | --supabase [URL KEY]] [--out DIR] [--lang en,it] [--scenario N]
       node generate-tests.mjs --situations [--supabase [URL KEY] | --sheet | --file JSON] [--out DIR] [--situation N]

  --situations    the SITUATION suite: what a driver reports after pressing REPORT, ${SITUATION_PERSONAS.length} personas per row.
                  Its rows come from the situations table (default), falling back to situations-starter.js
                  when that project has no such table yet or no active row in it
  --sheet         the starter sheet: trigger-scenarios.js (the trigger default), situations-starter.js with --situations
  --supabase      a designer's own rows; URL KEY, else SUPABASE_URL / SUPABASE_ANON_KEY, else the kit's project
  --file JSON     situation rows from a file: a list, or {"situations": [ … ]}
  --out DIR       where the test files go (default: elevenlabs/test_configs, …/situations with --situations)
  --lang en,it    languages to generate (triggers only; Italian variants exist for row #${[...IT_ROWS].join(', #')})
  --scenario N    one trigger row only
  --situation N   one situation row only
`;

const col = (s, w) => (String(s).length > w ? String(s).slice(0, w - 1) + '…' : String(s).padEnd(w));
function printTests(tests) {
  console.log(`${col('file', 56)} ${col('name', 52)} turns cond`);
  tests.forEach(t => console.log(`${col(t.file, 56)} ${col(t.body.name, 52)} ${String(t.body.simulation_max_turns).padStart(5)} ${String(t.body.success_conditions.length).padStart(4)}`));
}
function printWrote(out, written, removed) {
  const rel = path.relative(process.cwd(), out);
  const shown = !rel ? '.' : rel.startsWith('..') ? out : rel;
  console.log(`\nwrote ${written.length} file(s) to ${shown}; ${removed.length} stale removed${removed.length ? ' (' + removed.join(', ') + ')' : ''}`);
}
const supabaseName = o => `Supabase (${o.url || process.env.SUPABASE_URL || 'the kit\'s project'})`;

async function generateScenarios(o) {
  const scenarios = o.source === 'supabase' ? await loadSupabase(o.url, o.key) : loadSheet();
  const tests = buildTests(scenarios, { langs: o.langs, only: o.only });
  const { written, removed } = writeTests(tests, o.out, { langs: o.langs, only: o.only });
  const rows = new Set(tests.map(t => t.body._otto.scenario_title)).size;
  const from = o.source === 'supabase' ? supabaseName(o) : 'the starter sheet';
  console.log(`\nGENERATE — ${rows} scenario(s) from ${from} × ${TRIGGER_PERSONAS.length} persona(s) → ${tests.length} test(s)\n`);
  printTests(tests);
  /* a row with an empty "Otto says" cell is not an error — the phone
   * runs it — but the designer should know its tests grade nothing
   * about the row's own question */
  const noSays = [...new Set(tests.filter(t => !('scenario_question' in t.body.dynamic_variables)).map(t => t.body._otto.scenario_title))];
  noSays.forEach(title => console.log(`note: "${title}" has no Otto says line — its tests open with the app's own greeting, as the phone would`));
  printWrote(o.out, written, removed);
  return 0;
}

/* Where the situation rows come from. The live table is the default,
 * because the dashboard is where they are written — but a project whose
 * schema.sql predates the table (404) or whose tab is still empty must
 * not leave a button with nothing to run, so the starter twenty stand
 * in, and the run says which of the two it used. */
async function situationRows(o) {
  if (o.source === 'sheet') return { rows: loadSituationsSheet(), from: 'the starter sheet' };
  if (o.source === 'file') {
    const raw = JSON.parse(readFileSync(o.file, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.situations) ? raw.situations : null);
    if (!rows) throw new Error(`${o.file} carries no situation rows (a list, or {"situations": [ … ]})`);
    return { rows, from: o.file };
  }
  try {
    const rows = await loadSituationsSupabase(o.url, o.key);
    if (rows.length) return { rows, from: supabaseName(o) };
    console.log(`the situations table on ${supabaseName(o)} has no active row — generating from situations-starter.js instead`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`${supabaseName(o)} has no situations table yet — generating from situations-starter.js instead (run supabase/schema.sql there to get one)`);
  }
  return { rows: loadSituationsSheet(), from: 'the starter sheet' };
}

async function generateSituations(o) {
  const { rows, from } = await situationRows(o);
  const tests = buildSituationTests(rows, { only: o.only });
  const { written, removed } = writeTests(tests, o.out, { only: o.only, kind: 'situation' });
  const count = new Set(tests.map(t => t.body._otto.situation_title)).size;
  console.log(`\nGENERATE — ${count} situation(s) from ${from} × ${SITUATION_PERSONAS.length} persona(s) → ${tests.length} test(s)\n`);
  printTests(tests);
  /* a row that says a follow-up is not wanted grades the opposite way
   * round (Otto must NOT probe), which is easy to miss in a sheet */
  const controls = [...new Set(tests.filter(t => needsNoFollowUp(rows.find(r => String(r.title || '') === t.body._otto.situation_title) || {})).map(t => t.body._otto.situation_title))];
  controls.forEach(title => console.log(`note: "${title}" asks for no follow-up — its tests grade Otto for NOT probing, and for closing after at most one question`));
  printWrote(o.out, written, removed);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE); return 0; }
  return o.situations ? generateSituations(o) : generateScenarios(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => process.exit(code)).catch(e => { console.error(e.message || e); process.exit(1); });
}
