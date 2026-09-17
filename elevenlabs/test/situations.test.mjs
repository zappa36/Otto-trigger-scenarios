/*
 * The situation suite against its contract. A situation is what a
 * driver REPORTS after pressing the big button — there is no trigger in
 * the pilot — so these tests hold the shape that makes such a test mean
 * something: the phone's variables and nothing more (no scenario, no
 * measurements), no chat_history (Otto opens with his own first message,
 * as the button flow leaves him to), the driver's own first line, and
 * the six conditions in their order — relevance, no repetition, natural,
 * no invention, length, close — with the control row's three swapped
 * round and a seventh for the driver who says nothing in particular.
 *
 * The rows come from the dashboard at run time, so both sources are
 * exercised: the live table, and the starter sheet the generator falls
 * back to when a project has no table yet or nothing active in it.
 *
 *   node --test elevenlabs/test/situations.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMock } from './mock-elevenlabs.mjs';
import { loadSituationsSheet, loadRoute } from '../lib/sheet.mjs';
import { notesOnFile } from '../lib/scenario-vars.mjs';
import {
  buildSituationTests, buildSituationTest, SITUATION_PERSONAS, SITUATION_VARS, needsNoFollowUp, listOf,
} from '../generate-tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(HERE, '..', 'generate-tests.mjs');
const FIXTURE = path.join(HERE, 'fixture');

const rows = loadSituationsSheet();
const stops = loadRoute('route-kollwitz.js').stops;
const built = buildSituationTests(rows, { stops });
const tmp = () => mkdtempSync(path.join(tmpdir(), 'otto-sit-'));

/* the six conditions, by the word each one opens with */
const HEADS = ['RELEVANCE', 'NO REPETITION', 'NATURAL', 'NO INVENTION', 'LENGTH', 'CLOSE'];

