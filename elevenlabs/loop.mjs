#!/usr/bin/env node
/*
 * The tuning loop for the AGENT — Otto's prompt — the way the dashboard
 * and scripts/tune_triggers.py already run one for the trigger knobs.
 *
 * The trigger loop has recorded runs to replay; the agent loop has two
 * things instead: a suite of ElevenLabs simulation tests cut from the
 * sheets (generate-tests.mjs — a simulated driver per row and persona,
 * the SAME dynamic variables a phone sends; the SITUATION rows are the
 * pilot's suite, the trigger scenarios the one for when triggers come
 * back), and the real conversations the agent had in the field, joined
 * to the grade the designer gave each one on the dashboard. Both are
 * scored, a model is asked for the smallest prompt edit the evidence
 * supports, the edit goes on an agent BRANCH, the suite runs there, and
 * a human merges — nothing here changes the live agent's prompt on its
 * own.
 *
 * The prompt is CONFIDENTIAL and this repository is PUBLIC. So nothing
 * that shows it leaves this process: --quiet (the buttons pass it) keeps
 * the prompt, its diff and a branch's note off stdout, the note a
 * proposal wrote lives on the ElevenLabs branch as its description and
 * is read back from there by `promote`, `publish` has no --note and the
 * agent_runs row's note is always null, and the one request that
 * carries the prompt (POST branches) never prints what came back. What
 * the repository does carry: pass rates, the transcripts of SIMULATED
 * conversations, and tests.lock.json.
 *
 *   configure    the evaluation criteria + data collection ElevenLabs
 *                grades EVERY real call with (analysis.json), and the
 *                overrides the phone needs enabled
 *   push-tests   test_configs/**.json -> ElevenLabs tests, by name
 *   run          run the suite (repeat_count for pass rates), on main
 *                or on a branch; results/<stamp>-<label>.json
 *   pull         field conversations + analysis, joined to the
 *                dashboard grades; field/<stamp>.json
 *   score        per scenario: suite pass rate, field grade rate, the
 *                failures grouped by reason
 *   cut          a debrief graded bad -> a next-reply regression test
 *   propose      the smallest prompt diff the evidence supports
 *   branch       that diff on an agent branch, its note the branch's
 *                own description
 *   compare      base results vs branch results -> ACCEPT / REJECT
 *   promote      merge the branch into main, the version note read back
 *                from the branch
 *   publish      a results file as a row of the agent_runs table, for
 *                the dashboard to show next to each row
 *
 *   node loop.mjs <command> [--dry-run] [--quiet] [--dir DIR] [flags]
 *
 * Secrets: ELEVENLABS_API_KEY (never in browser code, never logged,
 * never committed) and OPENAI_API_KEY for the proposer. Every live
 * command refuses to run without its key; --dry-run prints the requests
 * it would send, with nothing sent. --dir (or LOOP_DIR) moves every
 * file the loop reads and writes — test_configs/, tests.lock.json,
 * results/, field/, proposals/ — which is how the tests keep out of the
 * real folder.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHttp, elevenLabs, openai, DEFAULT_BASE } from './lib/elevenlabs-api.mjs';
import { supabase, agentMessages, scenarioRows, acceptedFindings, DEFAULT_URL, DEFAULT_KEY } from './lib/supabase.mjs';
import { table, pct, stamp, reasonKey, unifiedDiff, signed } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* The dashboard's grade checks (GRADE_CHECKS in dashboard.js), key for
 * key — the loop reads grades by these keys and cuts regression tests
 * from the labels. */
export const GRADE_CHECKS = {
  opener: 'Opened with the scenario\'s question',
  followup: 'Followed up on what the tester actually found',
  tip: 'Got the tip type the scenario expects',
  brevity: 'Kept it short — a couple of questions, then let them go',
  language: 'Right language throughout',
};

/* jsonb object from Supabase, string if hand-fed; gradeOf in dashboard.js */
export const gradeOf = m => {
  let g = m && m.grade;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  return g && typeof g === 'object' ? g : null;
};
/* "graded" = anything judged or a note left; "bad" = a false anywhere —
 * gradeSummary in dashboard.js, the same two definitions */
export function gradeSummary(g) {
  const checks = (g && g.checks) || {};
  const keys = Object.keys(GRADE_CHECKS);
  const judged = keys.filter(k => checks[k] === true || checks[k] === false);
  const failed = keys.filter(k => checks[k] === false);
  return {
    graded: judged.length > 0 || !!String((g && g.note) || '').trim(),
    bad: failed.length > 0,
    judged: judged.length,
    passed: judged.length - failed.length,
    failed,
    failed_labels: failed.map(k => GRADE_CHECKS[k]),
  };
}

class UsageError extends Error {}

/* ---------- files ---------- */

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
/* newest file in a folder by name — stamps sort as text */
function latest(dir, re = /\.json$/) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter(n => re.test(n)).sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}
/* every test file under test_configs/, regressions/ included, in a
 * stable order; a file that is not JSON is reported and skipped */
