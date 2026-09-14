/*
 * The generator against its contracts: the variable key set mirrors
 * agentVars in app.js (read out of the source at test time, so a new
 * key on the phone fails here until it is mirrored), every generated
 * file is a valid create-test body with the `_otto` tag, generation is
 * deterministic, the committed test_configs/ match a fresh run, and the
 * scenario-specific facts hold (#8 never fired, #2 measured distances
 * but no stop and no passes, Italian for #1 only, a row without an
 * Otto says line opens with the app's greeting the way the phone does).
 *
 *   node --test elevenlabs/test/generate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadSheet, loadRoute, loadSupabase } from '../lib/sheet.mjs';
import { agentVars, agentBriefing, agentGreeting, LANG_TEXT, fillParams, initDynamicVariables, questionFor, stripQuotes } from '../lib/scenario-vars.mjs';
import { buildTests, buildTest, tipCategory, PERSONAS, IT_ROWS, DEFAULT_OUT } from '../generate-tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const GEN = path.join(HERE, '..', 'generate-tests.mjs');

/* C5 — the key set the phone sends, as the shared contract lists it */
const C5_KEYS = [
  'destination_title', 'destination_address', 'destination_lat', 'destination_lng', 'destination_consignee',
  'destination_floor', 'destination_notes', 'scenario_num', 'scenario_title', 'scenario_version',
  'scenario_question', 'debrief_language', 'scenario_rule', 'scenario_ar_states', 'scenario_signals',
  'scenario_timing', 'scenario_test_steps', 'expected_tip_type', 'trigger_fired', 'trigger_passes',
  'trigger_stopped', 'park_distance_m', 'walk_m', 'activity_state', 'activity_summary', 'distance_to_pin_m',
];

/* the keys agentVars() in app.js assigns, read from the source: every
 * `key:` of the `const v = {…}` literal plus every `v.key =` after it */
function keysInAppJs() {
  const src = readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const start = src.indexOf('function agentVars()');
  assert.ok(start > 0, 'app.js has no function agentVars()');
  const fn = src.slice(start, src.indexOf('\n}\n', start));
  const lit = fn.slice(fn.indexOf('const v = {'), fn.indexOf('\n  };', fn.indexOf('const v = {')));
  const keys = new Set();
  for (const m of lit.matchAll(/^\s+([a-z][a-z0-9_]*):\s/gm)) keys.add(m[1]);
  for (const m of fn.matchAll(/\bv\.([a-z][a-z0-9_]*)\s*=[^=]/g)) keys.add(m[1]);
  return keys;
}

/* the two `at` greetings of LANG_TEXT in app.js, evaluated out of the
 * source: `at: d => \`…\`,` under en then it */
