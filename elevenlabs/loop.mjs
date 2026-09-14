#!/usr/bin/env node
/*
 * The tuning loop for the AGENT — Otto's prompt — the way the dashboard
 * and scripts/tune_triggers.py already run one for the trigger knobs.
 *
 * The trigger loop has recorded runs to replay; the agent loop has two
 * things instead: a suite of ElevenLabs simulation tests cut from the
 * sheet (generate-tests.mjs — a simulated tester per scenario row and
 * persona, the SAME dynamic variables a phone sends), and the real
 * conversations the agent had in the field, joined to the grade the
 * designer gave each one on the dashboard. Both are scored, a model is
 * asked for the smallest prompt edit the evidence supports, the edit
 * goes on an agent BRANCH, the suite runs there, and a human merges —
 * nothing here changes the live agent's prompt on its own.
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
 *   branch       that diff on an agent branch
 *   compare      base results vs branch results -> ACCEPT / REJECT
 *   promote      merge the branch into main
 *
 *   node loop.mjs <command> [--dry-run] [--dir DIR] [flags]
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
import { supabase, agentMessages, scenarioRows, DEFAULT_URL, DEFAULT_KEY } from './lib/supabase.mjs';
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
  const http = makeHttp({
    dryRun, log,
    secrets: [env.ELEVENLABS_API_KEY, env.OPENAI_API_KEY],
    retryDelayMs: Number(env.LOOP_RETRY_MS) || 1500,
  });
  return {
    dir, dryRun, env, log, http,
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

async function pushTests(ctx) {
  const { log } = ctx;
  const configs = listConfigs(ctx.p.configs, log);
  if (!configs.length) { log(`no test files under ${ctx.p.configs} — run "npm run generate" first (regressions come from "cut")`); return 1; }
  const lock = readLock(ctx);
  const { api } = needEleven(ctx);
  const rows = [];
  let byName = null;
  for (const { file, body } of configs) {
    const { _otto, ...req } = body;
    const name = req.name;
    let id = lock[name] || null;
    let action = '';
    if (id) {
      try { await api.updateTest(id, req); action = 'updated'; } catch (e) {
        if (e.status !== 404) throw e;
        /* deleted in the workspace since the lock was written */
        id = null;
      }
    }
    if (!id) {
      /* one search for everything named like ours, matched exactly —
       * the lock may be missing (fresh clone) while the tests exist */
      if (!byName) byName = await findByName(api, 'Otto · ');
      const existing = byName.get(name);
      if (existing) { id = existing; await api.updateTest(id, req); action = 'updated (found by name)'; }
      else { const res = await api.createTest(req); id = res ? res.id : null; action = 'created'; }
    }
    if (id) lock[name] = id;
    rows.push({ name, action: ctx.dryRun ? 'would be ' + action : action, id: id || '—', file: path.relative(ctx.dir, file) });
  }
  const stale = Object.keys(lock).filter(n => !configs.some(c => c.body.name === n));
  if (!ctx.dryRun) writeJson(ctx.p.lock, sortKeys(lock));
  log(table(rows, [
    { key: 'name', label: 'test', width: 48 }, { key: 'action', label: 'action', width: 24 },
    { key: 'id', label: 'id', width: 28 }, { key: 'file', label: 'file', width: 60 },
  ]));
  log(`\n${rows.length} test(s) ${ctx.dryRun ? 'would be' : ''} pushed; ${ctx.dryRun ? 'tests.lock.json untouched (dry run)' : 'tests.lock.json written'}` +
    (stale.length ? `; ${stale.length} lock entr${stale.length === 1 ? 'y' : 'ies'} without a file kept (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''})` : ''));
  return 0;
}

/* ---------- run ---------- */

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