function listConfigs(dir, log) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = d => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.json')) {
        try {
          const body = readJson(p);
          if (!body || typeof body.name !== 'string') { log(`  skipping ${p}: no "name"`); continue; }
          out.push({ file: p, body });
        } catch (e) { log(`  skipping ${p}: ${e.message}`); }
      }
    }
  };
  walk(dir);
  return out;
}
const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
const slugLabel = s => String(s || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'run';
const sha = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- the context every command runs in ---------- */

function context(flags, env, log) {
  const dir = path.resolve(flags.dir || env.LOOP_DIR || HERE);
  const dryRun = !!flags.dryRun;
  /* --quiet is the confidentiality switch: the prompt, its diff and a
   * branch's note never reach stdout. The buttons pass it, because a
   * job log and a job summary on a public repository are published the
   * moment they are written. It takes nothing else away — counts, ids,
   * pass rates and the simulated transcripts still print. */
  const quiet = !!flags.quiet;
  const http = makeHttp({
    dryRun, log, quiet,
    secrets: [env.ELEVENLABS_API_KEY, env.OPENAI_API_KEY],
    retryDelayMs: Number(env.LOOP_RETRY_MS) || 1500,
  });
  return {
    dir, dryRun, quiet, env, log, http,
    p: {
      configs: path.join(dir, 'test_configs'),
      lock: path.join(dir, 'tests.lock.json'),
      results: path.join(dir, 'results'),
      field: path.join(dir, 'field'),
      proposals: path.join(dir, 'proposals'),
      analysis: path.join(dir, 'analysis.json'),
      agentConfigs: path.join(dir, 'agent_configs'),
    },
  };
}

/* The key is required to send; a dry run has nothing to send, so it
 * runs without one — that is what makes --dry-run a safe preview. */
function needEleven(ctx) {
  const key = ctx.env.ELEVENLABS_API_KEY;
  if (!key && !ctx.dryRun) throw new UsageError('ELEVENLABS_API_KEY is not set — the loop will not talk to ElevenLabs without it (export it from a secret; it never goes in browser code or git)');
  const agentId = ctx.env.ELEVENLABS_AGENT_ID || (ctx.dryRun ? 'AGENT_ID' : '');
  if (!agentId) throw new UsageError('ELEVENLABS_AGENT_ID is not set — the id of the agent the phone opens (public by design, the same value config.js carries)');
  return { api: elevenLabs({ apiKey: key || '', base: ctx.env.ELEVENLABS_BASE_URL || DEFAULT_BASE, http: ctx.http }), agentId };
}
const needDb = ctx => supabase({ url: ctx.env.SUPABASE_URL || DEFAULT_URL, key: ctx.env.SUPABASE_ANON_KEY || DEFAULT_KEY, http: ctx.http });
const readLock = ctx => (existsSync(ctx.p.lock) ? readJson(ctx.p.lock) : {});

/* ---------- configure ---------- */

/* analysis.json is a PATCH body; the agent's own criteria survive
 * because ours are merged over theirs by id (criteria) and by key
 * (data collection), and the override flags are only ever set, never
 * cleared. The reference does not say whether a PATCH of
 * platform_settings merges into the object the agent has or replaces
 * it wholesale, and the agent was fetched anyway, so what goes back is
 * the whole object with our three keys overlaid: the same agent under
 * either reading, where three keys on their own would wipe auth,
 * privacy, call limits, the widget and the attached tests if the
 * answer is "replaces". */
function mergePlatformSettings(existing, ours) {
  const out = echoable(existing);
  if (ours.evaluation) {
    const theirs = ((existing.evaluation || {}).criteria) || [];
    const mine = (ours.evaluation.criteria || []);
    const ids = new Set(mine.map(c => c.id));
    out.evaluation = { ...existing.evaluation, ...ours.evaluation, criteria: [...theirs.filter(c => !ids.has(c.id)), ...mine] };
  }
  if (ours.data_collection) out.data_collection = { ...(existing.data_collection || {}), ...ours.data_collection };
  if (ours.overrides) out.overrides = deepMerge(existing.overrides || {}, ours.overrides);
  return out;
}
/* What the agent reports but a PATCH cannot carry, per the reference:
 * `safety` is in the response schema only, and
 * queueing_config.hold_audio is marked read-only (it is set by
 * uploading a file). A strict validator could refuse them, and sending
 * them changes nothing, so the echo goes without them. */
function echoable(existing) {
  const out = { ...existing };
  delete out.safety;
  if (out.queueing_config && typeof out.queueing_config === 'object') {
    out.queueing_config = { ...out.queueing_config };
    delete out.queueing_config.hold_audio;
  }
  return out;
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}
const OVERRIDE_PATHS = [
  ['agent', 'first_message', 'the sheet\'s "Otto says" line as the opening question'],
  ['agent', 'language', 'the 🇮🇹 pick on the card'],
  ['conversation', 'text_only', 'a text client talking to the agent without audio cost (a manual check from a terminal; the suite itself needs no override)'],
];

async function configure(ctx) {
  const { log } = ctx;
  if (!existsSync(ctx.p.analysis)) {
    log(`analysis.json is not there (${ctx.p.analysis}) — it carries the evaluation criteria and data collection ElevenLabs should run on every call. The generator work package ships it; nothing was sent.`);
    return 1;
  }
  const spec = readJson(ctx.p.analysis);
  const ps = (spec && spec.platform_settings) || {};
  if (!ps.evaluation && !ps.data_collection && !ps.overrides) throw new UsageError('analysis.json has no platform_settings.evaluation / data_collection / overrides to send');
  const { api, agentId } = needEleven(ctx);
  const current = await api.getAgent(agentId);
  const existing = (current && current.platform_settings) || {};
  const merged = mergePlatformSettings(existing, ps);

  const criteria = (ps.evaluation && ps.evaluation.criteria) || [];
  const fields = Object.keys(ps.data_collection || {});
  log(`configure — ${criteria.length} evaluation criteria, ${fields.length} data-collection fields${current ? `, merged over the agent's own (${(((existing.evaluation || {}).criteria) || []).length} criteria, ${Object.keys(existing.data_collection || {}).length} fields)` : ''}`);
  const untouched = Object.keys(merged).filter(k => !['evaluation', 'data_collection', 'overrides'].includes(k));
  if (untouched.length) log(`  the agent's other platform settings go back as they are: ${untouched.join(', ')}`);
  log('Overrides the phone sends, which the agent must ALLOW (security -> overrides) or the session reconnects without them:');
  const cco = ((ps.overrides || {}).conversation_config_override) || {};
  const have = (((existing.overrides || {}).conversation_config_override) || {});
  for (const [group, field, why] of OVERRIDE_PATHS) {
    const wanted = !!(cco[group] && cco[group][field]);
    const already = !!(have[group] && have[group][field]);
    log(`  ${(group + '.' + field).padEnd(24)} ${wanted ? 'enabled in this PATCH' : already ? 'already enabled' : 'NOT in analysis.json — enable it by hand'}  (${why})`);
  }
  const res = await api.patchAgent(agentId, {
    platform_settings: merged,
    version_description: 'loop configure: evaluation criteria, data collection, overrides (analysis.json)',
  });
  if (!res) return 0;
  /* read back: an agent already on analysis_items (the docs' newer
   * by-reference attachment) may ignore the legacy fields — say so
   * rather than let every real call go ungraded in silence */
  const after = await api.getAgent(agentId);
  const got = new Set(((((after || {}).platform_settings || {}).evaluation || {}).criteria || []).map(c => c.id));
  const missing = criteria.filter(c => !got.has(c.id)).map(c => c.id);
  const gotFields = Object.keys(((after || {}).platform_settings || {}).data_collection || {});
  const missingFields = fields.filter(f => !gotFields.includes(f));
  if (missing.length || missingFields.length) {
    log(`WARNING: after the PATCH the agent does not show ${[...missing, ...missingFields].join(', ')} — if the agent uses platform_settings.analysis_items, attach the criteria in the ElevenLabs UI instead.`);
    return 1;
  }
  log(`agent ${agentId} now carries ${got.size} criteria and ${gotFields.length} data-collection fields; version ${(after && after.version_id) || '?'}`);
  return 0;
}

/* ---------- push-tests ---------- */

async function findByName(api, prefix) {
  const found = new Map();
  for await (const t of api.listTests({ search: prefix })) if (t && t.name && t.entity_type !== 'folder') found.set(t.name, t.id);
  return found;
}

/* The suite runs with no phone on the other end. A client tool the
 * agent calls — report_incident, say — has nobody to answer it, and
 * ElevenLabs fails the run outright ("Client tools are not supported in
 * simulation tests because there is no client to handle them"): the
 * first live baseline lost 21 of 33 tests to exactly that, not to the
 * prompt. So every tool the agent carries is mocked for the suite — an
 * answer in the tool's name, and the conversation goes on, which is
 * what the prompt is being judged on. Mocks are keyed by tool id, so
 * they are looked up here at push time rather than written into the
 * test files, which stay agent-independent. System tools are never
 * mocked by ElevenLabs and are left out. (On the phone the same tool is
 * real; otto-agent.js is where it would be answered.) */
async function toolMocks(api, agentId) {
  const agent = await api.getAgent(agentId);
  if (!agent) return null; // dry run
  const prompt = (((agent.conversation_config || {}).agent || {}).prompt) || {};
  const ids = [...new Set((prompt.tool_ids || []).map(String))];
  if (!ids.length) return { config: null, overrides: {}, names: [] };
  const known = new Map();
  for await (const t of api.listTools()) {
    if (t && ids.includes(String(t.id))) known.set(String(t.id), { name: (t.tool_config || {}).name || t.id, type: (t.tool_config || {}).type || '' });
  }
  const overrides = {};
  const names = [];
  for (const id of ids) {
    const info = known.get(id) || { name: id, type: '' };
    if (info.type === 'system') continue;
    /* a LIST per tool, not one object: the API allows several answers
     * for one tool, chosen by parameter_conditions. One unconditional
     * answer is what the suite needs, and it still goes in a list —
     * sending the bare object is a 422 ("Input should be a valid list")
     * that stops the whole push. */
    /* What the mock answers shapes what the agent says next: an answer
     * that reads like a sentence ("Done — report_incident was handled
     * on the client side") came back out of the agent's mouth as "I've
     * noted that" in the middle of the call, 57 of 78 failed calls on
     * the first situations baseline. So the answer is a receipt that
     * asks to be kept quiet, and whatever narration is left after it is
     * the prompt's own habit. */
    overrides[id] = [{ mock_result: 'OK. Handled in the background. Do not tell the driver it was saved, noted or logged; just continue the conversation.', is_error: false }];
    names.push(info.type ? `${info.name} (${info.type})` : info.name);
  }
  if (!names.length) return { config: null, overrides: {}, names: [] };
  return { config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, overrides, names };
}
/* a test file's own mock settings win over the looked-up ones */
function withMocks(req, mocks) {
  if (!mocks || !mocks.config || req.type !== 'simulation') return req;
  return {
    ...req,
    tool_mock_config: req.tool_mock_config || mocks.config,
    tool_mock_overrides: { ...mocks.overrides, ...(req.tool_mock_overrides || {}) },
  };
}

async function pushTests(ctx, flags = {}) {
  const { log } = ctx;
  /* Only the suite being pushed. A situations baseline has no business
   * rewriting the 33 trigger tests: it costs a round trip each and one
   * of them refusing an update took the whole push down with it, before
   * a single conversation had run. --filter takes the same text as
   * `run`, so the workflow hands both the same string. */
  const all = listConfigs(ctx.p.configs, log);
  const configs = flags.filter ? all.filter(c => c.body.name.includes(flags.filter)) : all;
  if (!all.length) { log(`no test files under ${ctx.p.configs} — run "npm run generate" first (regressions come from "cut")`); return 1; }
  if (!configs.length) { log(`no test file under ${ctx.p.configs} is named like "${flags.filter}" — nothing to push`); return 1; }
  if (configs.length !== all.length) log(`pushing ${configs.length} of ${all.length} test file(s) — those named like "${flags.filter}"`);
  const lock = readLock(ctx);
  const { api, agentId } = needEleven(ctx);
  const mocks = flags.noMockTools ? null : await toolMocks(api, agentId);
  if (flags.noMockTools) log('tool mocks off (--no-mock-tools): a client tool the agent calls fails the run');
  else if (!mocks) log('(dry run) the agent\'s tools are not looked up — live, every one of them is mocked for the suite');
  else if (mocks.names.length) log(`mocking ${mocks.names.length} tool(s) for the suite: ${mocks.names.join(', ')}`);
  else log('the agent carries no tools to mock');
  const rows = [];
  let byName = null;
  let replaced = 0;
  for (const { file, body } of configs) {
    const { _otto, ...bare } = body;
    const req = withMocks(bare, mocks);
    const name = req.name;
    let id = lock[name] || null;
    let action = '';
    if (id) {
      try { await api.updateTest(id, req); action = 'updated'; } catch (e) {
        /* 404: deleted in the workspace since the lock was written.
         * 422: the test that is there will not become this one — a
         * shape the update endpoint refuses, or a type that cannot be
         * changed in place. Neither is a reason to abandon the other
         * seventy-nine: drop that test and make it again. */
        if (e.status !== 404 && e.status !== 422) throw e;
        if (e.status === 422) {
          log(`  ${name}: the existing test would not take the update (${e.message.slice(0, 160)}…) — replacing it`);
          try { await api.deleteTest(id); } catch (d) { log(`  (could not delete ${id}: ${d.message.slice(0, 120)})`); }
          replaced++;
        }
        id = null;
      }
    }
    if (!id) {
      /* one search for everything named like ours, matched exactly —
       * the lock may be missing (fresh clone) while the tests exist */
      if (!byName) byName = await findByName(api, 'Otto · ');
      const existing = byName.get(name);
      if (existing) {
        try { await api.updateTest(existing, req); id = existing; action = 'updated (found by name)'; } catch (e) {
          if (e.status !== 422) throw e;
          try { await api.deleteTest(existing); } catch { /* it stays in the workspace */ }
          replaced++;
        }
      }
      if (!id) {
        const res = await api.createTest(req); id = res ? res.id : null; action = action || 'created';
      }
    }
    if (id) lock[name] = id;
    rows.push({ name, action: ctx.dryRun ? 'would be ' + action : action, id: id || '—', file: path.relative(ctx.dir, file) });
  }
  /* A lock entry with no test file behind it any more — a situation
   * row switched off on the dashboard, a test renamed — is dropped, or
   * the next `run` would still run it: run 114 ran five switched-off
   * rows (75 calls) that way, and the try after it was REJECTED on
   * one of them. Measured against every file on disk, not the filtered
   * set: a situations push must not forget the trigger tests. The
   * tests themselves stay in the ElevenLabs workspace, and a row
   * switched back on finds its test again by name. */
  const onDisk = new Set(all.map(c => c.body.name));
  const stale = Object.keys(lock).filter(n => !onDisk.has(n));
  for (const n of stale) delete lock[n];
  if (!ctx.dryRun) writeJson(ctx.p.lock, sortKeys(lock));
  log(table(rows, [
    { key: 'name', label: 'test', width: 48 }, { key: 'action', label: 'action', width: 24 },
    { key: 'id', label: 'id', width: 28 }, { key: 'file', label: 'file', width: 60 },
  ]));
  log(`\n${rows.length} test(s) ${ctx.dryRun ? 'would be' : ''} pushed; ${ctx.dryRun ? 'tests.lock.json untouched (dry run)' : 'tests.lock.json written'}` +
    (replaced ? `; ${replaced} test(s) the API would not update were replaced` : '') +
    (stale.length ? `; ${stale.length} lock entr${stale.length === 1 ? 'y' : 'ies'} without a test file dropped — a row switched off, or a test renamed (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}); the tests stay in ElevenLabs` : ''));
  return 0;
}

/* ---------- run ---------- */

/* The branch a button was given: its id (agtbrch_…), or the name it
 * was given in the ElevenLabs dashboard, which is what the designer
 * actually knows — the id is nowhere obvious there, and the first try
 * pasted the AGENT's id into the field. A name is looked up in the
 * agent's branches (the live ones), exactly and then ignoring case;
 * anything else is refused with the names that would have worked. */
const BRANCH_ID = /^agtbrch_/i;
async function resolveBranch(api, agentId, given, log) {
  const want = String(given || '').trim();
  if (!want || BRANCH_ID.test(want)) return want;
  if (/^agent_/i.test(want)) throw new UsageError(`"${want}" is the agent's own id, not a branch. Give the branch's name as you typed it in ElevenLabs (Versioning tab), or its id, which starts with agtbrch_`);
  const res = await api.listBranches(agentId, { include_archived: false, limit: 100 });
  if (!res) return want; // dry run
  const list = (res.results || []).filter(b => b && !b.is_archived);
  const exact = list.find(b => String(b.name || '') === want) || list.find(b => String(b.name || '').toLowerCase() === want.toLowerCase());
  if (!exact) {
    const names = list.map(b => `"${b.name}"`).join(', ');
    throw new UsageError(`no branch named "${want}" on agent ${agentId}${names ? ` — the live branches are ${names}` : ' — it has no live branches'}. Give the name as ElevenLabs shows it, or the id (agtbrch_…)`);
  }
  log(`branch "${exact.name}" is ${exact.id}`);
  return exact.id;
}

async function pollInvocation(api, id, ctx) {
  const every = Number(ctx.env.LOOP_POLL_MS) || 5000;
  const limit = Number(ctx.env.LOOP_TIMEOUT_MS) || 20 * 60e3;
  const t0 = Date.now();
  let lastDone = -1;
  for (;;) {
    const inv = await api.getInvocation(id);
    const runs = (inv && inv.test_runs) || [];
    const pending = runs.filter(r => r.status === 'pending').length;
    const done = runs.length - pending;
    if (done !== lastDone) { ctx.log(`  … ${done}/${runs.length} runs done`); lastDone = done; }
    if (runs.length && !pending) return inv;
    if (Date.now() - t0 > limit) {
      throw new Error(`invocation ${id} still has ${pending} pending run(s) after ${Math.round(limit / 60e3)} min — poll it yourself: GET /v1/convai/test-invocations/${id} (this run gave up at LOOP_TIMEOUT_MS=${limit}, polling every LOOP_POLL_MS=${every} ms; a longer suite needs a higher limit, not a second run)`);
    }
    await sleep(every);
  }
}

/* One run of a test, whole: what the evaluator said and the turns it
 * judged. Two are kept per test. `failure` is the first failed run: a
 * pass rate says THAT a test fails; the designer reading the dashboard
 * needs to see HOW — which turn went wrong, in which words — and one
 * run is enough for that, so the rest only add their rationale to the
 * list. `success` is the shortest passed run with any words in it, so
 * the same page can show what a good call looked like next to the bad
 * one — the "after" of a suggestion in Otto's own words rather than
 * lines written from the sheet. The rationale is the evaluator's
 * summary followed by its messages (the detail), the transcript the
 * agent_responses of that run without their timings. A tool the agent
 * called (report_incident, mocked for the suite) is kept too, as
 * `tools` on the agent turn it spoke next — the API sends the call as
 * a wordless agent entry before the words — so a reader can see where
 * in the call the report went off. */
function keptRun(r) {
  const ra = ((r.condition_result || {}).rationale) || {};
  const lines = [ra.summary, ...(ra.messages || [])].map(x => String(x || '').trim()).filter(Boolean);
  const transcript = [];
  let pending = [];
  for (const m of r.agent_responses || []) {
    if (!m) continue;
    const tools = (m.tool_calls || []).map(c => String((c && c.tool_name) || '')).filter(Boolean);
    if (!m.message) { pending.push(...tools); continue; }
    const turn = { role: m.role === 'agent' ? 'agent' : 'user', message: String(m.message) };
    if (turn.role === 'agent') {
      const all = [...pending, ...tools];
      if (all.length) turn.tools = all;
      pending = [];
    }
    transcript.push(turn);
  }
  if (pending.length) {
    const last = [...transcript].reverse().find(t => t.role === 'agent');
    if (last) last.tools = [...(last.tools || []), ...pending];
  }
  const verdicts = verdictsOf(r.condition_result);
  return {
    test_run_id: r.test_run_id || null,
    rationale: [...new Set(lines)].join('\n') || 'no rationale returned',
    ...(verdicts ? { verdicts } : {}),
    transcript,
  };
}
const oneLine = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();

/* The evaluator's summary is usually the verdict, not the reason:
 * "Evaluation failed", full stop. Its messages carry one paragraph per
 * success condition, so the first that reads as a failure is the line
 * worth a chip; a summary that says something of its own ("Unsupported
 * client tool") stands. */
const GENERIC_SUMMARY = /^(evaluation failed|failed|failure|test failed)\.?$/i;
/* The judge's own word per condition. Every condition the generator
 * writes ends with "Start your answer with PASS or FAIL", and the judge
 * answers one paragraph per condition, "Criterion N: FAIL. …" — so the
 * verdicts are read, not guessed, wherever it complied. A paragraph
 * without the word is 'unknown'; a rationale without a single verdict
 * is null, and the callers fall back to reading the prose. */
/* What the judge actually writes, two runs in: "Criterion 1 passed: …",
 * "Criterion 6 failed: …" — no colon after the number, the word
 * inflected. Both spellings count, with or without the separator. */
const VERDICT = /^\s*(?:criteri(?:on|a|o)\s+(\d+)\s*[:.\-–—]?\s*)?(?:\*{0,2}|_{0,2})(?:verdict\s*:\s*)?(PASS(?:ED)?|FAIL(?:ED)?)\b/i;
export function verdictsOf(cr) {
  const msgs = (((cr && cr.rationale) || {}).messages || []).map(oneLine);
  const out = [];
  let any = false;
  msgs.forEach((m, i) => {
    const hit = VERDICT.exec(m);
    const n = hit && hit[1] ? Number(hit[1]) : i + 1;
    const result = hit ? hit[2].slice(0, 4).toLowerCase() : 'unknown';
    if (hit) any = true;
    out[n - 1] = result;
  });
  if (!any) return null;
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = 'unknown';
  return out;
}
const firstFail = cr => {
  const v = verdictsOf(cr);
  if (!v) return null;
  const msgs = (((cr && cr.rationale) || {}).messages || []).map(oneLine);
  const i = v.indexOf('fail');
  if (i < 0) return null;
  return msgs.find(m => { const h = VERDICT.exec(m); return h && (h[1] ? Number(h[1]) === i + 1 : true) && h[2].slice(0, 4).toLowerCase() === 'fail'; }) || null;
};
/* The evaluator writes one paragraph per condition, for the ones it was
 * happy with as well as the ones it was not, in the same prose voice —
 * so a loose search for failure words picks the wrong paragraph and the
 * chip ends up quoting a condition that PASSED ("Otto never asks the
 * driver to repeat something already stated"). Only unambiguous
 * verdict language counts, and a negation in front of it disqualifies
 * it ("No form-filling language"). When nothing is unambiguous the line
 * says to read the reasons rather than guessing at them. */
const FAIL_CUES = /\b(does not meet|doesn't meet|not meet|not met|not satisfied|omits|never (provides|gives|offers|summar)|fails? to|exceed(s|ed|ing)|invented|fabricat|violat|is incomplete|without the required|no closing|form-filling)\b|non soddisfatt|supera(ndo)? il limite/i;
const NEGATED = /\b(no|not|never|avoids?|without)\s+(\w+\s+){0,3}(form-filling|invented)/i;
function whyOf(cr) {
  const ra = (cr && cr.rationale) || {};
  const summary = oneLine(ra.summary);
  const msgs = (ra.messages || []).map(oneLine).filter(Boolean);
  if (summary && !GENERIC_SUMMARY.test(summary)) return summary;
  /* the judge's own FAIL, where it wrote one; the cue words below are
   * for rationales from before the conditions asked for a verdict */
  const failed = firstFail(cr) || msgs.find(m => /^criteri(on|a|o) \d+/i.test(m) && FAIL_CUES.test(m) && !NEGATED.test(m));
  /* no summary at all: the messages are the whole rationale, as before */
  const line = failed
    || (summary ? (msgs.length ? 'the reasons name no single condition — read them in full' : '') : msgs.join(' '))
    || summary || 'no rationale returned';
  return line.length > 240 ? line.slice(0, 237).replace(/\s+\S*$/, '') + '…' : line;
}

/* one row per test: how many runs, how many passed, why the rest failed
 * (`why` is the first failure's rationale on one line, `failure` that
 * run whole — null for a test that passed every run — and `success`
 * the shortest passed run with words in it, null when none has any) */
export { whyOf };
/* ---------- what a call cost, and how fast Otto answered in it ----------
 * ElevenLabs times every agent turn of a simulated call the way it
 * times a real one (conversation_turn_metrics: seconds to the model's
 * first word and to its first whole sentence, turnTiming below), names
 * the model that produced the turn (producing_llm) and prices its
 * tokens (llm_usage.model_usage). A run keeps all three per test, over
 * EVERY call — not just the two it keeps whole — so a model trial reads
 * in seconds and cents next to its pass rate. Without the metrics, the
 * gap between the driver's turn and Otto's (time_in_call_secs, whole
 * seconds) stands in, and the summary says so (source: timestamps). */
function callStats(r) {
  const answers = [], words = [], gaps = [];
  const models = new Set(), usageModels = new Set();
  let cost = 0, tokensIn = 0, tokensOut = 0, priced = false;
  let prevUser = null, last = null;
  for (const m of r.agent_responses || []) {
    if (!m) continue;
    const at = typeof m.time_in_call_secs === 'number' ? m.time_in_call_secs : null;
    if (at != null) last = last == null ? at : Math.max(last, at);
    if (m.role !== 'agent') { if (at != null) prevUser = at; continue; }
    const tm = turnTiming(m);
    if (tm) {
      if (tm.first_sentence != null) answers.push(tm.first_sentence);
      if (tm.first_word != null) words.push(tm.first_word);
    } else if (m.message && at != null && prevUser != null && at >= prevUser) gaps.push(at - prevUser);
    if (m.message) prevUser = null;  // a second agent turn on the same driver turn is not a second wait
    if (m.producing_llm) models.add(String(m.producing_llm));
    const mu = m.llm_usage && m.llm_usage.model_usage;
    if (mu && typeof mu === 'object') {
      for (const [model, u] of Object.entries(mu)) {
        if (!u || typeof u !== 'object') continue;
        usageModels.add(model);
        for (const k of ['input', 'input_cache_read', 'input_cache_write', 'output_total']) {
          const x = u[k];
          if (!x || typeof x !== 'object') continue;
          priced = true;
          cost += Number(x.price) || 0;
          if (k === 'output_total') tokensOut += Number(x.tokens) || 0; else tokensIn += Number(x.tokens) || 0;
        }
      }
    }
  }
  return {
    answers, words, gaps, call_secs: last,
    models: [...(models.size ? models : usageModels)],
    cost: priced ? cost : null, tokens_in: tokensIn, tokens_out: tokensOut,
  };
}
const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
/* the seconds, over one test or a whole suite: medians of Otto's turns */
export function speedOf(tests) {
  const all = k => (tests || []).flatMap(t => (t.timing && t.timing[k]) || []);
  const answers = all('answers'), words = all('words'), gaps = all('gaps'), calls = all('calls');
  if (!answers.length && !gaps.length && !calls.length) return null;
  return {
    /* seconds until Otto's first whole sentence — the moment the voice
     * can start — per turn, the median; and the slowest turn */
    answer_s: answers.length ? round(median(answers), 1) : null,
    answer_max_s: answers.length ? round(Math.max(...answers), 1) : null,
    word_s: words.length ? round(median(words), 1) : null,
    /* the stand-in: whole seconds from the driver's turn to Otto's */
    gap_s: gaps.length ? round(median(gaps), 1) : null,
    call_s: calls.length ? round(median(calls), 1) : null,
    turns: answers.length || gaps.length,
    calls: calls.length,
    source: answers.length ? 'metrics' : gaps.length ? 'timestamps' : null,
  };
}
/* the dollars, the same way: what ElevenLabs priced the model's tokens
 * at, per call, over the calls it priced */
export function costOf(tests) {
  let cost = 0, tokensIn = 0, tokensOut = 0, calls = 0;
  for (const t of tests || []) {
    const u = t.usage;
    if (!u || !u.calls) continue;
    cost += u.cost || 0; tokensIn += u.tokens_in || 0; tokensOut += u.tokens_out || 0; calls += u.calls;
  }
  if (!calls) return null;
  return { per_call_usd: round(cost / calls, 6), total_usd: round(cost, 6), tokens_in: tokensIn, tokens_out: tokensOut, calls };
}
const modelsOf = tests => [...new Set((tests || []).flatMap(t => t.models || []))];
/* one line for a job summary: how fast, what it cost, on which model */
export function statsLine(tests, settings) {
  const sp = speedOf(tests), co = costOf(tests);
  const parts = [];
  if (sp && sp.source === 'metrics') parts.push(`Otto's first sentence after ${sp.answer_s} s (median over ${sp.turns} turn(s); slowest ${sp.answer_max_s} s)`);
  else if (sp && sp.source === 'timestamps') parts.push(`Otto answered ${sp.gap_s} s after the driver (whole seconds, median over ${sp.turns} turn(s) — ElevenLabs sent no finer timings)`);
  if (sp && sp.call_s != null) parts.push(`a call lasts ${sp.call_s} s (median of ${sp.calls})`);
  if (co) parts.push(`$${co.per_call_usd} per call in model tokens ($${co.total_usd} over ${co.calls} priced call(s))`);
  const m = modelsOf(tests);
  const set = settings && settings.model ? `set to ${settings.model}${settings.reasoning ? ', reasoning ' + settings.reasoning : ''}` : '';
  if (set || m.length) parts.push(`model ${[set, m.length ? `answered as ${m.join(', ')}` : ''].filter(Boolean).join('; ')}`);
  return parts.length ? 'speed and cost — ' + parts.join(' · ') : 'speed and cost — ElevenLabs sent no timings and no token prices for these calls';
}

export function aggregate(inv, { idToName = {}, meta = {} } = {}) {
  const byTest = new Map();
  for (const r of (inv && inv.test_runs) || []) {
    const name = idToName[r.test_id] || r.test_name || (r.metadata && r.metadata.test_name) || r.test_id;
    if (!byTest.has(r.test_id)) {
      byTest.set(r.test_id, { name, test_id: r.test_id, runs: 0, passed: 0, pending: 0, pass_rate: 0, why: null, rationales: [], failure: null, success: null, checks: null, branch_id: r.branch_id || null, version_id: r.version_id || null, timing: { answers: [], words: [], gaps: [], calls: [] }, usage: { cost: 0, tokens_in: 0, tokens_out: 0, calls: 0 }, models: [], ...(meta[name] || {}) });
    }
    const t = byTest.get(r.test_id);
    t.runs++;
    if (r.status !== 'pending') {
      const cs = callStats(r);
      t.timing.answers.push(...cs.answers); t.timing.words.push(...cs.words); t.timing.gaps.push(...cs.gaps);
      if (cs.call_secs != null) t.timing.calls.push(cs.call_secs);
      if (cs.cost != null) { t.usage.cost += cs.cost; t.usage.tokens_in += cs.tokens_in; t.usage.tokens_out += cs.tokens_out; t.usage.calls++; }
      for (const m of cs.models) if (!t.models.includes(m)) t.models.push(m);
    }
    /* the judge's word per condition, over every run of the test that
     * carried one — passed runs included, so a check's fail count has
     * the whole test as its denominator */
    const verdicts = r.status === 'pending' ? null : verdictsOf(r.condition_result);
    if (verdicts) {
      t.checks = t.checks || {};
      verdicts.forEach((v, i) => {
        if (v === 'unknown') return;
        const c = t.checks[i + 1] || (t.checks[i + 1] = { pass: 0, fail: 0 });
        c[v]++;
      });
    }
    if (r.status === 'passed') {
      t.passed++;
      const kept = keptRun(r);
      if (kept.transcript.length && (!t.success || kept.transcript.length < t.success.transcript.length)) t.success = kept;
    } else if (r.status === 'pending') t.pending++;
    else {
      const cr = r.condition_result || {};
      const why = whyOf(cr);
      if (!t.rationales.includes(why)) t.rationales.push(why);
      if (!t.failure) { t.why = oneLine(why); t.failure = keptRun(r); }
    }
    if (!t.branch_id && r.branch_id) t.branch_id = r.branch_id;
    if (!t.version_id && r.version_id) t.version_id = r.version_id;
  }
  const tests = [...byTest.values()];
  tests.forEach(t => { t.pass_rate = t.runs ? t.passed / t.runs : 0; });
  return tests.sort((a, b) => a.pass_rate - b.pass_rate || a.name.localeCompare(b.name));
}

/* the _otto block of every test file, by test name — so a results row
 * knows which row it came from, and which sheet, without another
 * lookup. A test belongs to one of the two suites: a trigger scenario
 * carries scenario_num, a situation carries situation_num, and a
 * regression cut from a real debrief carries whichever the join could
 * place. All four fields ride along either way, so a reader (the
 * dashboard, agentRunRow) never has to guess which sheet a run is
 * about. */
function metaByName(ctx) {
  const meta = {};
  const num = x => (x == null || x === '' ? null : x);
  for (const { body } of listConfigs(ctx.p.configs, () => {})) {
    const o = body._otto || {};
    meta[body.name] = {
      scenario_num: num(o.scenario_num), scenario_title: o.scenario_title || '',
      situation_num: num(o.situation_num), situation_title: o.situation_title || '',
      persona: o.persona || '', kind: o.kind || '', language: o.language || '',
      /* who played the driver and who judged — the test file pins both
       * (SIMULATION_MODELS in generate-tests.mjs), and a run from next
       * month has to say which models it was measured with */
      driver_model: body.simulated_user_model || '', judge_model: body.evaluation_model || '',
    };
  }
  return meta;
}

function printResults(log, tests) {
  log(table(tests, [
    { key: 'name', label: 'test', width: 52 },
    { get: t => `${t.passed}/${t.runs}`, label: 'passed', width: 7, right: true },
    { get: t => pct(t.pass_rate), label: 'rate', width: 5, right: true },
    { get: t => t.rationales[0] || (t.pending ? 'still pending' : ''), label: 'why (first failure)', width: 70 },
  ]));
}

async function run(ctx, flags) {
  const { log } = ctx;
  const repeat = Math.max(1, Math.min(20, parseInt(flags.repeat ?? '3', 10) || 3));
  let lock = readLock(ctx);
  /* a fresh clone has no lock yet; a dry run still shows the request,
   * with the ids push-tests would have written in place of the ids */
  if (!Object.keys(lock).length && ctx.dryRun) {
    lock = Object.fromEntries(listConfigs(ctx.p.configs, log).map(({ body }) => [body.name, '<id from tests.lock.json>']));
  }
  const filter = String(flags.filter || '').toLowerCase();
  let entries = Object.entries(lock).filter(([name]) => !filter || name.toLowerCase().includes(filter));
  /* The suite is what is on disk NOW: the situation files are generated
   * from the live rows at the start of every button, so a row switched
   * off has no file, and its lock entry (the test is still in
   * ElevenLabs, and was still in the lock until push-tests dropped it)
   * is not run. Without a single file on disk nothing can be told
   * apart, and the lock is run as it is. */
  const onDisk = new Set(listConfigs(ctx.p.configs, () => {}).map(({ body }) => body.name));
  if (onDisk.size) {
    const skipped = entries.filter(([name]) => !onDisk.has(name)).map(([name]) => name);
    if (skipped.length) {
      entries = entries.filter(([name]) => onDisk.has(name));
      log(`${skipped.length} test(s) in tests.lock.json ${skipped.length === 1 ? 'has' : 'have'} no test file now — a row switched off, or a test renamed — and ${skipped.length === 1 ? 'is' : 'are'} not run: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}`);
    }
  }
  if (!entries.length) {
    log(Object.keys(lock).length ? `no test in tests.lock.json${filter ? ` matches --filter "${flags.filter}" and` : ''} has a test file under ${ctx.p.configs} — generate the situation tests (node generate-tests.mjs --situations) and push-tests first` : 'tests.lock.json is empty — run push-tests first');
    return 1;
  }
  /* --rows 6,8,10: only those situation rows — the quick model trial */
  const rows = String(flags.rows || '').split(/[\s,]+/).filter(Boolean);
  if (rows.length) {
    if (rows.some(x => !/^\d+$/.test(x))) throw new UsageError(`--rows takes situation numbers, comma-separated (6,8,10), not "${flags.rows}"`);
    const want = new Set(rows.map(Number));
    entries = entries.filter(([name]) => { const m = /situation #(\d+)\b/.exec(name); return m && want.has(Number(m[1])); });
    if (!entries.length) { log(`no test in tests.lock.json is for situation row(s) ${rows.join(', ')} — the numbers are the # on the SITUATIONS tab`); return 1; }
    log(`rows ${rows.join(', ')}: ${entries.length} test(s)`);
  }
  const { api, agentId } = needEleven(ctx);
  const branchId = flags.branch ? await resolveBranch(api, agentId, flags.branch, log) : '';
  const body = { tests: entries.map(([, id]) => ({ test_id: id })) };
  if (repeat > 1) body.repeat_count = repeat;
  if (branchId) body.branch_id = branchId;
  log(`run — ${entries.length} test(s) × ${repeat} on ${branchId ? 'branch ' + branchId : 'main'}`);
  let started;
  try { started = await api.runTests(agentId, body); } catch (e) {
    /* the wrapper does not retry this POST — a 5xx from a gateway can
     * come back after the suite was accepted, and a second POST would
     * start and bill a second one — so the person decides */
    throw new Error(`${e.message} — not retried: a second run-tests would start (and bill) a second suite. If ElevenLabs did accept this one, it is on the agent's tests page and the reply above may name its id: poll GET /v1/convai/test-invocations/<id> instead of running again`);
  }
  /* which model Otto ran on, and how much it was let think — read from
   * the version the suite runs against, settings only, never the prompt
   * beside them. A run from next month has to say what it measured; a
   * model trial has to prove the branch took the setting. Read once the
   * suite is started, so a hiccup here costs a line, never the run. */
  let settings = null;
  try { settings = llmSettings(await api.getAgent(agentId, branchId ? { branch_id: branchId } : {})); } catch (e) {
    log(`  (the agent's model settings could not be read — ${String(e.message || e).slice(0, 120)} — so the results file will not say which model ran)`);
  }
  if (settings) log(`Otto's model on this run: ${settings.model || '?'}${settings.reasoning ? ', reasoning ' + settings.reasoning : ''}${settings.thinking_budget != null ? ', thinking budget ' + settings.thinking_budget : ''}`);
  if (!started) { log('  (dry run) would poll GET /v1/convai/test-invocations/<id> until no run is pending, then write results/<stamp>-<label>.json'); return 0; }
  const inv = await pollInvocation(api, started.id, ctx);
  const idToName = Object.fromEntries(entries.map(([n, id]) => [id, n]));
  const tests = aggregate(inv, { idToName, meta: metaByName(ctx) });
  const label = slugLabel(flags.label || (flags.branch ? 'branch' : 'main'));
  const file = path.join(ctx.p.results, `${stamp()}-${label}.json`);
  writeJson(file, {
    at: new Date().toISOString(), agent_id: agentId, invocation_id: started.id,
    branch_id: branchId || null, label, repeat, settings, tests,
  });
  printResults(log, tests);
  const passed = tests.reduce((s, t) => s + t.passed, 0), runs = tests.reduce((s, t) => s + t.runs, 0);
  log(`\n${passed}/${runs} runs passed across ${tests.length} test(s) — ${tests.filter(t => t.pass_rate < 1).length} with a failure\n${statsLine(tests, settings)}\nwrote ${file}`);
  return 0;
}

/* the language-model settings of an agent (or of one of its versions,
 * fetched with ?branch_id / ?version_id) — the four knobs a model trial
 * turns, and nothing else from the prompt block they sit in */
function llmSettings(agent) {
  const p = agent && agent.conversation_config && agent.conversation_config.agent && agent.conversation_config.agent.prompt;
  if (!p || typeof p !== 'object') return null;
  return {
    model: p.llm || null,
    reasoning: p.reasoning_effort || null,
    thinking_budget: p.thinking_budget ?? null,
    temperature: p.temperature ?? null,
  };
}

/* ---------- pull ---------- */

const iso = unix => (unix ? new Date(unix * 1000).toISOString() : null);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

/* ---------- reply speed ----------
 * ElevenLabs times every agent turn on its side — how long its language
 * model took to its first word and to its first full sentence (the
 * moment the voice can start) — and sends the numbers with the
 * transcript. The phone's own part in a reply is streamed and measured
 * in milliseconds; the seconds a driver waits are made over there. So
 * every agent turn keeps its timing, pull sums them up, and the field
 * button says how fast Otto answered and on which models. */
const TIMING_LABELS = {
  convai_llm_service_ttfb: 'first word from the model',
  convai_llm_service_ttf_sentence: 'first sentence',
};
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = x => (Math.round(x * 10) / 10).toFixed(1);
function turnTiming(t) {
  const m = t && t.conversation_turn_metrics;
  const all = {};
  for (const [k, v] of Object.entries((m && m.metrics) || {})) {
    const e = v && typeof v === 'object' ? v.elapsed_time : v;
    if (typeof e === 'number' && Number.isFinite(e)) all[k] = e;
  }
  if (!Object.keys(all).length) return null;
  return {
    first_word: all.convai_llm_service_ttfb ?? null,
    first_sentence: all.convai_llm_service_ttf_sentence ?? null,
    all,
    llm: t.producing_llm || null,
    tts: (m && m.convai_tts_model) || null,
  };
}
export function replySpeed(convs) {
  const turns = [];
  const inConvs = new Set();
  for (const c of convs || []) {
    for (const t of c.transcript || []) if (t.role === 'agent' && t.timing) { turns.push(t.timing); inConvs.add(c.conversation_id); }
  }
  const names = [...new Set(turns.flatMap(t => Object.keys(t.all)))];
  const order = [...Object.keys(TIMING_LABELS).filter(k => names.includes(k)), ...names.filter(k => !TIMING_LABELS[k]).sort()];
  const metrics = {};
  for (const k of order) {
    const xs = turns.map(t => t.all[k]).filter(x => x != null);
    metrics[k] = { median: +secs(median(xs)), max: +secs(Math.max(...xs)), turns: xs.length };
  }
  const llm = [...new Set(turns.map(t => t.llm).filter(Boolean))];
  const tts = [...new Set(turns.map(t => t.tts).filter(Boolean))];
  const line = !turns.length
    ? 'reply speed — ElevenLabs sent no per-turn timings for these conversations'
    : `reply speed — ${turns.length} Otto turn(s) with timings in ${inConvs.size} conversation(s): `
      + order.map(k => `${TIMING_LABELS[k] || k} after ${secs(metrics[k].median)} s (median; slowest ${secs(metrics[k].max)} s)`).join(', ')
      + (tts.length ? ` · voice model ${tts.join(', ')}` : '')
      + (llm.length ? ` · language model ${llm.join(', ')}` : '');
  return { turns: turns.length, conversations: inConvs.size, metrics, llm, tts, line };
}

/* the conversation as the field file keeps it: what the agent said and
 * heard, what ElevenLabs concluded, what the phone sent it — and, on
 * each agent turn, how long ElevenLabs took to make it (timing) */
function shapeConversation(item, d) {
  const an = (d && d.analysis) || {};
  const init = (d && d.conversation_initiation_client_data) || {};
  const evaluation = {};
  for (const [id, r] of Object.entries(an.evaluation_criteria_results || {})) evaluation[id] = { result: r.result, rationale: r.rationale || '' };
  const data = {};
  for (const [id, r] of Object.entries(an.data_collection_results || {})) data[id] = r && typeof r === 'object' && 'value' in r ? r.value : r;
  const meta = (d && d.metadata) || {};
  return {
    conversation_id: item.conversation_id,
    started_at: iso(meta.start_time_unix_secs || item.start_time_unix_secs),
    duration_s: meta.call_duration_secs ?? item.call_duration_secs ?? null,
    status: (d && d.status) || item.status,
    call_successful: an.call_successful || item.call_successful || 'unknown',
    branch_id: (d && d.branch_id) || item.branch_id || null,
    version_id: (d && d.version_id) || item.version_id || null,
    summary: an.transcript_summary || item.transcript_summary || '',
    evaluation, data,
    dynamic_variables: init.dynamic_variables || {},
    overrides: init.conversation_config_override || null,
    transcript: ((d && d.transcript) || []).filter(t => t && t.message).map(t => {
      const timing = t.role === 'agent' ? turnTiming(t) : null;
      return { role: t.role, message: t.message, t: t.time_in_call_secs ?? null, ...(timing ? { timing } : {}) };
    }),
  };
}

async function pull(ctx, flags) {
  const { log } = ctx;
  const days = Number(flags.days) || 14;
  const since = flags.since ? new Date(flags.since) : new Date(Date.now() - days * 86400e3);
  if (Number.isNaN(since.getTime())) throw new UsageError('--since needs an ISO date (2026-09-01 or 2026-09-01T00:00:00Z)');
  const { api, agentId } = needEleven(ctx);
  const db = needDb(ctx);
  const items = [];
  for await (const c of api.listConversations({ agent_id: agentId, call_start_after_unix: Math.floor(since.getTime() / 1000) })) items.push(c);
  const convs = [];
  for (const item of items) {
    const d = await api.getConversation(item.conversation_id);
    if (d) convs.push(shapeConversation(item, d));
  }
  let messages = [], scenarios = [];
  try { messages = await agentMessages(db); } catch (e) { log(`  no join to the dashboard: ${e.message}`); }
  try { scenarios = await scenarioRows(db); } catch (e) { log(`  no scenario lookup: ${e.message}`); }
  const byConv = new Map(messages.filter(m => m.conversation_id).map(m => [m.conversation_id, m]));
  const scByDest = new Map();
  for (const s of scenarios) if (s.destination_id && !scByDest.has(s.destination_id)) scByDest.set(s.destination_id, s);
  const counts = { conversations: convs.length, joined: 0, graded: 0, graded_bad: 0, stamped: 0 };
  for (const c of convs) {
    const m = byConv.get(c.conversation_id) || null;
    c.message = m ? pick(m, ['id', 'destination_id', 'title', 'category', 'transcript', 'convo', 'created_at']) : null;
    const sc = m && m.destination_id ? scByDest.get(m.destination_id) : null;
    c.scenario = sc ? pick(sc, ['id', 'num', 'title', 'learns', 'version']) : null;
    const g = gradeOf(m);
    const gs = gradeSummary(g);
    c.grade = g;
    c.graded = gs.graded;
    c.graded_bad = gs.bad;
    c.failed_checks = gs.failed;
    if (m) counts.joined++;
    if (gs.graded) counts.graded++;
    if (gs.bad) counts.graded_bad++;
    /* the dashboard leaves agent_version null — it cannot know which
     * version took the call; the conversation does. Stamp it, so a
     * grade stays comparable after the prompt moves on. */
    if (!flags.noStamp && g && !g.agent_version && c.version_id && m && m.id != null) {
      const stamped = { ...g, agent_version: c.version_id };
      try {
        const res = await db.patch('messages', { id: 'eq.' + m.id }, { grade: stamped });
        if (res === null || res.length) { c.grade = stamped; counts.stamped++; }
        else log(`  grade of message ${m.id} not stamped — the messages table lacks the update policy (re-run supabase/schema.sql)`);
      } catch (e) { log(`  grade of message ${m.id} not stamped: ${e.message}`); }
    }
  }
  log(`pull — since ${since.toISOString()}: ${counts.conversations} conversation(s), ${counts.joined} joined to a debrief, ${counts.graded} graded, ${counts.graded_bad} graded bad, ${counts.stamped} grade(s) stamped with the agent version`);
  const speed = replySpeed(convs);
  log(speed.line);
  if (ctx.dryRun) { log('  (dry run) nothing written'); return 0; }
  const file = path.join(ctx.p.field, `${stamp()}.json`);
  writeJson(file, { at: new Date().toISOString(), agent_id: agentId, since: since.toISOString(), counts, speed, conversations: convs });
  log(`wrote ${file}`);
  return 0;
}

/* ---------- score ---------- */

/* the row a score line is about, short enough for a column: "#3" is
 * trigger scenario 3, "s#3" situation 3 — the two sheets number from
 * one each, so a shared key would add them up */
const scenarioKey = (num, title, kind) => {
  const mark = kind === 'situation' ? 's#' : '#';
  return num != null && num !== '' ? `${mark}${num}` : (title ? String(title).slice(0, 40) : `(no ${kind === 'situation' ? 'situation' : 'scenario'})`);
};

export function scoreData(results, field) {
  const rows = new Map();
  const row = (num, title, kind = 'scenario') => {
    const k = scenarioKey(num, title, kind);
    if (!rows.has(k)) rows.set(k, { key: k, kind, num: num ?? null, title: title || '', tests: 0, runs: 0, passed: 0, conversations: 0, graded: 0, good: 0, bad: 0, checks: {}, reasons: new Map() });
    const r = rows.get(k);
    if (!r.title && title) r.title = title;
    return r;
  };
  const bump = (r, key, example) => {
    if (!key) return;
    const e = r.reasons.get(key) || { count: 0, example };
    e.count++;
    r.reasons.set(key, e);
  };
  for (const t of (results && results.tests) || []) {
    /* a situation test belongs to the situation sheet, and a field
     * conversation to whichever scenario the join placed it under */
    const sit = t.kind === 'situation' || t.situation_num != null;
    const r = sit ? row(t.situation_num, t.situation_title, 'situation') : row(t.scenario_num, t.scenario_title);
    r.tests++; r.runs += t.runs || 0; r.passed += t.passed || 0;
    for (const why of t.rationales || []) bump(r, reasonKey(why), why);
  }
  for (const c of (field && field.conversations) || []) {
    const r = row(c.scenario && c.scenario.num, c.scenario && c.scenario.title);
    r.conversations++;
    const gs = gradeSummary(c.grade);
    if (gs.graded) { r.graded++; if (gs.bad) r.bad++; else r.good++; }
    for (const k of gs.failed) {
      r.checks[k] = (r.checks[k] || 0) + 1;
      bump(r, 'grade: ' + GRADE_CHECKS[k].toLowerCase(), (c.grade && c.grade.note) || GRADE_CHECKS[k]);
    }
    for (const [id, e] of Object.entries(c.evaluation || {})) if (e.result === 'failure') bump(r, `criteria ${id}: ` + reasonKey(e.rationale), e.rationale);
  }
  const out = [...rows.values()].map(r => ({
    ...r,
    suite_pass_rate: r.runs ? r.passed / r.runs : null,
    field_grade_rate: r.graded ? r.good / r.graded : null,
    reasons: [...r.reasons.entries()].map(([k, v]) => ({ reason: k, count: v.count, example: v.example })).sort((a, b) => b.count - a.count),
  }));
  return out.sort((a, b) => (a.suite_pass_rate ?? 2) - (b.suite_pass_rate ?? 2) || (a.field_grade_rate ?? 2) - (b.field_grade_rate ?? 2) || (a.num ?? 1e9) - (b.num ?? 1e9));
}

async function score(ctx, flags) {
  const { log } = ctx;
  const resultsFile = flags.results || latest(ctx.p.results, /^(?!score-).*\.json$/);
  const fieldFile = flags.field || latest(ctx.p.field);
  if (!resultsFile && !fieldFile) throw new UsageError('nothing to score — run "run" (results/) and/or "pull" (field/) first, or pass --results / --field');
  const results = resultsFile ? readJson(resultsFile) : null;
  const field = fieldFile ? readJson(fieldFile) : null;
  const rows = scoreData(results, field);
  log(`score — suite: ${resultsFile ? path.basename(resultsFile) : 'none'} · field: ${fieldFile ? path.basename(fieldFile) : 'none'}\n`);
  log(table(rows, [
    { key: 'key', label: 'row', width: 6 }, { key: 'title', label: '', width: 34 },
    { get: r => (r.tests ? `${r.passed}/${r.runs}` : '—'), label: 'suite', width: 7, right: true },
    { get: r => pct(r.suite_pass_rate), label: 'rate', width: 5, right: true },
    { get: r => (r.conversations ? `${r.graded}/${r.conversations}` : '—'), label: 'graded', width: 7, right: true },
    { get: r => pct(r.field_grade_rate), label: 'good', width: 5, right: true },
    { get: r => Object.entries(r.checks).map(([k, n]) => `${k}×${n}`).join(' '), label: 'checks failed', width: 30 },
  ]));
  const buckets = [];
  for (const r of rows) for (const b of r.reasons) buckets.push({ scenario: r.key, ...b });
  buckets.sort((a, b) => b.count - a.count);
  if (buckets.length) {
    log('\nfailures by reason:');
    for (const b of buckets.slice(0, 12)) log(`  ${String(b.count).padStart(3)}× ${b.scenario.padEnd(6)} ${b.reason.slice(0, 60).padEnd(60)}  e.g. "${String(b.example).replace(/\s+/g, ' ').slice(0, 90)}"`);
  }
  const file = path.join(ctx.p.results, `score-${stamp()}.json`);
  writeJson(file, { at: new Date().toISOString(), results: resultsFile, field: fieldFile, scenarios: rows });
  log(`\nwrote ${file}`);
  return 0;
}

/* ---------- cut ---------- */

/* the phone's convo ({from:'ai'|'me', text, at}) when the debrief has
 * one — that is the conversation the designer graded — else the
 * ElevenLabs transcript */
function turnsOf(c) {
  const convo = c.message && Array.isArray(c.message.convo) ? c.message.convo : null;
  if (convo && convo.length) {
    const t0 = Date.parse(convo[0].at) || 0;
    return convo.filter(t => t && String(t.text || '').trim()).map((t, i) => ({
      role: t.from === 'ai' ? 'agent' : 'user',
      message: String(t.text).trim(),
      t: t.at && t0 ? Math.max(0, Math.round((Date.parse(t.at) - t0) / 1000)) : i,
    }));
  }
  return (c.transcript || []).map((t, i) => ({ role: t.role === 'agent' ? 'agent' : 'user', message: t.message, t: t.t ?? i }));
}

/* what the next reply has to do, per failed check — the labels are the
 * designer's verdict, these are the same verdict as an instruction */
const CHECK_DEMANDS = {
  opener: c => `opens with the scenario's own question${c.dynamic_variables.scenario_question ? ` (“${c.dynamic_variables.scenario_question}”)` : ''}, not a greeting or a different question`,
  followup: () => 'follows up on what the tester actually said in the turns above — a specific question about the place, the time or the way in they described, not a generic one',
  tip: c => `steers towards the tip type this scenario expects${c.dynamic_variables.expected_tip_type ? ` (${c.dynamic_variables.expected_tip_type})` : ''} with one concrete question that could produce it`,
  brevity: () => 'is short — at most one question — and, if a usable tip is already in the turns above, thanks the tester and lets them go instead of asking more',
  language: c => `is entirely in ${c.dynamic_variables.debrief_language || 'the language the tester used'}`,
};
export function regressionCondition(c, gs) {
  const demands = gs.failed.map(k => CHECK_DEMANDS[k] ? CHECK_DEMANDS[k](c) : GRADE_CHECKS[k]);
  const note = String((c.grade && c.grade.note) || '').trim();
  return `This is a real debrief in which the designer marked the agent's reply as failing: ${gs.failed_labels.join('; ')}.` +
    (note ? ` The designer's note: "${note}".` : '') +
    ` The agent's next reply passes only if it ${demands.join('; and ')}.`;
}

async function cut(ctx, flags) {
  const { log } = ctx;
  const fieldFile = flags.field || latest(ctx.p.field);
  if (!fieldFile) throw new UsageError('no field file — run "pull" first, or pass --field FILE');
  const field = readJson(fieldFile);
  const outDir = path.join(ctx.p.configs, 'regressions');
  const rows = [];
  let written = 0, skipped = 0, thin = 0, openerOut = 0;
  for (const c of field.conversations || []) {
    const gs = gradeSummary(c.grade);
    if (!gs.bad) continue;
    const file = path.join(outDir, `${slugLabel(c.conversation_id)}.json`);
    if (existsSync(file)) { skipped++; rows.push({ id: c.conversation_id, action: 'exists, kept', file: path.relative(ctx.dir, file) }); continue; }
    const turns = turnsOf(c);
    const agentAt = turns.map((t, i) => (t.role === 'agent' ? i : -1)).filter(i => i >= 0);
    /* Where the history is cut decides which reply the evaluator
     * scores, and the opener is a different reply from the rest. On the
     * phone the opener is the sheet's "Otto says" line, sent as the
     * first_message override, and the prompt only writes it when that
     * override is refused — so a debrief failed on the opener ALONE is
     * cut before the first agent turn: the history is usually empty and
     * left out (optional on an llm test), and the reply scored is the
     * opener itself. Every other check judges a reply made mid-
     * conversation, so those cut before the last agent turn — and when
     * the opener failed along with them, its demand is dropped from that
     * test: a reply four turns in cannot open with anything, and a
     * condition that asks it to fails on every prompt forever. */
    const openerOnly = gs.failed.length === 1 && gs.failed[0] === 'opener';
    const checks = openerOnly ? gs.failed : gs.failed.filter(k => k !== 'opener');
    const at = openerOnly ? agentAt[0] : agentAt[agentAt.length - 1];
    if (at == null || (!openerOnly && at < 1)) { thin++; rows.push({ id: c.conversation_id, action: openerOnly ? 'no agent turn to cut' : 'no turns before the last agent turn', file: '' }); continue; }
    if (!openerOnly && gs.failed.includes('opener')) openerOut++;
    const how = openerOnly ? ' (opener: first turn)' : gs.failed.includes('opener') ? ' (opener left out)' : '';
    const lang = /italian/i.test(String(c.dynamic_variables.debrief_language || '')) ? 'it' : 'en';
    /* The example lists are optional but must not be empty when sent
     * (the create-test reference: "Non-empty list … optional"), so
     * success_examples is left out — nobody wrote the good reply yet —
     * and the one failure example is the reply the designer actually
     * graded bad: the turn this test asks the agent to do better than.
     * chat_history is optional the same way, and left out when the cut
     * leaves nothing before it. */
    const history = turns.slice(0, at).map(t => ({ role: t.role, time_in_call_secs: t.t, message: t.message }));
    const body = {
      name: `Otto · regression · ${c.conversation_id}`,
      type: 'llm',
      dynamic_variables: c.dynamic_variables || {},
      ...(history.length ? { chat_history: history } : {}),
      success_condition: regressionCondition(c, { failed: checks, failed_labels: checks.map(k => GRADE_CHECKS[k]) }),
      failure_examples: [{ response: turns[at].message, type: 'failure' }],
    };
    if (field.agent_id) body.from_conversation_metadata = { conversation_id: c.conversation_id, agent_id: field.agent_id };
    /* which scenario the regression belongs to — on the dashboard a
     * suite result is shown per scenario, and a test without one is a
     * test nobody sees. pull joins the debrief to its scenario through
     * the destination; when that join is gone (a debrief deleted on the
     * dashboard, a field file fed by hand) the dynamic variables the
     * phone sent the agent still name the row it was acting out. */
    const dv = c.dynamic_variables || {};
    const sc = c.scenario || {};
    const numOf = x => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
    body._otto = {
      scenario_num: numOf(sc.num) ?? numOf(dv.scenario_num),
      scenario_title: String(sc.title || dv.scenario_title || ''),
      persona: 'field',
      kind: 'regression',
      source_conversation_id: c.conversation_id,
      language: lang,
    };
    if (ctx.dryRun) { rows.push({ id: c.conversation_id, action: 'would be written' + how, file: path.relative(ctx.dir, file) }); continue; }
    writeJson(file, body);
    written++;
    rows.push({ id: c.conversation_id, action: 'written' + how, file: path.relative(ctx.dir, file) });
  }
  if (rows.length) log(table(rows, [{ key: 'id', label: 'conversation', width: 34 }, { key: 'action', label: 'action', width: 40 }, { key: 'file', label: 'file', width: 60 }]));
  log(`cut — ${written} regression test(s) written, ${skipped} already there, ${thin} too thin to cut${written ? '; push them with push-tests' : ''}` +
    (openerOut ? `\n  ${openerOut} opener check(s) left out of a test cut mid-conversation — the opener is the phone's first_message override (the sheet's "Otto says"), so a wrong one is an override the agent refused (see configure) or a sheet line, not a prompt reply; a debrief failed on the opener alone gets a first-turn test` : ''));
  return 0;
}

/* ---------- propose ---------- */

const PROPOSE_SYSTEM =
  'You tune the system prompt of Otto, an ElevenLabs voice agent that debriefs a delivery app\'s field ' +
  'testers right after a trigger scenario fired (a parking loop, a wrong entrance, a long wait at the door). ' +
  'You get the current prompt, the tests it failed with the evaluator\'s rationale, real debriefs a designer ' +
  'graded bad (which checks failed, their note, the transcript), and how often each of the agent\'s own ' +
  'evaluation criteria failed in the field. Propose the next prompt. ' +
  'Return ONLY JSON: {"prompt": string, "note": string, "rationale": string}. ' +
  'prompt: the FULL new prompt — the current one with the smallest edit that addresses the evidence. Keep ' +
  'every {{dynamic_variable}} reference, every existing rule and the voice intact; do not restructure, do not ' +
  'add sections the evidence does not call for, and do not make it longer than the edit needs. ' +
  'note: one line (max 120 chars) saying what changed and why, grounded in the evidence — it becomes the ' +
  'version description. rationale: two or three sentences tying each edit to a failing test or a graded debrief. ' +
  'Be conservative: change only what the failures actually support; if the evidence is too thin to justify an ' +
  'edit, return the prompt unchanged and say so in the note. ' +
  'designer_decisions lists behaviours the designer has ruled fine by design, each with the reason: never propose ' +
  'an edit that changes, removes or "fixes" one of them, and disregard any rationale or graded note that complains ' +
  'about one of them — those are settled, whatever the evidence says.';

/* conversation_config.agent.prompt.prompt, on an agent or a pulled config */
const promptOf = j => {
  const p = j && j.conversation_config && j.conversation_config.agent && j.conversation_config.agent.prompt;
  return p && typeof p.prompt === 'string' ? p.prompt : null;
};

/* a pulled agent config (the ElevenLabs CLI's agent_configs/), if one
 * is in the folder — the layout is the CLI's to change, so this only
 * looks for the one field it needs, anywhere in any JSON there */
function localPrompt(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  const walk = d => { for (const n of readdirSync(d).sort()) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.json')) files.push(p); } };
  walk(dir);
  for (const f of files) {
    try {
      const p = promptOf(readJson(f));
      if (p && p.trim()) return { prompt: p, source: f };
    } catch { /* not a config */ }
  }
  return null;
}

/* the evidence, compact: the model reads failures, not whole files */
export function evidenceOf(results, field) {
  const failing = ((results && results.tests) || []).filter(t => t.pass_rate < 1).map(t => ({
    test: t.name, passed: `${t.passed}/${t.runs}`, scenario: t.scenario_title || null, persona: t.persona || null,
    rationales: (t.rationales || []).slice(0, 3).map(r => String(r).slice(0, 400)),
  }));
  const bad = ((field && field.conversations) || []).filter(c => gradeSummary(c.grade).bad).map(c => {
    const gs = gradeSummary(c.grade);
    return {
      conversation_id: c.conversation_id, scenario: c.scenario ? `#${c.scenario.num} ${c.scenario.title}` : null,
      failed_checks: gs.failed_labels, note: (c.grade && c.grade.note) || '',
      criteria_failed: Object.entries(c.evaluation || {}).filter(([, e]) => e.result === 'failure').map(([id, e]) => `${id}: ${String(e.rationale).slice(0, 200)}`),
      transcript: turnsOf(c).slice(-12).map(t => `${t.role}: ${String(t.message).slice(0, 300)}`),
    };
  });
  const criteria = {};
  for (const c of (field && field.conversations) || []) for (const [id, e] of Object.entries(c.evaluation || {})) {
    criteria[id] = criteria[id] || { failure: 0, success: 0, unknown: 0 };
    criteria[id][e.result in criteria[id] ? e.result : 'unknown']++;
  }
  return { failing_tests: failing, bad_debriefs: bad, criteria_results: criteria };
}

/* The proposer's input has a budget — the model's context, and its
 * attention. The prompt goes in whole; the evidence is trimmed to fit
 * BEFORE it is serialised, never by cutting the JSON string, which
 * hands the model an unterminated document and drops the tail in
 * silence. Rationales and transcripts are shortened first; then whole
 * items go, from the end of each list, alternating between the longer
 * one: the results are worst-first (aggregate) and the field file is
 * newest-first (the conversations list's default order), so what
 * survives is the worst tests and the latest debriefs. */
export const EVIDENCE_CHARS = 80000;
export function fitEvidence(prompt, evidence, budget = EVIDENCE_CHARS) {
  const size = ev => JSON.stringify({ current_prompt: prompt, ...ev }).length;
  const ev = { ...evidence, failing_tests: [...(evidence.failing_tests || [])], bad_debriefs: [...(evidence.bad_debriefs || [])] };
  const total = { failing_tests: ev.failing_tests.length, bad_debriefs: ev.bad_debriefs.length };
  let shortened = false;
  if (size(ev) > budget) {
    shortened = true;
    ev.failing_tests = ev.failing_tests.map(t => ({ ...t, rationales: (t.rationales || []).slice(0, 1).map(r => String(r).slice(0, 200)) }));
    ev.bad_debriefs = ev.bad_debriefs.map(d => ({ ...d, criteria_failed: (d.criteria_failed || []).slice(0, 2), transcript: (d.transcript || []).slice(-6).map(l => String(l).slice(0, 160)) }));
  }
  while (size(ev) > budget && (ev.failing_tests.length || ev.bad_debriefs.length)) {
    if (ev.bad_debriefs.length >= ev.failing_tests.length) ev.bad_debriefs.pop(); else ev.failing_tests.pop();
  }
  return {
    evidence: ev,
    fits: size(ev) <= budget,
    shortened,
    left_out: { failing_tests: total.failing_tests - ev.failing_tests.length, bad_debriefs: total.bad_debriefs - ev.bad_debriefs.length },
  };
}

async function propose(ctx, flags) {
  const { log } = ctx;
  const resultsFile = flags.results || latest(ctx.p.results, /^(?!score-).*\.json$/);
  const fieldFile = flags.field || latest(ctx.p.field);
  const results = resultsFile ? readJson(resultsFile) : null;
  const field = fieldFile ? readJson(fieldFile) : null;
  const evidence = evidenceOf(results, field);
  if (!evidence.failing_tests.length && !evidence.bad_debriefs.length) {
    log(`nothing to propose from — every test passes${resultsFile ? ` (${path.basename(resultsFile)})` : ''} and no debrief is graded bad${fieldFile ? ` (${path.basename(fieldFile)})` : ''}`);
    return 0;
  }
  let prompt = '', source = '';
  if (flags.prompt) {
    const raw = readFileSync(flags.prompt, 'utf8');
    let j = null;
    if (flags.prompt.endsWith('.json')) { try { j = JSON.parse(raw); } catch { j = null; } }
    prompt = promptOf(j) || raw;
    source = flags.prompt;
  } else if (!flags.agent) {
    const local = localPrompt(ctx.p.agentConfigs);
    if (local) { prompt = local.prompt; source = local.source; }
  }
  if (!prompt) {
    const { api, agentId } = needEleven(ctx);
    const agent = await api.getAgent(agentId);
    prompt = agent ? String(promptOf(agent) || '') : '<the prompt from GET agent>';
    source = agent ? `agent ${agentId} (version ${agent.version_id || '?'})` : 'agent (dry run)';
    if (agent && !prompt.trim()) throw new Error(`agent ${agentId} has no conversation_config.agent.prompt.prompt to tune`);
  }
  /* the prompt as the model gets it and as the diff is taken: a file
   * saved by an editor ends with a newline the reply never carries, and
   * a diff against the raw text would show that newline as a removed
   * line on every proposal */
  const base = prompt.trim();
  const key = ctx.env.OPENAI_API_KEY;
  if (!key && !ctx.dryRun) throw new UsageError('OPENAI_API_KEY is not set — the proposer is the repo\'s existing provider (scenario-ai uses the same key)');
  const model = ctx.env.LOOP_MODEL || 'gpt-4o';
  /* the designer's decisions — findings marked NOT A PROBLEM on the
   * dashboard's RUNS tab. They go to the proposer as rules, not as
   * evidence: a failing rationale that complains about one of them is
   * not a reason to edit the prompt */
  const accepted = await acceptedFindings(needDb(ctx));
  if (accepted === null) log('no accepted_findings table yet (supabase/schema.sql) — the proposer gets no designer decisions');
  else if (accepted.length) log(`${accepted.length} finding(s) the designer marked as fine by design — the proposer is told to leave them be`);
  evidence.designer_decisions = (accepted || []).map(a => ({ finding: String(a.title || a.key || ''), why: String(a.note || '') }));
  log(`propose — prompt from ${source} (${base.length} chars); ${evidence.failing_tests.length} failing test(s), ${evidence.bad_debriefs.length} debrief(s) graded bad; model ${model}`);
  const fit = fitEvidence(base, evidence);
  if (!fit.fits || (!fit.evidence.failing_tests.length && !fit.evidence.bad_debriefs.length)) {
    throw new UsageError(`the prompt (${base.length} chars) leaves no room for evidence in the proposer's input budget of ${EVIDENCE_CHARS} chars — nothing was sent; pass a shorter --prompt FILE`);
  }
  if (fit.shortened || fit.left_out.failing_tests || fit.left_out.bad_debriefs) {
    log(`  evidence trimmed to fit ${EVIDENCE_CHARS} chars: rationales and transcripts shortened, ${fit.left_out.failing_tests} of ${evidence.failing_tests.length} failing test(s) and ${fit.left_out.bad_debriefs} of ${evidence.bad_debriefs.length} bad debrief(s) left out (the worst tests and the latest debriefs are kept) — pass a narrower --results / --field to choose`);
  }
  /* the reply must hold the whole prompt (up to a quarter longer) plus
   * a note and a rationale; three characters a token over-estimates
   * JSON-escaped prose, and the cap is what one completion can write */
  const maxTokens = Math.min(16000, Math.ceil(base.length / 3) + 1500);
  const ai = openai({ apiKey: key || '', base: ctx.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', http: ctx.http });
  let out;
  try {
    out = await ai.json({ model, system: PROPOSE_SYSTEM, user: JSON.stringify({ current_prompt: base, ...fit.evidence }), maxTokens });
  } catch (e) {
    /* the proposer's own message quotes what came back, and what comes
     * back is the prompt with an edit in it */
    if (!ctx.quiet) throw e;
    throw new Error('the proposer failed and its message is not shown under --quiet: a reply, or a provider\'s error echoing the request, carries the prompt. Re-run without --quiet at a terminal to read it');
  }
  if (!out) return 0;
  const next = String(out.prompt || '').trim();
  const note = String(out.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const rationale = String(out.rationale || '').trim();
  /* the note and the rationale describe the edit, which is the prompt
   * seen from the side; under --quiet the reason for the refusal is all
   * that goes out */
  const refuse = why => { log(ctx.quiet ? `refused: ${why} — the model's note and rationale are not shown` : `refused: ${why}\n  note: ${note || '—'}\n  rationale: ${rationale || '—'}`); return 1; };
  if (!next) return refuse('the model returned no prompt');
  if (next === base) return refuse('the model proposed no change (the evidence was too thin, by its own account)');
  const growth = next.length / Math.max(1, base.length) - 1;
  if (growth > 0.25) return refuse(`the proposal grows the prompt by ${Math.round(growth * 100)}% (limit 25%) — a longer prompt is not a better one; re-run, or make the edit by hand`);
  const diff = unifiedDiff(base, next);
  const file = path.join(ctx.p.proposals, `${stamp()}.json`);
  writeJson(file, {
    at: new Date().toISOString(), model, source, base_sha: sha(base), base_chars: base.length, chars: next.length,
    prompt: next, note, rationale, diff,
    evidence: { results: resultsFile, field: fieldFile, failing_tests: evidence.failing_tests.length, bad_debriefs: evidence.bad_debriefs.length },
  });
  if (ctx.quiet) log(`\n${base.length} chars in, ${next.length} out, ${diff.split('\n').filter(l => /^[+-][^+-]/.test(l)).length} changed line(s)\nproposal written to ${file} — not shown\nnext: node loop.mjs branch --proposal ${file}`);
  else log(`\nnote: ${note}\nrationale: ${rationale}\n\n${diff}\n\nwrote ${file}\nnext: node loop.mjs branch --proposal ${file}`);
  return 0;
}

/* ---------- branch ---------- */

async function branch(ctx, flags) {
  const { log } = ctx;
  if (!flags.proposal) throw new UsageError('--proposal FILE is required (proposals/<stamp>.json from "propose")');
  const p = readJson(flags.proposal);
  if (!p || typeof p.prompt !== 'string' || !p.prompt.trim()) throw new UsageError(`${flags.proposal} carries no prompt`);
  const { api, agentId } = needEleven(ctx);
  const agent = await api.getAgent(agentId);
  /* version_id on GET agent is "the version the agent is on" — the
   * parent a branch is cut from */
  const parent = agent ? agent.version_id : '<version_id from GET agent>';
  if (agent && !parent) throw new Error(`GET agent ${agentId} returned no version_id — the agent has no committed version to branch from`);
  const name = flags.name || `loop-${stamp().slice(0, 15).toLowerCase()}`;
  const body = {
    parent_version_id: parent,
    name,
    /* the branch's description IS the version note from here on:
     * ElevenLabs keeps it next to the prompt it belongs to, and
     * `promote` reads it back rather than passing a proposal file
     * around a public runner */
    description: p.note || 'prompt proposal from the agent loop',
    conversation_config: { agent: { prompt: { prompt: p.prompt } } },
  };
  let res;
  try {
    res = await api.createBranch(agentId, body);
  } catch (e) {
    /* this is the one request that carries the prompt, and a 4xx from a
     * validator likes to quote the field it refused — which would be
     * the prompt, in the log of a public run */
    throw new Error(`${e.status || 'no reply'} from POST /v1/convai/agents/${agentId}/branches — the reply is not shown: it can quote the prompt back. Re-send it by hand if you need to read it`);
  }
  if (!res) return 0;
  /* ids and the branch name only: what the branch CHANGED is the prompt
   * described, and this line ends up in a job summary */
  log(`branch "${name}" created: ${res.created_branch_id} (version ${res.created_version_id}, from ${parent})`);
  writeJson(flags.proposal, { ...p, branch: { branch_id: res.created_branch_id, version_id: res.created_version_id, parent_version_id: parent, name, at: new Date().toISOString() } });
  log(`next: node loop.mjs run --branch ${res.created_branch_id} --label branch\n      node loop.mjs compare --base results/<main>.json --branch results/<branch>.json`);
  return 0;
}

/* ---------- model-branch ----------
 * A branch that differs from the live Otto in ONE thing: the language
 * model, and with it how much it is let think. The prompt, the voice,
 * the tools and everything else come from the version it is cut from —
 * the body carries settings only, so an error from the API can be
 * shown whole, and the branch's description can say what changed in
 * the clear (a model name is a setting, not the prompt). The suite on
 * that branch, compared against the baseline, then says what the model
 * costs in pass rate, and the run's own timings what it saves in
 * seconds. */
/* What each setting means to ElevenLabs, per model: some models take a
 * reasoning_effort, some a thinking_budget, and a model refuses the
 * rest with "Not supported reasoning effort" (the first live trial:
 * gemini-3.6-flash would not take "none"). So every setting is a
 * ladder — the first rung the model accepts wins, and the log and the
 * branch's description say which; "off" ends at the lowest effort the
 * model takes rather than failing the button. */
const OFF = [
  { reasoning_effort: 'none', thinking_budget: 0 },
  { reasoning_effort: null, thinking_budget: 0 },
  { reasoning_effort: 'minimal' },
  { reasoning_effort: 'low' },
];
const REASONING = {
  keep: [null],
  off: OFF,
  none: OFF,
  minimal: [{ reasoning_effort: 'minimal' }, { reasoning_effort: 'low' }],
  low: [{ reasoning_effort: 'low' }],
  medium: [{ reasoning_effort: 'medium' }],
  high: [{ reasoning_effort: 'high' }],
  xhigh: [{ reasoning_effort: 'xhigh' }],
  max: [{ reasoning_effort: 'max' }],
};
const describeRung = p => (!p ? 'the live setting'
  : [p.reasoning_effort !== undefined ? `reasoning ${p.reasoning_effort === null ? 'unset' : p.reasoning_effort}` : '', p.thinking_budget !== undefined ? `thinking budget ${p.thinking_budget}` : ''].filter(Boolean).join(', '));
async function modelBranch(ctx, flags) {
  const { log } = ctx;
  const model = String(flags.model || '').trim();
  if (!model) throw new UsageError('--model NAME is required — the language model as ElevenLabs names it (gpt-4.1-mini, gemini-2.5-flash, claude-haiku-4-5, …)');
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) throw new UsageError(`"${model}" does not look like a model name — letters, digits, dots and dashes, as ElevenLabs spells it`);
  let want = String(flags.reasoning == null || flags.reasoning === '' ? 'keep' : flags.reasoning).trim().toLowerCase();
  /* a YAML form reads a bare "off" as the boolean false and hands it
   * over as the word — the same setting */
  if (want === 'false' || want === 'no' || want === '0') want = 'off';
  if (!(want in REASONING)) throw new UsageError(`--reasoning is one of keep, off, minimal, low, medium, high, xhigh, max — not "${flags.reasoning}"`);
  const { api, agentId } = needEleven(ctx);
  const agent = await api.getAgent(agentId);
  const parent = agent ? agent.version_id : '<version_id from GET agent>';
  if (agent && !parent) throw new Error(`GET agent ${agentId} returned no version_id — the agent has no committed version to branch from`);
  const live = llmSettings(agent);
  if (live) log(`live Otto: model ${live.model || '?'}${live.reasoning ? ', reasoning ' + live.reasoning : ''}${live.thinking_budget != null ? ', thinking budget ' + live.thinking_budget : ''} (version ${parent})`);
  const change = want === 'keep' ? '' : `, reasoning ${want}`;
  /* ElevenLabs takes letters, digits, spaces and () [] {} - / . _ in a
   * branch name — no comma, no colon: the first trial was refused on
   * its own name. The default keeps to that set; a name given by hand
   * has the rest swapped for dashes */
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const name = String(flags.name || `model ${model}${want === 'keep' ? '' : ' reasoning ' + want} (${stamp})`).replace(/[^A-Za-z0-9 ()[\]{}\-/._]+/g, '-').trim();
  const rungs = REASONING[want];
  const refused = [];
  let res = null, used = null;
  for (const rung of rungs) {
    const setAs = refused.length ? ` (set as ${describeRung(rung)}: this model does not take ${refused.join(' or ')})` : '';
    const body = {
      parent_version_id: parent,
      name,
      description: `model trial: ${model}${change}${setAs} — the prompt is the live one, unchanged`,
      conversation_config: { agent: { prompt: { llm: model, ...(rung || {}) } } },
    };
    try {
      res = await api.createBranch(agentId, body);
      used = rung;
      break;
    } catch (e) {
      /* no prompt in this body — what the API objected to is the model
       * name or the reasoning setting, and it can say so */
      const msg = String(e.message || e);
      const aboutReasoning = (e.status === 400 || e.status === 422) && /reasoning|thinking/i.test(msg);
      if (aboutReasoning && rung !== rungs[rungs.length - 1]) {
        refused.push(describeRung(rung));
        log(`  ${model} does not take ${describeRung(rung)} — trying the next setting`);
        continue;
      }
      if (aboutReasoning) throw new Error(`${msg.slice(0, 300)} — ${model} takes none of the settings that mean "reasoning ${want}" (${[...refused, describeRung(rung)].join(', ')}). Its choices are in the agent's LLM settings in ElevenLabs; try another level, or "keep"`);
      throw new Error(`${msg.slice(0, 400)} — ElevenLabs refused the branch. If its message names the model: the names it takes are in the agent's LLM settings and in the API reference (conversation_config.agent.prompt.llm)`);
    }
  }
  const setAs = refused.length ? ` (set as ${describeRung(used)} — this model does not take ${refused.join(' or ')})` : '';
  if (!res) return 0;
  log(`branch "${name}" created: ${res.created_branch_id} (version ${res.created_version_id}, from ${parent}) — model ${model}${change}${setAs}`);
  if (flags.out) writeJson(flags.out, { branch_id: res.created_branch_id, version_id: res.created_version_id, parent_version_id: parent, name, model, reasoning: want, set_as: used, at: new Date().toISOString() });
  log(`next: node loop.mjs run --branch ${res.created_branch_id} --label model\n      node loop.mjs compare --base results/<main>.json --branch results/<model>.json`);
  return 0;
}

/* ---------- compare ---------- */

/* The verdict on a branch run against the baseline — judged by ROW,
 * not by test. A row is a situation (or a trigger scenario, or a lone
 * regression test) with every driver type and every repeat together:
 * twelve calls or more. A test is one driver type at three calls, and
 * a score out of three can only be 0, 33, 67 or 100: losing one call
 * by chance was a "33-point drop", and the same agent, unchanged,
 * loses single calls on every run — so a per-test rule said REJECT to
 * everything (run 62: eleven "drops", the totals two calls apart). A
 * row counts as worse only when it loses more than `margin` of its
 * calls (0.25: more than three of twelve). On top of that the total
 * must not fall, and at least one row that was not perfect must gain.
 * A test file without runs (rate only) is compared on its rate. Only
 * tests present on BOTH sides count: a driver type added since the
 * baseline (its tests exist only on the branch) would otherwise change
 * every row's mix, and the baseline would have to be re-run for no
 * reason; those tests are counted and named in `leftOut`. */
export function compareResults(base, branch, margin = 0.25) {
  const num = x => (x == null || x === '' ? null : x);
  const nameOf = t => String(t.name || t.test_id || '');
  const inBase = new Set((base.tests || []).map(nameOf)), inBranch = new Set((branch.tests || []).map(nameOf));
  const leftOut = {
    branch: (branch.tests || []).filter(t => !inBase.has(nameOf(t))).map(nameOf),
    base: (base.tests || []).filter(t => !inBranch.has(nameOf(t))).map(nameOf),
  };
  base = { ...base, tests: (base.tests || []).filter(t => inBranch.has(nameOf(t))) };
  branch = { ...branch, tests: (branch.tests || []).filter(t => inBase.has(nameOf(t))) };
  const rowOf = t => (num(t.situation_num) != null ? `situation #${t.situation_num}${t.situation_title ? ' ' + t.situation_title : ''}`
    : num(t.scenario_num) != null ? `scenario #${t.scenario_num}${t.scenario_title ? ' ' + t.scenario_title : ''}`
      : String(t.name || t.test_id || '?'));
  const tally = tests => {
    const m = new Map();
    for (const t of tests || []) {
      const k = rowOf(t);
      const g = m.get(k) || { name: k, runs: 0, passed: 0, rateSum: 0, n: 0, why: '' };
      const runs = Number(t.runs) || 0;
      const rate = Number(t.pass_rate) || 0;
      g.runs += runs; g.passed += runs ? (t.passed != null ? Number(t.passed) || 0 : Math.round(rate * runs)) : 0;
      g.rateSum += rate; g.n++;
      if (!g.why) g.why = (t.rationales && t.rationales[0]) || t.why || '';
      m.set(k, g);
    }
    for (const g of m.values()) g.rate = g.runs ? g.passed / g.runs : (g.n ? g.rateSum / g.n : 0);
    return m;
  };
  const a = tally(base.tests), b = tally(branch.tests);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows = names.map(name => {
    const x = a.get(name), y = b.get(name);
    const delta = x && y ? y.rate - x.rate : null;
    return {
      name, base: x ? x.rate : null, branch: y ? y.rate : null, delta,
      calls: y ? `${y.passed}/${y.runs}` : (x ? `–/${x.runs}` : ''),
      lost: x && y ? Math.max(0, x.passed - y.passed) : 0,
      dropped: delta != null && delta < -margin - 1e-9,
      improved: delta != null && x.rate < 1 - 1e-9 && delta > 1e-9,
      why: y ? y.why : '',
    };
  });
  const both = rows.filter(r => r.base != null && r.branch != null);
  const sum = (m, keys) => keys.reduce((o, k) => { const g = m.get(k); o.passed += g.passed; o.runs += g.runs; o.rate += g.rate; return o; }, { passed: 0, runs: 0, rate: 0 });
  const A = sum(a, both.map(r => r.name)), B = sum(b, both.map(r => r.name));
  const totalA = A.runs ? A.passed / A.runs : (both.length ? A.rate / both.length : 0);
  const totalB = B.runs ? B.passed / B.runs : (both.length ? B.rate / both.length : 0);
  const totalDown = totalB < totalA - 1e-9;
  const drops = rows.filter(r => r.dropped), improved = rows.filter(r => r.improved);
  const wasFailing = rows.filter(r => r.base != null && r.base < 1 - 1e-9);
  const unit = rows.length && rows.every(r => /^situation #/.test(r.name)) ? 'situation' : 'row';
  const pts = Math.round(margin * 100);
  const totals = A.runs ? `${B.passed} of ${B.runs} calls against ${A.passed} of ${A.runs}` : `${Math.round(totalB * 100)}% against ${Math.round(totalA * 100)}%`;
  const accept = !drops.length && !totalDown && improved.length > 0;
  const reason = drops.length ? `${drops.length} ${unit}(s) dropped by more than ${pts} points (${drops.map(r => `${r.name.replace(/^(situation|scenario) /, '')}: −${r.lost} call${r.lost === 1 ? '' : 's'}`).slice(0, 4).join(', ')}${drops.length > 4 ? ', …' : ''})`
    : totalDown ? `the branch passed fewer calls overall: ${totals}`
      : !wasFailing.length ? 'nothing was failing on the base run, so there is nothing for the branch to improve'
        : !improved.length ? `no ${unit} improved (${totals})`
          : `${improved.length} ${unit}(s) improved, none dropped by more than ${pts} points, and the total went up: ${totals}`;
  return { rows, accept, reason, drops: drops.length, improved: improved.length, totalDown, totals: { base: totalA, branch: totalB }, leftOut };
}

async function compare(ctx, flags) {
  const { log } = ctx;
  if (!flags.base || !flags.branch) throw new UsageError('--base FILE and --branch FILE are both required (two results/ files)');
  const margin = flags.margin != null ? Number(flags.margin) : 0.25;
  if (Number.isNaN(margin) || margin < 0 || margin > 1) throw new UsageError('--margin is a fraction of a row\'s calls, 0.25 = a quarter (more than three of twelve is a drop)');
  const base = readJson(flags.base), branch = readJson(flags.branch);
  const { rows, accept, reason, leftOut } = compareResults(base, branch, margin);
  log(`compare — base ${path.basename(flags.base)} (${base.label || ''}) vs branch ${path.basename(flags.branch)} (${branch.label || ''}${branch.branch_id ? ', ' + branch.branch_id : ''})\n`);
  const personasOf = names => [...new Set(names.map(n => (n.match(/ · ([a-z]+)$/) || [])[1]).filter(Boolean))];
  if (leftOut.branch.length) log(`  ${leftOut.branch.length} test(s) only on the branch left out of the verdict${personasOf(leftOut.branch).length ? ` — the ${personasOf(leftOut.branch).join(', ')} driver(s), not in the baseline; the next baseline will have them` : ''}`);
  if (leftOut.base.length) log(`  ${leftOut.base.length} test(s) only in the baseline left out of the verdict`);
  log(table(rows, [
    { key: 'name', label: 'situation / row (every driver type and repeat together)', width: 52 },
    { get: r => pct(r.base), label: 'base', width: 5, right: true },
    { get: r => pct(r.branch), label: 'branch', width: 6, right: true },
    { key: 'calls', label: 'calls', width: 7, right: true },
    { get: r => (r.delta == null ? 'n/a' : signed(r.delta * 100)), label: 'delta', width: 5, right: true },
    { get: r => (r.dropped ? '✗ dropped' : r.improved ? '✓ improved' : ''), label: '', width: 10 },
    { key: 'why', label: 'why (branch, first failure)', width: 60 },
  ]));
  const sa = speedOf(base.tests), sb = speedOf(branch.tests), ca = costOf(base.tests), cb = costOf(branch.tests);
  const secs = sp => (sp && sp.source === 'metrics' ? sp.answer_s : sp && sp.source === 'timestamps' ? sp.gap_s : null);
  if (secs(sa) != null && secs(sb) != null) {
    log(`\nspeed — Otto's ${sa.source === 'metrics' && sb.source === 'metrics' ? 'first sentence' : 'answer'} after ${secs(sb)} s on the branch, ${secs(sa)} s on the base (medians)${ca && cb ? ` · cost — $${cb.per_call_usd} per call on the branch, $${ca.per_call_usd} on the base` : ''}`);
  }
  log(`\n${accept ? 'ACCEPT' : 'REJECT'} — ${reason}${accept ? `\nnext: node loop.mjs promote --branch ${branch.branch_id || '<branch id>'}` : ''}`);
  return accept ? 0 : 1;
}

/* ---------- promote ---------- */

/* The version note comes from the branch itself — GET
 * /v1/convai/agents/{id}/branches/{branch_id} answers with the
 * description `branch` gave it (checked against the reference; the
 * merge endpoint takes no note of its own, only target_branch_id,
 * archive_source_branch and force). That is the whole point: the note
 * describes the prompt change, so it stays inside ElevenLabs instead of
 * riding to a runner in a proposal file — and it is printed only when
 * this is not a run whose log is published. */
async function promote(ctx, flags) {
  const { log } = ctx;
  if (!flags.branch) throw new UsageError('--branch ID is required (created_branch_id from "branch")');
  if (flags.proposal) throw new UsageError('--proposal is gone: promote reads the version note from the branch itself (its description), so no file carrying the prompt has to travel; pass --branch ID alone');
  const { api, agentId } = needEleven(ctx);
  const source = await resolveBranch(api, agentId, flags.branch, log);
  const agent = await api.getAgent(agentId);
  const target = flags.target || (agent ? agent.main_branch_id : '<main_branch_id from GET agent>');
  if (agent && !target) throw new Error(`GET agent ${agentId} returned no main_branch_id — pass --target BRANCH_ID`);
  const branchInfo = await api.getBranch(agentId, source);
  const note = branchInfo ? String(branchInfo.description || '').trim() : '';
  const res = await api.mergeBranch(agentId, source, target, { force: !!flags.force });
  if (res === null) return 0;
  log(`merged ${source} into ${target}${flags.force ? ' (forced)' : ''}; the source branch is archived.`);
  log(ctx.quiet
    ? '      the branch\'s version note is not shown (--quiet): it says what the prompt changed, and it stays in ElevenLabs'
    : `      version note, from the branch: ${note || '—'}`);
  log('next: node loop.mjs run --label main     # the new baseline\n' +
    '      node loop.mjs publish\n' +
    '      the prompt itself stays in ElevenLabs — agent_configs/ is gitignored, and this repository is public');
  return 0;
}

/* ---------- publish ---------- */

/* The row the dashboard reads — the contract between this file and
 * dashboard.html, so it changes together with both. `tests` is the
 * results file's per-test rows cut down to what a scenario card shows:
 * which test, which scenario and persona, runs and passes, the first
 * failure's one-line why and that run whole (failureOf). `summary` is
 * the run in five numbers, and the same per scenario keyed by the
 * sheet's #, so a card finds its own without scanning the tests. A test
 * that knows no scenario (a regression cut from a debrief the join
 * could not place) counts in the totals and under no scenario. Fields
 * the results file has as '' (metaByName's empties) go as null: the row
 * is JSON for a reader that asks "is there one", not "is it empty". */
export function agentRunRow(results, { runUrl = null, verdict = null, reason = null } = {}) {
  const text = x => (x == null || String(x).trim() === '' ? null : String(x));
  const numOf = x => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
  const rate = (passed, runs) => (runs ? passed / runs : 0);
  const tests = ((results && results.tests) || []).map(t => {
    const runs = t.runs || 0, passed = t.passed || 0;
    const name = String(t.name || t.test_id || '');
    return {
      name,
      test_id: text(t.test_id),
      /* a results file from before `kind` rode along: the regressions
       * and the situations are the tests named that way */
      kind: ['regression', 'scenario', 'situation'].includes(t.kind) ? t.kind
        : /^Otto · regression · /.test(name) ? 'regression'
          : /^Otto · situation /.test(name) ? 'situation' : 'scenario',
      scenario_num: numOf(t.scenario_num),
      scenario_title: text(t.scenario_title),
      situation_num: numOf(t.situation_num),
      situation_title: text(t.situation_title),
      persona: text(t.persona),
      language: t.language === 'it' || t.language === 'en' ? t.language : null,
      runs, passed, pass_rate: rate(passed, runs),
      /* an older results file has the rationales but no `why` */
      why: passed < runs ? text(oneLine(t.why != null ? t.why : (t.rationales || [])[0])) : null,
      failure: passed < runs && t.failure ? t.failure : null,
      /* a passed run with words in it, the shortest — what a good call
       * looked like, from Otto's own mouth; null from an older results
       * file, or when no passed run had a transcript */
      success: passed > 0 && t.success ? t.success : null,
      /* the judge's word per check over this test's runs; null from a
       * results file whose conditions did not ask for one */
      checks: t.checks && Object.keys(t.checks).length ? t.checks : null,
      /* how fast Otto answered in this test's calls and what they cost
       * in model tokens; null from a results file that kept neither */
      speed: (() => { const sp = speedOf([t]); return sp ? { answer_s: sp.answer_s, gap_s: sp.gap_s, call_s: sp.call_s, turns: sp.turns, source: sp.source } : null; })(),
      cost: (() => { const co = costOf([t]); return co ? { per_call_usd: co.per_call_usd, calls: co.calls } : null; })(),
    };
  });
  const src = (results && results.tests) || [];
  const speed = speedOf(src), cost = costOf(src);
  const distinct = k => [...new Set(src.map(t => t[k]).filter(Boolean))];
  const models = { otto: modelsOf(src), driver: distinct('driver_model'), judge: distinct('judge_model') };
  const settings = results && results.settings && typeof results.settings === 'object'
    ? { model: text(results.settings.model), reasoning: text(results.settings.reasoning), thinking_budget: numOf(results.settings.thinking_budget), temperature: numOf(results.settings.temperature) }
    : null;
  /* the same, over the whole suite: "check 3 failed in 120 of 240 calls" */
  const byCheck = {};
  for (const t of tests) for (const [n, c] of Object.entries(t.checks || {})) {
    const o = byCheck[n] || (byCheck[n] = { pass: 0, fail: 0 });
    o.pass += c.pass || 0; o.fail += c.fail || 0;
  }
  const tally = list => {
    const runs = list.reduce((n, t) => n + t.runs, 0), passed = list.reduce((n, t) => n + t.passed, 0);
    return { tests: list.length, runs, passed, pass_rate: rate(passed, runs) };
  };
  const perScenario = new Map();
  for (const t of tests) if (t.scenario_num != null) perScenario.set(t.scenario_num, [...(perScenario.get(t.scenario_num) || []), t]);
  const perSituation = new Map();
  for (const t of tests) if (t.situation_num != null) perSituation.set(t.situation_num, [...(perSituation.get(t.situation_num) || []), t]);
  const all = tally(tests);
  const byNum = m => Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([num, list]) => [String(num), tally(list)]));
  return {
    agent_id: results.agent_id,
    label: text(results.label),
    branch_id: text(results.branch_id),
    /* the version every run of the suite carries — the same on every
     * test of one invocation, so the first that has one */
    version_id: text((results.tests || []).map(t => t.version_id).find(Boolean)),
    invocation_id: text(results.invocation_id),
    repeat: numOf(results.repeat),
    run_url: text(runUrl),
    verdict: verdict || null,
    verdict_reason: text(reason),
    /* Always null, and the column stays for the rows that carry one
     * from before. A branch's note says what its prompt changed, which
     * is the prompt by implication — and this table is world-readable
     * with the anon key. The note lives on the ElevenLabs branch
     * (promote reads it back from there) and travels no further. */
    note: null,
    tests,
    summary: {
      tests: all.tests,
      tests_at_100: tests.filter(t => t.runs && t.passed === t.runs).length,
      runs: all.runs, passed: all.passed, pass_rate: all.pass_rate,
      by_scenario: byNum(perScenario),
      by_situation: byNum(perSituation),
      ...(Object.keys(byCheck).length ? { by_check: byCheck } : {}),
      /* the model trial's three numbers, on every run from here on:
       * which model Otto was set to (settings), how fast he answered
       * (speed), what the calls cost in tokens (cost), and which models
       * ElevenLabs says answered, played the driver and judged (models) */
      ...(settings ? { settings } : {}),
      ...(speed ? { speed } : {}),
      ...(cost ? { cost } : {}),
      ...(models.otto.length || models.driver.length || models.judge.length ? { models } : {}),
    },
    ran_at: results.at || new Date().toISOString(),
  };
}

/* what PostgREST said, readable: its error body is JSON with a
 * `message` (and a `hint` — "Perhaps you meant the table 'public.runs'"),
 * which is the line worth putting in a job summary; the raw body is
 * the fallback */
function postgrestSaid(e) {
  const m = String(e.message || '');
  const i = m.indexOf('{');
  if (i >= 0) {
    try {
      const j = JSON.parse(m.slice(i));
      const what = j.message || j.hint || (j.detail && (j.detail.message || j.detail));
      if (what) return m.slice(0, i) + String(what);
    } catch { /* not whole JSON — the raw body then */ }
  }
  return m.slice(0, 160);
}

async function publish(ctx, flags) {
  const { log } = ctx;
  const resultsFile = flags.results || latest(ctx.p.results, /^(?!score-).*\.json$/);
  if (!resultsFile) throw new UsageError('nothing to publish — run "run" first (results/), or pass --results FILE');
  const results = readJson(resultsFile);
  if (!results || !Array.isArray(results.tests)) throw new UsageError(`${resultsFile} is not a results file (no tests list)`);
  if (!results.agent_id) throw new UsageError(`${resultsFile} carries no agent_id — the table wants to know which agent the suite ran against`);
  /* compare's word, either case — the workflow hands it over as printed */
  let verdict = null;
  if (flags.verdict != null && String(flags.verdict).trim() !== '') {
    verdict = String(flags.verdict).trim().toLowerCase();
    if (verdict !== 'accept' && verdict !== 'reject') throw new UsageError(`--verdict is accept or reject (the word compare printed), not "${flags.verdict}"`);
  }
  /* --note is gone on purpose: it carried the proposal's one-line
   * summary of what the branch's prompt changed into a table anyone can
   * read with the anon key. Naming the flag beats ignoring it — the
   * runbook and old scripts still have it in their fingers. */
  if (flags.note != null) throw new UsageError('--note is gone: what a branch changed says what the prompt says, and agent_runs is world-readable (open pilot policies). The note stays on the ElevenLabs branch as its description, where "promote" reads it back; publish the verdict and the reason instead');
  const row = agentRunRow(results, { runUrl: flags.runUrl, verdict, reason: flags.reason });
  const db = needDb(ctx);
  log(`publish — ${path.basename(resultsFile)}: ${row.summary.passed}/${row.summary.runs} runs passed across ${row.summary.tests} test(s)${row.verdict ? ', ' + row.verdict.toUpperCase() : ''} -> agent_runs\n${statsLine(results.tests, results.settings)}`);
  let stored;
  try { stored = await db.insert('agent_runs', row); } catch (e) {
    /* PostgREST's "no such table" is a 404 with code PGRST205; a table
     * without the insert policy refuses with 42501. Both mean the
     * schema on that project is behind this build, and the fix is the
     * same file either way. */
    if (e.status === 404 || /PGRST205/.test(e.message)) { log(`the agent_runs table is not there yet (${postgrestSaid(e)}) — re-run supabase/schema.sql in the Supabase SQL editor, then publish again; the results file is still on disk`); return 1; }
    if (e.status === 401 || e.status === 403 || /42501/.test(e.message)) { log(`the agent_runs table refused the row (${postgrestSaid(e)}) — it lacks the insert policy: re-run supabase/schema.sql, then publish again`); return 1; }
    throw e;
  }
  if (ctx.dryRun) { log('  (dry run) nothing published'); return 0; }
  const id = stored[0] && stored[0].id;
  if (!id) { log('agent_runs stored nothing — the insert matched no policy (re-run supabase/schema.sql)'); return 1; }
  const rows = [
    `${Object.keys(row.summary.by_scenario).length} scenario(s)`,
    `${Object.keys(row.summary.by_situation).length} situation(s)`,
  ].join(', ');
  log(`published agent_runs ${id} (${rows}, ${row.label || 'no label'}${row.run_url ? ', ' + row.run_url : ''}) — dashboard.html shows it per row`);
  return 0;
}

/* ---------- the command line ---------- */

const COMMANDS = { configure, 'push-tests': pushTests, run, pull, score, cut, propose, branch, 'model-branch': modelBranch, compare, promote, publish };
const BOOLEAN_FLAGS = new Set(['dry-run', 'agent', 'no-stamp', 'force', 'help', 'no-mock-tools', 'quiet']);

export function parseArgs(argv) {
  const out = { cmd: null, flags: {}, rest: [] };
  const camel = k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOLEAN_FLAGS.has(k)) out.flags[camel(k)] = true;
      else if (eq > 0) out.flags[camel(k)] = a.slice(eq + 1);
      else { out.flags[camel(k)] = argv[i + 1]; i++; }
    } else if (!out.cmd) out.cmd = a;
    else out.rest.push(a);
  }
  return out;
}

const USAGE = `usage: node loop.mjs <command> [--dry-run] [--dir DIR] [flags]

  configure                       evaluation criteria + data collection + overrides (analysis.json) onto the agent
  push-tests [--filter TEXT] [--no-mock-tools]
                                  test_configs/**.json -> ElevenLabs tests, by name; writes tests.lock.json;
                                  the agent's tools are mocked for the suite (a client tool has no phone to answer it)
  run        [--branch ID|NAME] [--repeat N=3] [--filter TEXT] [--rows 6,8,10] [--label TEXT]   (a branch by its agtbrch_ id or its ElevenLabs name; --rows: only those situation rows)
  pull       [--since ISO | --days N=14] [--no-stamp]
  score      [--results FILE] [--field FILE]
  cut        [--field FILE]
  propose    [--results FILE] [--field FILE] [--prompt FILE | --agent] [--quiet]
  branch     --proposal FILE [--name TEXT]
  model-branch --model NAME [--reasoning keep|off|minimal|low|medium|high|xhigh|max] [--name TEXT] [--out FILE]
                                  a branch from the live version with only the language model (and its reasoning) changed
  compare    --base FILE --branch FILE [--margin 0.25]   (by situation: a drop is more than a quarter of its calls lost)
  promote    --branch ID|NAME [--target BRANCH_ID] [--force] [--quiet]
  publish    [--results FILE] [--run-url URL] [--verdict accept|reject] [--reason TEXT]

--quiet keeps the prompt, its diff and a branch's version note off stdout — for a run whose log is
        published (the buttons pass it). Counts, ids, pass rates and the simulated transcripts still print.

env: ELEVENLABS_API_KEY (secret) ELEVENLABS_AGENT_ID OPENAI_API_KEY (secret) LOOP_MODEL=gpt-4o
     SUPABASE_URL / SUPABASE_ANON_KEY (default: the kit's project; pull reads it, publish writes it) LOOP_DIR (same as --dir)
     LOOP_POLL_MS=5000 (how often run polls the invocation) LOOP_TIMEOUT_MS=1200000 (when run gives up on it: 20 min)`;

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const { cmd, flags } = parseArgs(argv);
  if (!cmd || flags.help || !COMMANDS[cmd]) {
    log(USAGE);
    if (cmd && !COMMANDS[cmd]) { log(`\nunknown command "${cmd}"`); return 1; }
    /* asked for the usage: fine; called with nothing: a usage error */
    return flags.help ? 0 : 1;
  }
  const ctx = context(flags, env, log);
  if (ctx.dryRun) log('DRY RUN — every request below is printed, none is sent');
  try {
    const code = await COMMANDS[cmd](ctx, flags);
    return code || 0;
  } catch (e) {
    log(e instanceof UsageError ? e.message : `${cmd} failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; });
}