function greetingsInAppJs() {
  const src = readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const found = [...src.matchAll(/^\s+at: (d => `[^`\n]*`),$/gm)].map(m => new Function('return ' + m[1])());
  assert.equal(found.length, 2, 'app.js should carry exactly two LANG_TEXT.at lines (en, it)');
  return { en: found[0], it: found[1] };
}

const sheet = loadSheet();
const stops = loadRoute('route-kollwitz.js').stops;
/* a park-and-walk run as the phone's tracking object holds it when the
 * trigger fires: parkWalkStep counts no passes and marks no stop */
const FULL = {
  scenario: sheet[1], destination: stops[0],
  run: { fired: true, passes: 0, stopped: false, shape: 'parkwalk', park_distance_m: 310, walk_m: 340 },
  activity: { state: 'STILL', summary: 'IN_VEHICLE 4m → STILL 40s' }, distance_to_pin_m: 12,
};

test('the sheet loads without a browser: ten rows, numbered 1..10', () => {
  assert.equal(sheet.length, 10);
  assert.deepEqual(sheet.map(s => s.num), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(sheet.every(s => s.title && s.otto_says && Array.isArray(s.params)));
  assert.equal(stops.length, 12);
});

test('agentVars mirrors app.js: same key set, read out of the source at test time', () => {
  const fromApp = keysInAppJs();
  assert.ok(fromApp.size >= 20, `only ${fromApp.size} keys found in app.js — the regex lost the literal`);
  const ours = new Set(Object.keys(agentVars(FULL)));
  assert.deepEqual([...ours].sort(), [...fromApp].sort(), 'lib/scenario-vars.mjs has drifted from agentVars() in app.js');
  assert.deepEqual([...ours].sort(), [...C5_KEYS].sort(), 'the key set no longer matches contract C5');
  /* and in the same order as the phone builds them */
  assert.deepEqual(Object.keys(agentVars(FULL)).slice(0, -1), C5_KEYS.slice(0, -1));
});

test('the phone helpers, ported: quotes, params, the variable filter', () => {
  assert.equal(stripQuotes('“Is it hard to park here?”'), 'Is it hard to park here?');
  assert.equal(stripQuotes(' "x" '), 'x');
  const params = [{ key: 'radius', value: 150 }, { key: 'speed', value: 9 }, { key: 'half', value: 0.5 }, { key: 'odd', value: 2.345 }, { key: 'big', value: 120.4 }];
  assert.equal(fillParams('{radius} {speed} {half} {odd} {big} {missing}', params), '150 9 0.5 2.35 120 {missing}');
  assert.deepEqual(initDynamicVariables({ a: '', b: null, c: undefined, d: 0, e: 'x', f: 2.5, g: false }), { d: 0, e: 'x', f: 2.5, g: false });
});

test('a hand-opened debrief after tracking ended sends no measurements at all', () => {
  const v = agentVars({ scenario: sheet[7], destination: stops[9], run: null, activity: null, distance_to_pin_m: 140 });
  assert.equal(v.trigger_fired, 'no');
  const dv = initDynamicVariables(v);
  for (const k of ['trigger_passes', 'trigger_stopped', 'park_distance_m', 'walk_m', 'activity_state', 'activity_summary']) assert.ok(!(k in dv), k + ' should be omitted');
  assert.equal(dv.distance_to_pin_m, 140);
  assert.match(agentBriefing(v), /opened by hand — the trigger did not fire/);
});

test('the park-and-walk row quotes its measured distances in the question and the briefing', () => {
  const v = agentVars(FULL);
  assert.equal(v.scenario_question, 'You parked about 310 m out and walked 340 m — was there nothing closer, or is that the smart spot for this address?');
  assert.equal(v.park_distance_m, 310);
  assert.equal(v.trigger_stopped, 'no');
  assert.equal(v.trigger_passes, 0);
  assert.match(agentBriefing(v), /the phone measured parked 310 m from the pin, walked 340 m\./);
  /* a pass/stop run measures neither, and says nothing about them */
  const ps = agentVars({ ...FULL, scenario: sheet[0], run: { fired: true, passes: 2, stopped: true, shape: 'passstop' } });
  assert.equal(ps.park_distance_m, '');
  assert.equal(ps.walk_m, '');
  assert.match(agentBriefing(ps), /2 slow passes near the pin, a stop\./);
  /* Italian: the translated line when it is cached, the English one otherwise */
  assert.equal(questionFor(sheet[0], { lang: 'it', saysIt: {} }).text, 'Is it hard to park here at this time? Where did you find a spot?');
  assert.equal(questionFor(sheet[0], { lang: 'it', saysIt: { 'Is it hard to park here at this time? Where did you find a spot?': 'Ciao?' } }).text, 'Ciao?');
  assert.match(agentBriefing(ps, 'it'), /conduct the entire debrief in Italian/);
});

/* C4 + the create-test body, checked by hand: the shape POST
 * /v1/convai/agent-testing/create takes for type "simulation" */
const TOP_KEYS = ['name', 'type', 'dynamic_variables', 'chat_history', 'simulation_scenario', 'simulation_max_turns', 'success_conditions', '_otto'];
function validate(body, file) {
  const at = `${file}: `;
  assert.deepEqual(Object.keys(body).sort(), [...TOP_KEYS].sort(), at + 'unexpected top-level keys');
  assert.equal(body.type, 'simulation', at + 'type');
  assert.match(body.name, /^Otto · (#\d+ )?[^·]+ · (cooperative|terse|sidetracked)( · it)?$/, at + 'name per C4');
  assert.equal(typeof body.simulation_scenario, 'string');
  assert.ok(body.simulation_scenario.length > 200, at + 'simulation_scenario too short');
  assert.ok(Number.isInteger(body.simulation_max_turns) && body.simulation_max_turns >= 1 && body.simulation_max_turns <= 50, at + 'simulation_max_turns');
  assert.ok(Array.isArray(body.success_conditions) && body.success_conditions.length >= 4 && body.success_conditions.length <= 6, at + 'success_conditions count');
  body.success_conditions.forEach(c => assert.ok(typeof c === 'string' && c.trim().length > 40, at + 'condition too short'));
  assert.ok(body.dynamic_variables && typeof body.dynamic_variables === 'object', at + 'dynamic_variables');
  for (const [k, v] of Object.entries(body.dynamic_variables)) {
    assert.ok(C5_KEYS.includes(k), at + `dynamic variable ${k} is not one the phone sends`);
    assert.ok(typeof v === 'string' || typeof v === 'number', at + `dynamic variable ${k} must be a string or number`);
    assert.notEqual(v, '', at + `dynamic variable ${k} is empty — initPayload would have omitted it`);
  }
  for (const k of ['destination_title', 'scenario_title', 'debrief_language', 'trigger_fired', 'expected_tip_type']) assert.ok(k in body.dynamic_variables, at + k + ' missing');
  assert.ok(Array.isArray(body.chat_history) && body.chat_history.length === 1, at + 'chat_history');
  body.chat_history.forEach(m => {
    assert.ok(m.role === 'user' || m.role === 'agent', at + 'chat_history role');
    assert.ok(Number.isInteger(m.time_in_call_secs), at + 'chat_history time_in_call_secs');
    assert.equal(typeof m.message, 'string');
  });
  assert.equal(body.chat_history[0].role, 'agent');
  /* the opener is what the phone puts in first_message: the row's
   * question, or the app's greeting when the row has no Otto says line
   * (then scenario_question is not sent either) */
  const opener = body.chat_history[0].message;
  if ('scenario_question' in body.dynamic_variables) assert.equal(opener, body.dynamic_variables.scenario_question, at + 'the opener is the scenario question');
  else assert.equal(opener, LANG_TEXT[body._otto.language].at({ title: body.dynamic_variables.destination_title, addr: body.dynamic_variables.destination_address }), at + 'a row without an Otto says line opens with the app\'s greeting');
  assert.ok(body.success_conditions[0].includes(`“${opener}”`), at + 'the first condition quotes the opener');
  const o = body._otto;
  assert.deepEqual(Object.keys(o).sort(), ['briefing', 'kind', 'language', 'persona', 'scenario_num', 'scenario_title'].sort(), at + '_otto keys');
  assert.equal(o.kind, 'scenario');
  assert.ok(o.scenario_num === null || Number.isInteger(o.scenario_num), at + '_otto.scenario_num');
  assert.equal(typeof o.scenario_title, 'string');
  assert.ok(PERSONAS.some(p => p.id === o.persona), at + '_otto.persona');
  assert.ok(o.language === 'en' || o.language === 'it', at + '_otto.language');
  assert.match(o.briefing, /^You are Otto, debriefing/);
  assert.match(file, /^scenario-\d\d-[a-z0-9-]+--(cooperative|terse|sidetracked)(-it)?\.json$/, at + 'file name per C4');
}

const built = buildTests(sheet);

test('the starter sheet yields 10 rows × 3 personas in English + 3 Italian variants, all valid', () => {
  assert.equal(built.length, 10 * PERSONAS.length + IT_ROWS.size * PERSONAS.length);
  built.forEach(t => validate(t.body, t.file));
  /* every starter row has an Otto says line, so every test opens with it */
  built.forEach(t => assert.ok('scenario_question' in t.body.dynamic_variables, t.file + ' lost its scenario question'));
  assert.equal(new Set(built.map(t => t.file)).size, built.length, 'file names collide');
  assert.equal(new Set(built.map(t => t.body.name)).size, built.length, 'test names collide');
  const en1 = built.find(t => t.file === 'scenario-01-parking-loops--cooperative.json');
  assert.equal(en1.body.name, 'Otto · #1 Parking loops · cooperative');
  assert.equal(en1.body.dynamic_variables.scenario_num, 1);
  assert.equal(en1.body.dynamic_variables.trigger_passes, 2);
  assert.equal(en1.body.dynamic_variables.destination_title, 'Sredzkistraße 20');
  assert.match(en1.body.dynamic_variables.destination_notes, /^a driver reported: /);
  assert.match(en1.body.dynamic_variables.scenario_rule, /~150 m of the stop 2× below 9 m\/s/);
});

test('scenario 8 never fired: trigger_fired is "no" and nothing was measured', () => {
  const eight = built.filter(t => t.body._otto.scenario_num === 8);
  assert.equal(eight.length, PERSONAS.length);
  eight.forEach(t => {
    assert.equal(t.body.dynamic_variables.trigger_fired, 'no');
    for (const k of ['trigger_passes', 'trigger_stopped', 'park_distance_m', 'walk_m', 'activity_summary']) assert.ok(!(k in t.body.dynamic_variables), k);
    assert.ok(t.body.success_conditions.some(c => /never claims to have seen, counted or measured/.test(c)));
    assert.match(t.body.simulation_scenario, /The trigger did not fire on this run/);
  });
});

test('the park-and-walk row sends what parkWalkStep measures: distances, no stop, no passes', () => {
  const two = built.filter(t => t.body._otto.scenario_num === 2);
  assert.equal(two.length, PERSONAS.length);
  two.forEach(t => {
    const dv = t.body.dynamic_variables;
    assert.equal(dv.trigger_fired, 'yes');
    assert.equal(dv.trigger_stopped, 'no', t.file + ': the park-and-walk detector never marks a stop');
    assert.equal(dv.trigger_passes, 0, t.file + ': the park-and-walk detector never counts passes');
    assert.equal(dv.park_distance_m, 310);
    assert.equal(dv.walk_m, 340);
    /* and neither side of the test quotes a stop the phone never reported */
    for (const text of [t.body.simulation_scenario, t.body._otto.briefing, ...t.body.success_conditions]) {
      assert.ok(!/a stop,|measured a stop/.test(text), t.file + ': quotes a stop');
    }
    assert.match(t.body.simulation_scenario, /the phone measured parked 310 m from the pin, walked 340 m;/);
    assert.match(t.body._otto.briefing, /the phone measured parked 310 m from the pin, walked 340 m\./);
    assert.ok(t.body.success_conditions.some(c => /the phone measured parked 310 m from the pin, walked 340 m —/.test(c)));
  });
  /* a designer's own park-and-walk row: the generic fixture measures
   * the same way, even when the row also carries a passes_needed knob */
  const pw = buildTest({ sc: { title: 'Far park', otto_says: 'Where did you leave the van?', learns: 'parking', params: [{ key: 'arrival_radius', value: 25 }, { key: 'passes_needed', value: 3 }] }, persona: PERSONAS[0], lang: 'en', stops });
  assert.equal(pw.body.dynamic_variables.trigger_stopped, 'no');
  assert.equal(pw.body.dynamic_variables.trigger_passes, 0);
  assert.equal(pw.body.dynamic_variables.park_distance_m, 250);
  assert.equal(pw.body.dynamic_variables.walk_m, 220);
  /* …while a pass/stop row stops, with the passes its params ask for */
  const ps = buildTest({ sc: { title: 'Loops', otto_says: 'Hard to park?', learns: 'parking', params: [{ key: 'passes_needed', value: 3 }] }, persona: PERSONAS[0], lang: 'en', stops });
  assert.equal(ps.body.dynamic_variables.trigger_stopped, 'yes');
  assert.equal(ps.body.dynamic_variables.trigger_passes, 3);
  assert.ok(!('park_distance_m' in ps.body.dynamic_variables));
});

test('a row without an Otto says line opens with the app\'s greeting, as the phone overrides first_message', () => {
  /* the greeting mirrors app.js word for word, in both languages */
  const fromApp = greetingsInAppJs();
  for (const d of [{ title: 'Sredzkistraße 20', addr: 'Sredzkistraße 20, 10435 Berlin' }, { title: 'Stop 3' }]) {
    assert.equal(LANG_TEXT.en.at(d), fromApp.en(d), 'LANG_TEXT.en.at has drifted from app.js');
    assert.equal(LANG_TEXT.it.at(d), fromApp.it(d), 'LANG_TEXT.it.at has drifted from app.js');
  }
  assert.equal(agentGreeting(sheet[0], stops[6]), 'Is it hard to park here at this time? Where did you find a spot?');
  assert.equal(agentGreeting({ title: 'No line' }, { title: 'Stop 3' }), 'This is Stop 3. What\'s the situation there? Tap the mic and describe what you see.');
  assert.equal(agentGreeting({ title: 'No line' }, null, { lang: 'it' }), 'Tocca il microfono e dimmi cosa hai trovato.');
  /* and a generated test carries it, not the keyless recorder's "What did you find?" */
  const row = { num: 12, title: 'Silent row — no opener on the sheet', otto_says: '', learns: 'access', params: [] };
  for (const lang of ['en', 'it']) {
    const t = buildTest({ sc: row, persona: PERSONAS[0], lang, stops });
    validate(t.body, t.file);
    const dv = t.body.dynamic_variables;
    assert.ok(!('scenario_question' in dv), 'no scenario_question without an Otto says line');
    const want = LANG_TEXT[lang].at({ title: dv.destination_title, addr: dv.destination_address });
    assert.equal(t.body.chat_history[0].message, want);
    assert.match(t.body.chat_history[0].message, lang === 'it' ? /^Questa è .+ Com'è la situazione lì\?/ : /^This is .+ What's the situation there\?/);
    assert.ok(!/What did you find\?|Cosa hai trovato\?/.test(JSON.stringify(t.body)), 'the recorder\'s line leaked into the test');
    assert.ok(t.body.success_conditions[0].includes(`“${want}”`));
  }
});

test('Italian variants exist for #1 only, and say so in the variables', () => {
  const it = built.filter(t => t.body._otto.language === 'it');
  assert.equal(it.length, PERSONAS.length);
  it.forEach(t => {
    assert.equal(t.body._otto.scenario_num, 1);
    assert.equal(t.body.dynamic_variables.debrief_language, 'Italian');
    assert.match(t.body.name, / · it$/);
    assert.match(t.file, /-it\.json$/);
    assert.match(t.body.chat_history[0].message, /^È difficile parcheggiare/);
    assert.ok(t.body.success_conditions.some(c => /Every agent turn is in Italian/.test(c)));
    assert.match(t.body._otto.briefing, /entire debrief in Italian/);
  });
  built.filter(t => t.body._otto.language === 'en').forEach(t => assert.equal(t.body.dynamic_variables.debrief_language, 'English'));
  assert.equal(buildTests(sheet, { langs: ['it'] }).length, PERSONAS.length);
  assert.equal(buildTests(sheet, { langs: ['en'], only: 4 }).length, PERSONAS.length);
});

test('the tip category is the word the "learns" column leads with', () => {
  assert.deepEqual(sheet.map(s => tipCategory(s.learns)), ['parking', 'parking', 'parking', 'access', 'address', 'recipient', 'other', 'hazard', 'hazard', 'none']);
  assert.equal(tipCategory('A parking tip'), 'parking');
  assert.equal(tipCategory('the way the courtyard opens'), 'other');
  assert.equal(tipCategory(''), 'none');
  const ten = built.find(t => t.file === 'scenario-10-clean-run--cooperative.json');
  assert.ok(ten.body.success_conditions.some(c => /ordinary delivery with nothing to report/.test(c)));
  assert.ok(ten.body.success_conditions.some(c => /within two of its own turns/.test(c)));
});

test('a designer\'s own row without a number still gets a valid test', () => {
  const row = { title: 'Courtyard gate — the code changes weekly', rule: 'Stop within {r} m', otto_says: '“Did the gate code work?”', learns: 'gate_code — the current code', test_steps: 'Go to the gate', params: [{ key: 'r', value: 40 }] };
  const t = buildTest({ sc: row, persona: PERSONAS[1], lang: 'en', stops });
  validate(t.body, t.file);
  assert.equal(t.body.name, 'Otto · Courtyard gate · terse');
  assert.equal(t.file, 'scenario-00-courtyard-gate-the-code-changes-weekly--terse.json');
  assert.equal(t.body._otto.scenario_num, null);
  assert.ok(!('scenario_num' in t.body.dynamic_variables));
  assert.equal(t.body.dynamic_variables.scenario_rule, 'Stop within 40 m');
  assert.ok(t.body.success_conditions.some(c => /type "gate_code"/.test(c)));
  assert.equal(t.body.success_conditions.length, 5);
});

test('generation is deterministic: the CLI run twice writes byte-identical files', () => {
  const a = mkdtempSync(path.join(tmpdir(), 'otto-gen-a-'));
  const b = mkdtempSync(path.join(tmpdir(), 'otto-gen-b-'));
  try {
    const out = execFileSync(process.execPath, [GEN, '--sheet', '--out', a], { encoding: 'utf8' });
    assert.match(out, /GENERATE — 10 scenario\(s\) from the starter sheet × 3 persona\(s\) → 33 test\(s\)/);
    assert.match(out, /wrote 33 file\(s\)/);
    execFileSync(process.execPath, [GEN, '--sheet', '--out', b], { encoding: 'utf8' });
    const fa = readdirSync(a).sort(), fb = readdirSync(b).sort();
    assert.deepEqual(fa, fb);
    assert.equal(fa.length, 33);
    fa.forEach(f => assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), f + ' differs between runs'));
    /* a stale file in scope goes, one out of scope (another language) stays */
    const again = execFileSync(process.execPath, [GEN, '--sheet', '--out', a, '--lang', 'en', '--scenario', '2'], { encoding: 'utf8' });
    assert.match(again, /wrote 3 file\(s\) to .*; 0 stale removed/);
    assert.equal(readdirSync(a).length, 33);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the committed test_configs/ match a fresh generation from the sheet', () => {
  const files = readdirSync(DEFAULT_OUT).filter(f => /^scenario-.*\.json$/.test(f)).sort();
  assert.deepEqual(files, built.map(t => t.file).sort(), 'test_configs/ has a different file set — re-run npm run generate');
  built.forEach(t => {
    const onDisk = readFileSync(path.join(DEFAULT_OUT, t.file), 'utf8');
    assert.equal(onDisk, JSON.stringify(t.body, null, 2) + '\n', t.file + ' is stale — re-run npm run generate');
  });
});

test('--supabase reads the scenarios table with the anon key, the way tune_triggers.py does', async () => {
  const seen = [];
  const rows = [
    { num: 3, title: 'Row three', otto_says: '“Q3?”', learns: 'parking', params: [] },
    { num: null, title: 'Unnumbered', otto_says: 'Q?', learns: 'access' },
    { num: 4, title: 'Empty cell', otto_says: '', learns: 'access', params: [] },
  ];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, apikey: req.headers.apikey, auth: req.headers.authorization });
    if (req.url.includes('boom')) { res.writeHead(500); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const got = await loadSupabase(base + '/', 'anon-key');
    assert.deepEqual(got, rows);
    assert.deepEqual(seen[0], { url: '/rest/v1/scenarios?select=*&order=num.asc.nullslast', apikey: 'anon-key', auth: 'Bearer anon-key' });
    const tests = buildTests(got, { langs: ['en'], stops });
    assert.equal(tests.length, 3 * PERSONAS.length);
    assert.equal(tests[0].body._otto.scenario_num, 3);
    assert.equal(tests[2 * PERSONAS.length].body._otto.scenario_num, null, 'unnumbered rows sort last');
    tests.forEach(t => validate(t.body, t.file));
    /* the CLI, end to end through the same server: the row with the
     * empty cell is generated, and the designer is told what it opens
     * with. Spawned asynchronously — the server answering the child
     * lives on this process's event loop, which execFileSync would block */
    const out = mkdtempSync(path.join(tmpdir(), 'otto-gen-sb-'));
    try {
      const { stdout: log } = await promisify(execFile)(process.execPath, [GEN, '--supabase', base, 'anon-key', '--lang', 'en', '--out', out], { encoding: 'utf8' });
      assert.match(log, /GENERATE — 3 scenario\(s\) from Supabase \(http:\/\/127\.0\.0\.1:\d+\) × 3 persona\(s\) → 9 test\(s\)/);
      assert.match(log, /^note: "Empty cell" has no Otto says line — its tests open with the app's own greeting, as the phone would$/m);
      assert.equal((log.match(/^note: /gm) || []).length, 1, 'one note per row, not per test');
      const empty = JSON.parse(readFileSync(path.join(out, 'scenario-04-empty-cell--cooperative.json'), 'utf8'));
      assert.match(empty.chat_history[0].message, /^This is .+ What's the situation there\?/);
      assert.ok(!('scenario_question' in empty.dynamic_variables));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }
});