/* one row per test: how many runs, how many passed, why the rest failed */
export function aggregate(inv, { idToName = {}, meta = {} } = {}) {
  const byTest = new Map();
  for (const r of (inv && inv.test_runs) || []) {
    const name = idToName[r.test_id] || r.test_name || (r.metadata && r.metadata.test_name) || r.test_id;
    if (!byTest.has(r.test_id)) {
      byTest.set(r.test_id, { name, test_id: r.test_id, runs: 0, passed: 0, pending: 0, pass_rate: 0, rationales: [], branch_id: r.branch_id || null, version_id: r.version_id || null, ...(meta[name] || {}) });
    }
    const t = byTest.get(r.test_id);
    t.runs++;
    if (r.status === 'passed') t.passed++;
    else if (r.status === 'pending') t.pending++;
    else {
      const cr = r.condition_result || {};
      const why = (cr.rationale && (cr.rationale.summary || (cr.rationale.messages || []).join(' '))) || 'no rationale returned';
      if (!t.rationales.includes(why)) t.rationales.push(why);
    }
    if (!t.branch_id && r.branch_id) t.branch_id = r.branch_id;
    if (!t.version_id && r.version_id) t.version_id = r.version_id;
  }
  const tests = [...byTest.values()];
  tests.forEach(t => { t.pass_rate = t.runs ? t.passed / t.runs : 0; });
  return tests.sort((a, b) => a.pass_rate - b.pass_rate || a.name.localeCompare(b.name));
}

/* the _otto block of every test file, by test name — so a results row
 * knows its scenario and persona without another lookup */
function metaByName(ctx) {
  const meta = {};
  for (const { body } of listConfigs(ctx.p.configs, () => {})) {
    const o = body._otto || {};
    meta[body.name] = { scenario_num: o.scenario_num == null ? null : o.scenario_num, scenario_title: o.scenario_title || '', persona: o.persona || '', kind: o.kind || '', language: o.language || '' };
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
  const entries = Object.entries(lock).filter(([name]) => !filter || name.toLowerCase().includes(filter));
  if (!entries.length) {
    log(Object.keys(lock).length ? `no test in tests.lock.json matches --filter "${flags.filter}"` : 'tests.lock.json is empty — run push-tests first');
    return 1;
  }
  const { api, agentId } = needEleven(ctx);
  const body = { tests: entries.map(([, id]) => ({ test_id: id })) };
  if (repeat > 1) body.repeat_count = repeat;
  if (flags.branch) body.branch_id = flags.branch;
  log(`run — ${entries.length} test(s) × ${repeat} on ${flags.branch ? 'branch ' + flags.branch : 'main'}`);
  let started;
  try { started = await api.runTests(agentId, body); } catch (e) {
    /* the wrapper does not retry this POST — a 5xx from a gateway can
     * come back after the suite was accepted, and a second POST would
     * start and bill a second one — so the person decides */
    throw new Error(`${e.message} — not retried: a second run-tests would start (and bill) a second suite. If ElevenLabs did accept this one, it is on the agent's tests page and the reply above may name its id: poll GET /v1/convai/test-invocations/<id> instead of running again`);
  }
  if (!started) { log('  (dry run) would poll GET /v1/convai/test-invocations/<id> until no run is pending, then write results/<stamp>-<label>.json'); return 0; }
  const inv = await pollInvocation(api, started.id, ctx);
  const idToName = Object.fromEntries(entries.map(([n, id]) => [id, n]));
  const tests = aggregate(inv, { idToName, meta: metaByName(ctx) });
  const label = slugLabel(flags.label || (flags.branch ? 'branch' : 'main'));
  const file = path.join(ctx.p.results, `${stamp()}-${label}.json`);
  writeJson(file, {
    at: new Date().toISOString(), agent_id: agentId, invocation_id: started.id,
    branch_id: flags.branch || null, label, repeat, tests,
  });
  printResults(log, tests);
  const passed = tests.reduce((s, t) => s + t.passed, 0), runs = tests.reduce((s, t) => s + t.runs, 0);
  log(`\n${passed}/${runs} runs passed across ${tests.length} test(s) — ${tests.filter(t => t.pass_rate < 1).length} with a failure\nwrote ${file}`);
  return 0;
}

/* ---------- pull ---------- */

const iso = unix => (unix ? new Date(unix * 1000).toISOString() : null);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

/* the conversation as the field file keeps it: what the agent said and
 * heard, what ElevenLabs concluded, what the phone sent it */
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
    transcript: ((d && d.transcript) || []).filter(t => t && t.message).map(t => ({ role: t.role, message: t.message, t: t.time_in_call_secs ?? null })),
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
  if (ctx.dryRun) { log('  (dry run) nothing written'); return 0; }
  const file = path.join(ctx.p.field, `${stamp()}.json`);
  writeJson(file, { at: new Date().toISOString(), agent_id: agentId, since: since.toISOString(), counts, conversations: convs });
  log(`wrote ${file}`);
  return 0;
}