function validate(body, file) {
  const at = `${file}: `;
  assert.equal(body.type, 'simulation', at + 'type');
  assert.match(body.name, /^Otto · situation #\d+ .+ · (cooperative|terse|sidetracked|vague)$/, at + 'name');
  assert.match(file, /^situation-\d\d-[a-z0-9-]+--(cooperative|terse|sidetracked|vague)\.json$/, at + 'file name');
  /* the pilot's button flow: the agent's own first message opens it */
  assert.ok(!('chat_history' in body), at + 'a situation test must not script the first turn');
  assert.equal(body.simulation_max_turns, body._otto.persona === 'vague' ? 10 : 8, at + 'turns');
  /* the driver and the judge are cast by name, never left to the platform's default */
  assert.equal(body.simulated_user_model, 'claude-sonnet-4-6', at + 'simulated_user_model');
  assert.equal(body.evaluation_model, 'claude-sonnet-4-6', at + 'evaluation_model');
  assert.match(body.simulation_scenario, /^You are a parcel-delivery driver on a round in Berlin\./, at + 'the driver, first person');
  assert.match(body.simulation_scenario, /pressed the big REPORT button/, at + 'why they are talking to Otto');
  assert.match(body.simulation_scenario, /What you know if Otto asks, and only when he asks: /, at + 'what is held back');
  assert.match(body.simulation_scenario, /Ground rules: stay in character as the driver; never mention being simulated/, at + 'ground rules');
  /* the judge's word per check is read, not guessed — every condition asks for it */
  body.success_conditions.forEach(c => assert.ok(c.endsWith(' Start your answer with PASS or FAIL, then the reason.'), at + 'condition without the verdict ask'));
  assert.match(body.simulation_scenario, /when Otto lets you go, say a short goodbye and stop\.$/, at + 'the end of the call');
  const heads = body.success_conditions.map(c => c.split(' — ')[0]);
  assert.deepEqual(heads.slice(0, 6), HEADS, at + 'the six conditions, in order');
  assert.equal(body.success_conditions.length, body._otto.persona === 'vague' ? 7 : 6, at + 'how many conditions');
  body.success_conditions.forEach((c, i) => assert.ok(c.length > 80, `${at}condition ${i + 1} is too short to stand on its own`));
  const o = body._otto;
  assert.deepEqual(Object.keys(o), ['kind', 'situation_num', 'situation_title', 'persona', 'language', 'scenario_num', 'scenario_title'], at + '_otto keys');
  assert.equal(o.kind, 'situation');
  assert.ok(Number.isInteger(o.situation_num) || o.situation_num === null, at + '_otto.situation_num');
  assert.equal(o.language, 'en');
  assert.equal(o.scenario_num, null, at + 'a situation is not a trigger scenario');
  assert.equal(o.scenario_title, null);
  assert.ok(SITUATION_PERSONAS.some(p => p.id === o.persona), at + '_otto.persona');
}

test('the starter sheet yields twenty situations × four personas, all valid', () => {
  assert.equal(rows.length, 20);
  assert.equal(SITUATION_PERSONAS.map(p => p.id).join(','), 'cooperative,terse,sidetracked,vague');
  assert.equal(built.length, 20 * 4);
  built.forEach(t => validate(t.body, t.file));
  assert.equal(new Set(built.map(t => t.file)).size, built.length, 'file names collide');
  assert.equal(new Set(built.map(t => t.body.name)).size, built.length, 'test names collide');
  const one = built.find(t => t.file === 'situation-01-road-closed--cooperative.json');
  assert.equal(one.body.name, 'Otto · situation #1 Road closed · cooperative');
  assert.equal(one.body._otto.situation_title, 'Road closed — could not reach the address');
});

test('a situation test sends what the phone sends with no scenario and no trigger — and nothing else', () => {
  for (const t of built) {
    const keys = Object.keys(t.body.dynamic_variables);
    /* the whole key set, in one place: a trigger variable here would be
     * a measurement the pilot's phone never made */
    assert.ok(keys.every(k => SITUATION_VARS.includes(k)), `${t.file}: ${keys.filter(k => !SITUATION_VARS.includes(k)).join(', ')} is not sent by the REPORT button`);
    assert.equal(t.body.dynamic_variables.debrief_language, 'English');
    assert.equal(t.body.dynamic_variables.trigger_fired, 'no');
    assert.equal(typeof t.body.dynamic_variables.destination_lat, 'number');
  }
  /* a stop with notes on file sends them; one without sends the key at
   * all, the way initPayload drops an empty value */
  const withNotes = built.find(t => t.body._otto.situation_num === 1);  // stop 4, a driver's note
  assert.deepEqual(Object.keys(withNotes.body.dynamic_variables), SITUATION_VARS);
  assert.match(withNotes.body.dynamic_variables.destination_notes, /^a driver reported: The front door is locked before 09:00/);
  const stop3 = stops.find(s => s.stop === 3);
  assert.equal(notesOnFile(stop3).length, 0, 'the fixture stop for #20 has no notes — that is the point of it');
  const noNotes = built.find(t => t.body._otto.situation_num === 20);   // stop 3, no notes
  assert.deepEqual(Object.keys(noNotes.body.dynamic_variables), SITUATION_VARS.filter(k => k !== 'destination_notes'));
});

test('a situation is set at its own stop, and the driver reports it in its own words', () => {
  const dog = built.find(t => t.file === 'situation-02-a-big-dog-at-the-door--terse.json');
  const row = rows.find(r => r.num === 2);
  const stop = stops.find(s => s.stop === row.stop);
  assert.equal(dog.body.dynamic_variables.destination_title, stop.title);
  assert.equal(dog.body.dynamic_variables.destination_consignee, stop.consignee);
  assert.ok(dog.body.simulation_scenario.includes(`“${row.driver_says}”`), 'the driver opens with the row\'s own line');
  assert.ok(dog.body.simulation_scenario.includes(row.driver_knows), 'and knows what the row says, when asked');
  assert.ok(dog.body.success_conditions[0].includes(row.follow_up[0]), 'relevance names what a fitting follow-up asks about');
  assert.ok(dog.body.success_conditions[0].includes(row.off_topic[0]), 'and what would not fit');
  assert.ok(dog.body.success_conditions[5].includes(row.tip.replace(/\.$/, '')), 'the close names the tip');
  /* the platform speaks the greeting before Otto's first turn — it is not one of his questions */
  assert.match(dog.body.success_conditions[4], /^LENGTH — after the driver has said what happened, Otto asks at most three follow-up questions/);
  assert.match(dog.body.success_conditions[4], /One good question is enough/);
  assert.match(dog.body.success_conditions[4], /opening greeting[^.]*does not count/);
  assert.doesNotMatch(dog.body.success_conditions[4], /opening question included/);
  /* only the cooperative driver is allowed to volunteer anything */
  assert.doesNotMatch(dog.body.simulation_scenario, /you may add one useful detail/);
  assert.match(built.find(t => t.file === 'situation-02-a-big-dog-at-the-door--cooperative.json').body.simulation_scenario, /you may add one useful detail/);
  /* a row without a stop of its own still lands on one of the twelve */
  const free = buildSituationTests([{ num: 3, title: 'No stop of its own', driver_says: 'x', driver_knows: 'y', follow_up: ['a'], off_topic: ['b'], tip: 'z' }], { stops });
  assert.equal(free[0].body.dynamic_variables.destination_title, stops[2].title);
});

test('the control row grades the opposite way round: no probing, one question, no invented tip', () => {
  const row = rows.find(r => r.num === 20);
  assert.ok(needsNoFollowUp(row), 'row #20 is the control — its follow_up column says nothing is needed');
  assert.ok(!rows.filter(r => r.num !== 20).some(needsNoFollowUp), 'no other starter row is a control');
  const t = built.find(t => t.file === 'situation-20-nothing-to-report--terse.json').body;
  assert.match(t.success_conditions[0], /Otto asks at most one short question to confirm that and does not go looking for a problem/);
  assert.match(t.success_conditions[0], /Probing for something that was not there fails\./);
  assert.match(t.success_conditions[4], /^LENGTH — after his opening message Otto asks at most one question, then closes\./);
  assert.match(t.success_conditions[5], /^CLOSE — Otto ends by confirming that there is nothing to note about Knaackstraße 22/);
  assert.match(t.success_conditions[5], /Inventing a tip for a stop where nothing happened fails\./);
  /* the three that hold whatever the row says still hold here */
  assert.match(t.success_conditions[1], /^NO REPETITION/);
  assert.match(t.success_conditions[2], /^NATURAL/);
  assert.match(t.success_conditions[3], /^NO INVENTION/);
  /* a row whose follow_up is empty altogether is a control too */
  assert.ok(needsNoFollowUp({ follow_up: [] }) && needsNoFollowUp({ follow_up: ['none'] }));
  assert.ok(!needsNoFollowUp({ follow_up: ['nothing showed up on the bell panel'] }) === false, 'the word has to lead the item');
});

test('the vague driver gets a seventh condition: one open question before anything specific', () => {
  const vague = built.filter(t => t.body._otto.persona === 'vague');
  assert.equal(vague.length, 20);
  vague.forEach(t => {
    assert.equal(t.body.success_conditions.length, 7);
    assert.match(t.body.success_conditions[6], /^OPEN QUESTION FIRST — the driver's first words do not say what happened/);
    assert.match(t.body.simulation_scenario, /You open with something unclear that does not say what happened/);
    assert.equal(t.body.simulation_max_turns, 10, 'the vague opener costs an exchange before the report even starts');
  });
  built.filter(t => t.body._otto.persona !== 'vague').forEach(t => {
    assert.ok(!t.body.success_conditions.some(c => /^OPEN QUESTION FIRST/.test(c)), t.file);
    assert.equal(t.body.simulation_max_turns, 8);
  });
});

test('generation is deterministic: the CLI run twice writes byte-identical files', () => {
  const a = tmp(), b = tmp();
  try {
    const out = execFileSync(process.execPath, [GEN, '--situations', '--sheet', '--out', a], { encoding: 'utf8' });
    assert.match(out, /GENERATE — 20 situation\(s\) from the starter sheet × 4 persona\(s\) → 80 test\(s\)/);
    assert.match(out, /wrote 80 file\(s\)/);
    assert.match(out, /^note: "Nothing to report — a normal delivery" asks for no follow-up/m);
    execFileSync(process.execPath, [GEN, '--situations', '--sheet', '--out', b], { encoding: 'utf8' });
    const fa = readdirSync(a).sort(), fb = readdirSync(b).sort();
    assert.deepEqual(fa, fb);
    assert.equal(fa.length, 80);
    fa.forEach(f => assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), f + ' differs between runs'));
    /* what the builder makes is what the CLI wrote */
    built.forEach(t => assert.equal(readFileSync(path.join(a, t.file), 'utf8'), JSON.stringify(t.body, null, 2) + '\n', t.file));
    /* one row only: the other 76 files are left where they are */
    const again = execFileSync(process.execPath, [GEN, '--situations', '--sheet', '--out', a, '--situation', '2'], { encoding: 'utf8' });
    assert.match(again, /wrote 4 file\(s\) to .*; 0 stale removed/);
    assert.equal(readdirSync(a).length, 80);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the flags of the two suites do not cross, and the situation suite is English only', () => {
  const fails = args => {
    try { execFileSync(process.execPath, [GEN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stderr || ''); }
    throw new Error(`${args.join(' ')} did not fail`);
  };
  assert.match(fails(['--situations', '--lang', 'it']), /the situation suite is English only/);
  assert.match(fails(['--situations', '--scenario', '2']), /--scenario picks a trigger row; with --situations use --situation N/);
  assert.match(fails(['--situation', '2']), /--situation picks a situation row; without --situations use --scenario N/);
  assert.match(fails(['--file', 'rows.json']), /--file is the situation suite's/);
});

test('--situations reads the situations table, and falls back to the sheet when there is none', async () => {
  const mock = await startMock(FIXTURE);
  const run = async args => {
    const out = tmp();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [GEN, '--situations', '--supabase', mock.url, 'anon-key', '--out', out, ...args], { encoding: 'utf8' });
      const files = readdirSync(out).sort();
      /* read them here: the folder goes with the call */
      const bodies = Object.fromEntries(files.map(f => [f, JSON.parse(readFileSync(path.join(out, f), 'utf8'))]));
      return { log: stdout, files, read: f => bodies[f] };
    } finally { rmSync(out, { recursive: true, force: true }); }
  };
  try {
    /* the live rows: the active ones only, in num order, each one a test
     * per persona — and a row without a stop still gets one */
    let r = await run([]);
    assert.match(r.log, /GENERATE — 2 situation\(s\) from Supabase \(http:\/\/127\.0\.0\.1:\d+\) × 4 persona\(s\) → 8 test\(s\)/);
    assert.equal(r.files.length, 8);
    assert.deepEqual(r.files.filter(f => f.endsWith('--vague.json')), ['situation-02-letterbox-full--vague.json', 'situation-05-building-site-mud-across-the-path--vague.json']);
    const got = mock.requests.filter(x => x.path === '/rest/v1/situations');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].query, { select: '*', active: 'eq.true', order: 'num.asc.nullslast' });
    assert.ok(got[0].auth.apikey && got[0].auth.bearer, 'the anon key in both headers, like every Supabase read');
    const one = r.read('situation-02-letterbox-full--cooperative.json');
    validate(one, 'situation-02-letterbox-full--cooperative.json');
    assert.equal(one._otto.situation_title, 'Letterbox full — card would not fit');
    assert.equal(one.dynamic_variables.destination_title, 'Husemannstraße 14', 'the row\'s own stop');
    assert.ok(one.success_conditions[0].includes('whether anybody was home'), 'follow_up came through as jsonb');
    const free = r.read('situation-05-building-site-mud-across-the-path--terse.json');
    assert.equal(free.dynamic_variables.destination_title, stops[4].title, 'a row without a stop cycles through the route');

    /* a project whose schema.sql predates the table: one line, then the
     * starter twenty — a button must not come back with nothing to run */
    mock.state.situationsTable = false;
    r = await run([]);
    assert.match(r.log, /^Supabase \(http:\/\/127\.0\.0\.1:\d+\) has no situations table yet — generating from situations-starter\.js instead \(run supabase\/schema\.sql there to get one\)$/m);
    assert.match(r.log, /GENERATE — 20 situation\(s\) from the starter sheet × 4 persona\(s\) → 80 test\(s\)/);
    assert.equal(r.files.length, 80);

    /* the table is there but the tab is empty, or everything in it is
     * switched off: the same fallback, its own line */
    mock.state.situationsTable = true;
    mock.state.situations = [];
    r = await run([]);
    assert.match(r.log, /has no active row — generating from situations-starter\.js instead$/m);
    assert.equal(r.files.length, 80);
  } finally {
    await mock.close();
  }
});

