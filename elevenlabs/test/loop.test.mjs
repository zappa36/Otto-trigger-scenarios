/*
 * The loop end to end against the in-process mock: every command, the
 * files it writes, the requests it sends — and the two things that must
 * never happen: a request without a key, and a request on --dry-run.
 * Each test works in its own temp copy of test/fixture, so nothing here
 * touches the real test_configs/, results/, field/ or proposals/.
 *
 *   node --test            (from elevenlabs/)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-elevenlabs.mjs';
import { main, aggregate, compareResults, scoreData, gradeSummary, fitEvidence, agentRunRow, replySpeed } from '../loop.mjs';
import { makeHttp, elevenLabs, ApiError } from '../lib/elevenlabs-api.mjs';
import { unifiedDiff, table, reasonKey } from '../lib/report.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const T1 = 'Otto · #1 Parking loops · cooperative';
const T8 = 'Otto · #8 Blocked route · terse';

let mock;
before(async () => { mock = await startMock(FIXTURE); });
after(() => mock.close());
beforeEach(() => mock.reset());

/* a fresh working folder: the fixture's test_configs and analysis.json,
 * nothing else — the loop writes everything else itself */
function workdir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'otto-loop-'));
  cpSync(path.join(FIXTURE, 'test_configs'), path.join(dir, 'test_configs'), { recursive: true });
  cpSync(path.join(FIXTURE, 'analysis.json'), path.join(dir, 'analysis.json'));
  return dir;
}
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const filesIn = d => (existsSync(d) ? readdirSync(d).sort() : []);

const ENV = () => ({
  ELEVENLABS_API_KEY: 'sk-eleven-test-key',
  ELEVENLABS_AGENT_ID: 'agent_test1',
  ELEVENLABS_BASE_URL: mock.url,
  SUPABASE_URL: mock.url,
  SUPABASE_ANON_KEY: 'anon-test',
  OPENAI_API_KEY: 'sk-openai-test-key',
  OPENAI_BASE_URL: mock.url + '/v1',
  LOOP_MODEL: 'gpt-4o',
  LOOP_POLL_MS: '5',
  LOOP_RETRY_MS: '5',
});

/* run a command as the CLI would, capturing what it prints */
async function loop(args, dir, envPatch = {}) {
  const lines = [];
  const env = { ...ENV(), ...envPatch };
  for (const k of Object.keys(envPatch)) if (envPatch[k] === undefined) delete env[k];
  const code = await main([...args, '--dir', dir], { env, log: s => lines.push(String(s)) });
  return { code, out: lines.join('\n') };
}
const sent = (method, re) => mock.requests.filter(r => r.method === method && re.test(r.path));

/* the whole day-one flow in one folder, in order — later tests reuse
 * what the earlier commands wrote */
const shared = { dir: null, results: null, branchResults: null, field: null, proposal: null };

test('push-tests creates what is missing, finds the rest by name, and updates through the lock next time', async () => {
  const dir = workdir();
  shared.dir = dir;
  let r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  const lock = readJson(path.join(dir, 'tests.lock.json'));
  assert.deepEqual(lock, { [T1]: 'test_001', [T8]: 'test_pre8' });
  assert.equal(sent('POST', /agent-testing\/create$/).length, 1, 'one create (#1 was missing)');
  assert.equal(sent('GET', /agent-testing$/).length, 1, 'one search by name');
  assert.equal(sent('PUT', /agent-testing\/test_pre8$/).length, 1, '#8 found by name and updated');
  const created = sent('POST', /agent-testing\/create$/)[0].body;
  assert.equal(created.name, T1);
  assert.equal(created._otto, undefined, '_otto is stripped before posting');
  assert.equal(created.type, 'simulation');
  assert.ok(Array.isArray(created.success_conditions));
  assert.ok(mock.requests.every(q => q.auth.xi), 'every ElevenLabs request carries xi-api-key');
  assert.match(r.out, /created/);
  assert.match(r.out, /found by name/);

  mock.requests.length = 0;
  r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /create$/).length, 0, 'nothing created the second time');
  assert.equal(sent('GET', /agent-testing$/).length, 0, 'no search when the lock has every id');
  assert.equal(sent('PUT', /agent-testing\//).length, 2, 'both updated through the lock');
  assert.deepEqual(readJson(path.join(dir, 'tests.lock.json')), lock);
});