/* ---------- score ---------- */

const scenarioKey = (num, title) => (num != null && num !== '' ? `#${num}` : (title ? String(title).slice(0, 40) : '(no scenario)'));

export function scoreData(results, field) {
  const rows = new Map();
  const row = (num, title) => {
    const k = scenarioKey(num, title);
    if (!rows.has(k)) rows.set(k, { key: k, num: num ?? null, title: title || '', tests: 0, runs: 0, passed: 0, conversations: 0, graded: 0, good: 0, bad: 0, checks: {}, reasons: new Map() });
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
    const r = row(t.scenario_num, t.scenario_title);
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
    { key: 'key', label: 'scenario', width: 6 }, { key: 'title', label: '', width: 34 },
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
    body._otto = {
      scenario_num: c.scenario && c.scenario.num != null ? c.scenario.num : null,
      scenario_title: (c.scenario && c.scenario.title) || '',
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
  'edit, return the prompt unchanged and say so in the note.';

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
  const out = await ai.json({ model, system: PROPOSE_SYSTEM, user: JSON.stringify({ current_prompt: base, ...fit.evidence }), maxTokens });
  if (!out) return 0;
  const next = String(out.prompt || '').trim();
  const note = String(out.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const rationale = String(out.rationale || '').trim();
  const refuse = why => { log(`refused: ${why}\n  note: ${note || '—'}\n  rationale: ${rationale || '—'}`); return 1; };
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
  log(`\nnote: ${note}\nrationale: ${rationale}\n\n${diff}\n\nwrote ${file}\nnext: node loop.mjs branch --proposal ${file}`);
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
    description: p.note || 'prompt proposal from the agent loop',
    conversation_config: { agent: { prompt: { prompt: p.prompt } } },
  };
  const res = await api.createBranch(agentId, body);
  if (!res) return 0;
  log(`branch "${name}" created: ${res.created_branch_id} (version ${res.created_version_id}, from ${parent})`);
  writeJson(flags.proposal, { ...p, branch: { branch_id: res.created_branch_id, version_id: res.created_version_id, parent_version_id: parent, name, at: new Date().toISOString() } });
  log(`next: node loop.mjs run --branch ${res.created_branch_id} --label branch\n      node loop.mjs compare --base results/<main>.json --branch results/<branch>.json`);
  return 0;
}

/* ---------- compare ---------- */

export function compareResults(base, branch, margin = 0.1) {
  const a = new Map((base.tests || []).map(t => [t.name, t]));
  const b = new Map((branch.tests || []).map(t => [t.name, t]));
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows = names.map(name => {
    const x = a.get(name), y = b.get(name);
    const delta = x && y ? y.pass_rate - x.pass_rate : null;
    return {
      name, base: x ? x.pass_rate : null, branch: y ? y.pass_rate : null, delta,
      dropped: delta != null && delta < -margin - 1e-9,
      improved: delta != null && x.pass_rate < 1 - 1e-9 && delta > 1e-9,
      why: y && y.rationales && y.rationales[0] ? y.rationales[0] : '',
    };
  });
  const drops = rows.filter(r => r.dropped), improved = rows.filter(r => r.improved);
  const wasFailing = rows.filter(r => r.base != null && r.base < 1 - 1e-9);
  const accept = !drops.length && improved.length > 0;
  const reason = drops.length ? `${drops.length} test(s) dropped by more than ${Math.round(margin * 100)} points`
    : !wasFailing.length ? 'nothing was failing on the base run, so there is nothing for the branch to improve'
      : !improved.length ? 'no previously failing test improved'
        : `${improved.length} previously failing test(s) improved and none dropped by more than ${Math.round(margin * 100)} points`;
  return { rows, accept, reason, drops: drops.length, improved: improved.length };
}

async function compare(ctx, flags) {
  const { log } = ctx;
  if (!flags.base || !flags.branch) throw new UsageError('--base FILE and --branch FILE are both required (two results/ files)');
  const margin = flags.margin != null ? Number(flags.margin) : 0.1;
  if (Number.isNaN(margin) || margin < 0 || margin > 1) throw new UsageError('--margin is a fraction, 0.1 = ten points');
  const base = readJson(flags.base), branch = readJson(flags.branch);
  const { rows, accept, reason } = compareResults(base, branch, margin);
  log(`compare — base ${path.basename(flags.base)} (${base.label || ''}) vs branch ${path.basename(flags.branch)} (${branch.label || ''}${branch.branch_id ? ', ' + branch.branch_id : ''})\n`);
  log(table(rows, [
    { key: 'name', label: 'test', width: 52 },
    { get: r => pct(r.base), label: 'base', width: 5, right: true },
    { get: r => pct(r.branch), label: 'branch', width: 6, right: true },
    { get: r => (r.delta == null ? 'n/a' : signed(r.delta * 100)), label: 'delta', width: 5, right: true },
    { get: r => (r.dropped ? '✗ dropped' : r.improved ? '✓ improved' : ''), label: '', width: 10 },
    { key: 'why', label: 'why (branch, first failure)', width: 60 },
  ]));
  log(`\n${accept ? 'ACCEPT' : 'REJECT'} — ${reason}${accept ? `\nnext: node loop.mjs promote --branch ${branch.branch_id || '<branch id>'}` : ''}`);
  return accept ? 0 : 1;
}

/* ---------- promote ---------- */

async function promote(ctx, flags) {
  const { log } = ctx;
  if (!flags.branch) throw new UsageError('--branch ID is required (created_branch_id from "branch")');
  const { api, agentId } = needEleven(ctx);
  const agent = await api.getAgent(agentId);
  const target = flags.target || (agent ? agent.main_branch_id : '<main_branch_id from GET agent>');
  if (agent && !target) throw new Error(`GET agent ${agentId} returned no main_branch_id — pass --target BRANCH_ID`);
  const note = flags.proposal && existsSync(flags.proposal) ? (readJson(flags.proposal).note || '') : '';
  const res = await api.mergeBranch(agentId, flags.branch, target, { force: !!flags.force });
  if (res === null) return 0;
  log(`merged ${flags.branch} into ${target}${flags.force ? ' (forced)' : ''}; the source branch is archived.`);
  log('next: pull the agent config into git and commit it with the note as the version description —\n' +
    `      elevenlabs agents pull --agent ${agentId}\n` +
    `      git add agent_configs && git commit -m ${JSON.stringify(note || 'Otto prompt: <the note from the proposal>')}\n` +
    '      node loop.mjs run --label main     # the new baseline');
  return 0;
}

/* ---------- the command line ---------- */

const COMMANDS = { configure, 'push-tests': pushTests, run, pull, score, cut, propose, branch, compare, promote };
const BOOLEAN_FLAGS = new Set(['dry-run', 'agent', 'no-stamp', 'force', 'help']);

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
  push-tests                      test_configs/**.json -> ElevenLabs tests, by name; writes tests.lock.json
  run        [--branch ID] [--repeat N=3] [--filter TEXT] [--label TEXT]
  pull       [--since ISO | --days N=14] [--no-stamp]
  score      [--results FILE] [--field FILE]
  cut        [--field FILE]
  propose    [--results FILE] [--field FILE] [--prompt FILE | --agent]
  branch     --proposal FILE [--name TEXT]
  compare    --base FILE --branch FILE [--margin 0.1]
  promote    --branch ID [--target BRANCH_ID] [--proposal FILE] [--force]

env: ELEVENLABS_API_KEY (secret) ELEVENLABS_AGENT_ID OPENAI_API_KEY (secret) LOOP_MODEL=gpt-4o
     SUPABASE_URL / SUPABASE_ANON_KEY (default: the kit's project) LOOP_DIR (same as --dir)
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