test('rows from a file, and the jsonb columns however they arrive', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rows.json');
    const row = {
      num: 7, title: 'Hand-fed row', driver_says: 'The gate was chained shut.', driver_knows: 'A chain and a padlock.',
      follow_up: '["how the driver got in", "whether the parcel was delivered"]', off_topic: 'parking', tip: 'Gate chained — ring the shop.',
    };
    execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify({situations: [JSON.parse(process.argv[2])]}))', file, JSON.stringify(row)]);
    const out = path.join(dir, 'out');
    const log = execFileSync(process.execPath, [GEN, '--situations', '--file', file, '--out', out], { encoding: 'utf8' });
    assert.match(log, /GENERATE — 1 situation\(s\) from .*rows\.json × 4 persona\(s\) → 4 test\(s\)/);
    const body = JSON.parse(readFileSync(path.join(out, 'situation-07-hand-fed-row--terse.json'), 'utf8'));
    validate(body, 'situation-07-hand-fed-row--terse.json');
    assert.ok(body.success_conditions[0].includes('how the driver got in; whether the parcel was delivered'));
    assert.ok(body.success_conditions[0].includes('for example parking'));
    /* the same coercions, straight */
    assert.deepEqual(listOf('["a","b"]'), ['a', 'b']);
    assert.deepEqual(listOf('a'), ['a']);
    assert.deepEqual(listOf(['a', ' b ', '']), ['a', 'b']);
    assert.deepEqual(listOf(null), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an inactive row is not run, and a row can be picked on its own', () => {
  const some = [
    { num: 1, title: 'On', driver_says: 'a', driver_knows: 'b', follow_up: ['c'], off_topic: ['d'], tip: 'e' },
    { num: 2, title: 'Off', active: false, driver_says: 'a', driver_knows: 'b', follow_up: ['c'], off_topic: ['d'], tip: 'e' },
  ];
  assert.equal(buildSituationTests(some, { stops }).length, 4);
  assert.equal(buildSituationTests(some, { stops, only: 1 }).length, 4);
  assert.equal(buildSituationTests(some, { stops, only: 2 }).length, 0);
  /* a row with no number of its own still gets a valid test */
  const t = buildSituationTest({ row: { title: 'Unnumbered', driver_says: 'a', driver_knows: 'b', follow_up: ['c'], off_topic: ['d'], tip: 'e' }, persona: SITUATION_PERSONAS[0], stops });
  assert.equal(t.file, 'situation-00-unnumbered--cooperative.json');
  assert.equal(t.body.name, 'Otto · situation Unnumbered · cooperative');
  assert.equal(t.body._otto.situation_num, null);
});