test('run polls the invocation, aggregates per test worst-first, and writes the results file', async () => {
  const dir = shared.dir;
  const r = await loop(['run', '--repeat', '3', '--label', 'main'], dir);
  assert.equal(r.code, 0, r.out);
  const runReq = sent('POST', /run-tests$/)[0];
  assert.deepEqual(runReq.body.tests, [{ test_id: 'test_001' }, { test_id: 'test_pre8' }]);
  assert.equal(runReq.body.repeat_count, 3);
  assert.equal(runReq.body.branch_id, undefined);
  assert.equal(sent('GET', /test-invocations\/inv_1$/).length, 2, 'pending once, then complete');
  const files = filesIn(path.join(dir, 'results'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}\.\d{3}Z-main\.json$/);
  const res = readJson(path.join(dir, 'results', files[0]));
  shared.results = path.join(dir, 'results', files[0]);
  assert.equal(res.agent_id, 'agent_test1');
  assert.equal(res.invocation_id, 'inv_1');
  assert.equal(res.branch_id, null);
  assert.equal(res.tests.length, 2);
  assert.equal(res.tests[0].name, T1, 'the failing test comes first');
  assert.equal(res.tests[0].runs, 3);
  assert.equal(res.tests[0].passed, 2);
  assert.ok(Math.abs(res.tests[0].pass_rate - 2 / 3) < 1e-9);
  assert.deepEqual(res.tests[0].rationales, ['The agent asked four questions and never let the tester go. It opened correctly.']);
  assert.equal(res.tests[0].scenario_num, 1, 'the _otto block rides along');
  assert.equal(res.tests[0].persona, 'cooperative');
  assert.equal(res.tests[0].kind, 'scenario');
  assert.equal(res.tests[0].language, 'en');
  /* the first failed run, whole — the dashboard shows which turn went
   * wrong, not just that one did */
  assert.equal(res.tests[0].why, 'The agent asked four questions and never let the tester go. It opened correctly.');
  assert.deepEqual(res.tests[0].failure, {
    test_run_id: 'run_2',
    rationale: 'The agent asked four questions and never let the tester go. It opened correctly.\nCriterion 1: PASS. It opened correctly.\nCriterion 2: FAIL. Asked four questions.\nCriterion 3: FAIL. Did not let the tester go.',
    verdicts: ['pass', 'fail', 'fail'],
    transcript: [{ role: 'agent', message: 'Is it hard to park here at this time? Where did you find a spot?', tools: ['report_incident'] }],
  });
  /* the judge's word per check, over every run that carried one — the
   * passed run_1 included, the wordless run_3 not */
  assert.deepEqual(res.tests[0].checks, { 1: { pass: 2, fail: 0 }, 2: { pass: 1, fail: 1 }, 3: { pass: 0, fail: 1 } });
  assert.equal(res.tests[1].checks, null, 'no verdict words, no checks');
  /* one passed run kept too — the shortest with any words in it; run_3
   * passed but said nothing, so run_1 is the one */
  assert.deepEqual(res.tests[0].success, {
    test_run_id: 'run_1',
    rationale: 'Criterion 1: PASS. Opened with the question.\nCriterion 2: PASS. Got a parking tip.',
    verdicts: ['pass', 'pass'],
    transcript: [
      { role: 'user', message: 'Hi, done with the stop.' },
      { role: 'agent', message: 'Is it hard to park here at this time? Where did you find a spot?' },
      { role: 'user', message: 'Easy, right outside.' },
      { role: 'agent', message: 'Thanks, safe travels.' },
    ],
  });
  assert.deepEqual(res.tests[1].success, {
    test_run_id: 'run_4', rationale: 'no rationale returned',
    transcript: [{ role: 'user', message: 'Road was shut.' }, { role: 'agent', message: 'Which street was closed?' }, { role: 'user', message: 'Danziger.' }, { role: 'agent', message: 'Thanks, bye.' }],
  }, 'the shortest passed run with words — run_5 and run_6 said nothing');
  /* every call's timings, token prices and model, per test — over all
   * three runs, not just the two kept whole: seconds to Otto's first
   * sentence and first word per turn, the length of each call, and
   * what the tokens cost */
  assert.deepEqual(res.tests[0].timing, { answers: [0.9, 0.7, 1.5], words: [0.6, 0.4, 1.0], gaps: [], calls: [11, 0] });
  assert.ok(Math.abs(res.tests[0].usage.cost - 0.0004062) < 1e-9, 'input + output prices over run_1, the only priced call');
  assert.deepEqual({ ...res.tests[0].usage, cost: 0 }, { cost: 0, tokens_in: 2500, tokens_out: 52, calls: 1 });
  assert.deepEqual(res.tests[0].models, ['gpt-4o-mini'], 'producing_llm, as ElevenLabs names it');
  assert.equal(res.tests[0].driver_model, 'claude-sonnet-4-6', 'from the test file');
  assert.equal(res.tests[0].judge_model, 'claude-sonnet-4-6');
  assert.deepEqual(res.tests[1].timing, { answers: [], words: [], gaps: [4, 2], calls: [12] }, 'no metrics on #8: the whole-second gaps from the driver\'s turn to Otto\'s stand in');
  assert.deepEqual(res.tests[1].usage, { cost: 0, tokens_in: 0, tokens_out: 0, calls: 0 });
  assert.deepEqual(res.tests[1].models, []);
  assert.equal(res.tests[1].driver_model, '', 'the #8 fixture file pins no models');
  /* the agent's own LLM settings, read from GET agent once the suite is
   * started — the model and its reasoning knobs, nothing of the prompt */
  assert.deepEqual(res.settings, { model: 'gpt-4o-mini', reasoning: null, thinking_budget: null, temperature: null });
  assert.equal(sent('GET', /\/v1\/convai\/agents\/agent_test1$/).length, 1);
  assert.match(r.out, /Otto's model on this run: gpt-4o-mini/);
  assert.match(r.out, /speed and cost — Otto's first sentence after 0\.9 s \(median over 3 turn\(s\); slowest 1\.5 s\) · a call lasts 11 s \(median of 3\) · \$0\.000406 per call in model tokens \(\$0\.000406 over 1 priced call\(s\)\) · model set to gpt-4o-mini; answered as gpt-4o-mini/);
  assert.equal(res.tests[1].pass_rate, 1);
  assert.equal(res.tests[1].why, null);
  assert.equal(res.tests[1].failure, null, 'a test that passed every run has no failure to show');
  assert.match(r.out, /2\/3/);
  assert.match(r.out, /5\/6 runs passed/);
});

test('run --branch sends the branch id and the results carry it', async () => {
  const dir = shared.dir;
  const r = await loop(['run', '--branch', 'agtbrch_loop1', '--repeat', '3', '--label', 'branch'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /run-tests$/)[0].body.branch_id, 'agtbrch_loop1');
  const file = filesIn(path.join(dir, 'results')).find(f => f.endsWith('-branch.json'));
  const res = readJson(path.join(dir, 'results', file));
  shared.branchResults = path.join(dir, 'results', file);
  assert.equal(res.branch_id, 'agtbrch_loop1');
  assert.ok(res.tests.every(t => t.branch_id === 'agtbrch_loop1'));
});

test('model-branch cuts a branch from the live version with only the language model changed, and names the model in the clear', async () => {
  const dir = workdir();
  const out = path.join(dir, 'model-branch.json');
  let r = await loop(['model-branch', '--model', 'gpt-4.1-mini', '--reasoning', 'low', '--out', out], dir);
  assert.equal(r.code, 0, r.out);
  const post = sent('POST', /\/branches$/);
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, {
    parent_version_id: 'agtvrsn_v1',
    name: post[0].body.name,
    description: 'model trial: gpt-4.1-mini, reasoning low — the prompt is the live one, unchanged',
    conversation_config: { agent: { prompt: { llm: 'gpt-4.1-mini', reasoning_effort: 'low' } } },
  }, 'settings only: no prompt travels in this body');
  assert.match(post[0].body.name, /^model gpt-4\.1-mini reasoning low \(\d{4}-\d\d-\d\d \d\d\.\d\d\)$/, 'a name unique within the agent, readable in the Versioning tab, in the characters ElevenLabs allows (no comma, no colon)');
  assert.match(r.out, /live Otto: model gpt-4o-mini \(version agtvrsn_v1\)/);
  assert.match(r.out, /branch "model gpt-4\.1-mini reasoning low \(.*\)" created: agtbrch_loop1 \(version agtvrsn_b1, from agtvrsn_v1\) — model gpt-4\.1-mini, reasoning low/);
  assert.match(r.out, /next: node loop\.mjs run --branch agtbrch_loop1 --label model/);
  const wrote = readJson(out);
  assert.deepEqual({ ...wrote, name: '', at: '' }, { branch_id: 'agtbrch_loop1', version_id: 'agtvrsn_b1', parent_version_id: 'agtvrsn_v1', name: '', model: 'gpt-4.1-mini', reasoning: 'low', set_as: { reasoning_effort: 'low' }, at: '' });
  /* reasoning off turns both knobs off; keep (the default) sends the model alone; a name of one's own is taken */
  mock.reset(); mock.requests.length = 0;
  r = await loop(['model-branch', '--model', 'gemini-2.5-flash', '--reasoning', 'off', '--name', 'flash: no thinking, please'], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sent('POST', /\/branches$/)[0].body.conversation_config, { agent: { prompt: { llm: 'gemini-2.5-flash', reasoning_effort: 'none', thinking_budget: 0 } } });
  assert.equal(sent('POST', /\/branches$/)[0].body.name, 'flash- no thinking- please', 'a name of one\'s own, in the characters ElevenLabs allows');
  mock.reset(); mock.requests.length = 0;
  r = await loop(['model-branch', '--model', 'gemini-3.6-flash', '--reasoning', 'false'], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sent('POST', /\/branches$/)[0].body.conversation_config, { agent: { prompt: { llm: 'gemini-3.6-flash', reasoning_effort: 'none', thinking_budget: 0 } } }, 'the form\'s "false" is off');
  assert.match(r.out, /— model gemini-3\.6-flash, reasoning off/);
  mock.reset(); mock.requests.length = 0;
  r = await loop(['model-branch', '--model', 'claude-haiku-4-5'], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sent('POST', /\/branches$/)[0].body.conversation_config, { agent: { prompt: { llm: 'claude-haiku-4-5' } } });
  assert.equal(sent('POST', /\/branches$/)[0].body.description, 'model trial: claude-haiku-4-5 — the prompt is the live one, unchanged');
  /* what it refuses before sending anything */
  for (const [args, msg] of [
    [['model-branch'], /--model NAME is required/],
    [['model-branch', '--model', 'gpt 4'], /does not look like a model name/],
    [['model-branch', '--model', 'gpt-4.1-mini', '--reasoning', 'lots'], /--reasoning is one of keep, none, minimal, low, medium, high, xhigh, max \(ElevenLabs' own words; off is taken as none\) — not "lots"/],
  ]) {
    mock.requests.length = 0;
    r = await loop(args, dir);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, msg);
    assert.equal(mock.requests.length, 0, 'nothing sent');
  }
  /* the API's refusal is shown whole: this body has no prompt to hide */
  mock.reset(); mock.requests.length = 0;
  mock.state.branchRefuses = 422;
  r = await loop(['model-branch', '--model', 'gpt-99'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /model-branch failed: 422 from POST \/v1\/convai\/agents\/agent_test1\/branches: .*— ElevenLabs refused the branch\./);
  mock.state.branchRefuses = 0;
  /* a model that will not switch reasoning off ("Not supported
   * reasoning effort", as gemini-3.6-flash answered live) gets the
   * lowest setting it takes, and the log and the description say so */
  mock.reset(); mock.requests.length = 0;
  mock.state.refuseReasoning = ['none', 'null'];
  r = await loop(['model-branch', '--model', 'gemini-3.6-flash', '--reasoning', 'off', '--out', out], dir);
  assert.equal(r.code, 0, r.out);
  const tries = sent('POST', /\/branches$/);
  assert.equal(tries.length, 3, 'none with budget 0, then unset with budget 0, then minimal');
  assert.deepEqual(tries[0].body.conversation_config.agent.prompt, { llm: 'gemini-3.6-flash', reasoning_effort: 'none', thinking_budget: 0 });
  assert.deepEqual(tries[1].body.conversation_config.agent.prompt, { llm: 'gemini-3.6-flash', reasoning_effort: null, thinking_budget: 0 });
  assert.deepEqual(tries[2].body.conversation_config.agent.prompt, { llm: 'gemini-3.6-flash', reasoning_effort: 'minimal' });
  assert.equal(tries[2].body.description, 'model trial: gemini-3.6-flash, reasoning off (set as reasoning minimal: this model does not take reasoning none, thinking budget 0 or reasoning unset, thinking budget 0) — the prompt is the live one, unchanged');
  assert.match(r.out, /gemini-3\.6-flash does not take reasoning none, thinking budget 0 — trying the next setting\n\s+gemini-3\.6-flash does not take reasoning unset, thinking budget 0 — trying the next setting/);
  assert.match(r.out, /created: agtbrch_loop1 .*— model gemini-3\.6-flash, reasoning off \(set as reasoning minimal — this model does not take reasoning none, thinking budget 0 or reasoning unset, thinking budget 0\)/);
  assert.deepEqual(readJson(out).set_as, { reasoning_effort: 'minimal' });
  assert.equal(mock.state.branches.length, 1, 'one branch made');
  /* a level the model does not take at all is refused with its choices named */
  mock.reset(); mock.requests.length = 0;
  mock.state.refuseReasoning = ['medium'];
  r = await loop(['model-branch', '--model', 'gpt-4.1', '--reasoning', 'medium'], dir);
  assert.equal(r.code, 1);
  assert.equal(sent('POST', /\/branches$/).length, 1, 'no other rung to try');
  assert.match(r.out, /gpt-4\.1 takes none of the settings that mean "reasoning medium" \(reasoning medium\)\. Its choices are in the agent's LLM settings in ElevenLabs; try another level, or "keep"/);
  mock.reset(); mock.requests.length = 0;
  mock.state.refuseReasoning = ['none', 'null', 'minimal', 'low'];
  r = await loop(['model-branch', '--model', 'gpt-4.1', '--reasoning', 'off'], dir);
  assert.equal(r.code, 1);
  assert.equal(sent('POST', /\/branches$/).length, 4, 'every rung tried');
  assert.match(r.out, /gpt-4\.1 takes none of the settings that mean "reasoning off"/);
  mock.state.refuseReasoning = [];
  /* a dry run prints the request and sends nothing */
  mock.requests.length = 0;
  r = await loop(['model-branch', '--model', 'gpt-4.1-mini', '--dry-run'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(mock.requests.length, 0);
  assert.match(r.out, /POST .*\/branches/);
});

test('run --rows runs only those situation rows', async () => {
  const dir = workdir();
  rmSync(path.join(dir, 'test_configs'), { recursive: true, force: true });
  writeFileSync(path.join(dir, 'tests.lock.json'), JSON.stringify({
    'Otto · situation #6 A big dog at the door · terse': 'test_s6t',
    'Otto · situation #6 A big dog at the door · vague': 'test_s6v',
    'Otto · situation #16 Reception takes parcels only until three · terse': 'test_s16',
    'Otto · situation #8 Gate needs a code · terse': 'test_s8',
    [T1]: 'test_001',
  }));
  let r = await loop(['run', '--rows', '6, 8', '--repeat', '1', '--label', 'trial'], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sent('POST', /run-tests$/)[0].body.tests.map(t => t.test_id), ['test_s6t', 'test_s6v', 'test_s8'], '#16 is not #6, and a trigger test has no row');
  assert.equal(sent('POST', /run-tests$/)[0].body.repeat_count, undefined, 'one run each');
  assert.match(r.out, /rows 6, 8: 3 test\(s\)/);
  mock.requests.length = 0;
  r = await loop(['run', '--rows', '99'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /no test in tests\.lock\.json is for situation row\(s\) 99 — the numbers are the # on the SITUATIONS tab/);
  r = await loop(['run', '--rows', 'six'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /--rows takes situation numbers, comma-separated \(6,8,10\), not "six"/);
  assert.equal(mock.requests.length, 0, 'nothing sent either time');
});

test('a lock entry without a test file — a row switched off — is not run, and push-tests drops it', async () => {
  const dir = workdir();
  let r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  /* the lock as run 114 had it: a test whose row was switched off on
   * the dashboard, so the generator wrote no file for it this time */
  const lockFile = path.join(dir, 'tests.lock.json');
  const OLD = 'Otto · situation #17 The shop is closed on Mondays · terse';
  writeFileSync(lockFile, JSON.stringify({ ...readJson(lockFile), [OLD]: 'test_old17' }, null, 2));
  mock.requests.length = 0;
  r = await loop(['run', '--repeat', '2'], dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(sent('POST', /run-tests$/)[0].body.tests.map(t => t.test_id).sort(), ['test_001', 'test_pre8'], 'the switched-off row\'s test is not run');
  assert.match(r.out, /1 test\(s\) in tests\.lock\.json has no test file now — a row switched off, or a test renamed — and is not run: Otto · situation #17 The shop is closed on Mondays · terse/);
  assert.match(r.out, /run — 2 test\(s\) × 2 on main/);
  /* push-tests forgets it — but only what has no file at all: a filter
   * that leaves a test out must not throw its entry away */
  r = await loop(['push-tests', '--filter', '#1 '], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 lock entry without a test file dropped — a row switched off, or a test renamed \(Otto · situation #17 The shop is closed on Mondays · terse\); the tests stay in ElevenLabs/);
  assert.deepEqual(Object.keys(readJson(lockFile)).sort(), [T1, T8], 'the filtered-out test keeps its entry; the fileless one is gone');
  assert.equal(sent('DELETE', /agent-testing/).length, 0, 'nothing is deleted in ElevenLabs');
  /* with no file on disk at all, nothing can be told apart: the lock runs as it is */
  rmSync(path.join(dir, 'test_configs'), { recursive: true, force: true });
  writeFileSync(lockFile, JSON.stringify({ ...readJson(lockFile), [OLD]: 'test_old17' }, null, 2));
  mock.requests.length = 0;
  r = await loop(['run', '--repeat', '2'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /run-tests$/)[0].body.tests.length, 3);
  assert.doesNotMatch(r.out, /has no test file now/);
});

test('run --branch takes the branch\'s ElevenLabs name too, and refuses the agent\'s own id by name', async () => {
  const dir = shared.dir;
  /* the name as typed in the dashboard: looked up, the id sent */
  let r = await loop(['run', '--branch', 'Tip Detail', '--repeat', '2', '--label', 'branch'], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /branch "tip detail" is agtbrch_hand01/);
  assert.equal(sent('POST', /run-tests$/)[0].body.branch_id, 'agtbrch_hand01');
  assert.equal(sent('GET', /\/branches$/).length, 1, 'one list call');
  /* an id is sent as it is, no lookup */
  mock.reset();
  r = await loop(['run', '--branch', 'agtbrch_hand01', '--repeat', '2', '--label', 'branch'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('GET', /\/branches$/).length, 0, 'an id needs no list');
  /* the first live try pasted the agent id into the field */
  mock.reset();
  r = await loop(['run', '--branch', 'agent_test1', '--repeat', '2', '--label', 'branch'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /"agent_test1" is the agent's own id, not a branch\. Give the branch's name as you typed it in ElevenLabs/);
  assert.equal(sent('POST', /run-tests$/).length, 0, 'nothing started, nothing billed');
  /* a name that is not there: the live names, the archived one left out */
  mock.reset();
  r = await loop(['run', '--branch', 'tip detials', '--repeat', '2', '--label', 'branch'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /no branch named "tip detials" on agent agent_test1 — the live branches are "tip detail"/);
  assert.doesNotMatch(r.out, /old idea/);
  /* promote resolves the same way */
  mock.reset();
  r = await loop(['promote', '--branch', 'tip detail'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /\/branches\/agtbrch_hand01\/merge$/).length, 1);
});

test('run --filter narrows by name, and an empty lock is a clear message', async () => {
  const dir = shared.dir;
  await loop(['run', '--filter', 'blocked', '--repeat', '2', '--label', 'blocked'], dir);
  assert.deepEqual(sent('POST', /run-tests$/)[0].body.tests, [{ test_id: 'test_pre8' }]);
  const empty = workdir();
  const r = await loop(['run'], empty);
  assert.equal(r.code, 1);
  assert.match(r.out, /push-tests first/);
  assert.equal(mock.requests.filter(q => /run-tests/.test(q.path)).length, 1, 'nothing sent for the empty lock');
});

test('publish posts the results file as one agent_runs row — the contract dashboard.html reads — and prints the id', async () => {
  const dir = shared.dir;
  const results = readJson(shared.results);
  let r = await loop(['publish', '--results', shared.results, '--run-url', 'https://github.com/o/r/actions/runs/42'], dir);
  assert.equal(r.code, 0, r.out);
  const posts = sent('POST', /\/rest\/v1\/agent_runs$/);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].auth.apikey && posts[0].auth.bearer, 'the anon key in both headers, like every Supabase write');
  assert.equal(posts[0].prefer, 'return=representation', 'the row comes back with its id');
  assert.ok(Array.isArray(posts[0].body) && posts[0].body.length === 1, 'one row, as a list — the shape backend.js inserts');
  const row = posts[0].body[0];
  assert.ok(!('id' in row) && !('created_at' in row), 'the database fills those in');
  assert.deepEqual(Object.keys(row), ['agent_id', 'label', 'branch_id', 'version_id', 'invocation_id', 'repeat', 'run_url', 'verdict', 'verdict_reason', 'note', 'tests', 'summary', 'ran_at']);
  assert.equal(row.agent_id, 'agent_test1');
  assert.equal(row.label, 'main');
  assert.equal(row.branch_id, null);
  assert.equal(row.version_id, 'agtvrsn_v1', 'from the tests\' version_id');
  assert.equal(row.invocation_id, 'inv_1');
  assert.equal(row.repeat, 3);
  assert.equal(row.run_url, 'https://github.com/o/r/actions/runs/42');
  assert.equal(row.verdict, null, 'no verdict on a baseline');
  assert.equal(row.verdict_reason, null);
  assert.equal(row.note, null);
  assert.equal(row.ran_at, results.at);
  assert.deepEqual(row.tests[0], {
    name: T1, test_id: 'test_001', kind: 'scenario', scenario_num: 1, scenario_title: 'Parking loops — two slow passes and a stop',
    situation_num: null, situation_title: null, persona: 'cooperative', language: 'en',
    runs: 3, passed: 2, pass_rate: 2 / 3,
    why: 'The agent asked four questions and never let the tester go. It opened correctly.',
    failure: {
      test_run_id: 'run_2',
      rationale: 'The agent asked four questions and never let the tester go. It opened correctly.\nCriterion 1: PASS. It opened correctly.\nCriterion 2: FAIL. Asked four questions.\nCriterion 3: FAIL. Did not let the tester go.',
      verdicts: ['pass', 'fail', 'fail'],
      transcript: [{ role: 'agent', message: 'Is it hard to park here at this time? Where did you find a spot?', tools: ['report_incident'] }],
    },
    success: {
      test_run_id: 'run_1',
      rationale: 'Criterion 1: PASS. Opened with the question.\nCriterion 2: PASS. Got a parking tip.',
      verdicts: ['pass', 'pass'],
      transcript: [
        { role: 'user', message: 'Hi, done with the stop.' },
        { role: 'agent', message: 'Is it hard to park here at this time? Where did you find a spot?' },
        { role: 'user', message: 'Easy, right outside.' },
        { role: 'agent', message: 'Thanks, safe travels.' },
      ],
    },
    checks: { 1: { pass: 2, fail: 0 }, 2: { pass: 1, fail: 1 }, 3: { pass: 0, fail: 1 } },
    /* the seconds and the cents per test: medians over its calls */
    speed: { answer_s: 0.9, gap_s: null, call_s: 5.5, turns: 3, source: 'metrics' },
    cost: { per_call_usd: 0.000406, calls: 1 },
  });
  assert.deepEqual(row.tests[1], { name: T8, test_id: 'test_pre8', kind: 'scenario', scenario_num: 8, scenario_title: 'Blocked route — turned round short of the address', situation_num: null, situation_title: null, persona: 'terse', language: 'en', runs: 3, passed: 3, pass_rate: 1, why: null, failure: null,
    success: { test_run_id: 'run_4', rationale: 'no rationale returned', transcript: [{ role: 'user', message: 'Road was shut.' }, { role: 'agent', message: 'Which street was closed?' }, { role: 'user', message: 'Danziger.' }, { role: 'agent', message: 'Thanks, bye.' }] },
    checks: null,
    speed: { answer_s: null, gap_s: 3, call_s: 12, turns: 2, source: 'timestamps' }, cost: null });
  assert.deepEqual(row.summary, {
    tests: 2, tests_at_100: 1, runs: 6, passed: 5, pass_rate: 5 / 6,
    by_scenario: { 1: { tests: 1, runs: 3, passed: 2, pass_rate: 2 / 3 }, 8: { tests: 1, runs: 3, passed: 3, pass_rate: 1 } },
    by_situation: {},
    by_check: { 1: { pass: 2, fail: 0 }, 2: { pass: 1, fail: 1 }, 3: { pass: 0, fail: 1 } },
    /* the model trial's numbers, on every run: what Otto was set to,
     * how fast he answered, what the calls cost, who answered / drove / judged */
    settings: { model: 'gpt-4o-mini', reasoning: null, thinking_budget: null, temperature: null },
    speed: { answer_s: 0.9, answer_max_s: 1.5, word_s: 0.6, gap_s: 3, call_s: 11, turns: 3, calls: 3, source: 'metrics' },
    cost: { per_call_usd: 0.000406, total_usd: 0.000406, tokens_in: 2500, tokens_out: 52, calls: 1 },
    models: { otto: ['gpt-4o-mini'], driver: ['claude-sonnet-4-6'], judge: ['claude-sonnet-4-6'] },
  });
  assert.equal(mock.state.agentRuns.length, 1, 'stored');
  assert.match(r.out, /5\/6 runs passed across 2 test\(s\) -> agent_runs\nspeed and cost — Otto's first sentence after 0\.9 s/);
  assert.match(r.out, /published agent_runs 00000000-0000-4000-8000-000000000001 \(2 scenario\(s\), 0 situation\(s\), main, https:\/\/github\.com\/o\/r\/actions\/runs\/42\) — dashboard\.html shows it per row/);

  /* the note is gone: it said what the branch's prompt changed, and
   * anyone can read this table with the anon key. The flag is refused
   * by name rather than ignored, and nothing is sent. */
  mock.requests.length = 0;
  r = await loop(['publish', '--results', shared.branchResults, '--verdict', 'REJECT', '--reason', 'no previously failing test improved', '--note', 'Ask where they parked first'], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--note is gone: .*agent_runs is world-readable/);
  assert.match(r.out, /stays on the ElevenLabs branch as its description/);
  assert.equal(mock.requests.length, 0, 'nothing sent');

  /* the branch run from propose: compare's verdict and reason ride along, the note never does */
  mock.requests.length = 0;
  r = await loop(['publish', '--results', shared.branchResults, '--verdict', 'REJECT', '--reason', 'no previously failing test improved'], dir);
  assert.equal(r.code, 0, r.out);
  const branchRow = sent('POST', /agent_runs$/)[0].body[0];
  assert.equal(branchRow.label, 'branch');
  assert.equal(branchRow.branch_id, 'agtbrch_loop1');
  assert.equal(branchRow.version_id, 'agtvrsn_b1');
  assert.equal(branchRow.verdict, 'reject', 'compare\'s word, whichever case it came in');
  assert.equal(branchRow.verdict_reason, 'no previously failing test improved');
  assert.equal(branchRow.note, null, 'the column stays, unused');
  assert.equal(branchRow.run_url, null, 'run by hand');
  assert.match(r.out, /, REJECT -> agent_runs/);
  assert.match(r.out, /published agent_runs 00000000-0000-4000-8000-000000000002/);

  /* no --results: the latest results file that is not a score */
  mock.requests.length = 0;
  r = await loop(['publish'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /agent_runs$/)[0].body[0].label, 'blocked', 'the last run in this folder was the filtered one');

  /* a word compare never prints */
  mock.requests.length = 0;
  r = await loop(['publish', '--results', shared.results, '--verdict', 'maybe'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /--verdict is accept or reject/);
  assert.equal(mock.requests.length, 0, 'nothing sent');

  /* a project whose schema.sql predates the table: say what to run, exit 1 */
  mock.state.agentRunsTable = false;
  r = await loop(['publish', '--results', shared.results], dir);
  assert.equal(r.code, 1, r.out);
  assert.equal(sent('POST', /agent_runs$/).length, 1, 'one POST, not retried');
  assert.match(r.out, /the agent_runs table is not there yet \(404 from POST \/rest\/v1\/agent_runs: Could not find the table 'public\.agent_runs' in the schema cache\) — re-run supabase\/schema\.sql/, 'PostgREST\'s own message, not its JSON');
  mock.state.agentRunsTable = true;

  /* --dry-run: the row is printed, nothing is sent, no key appears */
  mock.requests.length = 0;
  r = await loop(['publish', '--results', shared.results, '--run-url', 'https://github.com/o/r/actions/runs/43', '--dry-run'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(mock.requests.length, 0, 'the mock saw nothing');
  assert.equal(mock.state.agentRuns.length, 3, 'nothing stored');
  assert.match(r.out, /\(dry run\) POST .*\/rest\/v1\/agent_runs/);
  assert.match(r.out, /"run_url": "https:\/\/github\.com\/o\/r\/actions\/runs\/43"/);
  assert.match(r.out, /nothing published/);
  assert.ok(!r.out.includes('anon-test') && !r.out.includes('sk-eleven'), 'no key printed');

  /* a results file from before why/failure rode along publishes with what it has */
  const old = { at: '2026-09-01T06:00:00.000Z', agent_id: 'agent_test1', invocation_id: 'inv_0', branch_id: null, label: 'main', repeat: 2,
    tests: [{ name: 'Otto · regression · conv_old', test_id: 'test_9', runs: 2, passed: 1, pass_rate: 0.5, rationales: ['Too  long.\nReally.'] }] };
  const oldFile = path.join(dir, 'old.json');
  writeFileSync(oldFile, JSON.stringify(old));
  const oldRow = agentRunRow(old, { runUrl: '' });
  assert.deepEqual(oldRow.tests[0], { name: 'Otto · regression · conv_old', test_id: 'test_9', kind: 'regression', scenario_num: null, scenario_title: null, situation_num: null, situation_title: null, persona: null, language: null, runs: 2, passed: 1, pass_rate: 0.5, why: 'Too long. Really.', failure: null, success: null, checks: null, speed: null, cost: null });
  assert.equal(oldRow.summary.by_check, undefined, 'no verdict words anywhere, no by_check');
  assert.equal(oldRow.summary.speed, undefined, 'no timings kept, no speed; and no settings, cost or models either');
  assert.deepEqual(oldRow.summary, { tests: 1, tests_at_100: 0, runs: 2, passed: 1, pass_rate: 0.5, by_scenario: {}, by_situation: {} }, 'a test without a row counts in the totals and under no row');
  assert.equal(oldRow.version_id, null);
  assert.equal(oldRow.run_url, null, 'an empty --run-url is none');
  mock.requests.length = 0;
  r = await loop(['publish', '--results', oldFile], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /agent_runs$/)[0].body[0].ran_at, '2026-09-01T06:00:00.000Z');
});

test('pull joins conversations to their dashboard grades by conversation_id and stamps the agent version', async () => {
  const dir = shared.dir;
  const r = await loop(['pull', '--days', '30000'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('GET', /\/v1\/convai\/conversations$/).length, 2, 'both pages of the list');
  assert.equal(sent('GET', /\/v1\/convai\/conversations$/)[0].query.agent_id, 'agent_test1');
  assert.ok(sent('GET', /\/v1\/convai\/conversations$/)[0].query.call_start_after_unix);
  assert.equal(sent('GET', /\/v1\/convai\/conversations\/conv_/).length, 3);
  assert.ok(sent('GET', /\/rest\/v1\/messages$/)[0].auth.apikey, 'Supabase reads carry the anon key');
  const files = filesIn(path.join(dir, 'field'));
  assert.equal(files.length, 1);
  const field = readJson(path.join(dir, 'field', files[0]));
  shared.field = path.join(dir, 'field', files[0]);
  assert.deepEqual(field.counts, { conversations: 3, joined: 2, graded: 2, graded_bad: 1, stamped: 1 });
  const a = field.conversations.find(c => c.conversation_id === 'conv_aaa');
  assert.equal(a.message.id, 'm1');
  assert.equal(a.message.category, 'parking');
  assert.equal(a.scenario.num, 1, 'scenario via destination_id');
  assert.equal(a.graded_bad, true);
  assert.deepEqual(a.failed_checks, ['followup', 'tip']);
  assert.equal(a.evaluation.otto_tip_elicited.result, 'failure');
  assert.equal(a.data.tip_type, 'parking');
  assert.equal(a.dynamic_variables.scenario_num, 1);
  assert.equal(a.transcript.length, 5);
  assert.equal(a.grade.agent_version, 'agtvrsn_v1', 'stamped from the conversation');
  const patch = sent('PATCH', /\/rest\/v1\/messages$/);
  assert.equal(patch.length, 1, 'only the grade without a version is stamped');
  assert.equal(patch[0].query.id, 'eq.m1');
  assert.equal(patch[0].body.grade.agent_version, 'agtvrsn_v1');
  assert.equal(patch[0].body.grade.note, 'Never asked where the loading bay is', 'the rest of the grade is kept');
  const c = field.conversations.find(x => x.conversation_id === 'conv_ccc');
  assert.equal(c.message, null);
  assert.equal(c.graded, false);
  assert.match(r.out, /3 conversation\(s\), 2 joined to a debrief, 2 graded, 1 graded bad, 1 grade\(s\) stamped/);
  /* reply speed: ElevenLabs's timing of each agent turn rides on the turn,
   * and the pull sums them — the fixture times three of the agent turns
   * (0.9/1.4, 0.5/0.8 and 0.7/1.0 s to the first word / first sentence),
   * the greetings and conv_ccc carry none */
  assert.deepEqual(a.transcript[2].timing, {
    first_word: 0.9, first_sentence: 1.4,
    all: { convai_llm_service_ttfb: 0.9, convai_llm_service_ttf_sentence: 1.4 },
    llm: 'gpt-4o', tts: 'eleven_flash_v2_5',
  });
  assert.equal(a.transcript[0].timing, undefined, 'the greeting has no timing to keep');
  assert.equal(field.speed.turns, 3);
  assert.equal(field.speed.conversations, 2);
  assert.deepEqual(field.speed.metrics.convai_llm_service_ttfb, { median: 0.7, max: 0.9, turns: 3 });
  assert.deepEqual(field.speed.metrics.convai_llm_service_ttf_sentence, { median: 1.0, max: 1.4, turns: 3 });
  assert.deepEqual(field.speed.llm, ['gpt-4o']);
  assert.match(r.out, /reply speed — 3 Otto turn\(s\) with timings in 2 conversation\(s\): first word from the model after 0\.7 s \(median; slowest 0\.9 s\), first sentence after 1\.0 s \(median; slowest 1\.4 s\) · voice model eleven_flash_v2_5 · language model gpt-4o/);
});

test('replySpeed says so when ElevenLabs sent no timings, and lists unknown metrics by name', () => {
  assert.equal(replySpeed([]).line, 'reply speed — ElevenLabs sent no per-turn timings for these conversations');
  assert.equal(replySpeed([{ conversation_id: 'x', transcript: [{ role: 'agent', message: 'hi' }, { role: 'user', message: 'yo' }] }]).turns, 0);
  const odd = replySpeed([{ conversation_id: 'x', transcript: [
    { role: 'agent', message: 'a', timing: { first_word: 1.25, first_sentence: null, all: { convai_llm_service_ttfb: 1.25, convai_asr_service_ttfb: 0.31 }, llm: 'gemini-2.5-flash', tts: null } },
    { role: 'agent', message: 'b', timing: { first_word: 0.75, first_sentence: null, all: { convai_llm_service_ttfb: 0.75 }, llm: 'gemini-2.5-flash', tts: null } },
  ] }]);
  assert.equal(odd.metrics.convai_llm_service_ttfb.median, 1.0);
  assert.deepEqual(odd.metrics.convai_asr_service_ttfb, { median: 0.3, max: 0.3, turns: 1 });
  assert.equal(odd.line, 'reply speed — 2 Otto turn(s) with timings in 1 conversation(s): first word from the model after 1.0 s (median; slowest 1.3 s), convai_asr_service_ttfb after 0.3 s (median; slowest 0.3 s) · language model gemini-2.5-flash');
});

test('score groups the suite and the field per scenario, and the failures by reason', async () => {
  const dir = shared.dir;
  const r = await loop(['score', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 0, r.out);
  const file = filesIn(path.join(dir, 'results')).find(f => f.startsWith('score-'));
  assert.ok(file);
  const s = readJson(path.join(dir, 'results', file));
  const one = s.scenarios.find(x => x.key === '#1');
  assert.equal(one.tests, 1);
  assert.equal(one.runs, 3);
  assert.equal(one.passed, 2);
  assert.equal(one.conversations, 1);
  assert.equal(one.graded, 1);
  assert.equal(one.bad, 1);
  assert.deepEqual(one.checks, { followup: 1, tip: 1 });
  assert.equal(one.field_grade_rate, 0);
  assert.ok(one.reasons.some(b => b.reason === 'the agent asked four questions and never let the tester go' && b.count === 1));
  assert.ok(one.reasons.some(b => b.reason.startsWith('criteria otto_tip_elicited')));
  const eight = s.scenarios.find(x => x.key === '#8');
  assert.equal(eight.suite_pass_rate, 1);
  assert.equal(eight.field_grade_rate, 1);
  assert.equal(s.scenarios[0].key, '#1', 'worst first');
  assert.match(r.out, /failures by reason/);
  assert.match(r.out, /grade: followed up on what the tester actually found/);
});

test('cut writes a next-reply regression test from the debrief graded bad, without the last agent turn, and never twice', async () => {
  const dir = shared.dir;
  let r = await loop(['cut', '--field', shared.field], dir);
  assert.equal(r.code, 0, r.out);
  const file = path.join(dir, 'test_configs', 'regressions', 'conv_aaa.json');
  assert.ok(existsSync(file));
  assert.ok(!existsSync(path.join(dir, 'test_configs', 'regressions', 'conv_bbb.json')), 'a good grade cuts nothing');
  const t = readJson(file);
  assert.equal(t.name, 'Otto · regression · conv_aaa');
  assert.equal(t.type, 'llm');
  assert.deepEqual(t.chat_history.map(x => x.role), ['agent', 'user', 'agent', 'user'], 'everything before the last agent turn');
  assert.equal(t.chat_history[3].message, 'Not really.');
  assert.equal(t.chat_history[3].time_in_call_secs, 18);
  assert.match(t.success_condition, /Followed up on what the tester actually found; Got the tip type the scenario expects/);
  assert.match(t.success_condition, /Never asked where the loading bay is/);
  assert.match(t.success_condition, /parking — where to stop at this address/);
  assert.ok(!('success_examples' in t), 'an empty example list is not sent (the API wants a non-empty one or none)');
  assert.deepEqual(t.failure_examples, [{ response: 'Thanks, safe travels.', type: 'failure' }], 'the reply that was graded bad is the failure example');
  assert.equal(t.dynamic_variables.scenario_question, 'Is it hard to park here at this time? Where did you find a spot?');
  assert.deepEqual(t.from_conversation_metadata, { conversation_id: 'conv_aaa', agent_id: 'agent_test1' });
  assert.deepEqual(t._otto, { scenario_num: 1, scenario_title: 'Parking loops — two slow passes and a stop', persona: 'field', kind: 'regression', source_conversation_id: 'conv_aaa', language: 'en' });
  assert.match(r.out, /1 regression test\(s\) written, 0 already there/);

  const before = statSync(file).mtimeMs;
  writeFileSync(file, readFileSync(file, 'utf8').replace('"llm"', '"llm"'));
  r = await loop(['cut', '--field', shared.field], dir);
  assert.match(r.out, /0 regression test\(s\) written, 1 already there/);
  assert.equal(statSync(file).mtimeMs >= before, true);

  /* push-tests finds it under regressions/ */
  r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  const lock = readJson(path.join(dir, 'tests.lock.json'));
  assert.equal(lock['Otto · regression · conv_aaa'], 'test_001', 'created on the fresh mock');
  const posted = sent('POST', /create$/)[0].body;
  assert.equal(posted._otto, undefined);
  assert.equal(posted.type, 'llm');
});

test('propose hands the proposer the evidence, writes the diff, and refuses a prompt that grows by more than a quarter', async () => {
  const dir = shared.dir;
  /* one finding the designer ruled fine on the RUNS tab: it reaches the
   * proposer as a decision, not as evidence */
  mock.state.accepted = [{ key: 'greeting-first', title: 'Otto opens with “Hello! How can I help you today?”', note: 'the platform speaks it before Otto’s first turn — correct by design', decided_at: '2026-09-16T10:00:00Z' }];
  let r = await loop(['propose', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 finding\(s\) the designer marked as fine by design/);
  const req = sent('POST', /chat\/completions$/)[0];
  assert.match(req.body.messages[0].content, /designer_decisions lists behaviours the designer has ruled fine by design/);
  assert.ok(req.auth.bearer);
  assert.equal(req.body.model, 'gpt-4o');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  const user = JSON.parse(req.body.messages[1].content);
  assert.match(user.current_prompt, /^You are Otto/);
  assert.equal(user.failing_tests.length, 1);
  assert.equal(user.failing_tests[0].test, T1);
  assert.equal(user.bad_debriefs.length, 1);
  assert.equal(user.bad_debriefs[0].conversation_id, 'conv_aaa');
  assert.deepEqual(user.bad_debriefs[0].failed_checks, ['Followed up on what the tester actually found', 'Got the tip type the scenario expects']);
  assert.equal(user.criteria_results.otto_tip_elicited.failure, 1);
  assert.deepEqual(user.designer_decisions, [{ finding: 'Otto opens with “Hello! How can I help you today?”', why: 'the platform speaks it before Otto’s first turn — correct by design' }]);
  assert.equal(sent('GET', /\/v1\/convai\/agents\/agent_test1$/).length, 1, 'the prompt came from GET agent');
  const files = filesIn(path.join(dir, 'proposals'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}\.\d{3}Z\.json$/);
  const p = readJson(path.join(dir, 'proposals', files[0]));
  shared.proposal = path.join(dir, 'proposals', files[0]);
  assert.match(p.prompt, /Ask where they parked before anything else\.$/);
  assert.equal(p.note, 'Ask where they parked first — two field debriefs never got the spot');
  assert.match(p.diff, /^--- prompt \(current\)\n\+\+\+ prompt \(proposed\)\n@@ /);
  assert.match(p.diff, /\n\+Ask where they parked before anything else\./);
  assert.match(r.out, /\+Ask where they parked/);
  assert.match(r.out, /next: node loop\.mjs branch --proposal/);

  mock.state.openaiReply = () => ({ prompt: mock.state.agent.conversation_config.agent.prompt.prompt + '\n' + 'A new rule. '.repeat(60), note: 'much longer', rationale: 'x' });
  r = await loop(['propose', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused: the proposal grows the prompt by \d+% \(limit 25%\)/);
  assert.equal(filesIn(path.join(dir, 'proposals')).length, 1, 'nothing written for a refused proposal');

  mock.state.openaiReply = () => ({ prompt: mock.state.agent.conversation_config.agent.prompt.prompt, note: 'no change', rationale: 'thin' });
  r = await loop(['propose', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused: the model proposed no change/);

  /* --prompt FILE: a plain text prompt, no GET agent */
  mock.reset();
  const pf = path.join(dir, 'prompt.txt');
  writeFileSync(pf, 'You are Otto, debriefing a field tester after a trigger scenario fired.\nAsk one thing.\nThen let them get on with the route.\n');
  mock.state.openaiReply = () => ({ prompt: 'You are Otto, debriefing a field tester after a trigger scenario fired.\nAsk one thing, then stop.\nThen let them get on with the route.', note: 'stop after one', rationale: 'brevity' });
  r = await loop(['propose', '--results', shared.results, '--field', shared.field, '--prompt', pf], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('GET', /\/v1\/convai\/agents\//).length, 0);
  assert.match(r.out, /-Ask one thing\.\n\+Ask one thing, then stop\./);
  assert.equal(filesIn(path.join(dir, 'proposals')).length, 2, 'a second proposal never overwrites the first');
});

test('propose runs without the accepted_findings table and says the proposer got no decisions', async () => {
  const dir = shared.dir;
  mock.state.acceptedTable = false;
  const r = await loop(['propose', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no accepted_findings table yet \(supabase\/schema\.sql\)/);
  const user = JSON.parse(sent('POST', /chat\/completions$/)[0].body.messages[1].content);
  assert.deepEqual(user.designer_decisions, []);
});

test('propose has nothing to say when everything passes', async () => {
  const dir = workdir();
  const clean = path.join(dir, 'clean.json');
  writeFileSync(clean, JSON.stringify({ tests: [{ name: T1, runs: 3, passed: 3, pass_rate: 1, rationales: [] }] }));
  const r = await loop(['propose', '--results', clean], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to propose from/);
  assert.equal(mock.requests.length, 0);
});

test('branch cuts an agent branch from the current version with the proposed prompt', async () => {
  const dir = shared.dir;
  const r = await loop(['branch', '--proposal', shared.proposal, '--name', 'loop-test'], dir);
  assert.equal(r.code, 0, r.out);
  const req = sent('POST', /\/branches$/)[0];
  assert.equal(req.body.parent_version_id, 'agtvrsn_v1', 'version_id from GET agent');
  assert.equal(req.body.name, 'loop-test');
  assert.equal(req.body.description, 'Ask where they parked first — two field debriefs never got the spot');
  assert.equal(req.body.conversation_config.agent.prompt.prompt, readJson(shared.proposal).prompt);
  assert.match(r.out, /agtbrch_loop1 \(version agtvrsn_b1/);
  assert.match(r.out, /run --branch agtbrch_loop1/);
  assert.equal(readJson(shared.proposal).branch.branch_id, 'agtbrch_loop1', 'the proposal remembers its branch');
});

test('compare accepts an improvement without drops and rejects a drop or a standstill', async () => {
  const dir = shared.dir;
  const base = { label: 'main', tests: [{ name: T1, pass_rate: 1 / 3, runs: 3, passed: 1, rationales: [] }, { name: T8, pass_rate: 1, runs: 3, passed: 3, rationales: [] }] };
  const better = { label: 'branch', branch_id: 'agtbrch_loop1', tests: [{ name: T1, pass_rate: 1, runs: 3, passed: 3, rationales: [] }, { name: T8, pass_rate: 1, runs: 3, passed: 3, rationales: [] }] };
  const worse = { label: 'branch', tests: [{ name: T1, pass_rate: 1 / 3, runs: 3, passed: 1, rationales: [] }, { name: T8, pass_rate: 2 / 3, runs: 3, passed: 2, rationales: ['Forgot the sign-off.'] }] };
  const same = { label: 'branch', tests: base.tests };
  const w = (n, o) => { const f = path.join(dir, n); writeFileSync(f, JSON.stringify(o)); return f; };
  let r = await loop(['compare', '--base', w('base.json', base), '--branch', w('better.json', better)], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ACCEPT — 1 row\(s\) improved, none dropped by more than 25 points, and the total went up: 6 of 6 calls against 4 of 6/);
  assert.match(r.out, /promote --branch agtbrch_loop1/);
  /* one call lost out of three is a 33-point drop on a lone row */
  r = await loop(['compare', '--base', w('base.json', base), '--branch', w('worse.json', worse)], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /REJECT — 1 row\(s\) dropped by more than 25 points \(Otto · #8 Blocked route · terse: −1 call\)/);
  assert.match(r.out, /✗ dropped/);
  r = await loop(['compare', '--base', w('base.json', base), '--branch', w('same.json', same)], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /REJECT — no row improved \(4 of 6 calls against 4 of 6\)/);
  r = await loop(['compare', '--base', w('base.json', base), '--branch', w('worse.json', worse), '--margin', '0.5'], dir);
  assert.equal(r.code, 1, 'a wide margin forgives the drop, but the total fell');
  assert.match(r.out, /REJECT — the branch passed fewer calls overall: 3 of 6 calls against 4 of 6/);
  assert.equal(mock.requests.length, 0, 'compare is offline');
  /* the real files from the runs above: the mock branch run is the same fixture, so nothing improved */
  r = await loop(['compare', '--base', shared.results, '--branch', shared.branchResults], dir);
  assert.equal(r.code, 1);
});

test('promote merges the branch into the main branch and takes the version note from the branch', async () => {
  const dir = shared.dir;
  /* the branch carries its own note: `branch` put the proposal's note
   * in its description, so nothing has to travel in a file */
  mock.state.branchDescription = 'Ask where they parked first — two field debriefs never got the spot';
  const r = await loop(['promote', '--branch', 'agtbrch_loop1'], dir);
  assert.equal(r.code, 0, r.out);
  const got = sent('GET', /\/branches\/agtbrch_loop1$/)[0];
  assert.ok(got, 'the branch was read for its description');
  const req = sent('POST', /\/branches\/agtbrch_loop1\/merge$/)[0];
  assert.ok(req, 'merge posted');
  assert.equal(req.query.target_branch_id, 'branch_main', 'main_branch_id from GET agent');
  assert.deepEqual(req.body, { archive_source_branch: true, force: false });
  assert.match(r.out, /version note, from the branch: Ask where they parked first — two field debriefs never got the spot/);
  assert.doesNotMatch(r.out, /git add agent_configs/, 'the config never goes into this repository');

  /* --quiet: the merge still happens, the note stays in ElevenLabs */
  mock.requests.length = 0;
  mock.state.branchDescription = 'Ask where they parked first — two field debriefs never got the spot';
  const q = await loop(['promote', '--branch', 'agtbrch_loop1', '--quiet'], dir);
  assert.equal(q.code, 0, q.out);
  assert.equal(sent('POST', /\/merge$/).length, 1, 'still merged');
  assert.ok(!q.out.includes('Ask where they parked first'), 'the note is not printed under --quiet');
  assert.match(q.out, /version note is not shown \(--quiet\)/);

  /* the old way round is named, not silently ignored */
  const old = await loop(['promote', '--branch', 'agtbrch_loop1', '--proposal', shared.proposal], dir);
  assert.equal(old.code, 1);
  assert.match(old.out, /--proposal is gone: promote reads the version note from the branch itself/);
});

test('configure merges analysis.json over the agent\'s own settings and enables the overrides', async () => {
  const dir = workdir();
  const r = await loop(['configure'], dir);
  assert.equal(r.code, 0, r.out);
  const req = sent('PATCH', /\/v1\/convai\/agents\/agent_test1$/)[0];
  const ps = req.body.platform_settings;
  assert.deepEqual(ps.evaluation.criteria.map(c => c.id), ['their_crit', 'otto_tip_elicited'], 'theirs kept, ours added');
  assert.equal(ps.data_collection.tip_type.type, 'string');
  assert.deepEqual(ps.overrides.conversation_config_override, { agent: { first_message: true, language: true }, conversation: { text_only: true } });
  assert.equal(req.body._otto, undefined);
  assert.equal(req.body.platform_settings._otto, undefined);
  assert.match(req.body.version_description, /analysis\.json/);
  assert.match(r.out, /agent\.first_message\s+enabled in this PATCH/);
  assert.match(r.out, /now carries 2 criteria and 1 data-collection fields/);
  assert.equal(mock.state.agent.platform_settings.overrides.conversation_config_override.agent.first_message, true);
  /* the rest of the agent's settings travel with the PATCH, so the
   * agent comes out right whether ElevenLabs merges or replaces the
   * object — the mock replaces, and the attached tests must survive it */
  const theirs = mock.fixture.agent.platform_settings;
  for (const k of ['auth', 'call_limits', 'privacy', 'widget', 'testing']) assert.deepEqual(ps[k], theirs[k], `${k} goes back unchanged`);
  assert.equal(ps.safety, undefined, 'safety is response-only and is not echoed');
  assert.deepEqual(ps.queueing_config, { enabled: false }, 'read-only hold_audio dropped, the rest of queueing_config kept');
  assert.deepEqual(mock.state.agent.platform_settings.testing, { attached_tests: [{ test_id: 'test_pre8' }] }, 'attached tests survived a replacing PATCH');
  assert.deepEqual(mock.state.agent.platform_settings.auth, theirs.auth, 'auth survived a replacing PATCH');
  assert.match(r.out, /other platform settings go back as they are: auth, call_limits, privacy, widget, testing, queueing_config/);

  rmSync(path.join(dir, 'analysis.json'));
  mock.requests.length = 0;
  const r2 = await loop(['configure'], dir);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /analysis\.json is not there/);
  assert.equal(mock.requests.length, 0);
});

test('--dry-run prints every request and sends nothing, with no key in the environment', async () => {
  const dir = workdir();
  writeFileSync(path.join(dir, 'tests.lock.json'), JSON.stringify({ [T1]: 'test_001' }));
  mkdirSync(path.join(dir, 'proposals'));
  const proposal = path.join(dir, 'proposals', 'p.json');
  writeFileSync(proposal, JSON.stringify({ prompt: 'You are Otto. Ask once.', note: 'ask once' }));
  const noKeys = { ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: undefined };
  const commands = [
    ['configure'], ['push-tests'], ['run', '--repeat', '2'], ['pull'],
    ['cut', '--field', shared.field], ['propose', '--results', shared.results, '--field', shared.field],
    ['branch', '--proposal', proposal], ['promote', '--branch', 'branch_x'],
    ['publish', '--results', shared.results, '--verdict', 'accept', '--reason', 'r'],
  ];
  for (const cmd of commands) {
    const r = await loop([...cmd, '--dry-run'], dir, noKeys);
    assert.equal(r.code, 0, `${cmd[0]}: ${r.out}`);
    assert.match(r.out, /DRY RUN/, cmd[0]);
    /* cut talks to nobody — it only says what it would write */
    if (cmd[0] === 'cut') assert.match(r.out, /would be written/);
    else assert.match(r.out, /\(dry run\) (GET|POST|PUT|PATCH)/, cmd[0]);
    assert.ok(!r.out.includes('sk-eleven') && !r.out.includes('sk-openai'), 'no key printed');
  }
  assert.equal(mock.requests.length, 0, 'the mock saw nothing');
  assert.equal(filesIn(path.join(dir, 'results')).length, 0);
  assert.equal(filesIn(path.join(dir, 'field')).length, 0);
  assert.equal(filesIn(path.join(dir, 'proposals')).length, 1, 'no proposal written');
  assert.ok(!existsSync(path.join(dir, 'test_configs', 'regressions')), 'no regression written');
  assert.deepEqual(readJson(path.join(dir, 'tests.lock.json')), { [T1]: 'test_001' }, 'the lock is untouched');
  const printed = (await loop(['push-tests', '--dry-run'], dir, noKeys)).out;
  assert.match(printed, /\(dry run\) PUT .*\/v1\/convai\/agent-testing\/test_001/);
  assert.match(printed, /\(dry run\) POST .*\/v1\/convai\/agent-testing\/create/);
  assert.doesNotMatch(printed, /"_otto"/);

  /* a fresh clone has no lock: the dry run still previews the request,
   * with a placeholder where push-tests would have put the id */
  const fresh = workdir();
  const r = await loop(['run', '--repeat', '2', '--dry-run'], fresh, noKeys);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(dry run\) POST .*\/v1\/convai\/agents\/agent_test1\/run-tests/);
  assert.match(r.out, /"test_id": "<id from tests\.lock\.json>"/);
  assert.match(r.out, /"repeat_count": 2/);
  assert.equal(mock.requests.length, 0, 'still nothing sent');
  assert.ok(!existsSync(path.join(fresh, 'tests.lock.json')), 'no lock invented');
});

test('a live command refuses to run without its key and names the variable', async () => {
  const dir = workdir();
  let r = await loop(['push-tests'], dir, { ELEVENLABS_API_KEY: undefined });
  assert.equal(r.code, 1);
  assert.match(r.out, /ELEVENLABS_API_KEY is not set/);
  r = await loop(['pull'], dir, { ELEVENLABS_AGENT_ID: undefined });
  assert.equal(r.code, 1);
  assert.match(r.out, /ELEVENLABS_AGENT_ID is not set/);
  r = await loop(['propose', '--results', shared.results, '--prompt', path.join(FIXTURE, 'agent.json')], dir, { OPENAI_API_KEY: undefined });
  assert.equal(r.code, 1);
  assert.match(r.out, /OPENAI_API_KEY is not set/);
  assert.equal(mock.requests.length, 0);
  r = await loop(['nonsense'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown command "nonsense"/);
  r = await loop([], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /usage: node loop\.mjs/);
  r = await loop(['--help'], dir);
  assert.equal(r.code, 0, 'asking for the usage is not an error');
  assert.match(r.out, /usage: node loop\.mjs/);
});

test('the http wrapper retries once on a 5xx, never prints the key, and names a failure', async () => {
  const lines = [];
  const http = makeHttp({ log: s => lines.push(s), secrets: ['sk-secret'], retryDelayMs: 1 });
  const api = elevenLabs({ apiKey: 'sk-secret', base: mock.url, http });
  mock.state.failNext = 503;
  const agent = await api.getAgent('agent_test1');
  assert.equal(agent.agent_id, 'agent_test1');
  assert.equal(mock.requests.length, 2, 'one retry');
  mock.state.failNext = 400;
  await assert.rejects(() => api.getAgent('agent_test1'), e => e instanceof ApiError && /^400 from GET \/v1\/convai\/agents\/agent_test1: /.test(e.message));
  assert.equal(mock.requests.length, 3, 'no retry on a 4xx');
  await assert.rejects(() => api.updateTest('nope', { name: 'x' }), e => e.status === 404);
  const dry = makeHttp({ dryRun: true, log: s => lines.push(s), secrets: ['sk-secret'] });
  await dry.send({ method: 'POST', base: mock.url, path: '/v1/x', body: { leaked: 'sk-secret in a body' } });
  assert.match(lines.join('\n'), /\[redacted\] in a body/);
  assert.ok(!lines.join('\n').includes('sk-secret'));
});

test('aggregate, compareResults, scoreData and gradeSummary as pure functions', () => {
  const inv = { test_runs: [
    { test_id: 'a', status: 'passed' }, { test_id: 'a', status: 'failed', condition_result: { result: 'failure', rationale: { messages: ['m1', 'm2'], summary: '' } } },
    { test_id: 'b', status: 'failed', condition_result: { result: 'failure', rationale: { summary: 'Why.' } }, branch_id: 'br', version_id: 'v' },
    { test_id: 'b', status: 'failed', condition_result: { result: 'failure', rationale: { summary: 'Why.' } } },
  ] };
  const t = aggregate(inv, { idToName: { a: 'A' } });
  assert.deepEqual(t.map(x => [x.name, x.runs, x.passed, x.pass_rate, x.rationales, x.branch_id]), [
    ['b', 2, 0, 0, ['Why.'], 'br'], ['A', 2, 1, 0.5, ['m1 m2'], null],
  ]);
  assert.equal(gradeSummary(null).graded, false);
  assert.equal(gradeSummary({ checks: {}, note: 'a note' }).graded, true);
  assert.equal(gradeSummary({ checks: { opener: true } }).bad, false);
  assert.deepEqual(gradeSummary({ checks: { opener: true, tip: false } }).failed, ['tip']);
  const c = compareResults({ tests: [{ name: 'x', pass_rate: 0.5 }] }, { tests: [{ name: 'x', pass_rate: 0.4 }] });
  assert.equal(c.accept, false);
  assert.equal(c.rows[0].dropped, false, 'a ten-point drop is within the margin');
  assert.equal(c.totalDown, true, 'but the total fell, so no accept');
  /* judged by situation, every driver type together: four tests at 3
   * calls, one of them losing a call, is one call of twelve — noise, not
   * a drop; four calls of twelve is a drop; a gain elsewhere and a
   * higher total is an accept */
  const sit = (n, per) => per.map((p, i) => ({ name: `Otto · situation #${n} x · d${i}`, situation_num: n, situation_title: 'x', persona: 'd' + i, runs: 3, passed: p, pass_rate: p / 3, rationales: [] }));
  const baseR = { tests: [...sit(1, [1, 1, 1, 1]), ...sit(2, [0, 0, 1, 0])] };
  const noise = compareResults(baseR, { tests: [...sit(1, [0, 1, 1, 1]), ...sit(2, [1, 0, 1, 0])] });
  assert.equal(noise.rows.length, 2, 'one row per situation');
  assert.deepEqual(noise.rows.map(r => r.dropped), [false, false], 'one call of twelve is within a quarter');
  assert.equal(noise.accept, true, 'situation #2 gained a call and the total did not fall');
  assert.match(noise.reason, /^1 situation\(s\) improved, none dropped by more than 25 points, and the total went up: 5 of 24 calls against 5 of 24/);
  const drop = compareResults(baseR, { tests: [...sit(1, [0, 0, 0, 0]), ...sit(2, [1, 1, 1, 1])] });
  assert.equal(drop.rows[0].dropped, true, 'four calls of twelve lost is a drop');
  assert.equal(drop.accept, false);
  assert.match(drop.reason, /^1 situation\(s\) dropped by more than 25 points \(#1 x: −4 calls\)/);
  /* a driver type added since the baseline: its tests exist only on the
   * branch and are left out, so the rows compare like for like */
  const extra = { name: 'Otto · situation #1 x · annoyed', situation_num: 1, situation_title: 'x', persona: 'annoyed', runs: 3, passed: 0, pass_rate: 0, rationales: [] };
  const fair = compareResults(baseR, { tests: [...sit(1, [0, 1, 1, 1]), ...sit(2, [1, 0, 1, 0]), extra] });
  assert.deepEqual(fair.leftOut, { branch: ['Otto · situation #1 x · annoyed'], base: [] });
  assert.equal(fair.rows[0].calls, '3/12', 'the annoyed tests do not count in the row');
  assert.equal(fair.accept, true);
  const s = scoreData({ tests: [{ scenario_num: 3, scenario_title: 'T', runs: 2, passed: 1, rationales: ['Too long. Really.'] }] }, null);
  assert.equal(s[0].key, '#3');
  assert.equal(s[0].reasons[0].reason, 'too long');
  /* both sheets number from one, so a situation row keys apart from the
   * trigger scenario with the same number */
  const both = scoreData({ tests: [
    { scenario_num: 3, scenario_title: 'T', runs: 2, passed: 2 },
    { kind: 'situation', situation_num: 3, situation_title: 'A dog at the door', runs: 2, passed: 1 },
  ] }, null);
  assert.deepEqual(both.map(x => [x.key, x.kind, x.title]).sort(), [['#3', 'scenario', 'T'], ['s#3', 'situation', 'A dog at the door']]);
  assert.equal(reasonKey('  The AGENT asked   four questions! Then more.'), 'the agent asked four questions');
});

test('unifiedDiff and table', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
  const d = unifiedDiff('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine!\nten\neleven');
  assert.match(d, /@@ -6,5 \+6,6 @@\n six\n seven\n eight\n-nine\n\+nine!\n ten\n\+eleven$/);
  const two = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL');
  assert.equal((two.match(/^@@ /gm) || []).length, 2, 'two hunks when the changes are far apart');
  const t = table([{ a: 'a very long name indeed', b: 0.5 }], [{ key: 'a', label: 'name', width: 10 }, { key: 'b', label: 'n', width: 4, right: true }]);
  assert.equal(t, 'name           n\na very lo…   0.5', 'a right-aligned column has a right-aligned header');
});

test('cut puts an opener failure at the first agent turn, and leaves the opener out of a test cut mid-conversation', async () => {
  const dir = workdir();
  const field = readJson(shared.field);
  const aaa = field.conversations.find(c => c.conversation_id === 'conv_aaa');
  const clone = (id, checks, extra = {}) => ({ ...JSON.parse(JSON.stringify(aaa)), conversation_id: id, grade: { checks, note: '', at: '2026-09-10T09:00:00Z', agent_version: null }, ...extra });
  const openerOnly = clone('conv_op1', { opener: false, followup: null, tip: null, brevity: null, language: null });
  const mixed = clone('conv_op2', { opener: false, followup: false, tip: null, brevity: null, language: null });
  /* no phone convo, an ElevenLabs transcript with nothing but a wrong opener */
  const bare = clone('conv_op3', { opener: false }, { message: null, transcript: [{ role: 'agent', message: 'Hi there! How was your day?', t: 0 }] });
  const f = path.join(dir, 'field.json');
  writeFileSync(f, JSON.stringify({ ...field, conversations: [openerOnly, mixed, bare] }));
  const r = await loop(['cut', '--field', f], dir);
  assert.equal(r.code, 0, r.out);
  const t1 = readJson(path.join(dir, 'test_configs', 'regressions', 'conv_op1.json'));
  assert.ok(!('chat_history' in t1), 'nothing before the first agent turn, so no history is sent');
  assert.deepEqual(t1.failure_examples, [{ response: 'Is it hard to park here at this time? Where did you find a spot?', type: 'failure' }], 'the opener is the reply to do better than');
  assert.match(t1.success_condition, /failing: Opened with the scenario's question\./);
  assert.match(t1.success_condition, /opens with the scenario's own question \(“Is it hard to park here at this time\? Where did you find a spot\?”\)/);
  assert.doesNotMatch(t1.success_condition, /follows up/);
  assert.deepEqual(t1._otto, { scenario_num: 1, scenario_title: 'Parking loops — two slow passes and a stop', persona: 'field', kind: 'regression', source_conversation_id: 'conv_op1', language: 'en' });
  const t2 = readJson(path.join(dir, 'test_configs', 'regressions', 'conv_op2.json'));
  assert.deepEqual(t2.chat_history.map(x => x.role), ['agent', 'user', 'agent', 'user'], 'the other checks cut before the last agent turn');
  assert.equal(t2.failure_examples[0].response, 'Thanks, safe travels.');
  assert.match(t2.success_condition, /failing: Followed up on what the tester actually found\./);
  assert.match(t2.success_condition, /follows up on what the tester actually said/);
  assert.doesNotMatch(t2.success_condition, /opens with|Opened with/, 'a reply four turns in is never asked to open');
  const t3 = readJson(path.join(dir, 'test_configs', 'regressions', 'conv_op3.json'));
  assert.ok(!('chat_history' in t3));
  assert.equal(t3.failure_examples[0].response, 'Hi there! How was your day?');
  assert.match(r.out, /conv_op1 +written \(opener: first turn\)/);
  assert.match(r.out, /conv_op2 +written \(opener left out\)/);
  assert.match(r.out, /3 regression test\(s\) written/);
  assert.match(r.out, /1 opener check\(s\) left out of a test cut mid-conversation/);
  assert.match(r.out, /first_message override/);

  /* the same field on a dry run: the cut point is announced, nothing written */
  const dry = workdir();
  const d = await loop(['cut', '--field', f, '--dry-run'], dry);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /would be written \(opener: first turn\)/);
  assert.ok(!existsSync(path.join(dry, 'test_configs', 'regressions')));

  /* pushed, the first-turn test goes out without a chat_history key */
  mock.requests.length = 0;
  const pushed = await loop(['push-tests'], dir);
  assert.equal(pushed.code, 0, pushed.out);
  const posted = sent('POST', /create$/).map(q => q.body).find(b => b.name === 'Otto · regression · conv_op1');
  assert.ok(posted);
  assert.ok(!('chat_history' in posted));
  assert.equal(posted.type, 'llm');
});

test('cut files a regression under its scenario: the join first, the phone\'s dynamic variables when the join is gone', async () => {
  const dir = workdir();
  const field = readJson(shared.field);
  const aaa = field.conversations.find(c => c.conversation_id === 'conv_aaa');
  const bad = { checks: { opener: true, followup: false, tip: null, brevity: null, language: null }, note: '', at: '2026-09-10T09:00:00Z', agent_version: null };
  const clone = (id, extra) => ({ ...JSON.parse(JSON.stringify(aaa)), conversation_id: id, grade: bad, ...extra });
  const joined = clone('conv_j1', {});
  /* the debrief's row is gone from the dashboard: no message, no scenario — but the phone told the agent which row it was */
  const unjoined = clone('conv_j2', { message: null, scenario: null, dynamic_variables: { ...aaa.dynamic_variables, scenario_num: '8', scenario_title: 'Blocked route — turned round short of the address' } });
  const nowhere = clone('conv_j3', { message: null, scenario: null, dynamic_variables: { debrief_language: 'Italian' } });
  const f = path.join(dir, 'field.json');
  writeFileSync(f, JSON.stringify({ ...field, conversations: [joined, unjoined, nowhere] }));
  const r = await loop(['cut', '--field', f], dir);
  assert.equal(r.code, 0, r.out);
  const otto = id => readJson(path.join(dir, 'test_configs', 'regressions', `${id}.json`))._otto;
  assert.deepEqual(otto('conv_j1'), { scenario_num: 1, scenario_title: 'Parking loops — two slow passes and a stop', persona: 'field', kind: 'regression', source_conversation_id: 'conv_j1', language: 'en' });
  assert.deepEqual(otto('conv_j2'), { scenario_num: 8, scenario_title: 'Blocked route — turned round short of the address', persona: 'field', kind: 'regression', source_conversation_id: 'conv_j2', language: 'en' }, 'the number as a number, from the variables');
  assert.deepEqual(otto('conv_j3'), { scenario_num: null, scenario_title: '', persona: 'field', kind: 'regression', source_conversation_id: 'conv_j3', language: 'it' }, 'no scenario anywhere stays unknown rather than invented');
  /* and through run, the regression's row knows its scenario */
  mock.requests.length = 0;
  assert.equal((await loop(['push-tests'], dir)).code, 0);
  const lock = readJson(path.join(dir, 'tests.lock.json'));
  assert.ok(lock['Otto · regression · conv_j2']);
});

test('run gives up on an invocation that never completes, names the knobs, and writes nothing', async () => {
  const dir = workdir();
  writeFileSync(path.join(dir, 'tests.lock.json'), JSON.stringify({ [T1]: 'test_001' }));
  mock.state.neverComplete = true;
  const r = await loop(['run', '--repeat', '2'], dir, { LOOP_POLL_MS: '5', LOOP_TIMEOUT_MS: '40' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /run failed: invocation inv_1 still has 2 pending run\(s\) after 0 min — poll it yourself: GET \/v1\/convai\/test-invocations\/inv_1/);
  assert.match(r.out, /LOOP_TIMEOUT_MS=40/);
  assert.match(r.out, /LOOP_POLL_MS=5/);
  assert.ok(sent('GET', /test-invocations\/inv_1$/).length >= 2, 'polled more than once before giving up');
  assert.equal(filesIn(path.join(dir, 'results')).length, 0, 'no results file for a suite that did not finish');
});

test('a 5xx is not retried on the POSTs that start, create or merge something, a 429 is, and run says why', async () => {
  const lines = [];
  const http = makeHttp({ log: s => lines.push(s), secrets: ['sk-secret'], retryDelayMs: 1 });
  const api = elevenLabs({ apiKey: 'sk-secret', base: mock.url, http });
  mock.state.failNext = 502;
  await assert.rejects(() => api.createTest({ name: 'Otto · x', type: 'llm' }), e => e instanceof ApiError && e.status === 502);
  assert.equal(mock.requests.length, 1, 'one POST — a second would leave a duplicate test');
  assert.equal(mock.state.tests.length, 1, 'only the pre-existing test in the workspace');
  mock.state.failNext = 429;
  const res = await api.createTest({ name: 'Otto · y', type: 'llm' });
  assert.equal(res.id, 'test_001');
  assert.equal(mock.requests.length, 3, 'a 429 was refused outright, so the POST went again');
  mock.state.failNext = 503;
  await assert.rejects(() => api.createBranch('agent_test1', { parent_version_id: 'v', name: 'b', description: 'd' }), e => e.status === 503);
  assert.equal(mock.state.branches.length, 0);
  mock.state.failNext = 504;
  await assert.rejects(() => api.mergeBranch('agent_test1', 'b1', 'branch_main'), e => e.status === 504);
  assert.equal(mock.state.merges.length, 0);
  assert.equal(mock.requests.length, 5, 'neither was re-sent');

  const dir = workdir();
  writeFileSync(path.join(dir, 'tests.lock.json'), JSON.stringify({ [T1]: 'test_001' }));
  mock.requests.length = 0;
  mock.state.failNext = 502;
  const r = await loop(['run', '--repeat', '2'], dir);
  assert.equal(r.code, 1, r.out);
  assert.equal(sent('POST', /run-tests$/).length, 1, 'one run-tests, never two');
  assert.match(r.out, /run failed: 502 from POST \/v1\/convai\/agents\/agent_test1\/run-tests: /);
  assert.match(r.out, /not retried: a second run-tests would start \(and bill\) a second suite/);
  assert.match(r.out, /poll GET \/v1\/convai\/test-invocations\/<id>/);
  assert.equal(filesIn(path.join(dir, 'results')).length, 0);
});

test('propose sizes the completion from the prompt, reports a reply cut by the token limit, and diffs the trimmed prompt', async () => {
  const dir = workdir();
  const pf = path.join(dir, 'prompt.txt');
  const text = 'You are Otto, debriefing a field tester after a trigger scenario fired.\nAsk one thing.\nThen let them get on with the route.\n';
  writeFileSync(pf, text);
  mock.state.openaiReply = () => ({ prompt: text.trim().replace('Ask one thing.', 'Ask one thing, then stop.'), note: 'stop after one', rationale: 'brevity' });
  let r = await loop(['propose', '--results', shared.results, '--field', shared.field, '--prompt', pf], dir);
  assert.equal(r.code, 0, r.out);
  const req = sent('POST', /chat\/completions$/)[0];
  assert.equal(req.body.max_tokens, Math.min(16000, Math.ceil(text.trim().length / 3) + 1500));
  assert.equal(JSON.parse(req.body.messages[1].content).current_prompt, text.trim(), 'the model gets the prompt without the file\'s trailing newline');
  const p = readJson(path.join(dir, 'proposals', filesIn(path.join(dir, 'proposals'))[0]));
  assert.equal(p.base_chars, text.trim().length);
  assert.match(p.diff, /@@ -1,3 \+1,3 @@/, 'three lines against three, no phantom fourth');
  assert.doesNotMatch(p.diff, /\n-\n|\n-$/, 'no removed blank line for the trailing newline');

  const long = 'x'.repeat(30000);
  writeFileSync(pf, long);
  mock.state.openaiReply = () => ({ prompt: long + ' y', note: 'n', rationale: 'r' });
  mock.requests.length = 0;
  r = await loop(['propose', '--results', shared.results, '--field', shared.field, '--prompt', pf], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(sent('POST', /chat\/completions$/)[0].body.max_tokens, 11500, 'ceil(30000 / 3) + 1500');

  mock.state.openaiFinish = 'length';
  r = await loop(['propose', '--results', shared.results, '--field', shared.field, '--prompt', pf], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /cut by the token limit \(max_tokens 11500\)/);
  assert.doesNotMatch(r.out, /something other than JSON/);
});

test('propose trims the evidence to the budget instead of cutting the JSON, and says what was left out', async () => {
  const many = n => Array.from({ length: n }, (_, i) => i);
  const evidence = {
    failing_tests: many(30).map(i => ({ test: `T${i}`, passed: '0/3', scenario: 's', persona: 'p', rationales: many(3).map(j => `rationale ${j} `.repeat(40).slice(0, 400)) })),
    bad_debriefs: many(20).map(i => ({ conversation_id: `c${i}`, scenario: '#1', failed_checks: ['x'], note: '', criteria_failed: [], transcript: many(12).map(() => `user: ${'word '.repeat(70).slice(0, 300)}`) })),
    criteria_results: {},
  };
  const raw = JSON.stringify({ current_prompt: 'p', ...evidence }).length;
  assert.ok(raw > 80000, `the raw payload is ${raw} chars`);
  const fit = fitEvidence('p', evidence);
  assert.ok(fit.fits);
  const payload = JSON.stringify({ current_prompt: 'p', ...fit.evidence });
  assert.ok(payload.length <= 80000, `${payload.length} chars`);
  JSON.parse(payload);
  assert.ok(fit.shortened);
  assert.equal(fit.evidence.failing_tests[0].test, 'T0', 'the worst test survives');
  assert.equal(fit.evidence.bad_debriefs[0].conversation_id, 'c0', 'the latest debrief survives');
  assert.ok(fit.evidence.bad_debriefs[0].transcript.length <= 6);
  const tiny = fitEvidence('p'.repeat(100), evidence, 50);
  assert.equal(tiny.fits, false, 'a prompt over the budget cannot fit');
  assert.deepEqual(tiny.left_out, { failing_tests: 30, bad_debriefs: 20 });

  /* through the command: a field file with far more debriefs than fit */
  const dir = workdir();
  const field = readJson(shared.field);
  const aaa = field.conversations.find(c => c.conversation_id === 'conv_aaa');
  const big = many(120).map(i => ({
    ...JSON.parse(JSON.stringify(aaa)), conversation_id: `conv_big${i}`, message: null,
    transcript: many(12).map(j => ({ role: j % 2 ? 'user' : 'agent', message: `turn ${j} ${'blah '.repeat(80)}`, t: j })),
  }));
  const f = path.join(dir, 'field.json');
  writeFileSync(f, JSON.stringify({ ...field, conversations: big }));
  const r = await loop(['propose', '--results', shared.results, '--field', f, '--prompt', path.join(FIXTURE, 'agent.json')], dir);
  assert.equal(r.code, 0, r.out);
  const content = sent('POST', /chat\/completions$/)[0].body.messages[1].content;
  assert.ok(content.length <= 80000);
  const user = JSON.parse(content);
  assert.ok(user.bad_debriefs.length > 0 && user.bad_debriefs.length < 120, `${user.bad_debriefs.length} debriefs sent`);
  assert.equal(user.bad_debriefs[0].conversation_id, 'conv_big0', 'the first in the field file — the newest — is kept');
  assert.match(r.out, /evidence trimmed to fit 80000 chars: rationales and transcripts shortened, 0 of 1 failing test\(s\) and [1-9]\d* of 120 bad debrief\(s\) left out/);
  assert.match(r.out, /pass a narrower --results \/ --field/);
});

test('push-tests mocks the agent\'s tools for the suite — a client tool has no phone to answer it', async () => {
  const dir = workdir();
  /* the fixture agent carries one client tool and one system tool */
  mock.state.agent.conversation_config.agent.prompt.tool_ids = ['tool_report', 'tool_end'];
  let r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /mocking 1 tool\(s\) for the suite: report_incident \(client\)/);
  const created = sent('POST', /agent-testing\/create$/).map(x => x.body);
  const sim = created.find(b => b.type === 'simulation');
  assert.ok(sim, 'a simulation test was created');
  assert.deepEqual(sim.tool_mock_config, { mocking_strategy: 'all', fallback_strategy: 'raise_error' });
  assert.ok(Array.isArray(sim.tool_mock_overrides.tool_report), 'the API wants a list of answers per tool, not one object');
  assert.equal(sim.tool_mock_overrides.tool_report.length, 1);
  /* a receipt that asks to be kept quiet — not a sentence in the tool's name the agent would repeat to the driver */
  assert.match(sim.tool_mock_overrides.tool_report[0].mock_result, /^OK\. Handled in the background\. Do not tell the driver/);
  assert.doesNotMatch(sim.tool_mock_overrides.tool_report[0].mock_result, /report_incident|client side|carry on/);
  assert.equal(sim.tool_mock_overrides.tool_report[0].is_error, false);
  assert.equal(sim.tool_mock_overrides.tool_end, undefined, 'system tools are never mocked');
  assert.equal(sim._otto, undefined);
  /* the files on disk stay agent-independent */
  const onDisk = readJson(path.join(dir, 'test_configs', 'scenario-01-parking-loops--cooperative.json'));
  assert.equal(onDisk.tool_mock_config, undefined);

  /* an agent without tools gets no mock block; --no-mock-tools sends none either way */
  mock.reset();
  r = await loop(['push-tests'], dir);
  assert.match(r.out, /carries no tools to mock/);
  assert.ok(sent('PUT', /agent-testing\//).every(x => x.body.tool_mock_config === undefined));
  mock.reset();
  mock.state.agent.conversation_config.agent.prompt.tool_ids = ['tool_report'];
  r = await loop(['push-tests', '--no-mock-tools'], dir);
  assert.match(r.out, /tool mocks off/);
  assert.ok(sent('PUT', /agent-testing\//).every(x => x.body.tool_mock_config === undefined));
  assert.equal(sent('GET', /\/v1\/convai\/tools$/).length, 0, 'the tools are not even looked up');
});

test('the why line names the failed criterion, not the verdict word', async () => {
  const { whyOf, verdictsOf } = await import('../loop.mjs');
  /* the judge's own word wins over the cue words: the first FAIL
   * paragraph is the reason, whatever the passing ones say */
  const worded = { rationale: { summary: 'Evaluation failed', messages: [
    'Criterion 1: PASS. The first follow-up fits the report, exceeding expectations.',
    'Criterion 2: PASS. Nothing asked twice.',
    'Criterion 3: FAIL. Otto read the whole report back before his first question.',
    'Criterion 5: FAIL. Four follow-up questions.',
  ] } };
  assert.equal(whyOf(worded), 'Criterion 3: FAIL. Otto read the whole report back before his first question.');
  assert.deepEqual(verdictsOf(worded), ['pass', 'pass', 'fail', 'unknown', 'fail']);
  assert.deepEqual(verdictsOf({ rationale: { messages: ['**FAIL** — no tip.', 'Verdict: PASS, fine.'] } }), ['fail', 'pass'], 'without the criterion prefix the position is the number; markdown and a "Verdict:" lead are tolerated');
  /* the judge's real spelling on the live runs: no colon after the number, the word inflected */
  assert.deepEqual(verdictsOf({ rationale: { summary: 'Evaluation failed', messages: ['Criterion 1 passed: the first follow-up fits.', 'Criterion 2 failed: Otto re-asked the floor.', 'Criterion 3 passed: plain words.'] } }), ['pass', 'fail', 'pass']);
  assert.equal(whyOf({ rationale: { summary: 'Evaluation failed', messages: ['Criterion 1 passed: the first follow-up fits.', 'Criterion 2 failed: Otto re-asked the floor.'] } }), 'Criterion 2 failed: Otto re-asked the floor.');
  assert.equal(verdictsOf({ rationale: { messages: ['Criterion 1: fine.', 'Criterion 2: not so fine.'] } }), null, 'no verdict word anywhere is null, and the callers read the prose');
  assert.equal(whyOf({ rationale: { summary: 'Unsupported client tool', messages: ['Criterion 1: FAIL. x'] } }), 'Unsupported client tool', 'a summary that says something of its own still wins');
  const generic = { rationale: { summary: 'Evaluation failed', messages: [
    'Criterion 1: The agent opens with exactly the required question. Criteria met.',
    'Criterion 4: Questions asked: four — exceeding the limit of three.',
    'The agent ended the conversation.',
  ] } };
  assert.equal(whyOf(generic), 'Criterion 4: Questions asked: four — exceeding the limit of three.');
  const specific = { rationale: { summary: 'Unsupported client tool', messages: ["Client tool 'report_incident' was called during simulation."] } };
  assert.equal(whyOf(specific), 'Unsupported client tool');
  const noSummary = { rationale: { messages: ['m1', 'm2'] } };
  assert.equal(whyOf(noSummary), 'm1 m2');
  assert.equal(whyOf({}), 'no rationale returned');
  const long = { rationale: { summary: 'Evaluation failed', messages: ['Criterion 6: the closing tip omits ' + 'the time restriction '.repeat(30)] } };
  assert.ok(whyOf(long).length <= 240 && whyOf(long).endsWith('…'));

  /* the evaluator writes a paragraph for the conditions it was happy
   * with too, in the same voice — quoting one of those as the reason a
   * test failed is worse than saying nothing */
  const allPassing = { rationale: { summary: 'Evaluation failed', messages: [
    'Criterion 2: Otto never asks the driver to repeat something already stated. Each question adds new information.',
    'Criterion 3: No form-filling language or lecturing. Plain spoken throughout.',
    'Criterion 4: Otto states no invented facts.',
  ] } };
  assert.match(whyOf(allPassing), /read them in full/);
  const mixed = { rationale: { summary: 'Evaluation failed', messages: [
    'Criterion 3: No form-filling language or lecturing.',
    'Criterion 6: Otto never provides a closing tip for the next driver.',
  ] } };
  assert.match(whyOf(mixed), /^Criterion 6:/);
});

/* ---------- the situation suite, and the prompt that must not leak ---------- */

/* The prompt is confidential and the repository is public: a job log, a
 * job summary, an artifact and the shared agent_runs table are all
 * published the moment they are written. --quiet is the switch the
 * buttons pass, and this is what it has to hold back. */
test('propose --quiet prints counts and a file name — never the prompt, the diff or the note', async () => {
  const dir = shared.dir;
  const secret = mock.state.agent.conversation_config.agent.prompt.prompt;
  const r = await loop(['propose', '--quiet', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(r.code, 0, r.out);
  const written = filesIn(path.join(dir, 'proposals'));
  const file = path.join(dir, 'proposals', written[written.length - 1]);
  const p = readJson(file);
  /* the proposal itself is whole — it stays on the runner, gitignored */
  assert.match(p.prompt, /Ask where they parked before anything else\.$/);
  assert.ok(p.diff.includes('Ask where they parked before anything else.'));
  assert.equal(p.note, 'Ask where they parked first — two field debriefs never got the spot');
  /* what was printed carries none of it */
  for (const line of secret.split('\n')) assert.ok(!r.out.includes(line.trim()), `the prompt was printed: ${line.slice(0, 40)}`);
  assert.ok(!r.out.includes('Ask where they parked'), 'the proposed line or the note was printed');
  assert.doesNotMatch(r.out, /^[+-][^+-]/m, 'a diff line was printed');
  assert.doesNotMatch(r.out, /^rationale:/m);
  assert.match(r.out, /proposal written to .*\.json — not shown/);
  assert.match(r.out, /\d+ chars in, \d+ out, \d+ changed line\(s\)/);
  assert.match(r.out, /next: node loop\.mjs branch --proposal/);

  /* a refusal says why, and keeps the model's own words to itself */
  mock.state.openaiReply = () => ({ prompt: secret + '\n' + 'A new rule. '.repeat(60), note: 'much longer', rationale: 'because the prompt says X' });
  const refused = await loop(['propose', '--quiet', '--results', shared.results, '--field', shared.field], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refused: the proposal grows the prompt by \d+% \(limit 25%\)/);
  assert.match(refused.out, /the model's note and rationale are not shown$/);
  assert.ok(!refused.out.includes('much longer') && !refused.out.includes('because the prompt says X'));

  /* a dry run prints the requests it would send, and no bodies: the
   * proposer's body IS the prompt */
  mock.reset();
  const dry = await loop(['propose', '--quiet', '--dry-run', '--results', shared.results, '--field', shared.field, '--prompt', path.join(dir, 'prompt.txt')], dir);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /\(dry run\) POST .*\/chat\/completions/);
  assert.match(dry.out, /\(body not shown — --quiet\)/);
  assert.ok(!dry.out.includes('You are Otto'), 'the prompt travelled in the printed body');
  assert.equal(mock.requests.length, 0, 'nothing sent');
});

/* branch is the one request that carries the prompt itself; what it
 * prints is ids, and what a refusal prints is not the reply */
test('branch prints ids only, and never what came back from the request that carries the prompt', async () => {
  const dir = shared.dir;
  const proposal = path.join(dir, 'proposals', 'quiet-branch.json');
  writeFileSync(proposal, JSON.stringify({ prompt: 'You are Otto. The secret line nobody may read.', note: 'a note about the secret line' }));
  const r = await loop(['branch', '--proposal', proposal, '--name', 'loop-quiet'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes('secret line'), 'the prompt was printed');
  assert.ok(!r.out.includes('a note about the secret line'), 'the note was printed');
  assert.match(r.out, /branch "loop-quiet" created: agtbrch_loop1 \(version agtvrsn_b1, from agtvrsn_v1\)/);
  /* the note does reach ElevenLabs, as the branch's description — that
   * is where promote reads it from */
  assert.equal(sent('POST', /\/branches$/)[0].body.description, 'a note about the secret line');

  mock.state.branchRefuses = 422;
  const bad = await loop(['branch', '--proposal', proposal], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /422 from POST \/v1\/convai\/agents\/agent_test1\/branches — the reply is not shown/);
  assert.ok(!bad.out.includes('secret line'));
});

/* the situation suite rides through the loop the way the trigger suite
 * does: the _otto block on the test file becomes the meta on the
 * results row, and the published row groups by situation as well as by
 * scenario, so a situation card on the dashboard finds its own */
test('a situation test carries its row through run, results and the agent_runs row', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'otto-sit-'));
  const configs = path.join(dir, 'test_configs', 'situations');
  mkdirSync(configs, { recursive: true });
  const name = 'Otto · situation #2 A big dog at the door · vague';
  writeFileSync(path.join(configs, 'situation-02-a-big-dog-at-the-door--vague.json'), JSON.stringify({
    name,
    type: 'simulation',
    dynamic_variables: { destination_title: 'Knaackstraße 22', debrief_language: 'English', trigger_fired: 'no' },
    simulation_scenario: 'You are a parcel-delivery driver …',
    simulation_max_turns: 10,
    success_conditions: ['RELEVANCE — …'],
    _otto: { kind: 'situation', situation_num: 2, situation_title: 'A big dog at the door', persona: 'vague', language: 'en', scenario_num: null, scenario_title: null },
  }, null, 2));

  let r = await loop(['push-tests'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readJson(path.join(dir, 'tests.lock.json'))[name], 'test_001');
  const posted = sent('POST', /agent-testing\/create$/)[0].body;
  assert.equal(posted._otto, undefined, 'the _otto block is stripped before posting');
  assert.ok(!('chat_history' in posted), 'a situation test lets the agent open with its own first message');

  r = await loop(['run', '--repeat', '3'], dir);
  assert.equal(r.code, 0, r.out);
  const results = readJson(path.join(dir, 'results', filesIn(path.join(dir, 'results'))[0]));
  const mine = results.tests.find(t => t.name === name);
  assert.ok(mine, 'the situation test is in the results');
  assert.equal(mine.kind, 'situation');
  assert.equal(mine.situation_num, 2);
  assert.equal(mine.situation_title, 'A big dog at the door');
  assert.equal(mine.scenario_num, null);
  assert.equal(mine.persona, 'vague');

  mock.requests.length = 0;
  r = await loop(['publish'], dir);
  assert.equal(r.code, 0, r.out);
  const row = sent('POST', /agent_runs$/)[0].body[0];
  const published = row.tests.find(t => t.name === name);
  assert.equal(published.kind, 'situation');
  assert.equal(published.situation_num, 2);
  assert.equal(published.situation_title, 'A big dog at the door');
  assert.equal(published.scenario_num, null);
  assert.equal(published.scenario_title, null);
  assert.deepEqual(row.summary.by_situation, { 2: { tests: 1, runs: 3, passed: 2, pass_rate: 2 / 3 } });
  assert.equal(row.note, null);
  assert.match(r.out, /0 scenario\(s\), 1 situation\(s\)/);
  /* a results file from before the situations, published by a name the
   * suite gives them: still filed as one */
  const guessed = agentRunRow({ agent_id: 'a', tests: [{ name, runs: 1, passed: 1 }] });
  assert.equal(guessed.tests[0].kind, 'situation');
  rmSync(dir, { recursive: true, force: true });
});

test('push-tests pushes only the suite it was given, and replaces a test the API will not update', async () => {
  const dir = workdir();
  /* two suites side by side in the same folder */
  mkdirSync(path.join(dir, 'test_configs', 'situations'), { recursive: true });
  writeFileSync(path.join(dir, 'test_configs', 'situations', 'situation-01-road-closed--terse.json'), JSON.stringify({
    name: 'Otto · situation #1 Road closed · terse', type: 'simulation',
    dynamic_variables: { trigger_fired: 'no' }, simulation_scenario: 'you are a driver', simulation_max_turns: 8,
    success_conditions: ['Otto asks about the closure'],
    _otto: { kind: 'situation', situation_num: 1, situation_title: 'Road closed', persona: 'terse', language: 'en' },
  }, null, 2));

  let r = await loop(['push-tests', '--filter', 'Otto · situation'], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushing 1 of \d+ test file\(s\)/);
  const pushedNames = [...sent('POST', /agent-testing\/create$/), ...sent('PUT', /agent-testing\//)].map(x => x.body.name);
  assert.deepEqual(pushedNames, ['Otto · situation #1 Road closed · terse'], 'the trigger tests were left alone');
  assert.deepEqual(Object.keys(readJson(path.join(dir, 'tests.lock.json'))), ['Otto · situation #1 Road closed · terse']);

  /* the API refuses to update what is already there: it is replaced, and
   * the rest of the push carries on */
  mock.reset();
  mock.state.refuseUpdate = true;
  r = await loop(['push-tests', '--filter', 'Otto · situation'], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would not take the update/);
  assert.match(r.out, /1 test\(s\) the API would not update were replaced/);
  assert.equal(sent('DELETE', /agent-testing\//).length, 1, 'the refused test was deleted');
  assert.equal(sent('POST', /agent-testing\/create$/).length, 1, 'and made again');
  assert.ok(readJson(path.join(dir, 'tests.lock.json'))['Otto · situation #1 Road closed · terse'], 'the lock points at the new id');

  /* a filter that matches nothing says so instead of pushing everything */
  r = await loop(['push-tests', '--filter', 'nothing matches this'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /no test file .* is named like/);
});
