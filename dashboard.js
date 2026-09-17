'use strict';

/* ============================================================
 * Trigger-scenarios dashboard — the test designer's surface.
 *
 * One row here is one row of the "Otto triggers" sheet: what
 * should trigger, what Otto should ask, what he should learn,
 * how to test it. The dashboard adds the one thing the sheet
 * cannot hold: a clear Google-Maps address per scenario, pinned
 * as a destination so the tester's phone app shows exactly where
 * to go. The messages Otto files against that destination are
 * "what Otto understood" — shown next to the definition, with a
 * PASS / PARTIAL / FAIL verdict per scenario.
 *
 * Same storage philosophy as the app: Supabase when configured,
 * localStorage otherwise (then both pages share one browser and
 * keep each other fresh through the storage event).
 * ============================================================ */

const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- state ---------- */
const LS_DEST = 'od_destinations';
const LS_MSGS = 'od_messages';
const LS_SCEN = 'od_scenarios';
const LS_RUNS = 'od_runs';
const LS_SITU = 'od_situations';

let scenarios = [];
let destinations = [];
let messagesByDest = {};
let runsByScenario = {};
/* The agent suite's published runs (agent_runs), newest first — the
 * simulated testers' half of the evidence, shown on each card next to
 * the field debriefs. Live mode only: the loop publishes them from
 * GitHub Actions into the shared backend, so a keyless dashboard has
 * nothing to read. A missing table (schema.sql behind this build) and
 * a read that failed are remembered apart, so every card can say
 * which. */
let agentRuns = [];
let agentRunsMissing = false;
let agentRunsError = '';
/* the designer's NOT A PROBLEM list (RUNS tab): rows {key, title,
 * note, decided_at}, newest first — kept in memory for the session
 * when the backend has no table for it yet */
let accepted = [];
let acceptedMissing = false;
let acceptedOpen = false;  // the list unfolds right after a mark, so the entry and its UNDO are in view
let expandedId = null;

/* ---------- the situations ----------
 * The pilot's other sheet, in its own list tab: what a driver REPORTS
 * when they press the big button, and what a follow-up that fits THAT
 * asks about. No pin, no rule, no sliders — a situation is acted out
 * in a conversation, so the only results it has are the agent suite's.
 * One open card is one editor: every field is edited in place against
 * a draft (sitEdit), saved or cancelled like a debrief's reword. */
let situations = [];
let situationsMissing = false;  // the table is not in the database yet
let expandedSitId = null;
let sitEdit = null;             // { id, ...form values } — the open card's unsaved edits

/* in-flight UI state for the tuning loop — all per one scenario at a time */
let tune = null;         // { id, params } — slider values not yet saved as a version
let fbRec = null;        // { id, text, via, state } — the open feedback recorder
let proposal = null;     // { id, changes, params, note, demo, fb_ids, none } — a proposed next version
let proposalBusy = null; // scenario id while the revision round-trip runs
let msgEdit = null;      // { destId, i, title, transcript } — a debrief being reworded
/* Grades in progress — { gradeKey(row): { checks, note } }, one per
 * agent debrief being judged. A map, not one slot: two debriefs
 * half-graded side by side must not cost each other their typed note.
 * Keyed by the ROW, not its position like msgEdit: a refresh that lands
 * a newer debrief on the same pin, or a delete above it, moves the row
 * down a slot and the half-typed grade must move with it — saved by
 * slot it would go onto the wrong conversation, which is exactly the
 * ground truth the agent loop must not be fed. Cleared by save, cancel,
 * the row's own delete, and a reload that no longer carries the row. */
let msgGrades = {};
const gradeBusy = () => Object.keys(msgGrades).length > 0;

const destById = id => destinations.find(d => d.id === id) || null;
const localId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const warn = e => console.warn('dashboard:', e && e.message ? e.message : e);
/* A write failing against a live backend usually means the scenarios
 * table predates the tuning-loop columns — say so where it is seen. */
/* A hint held until the next render has drawn, because the render that
 * usually follows a failed save repaints #stats and would wipe it. */
let schemaMsg = '';
const schemaHint = e => {
  warn(e);
  if (!Backend.enabled) return;
  const msg = String((e && e.message) || '');
  if (/situations/i.test(msg) || /PGRST205|42P01|schema cache/i.test(msg)) {
    schemaMsg = 'That row could not be saved — the backend has no situations table yet. Re-run supabase/schema.sql once, then ↻ REFRESH. Until then rows stay in this browser only.';
  } else if (/column|schema|400/i.test(msg)) {
    schemaMsg = 'Save failed — a table is missing newer columns. Re-run supabase/schema.sql, then ↻ REFRESH.';
  } else { return; }
  el('stats').textContent = schemaMsg;
};
/* Auto-refresh must not repaint over a drag, a recording, or an open
 * proposal — those live only in the DOM until saved. Same for the
 * pre-arrival notes: a consignee mid-edit or a note typed but not yet
 * added lives only in its input. */
const notesEditing = () => {
  const a = document.activeElement;
  if (a && a.closest && a.closest('.notes-block')) return true;
  return [...document.querySelectorAll('[data-note-new]')].some(i => i.value.trim());
};
/* In the DEMO view none of that workshop state is on screen — a repaint
 * can disrupt nothing, and a client demo WANTS the fresh debrief landing
 * live. The state itself is kept (it lives JS-side), so flipping back to
 * TESTING restores drags, drafts and proposals exactly as left. */
const uiBusy = () => !!proposalBusy
  /* a run summary being read is as good as an open editor: the 30 s
   * poll would rebuild the page and fold every expanded conversation
   * back up under the reader — ↻ REFRESH is there when they are done */
  || (runsTabOn() && !!openRunId)
  || (cardView !== 'demo' && !!(tune || fbRec || proposal || msgEdit || gradeBusy() || sitDirty()))
  || !el('form-sheet').hidden || !el('stop-sheet').hidden || notesEditing();

const persistLocal = () => {
  if (Backend.enabled) return;
  try {
    localStorage.setItem(LS_SCEN, JSON.stringify(scenarios));
    localStorage.setItem(LS_DEST, JSON.stringify(destinations));
    localStorage.setItem(LS_SITU, JSON.stringify(situations));
  } catch { /* private mode */ }
};

/* ---------- pre-arrival notes ----------
 * What Otto reads ALOUD on the phone as the driver approaches the pin:
 * the consignee (name + floor) and building notes, saved here by the
 * dispatcher onto the destination row. Notes are newest first — the
 * phone reads from the top. (Driver-left notes need no storage of
 * their own: they are the debriefs already filed against the pin.) */
const dispatchNotesOf = d => {
  let n = d && d.notes;
  if (typeof n === 'string') { try { n = JSON.parse(n); } catch { n = null; } }
  return Array.isArray(n) ? n.filter(x => x && String(x.text || '').trim()) : [];
};

function saveDestPatch(d, patch) {
  Object.assign(d, patch);
  if (Backend.enabled) Backend.updateDestination(d.id, patch).catch(schemaHint);
  persistLocal();
}

function addDestNote(sc, card) {
  const d = sc.destination_id && destById(sc.destination_id);
  const input = card.querySelector('[data-note-new]');
  const text = String((input && input.value) || '').trim();
  if (!d || !text) return;
  const note = { id: localId('n'), text, at: new Date().toISOString(), by: 'dispatch' };
  saveDestPatch(d, { notes: [note, ...dispatchNotesOf(d)] });
  render();
}

function deleteDestNote(sc, idx) {
  const d = sc.destination_id && destById(sc.destination_id);
  if (!d) return;
  const notes = dispatchNotesOf(d);
  if (!(idx >= 0 && idx < notes.length)) return;
  notes.splice(idx, 1);
  saveDestPatch(d, { notes });
  render();
}

/* One tap in the notes block turns the reading ring into a slider —
 * a notes_radius param the phone reads live (notesRadiiOf in app.js),
 * tuned and versioned like every other detector knob from then on. */
async function addNotesRadiusParam(sc) {
  if (paramsOf(sc).some(p => p && p.key === 'notes_radius')) return;
  /* drags staged on the sliders ride along — what is on screen is what
   * gets saved, never silently thrown away */
  const staged = tune && tune.id === sc.id ? tuneDiff(paramsOf(sc), tune.params) : '';
  const base = (tune && tune.id === sc.id ? tune.params : paramsOf(sc)).map(p => ({ ...p }));
  tune = null;
  const params = base.concat([{
    key: 'notes_radius', label: 'Notes read distance', value: 350, min: 50, max: 1000, step: 10, unit: 'm',
  }]);
  await saveNewVersion(sc, { params }, 'Notes read distance made tunable (350 m)' + (staged ? ' · ' + staged : ''));
  render();
}

/* The sheet's long titles ("Parking loops — driver circles the block…")
 * carry the pin: everything before the dash is the short name. */
const shortTitle = sc => String(sc.title || 'Scenario').split(/\s+—\s+|\s+-\s+/)[0].trim().slice(0, 40);
const stripQuotes = s => String(s || '').trim().replace(/^[“”"']+/, '').replace(/[“”"']+$/, '');

/* ---------- tunable values (params) ----------
 * A rule can reference its numbers as {key} placeholders; sc.params
 * carries the live value plus the range a slider offers:
 *   [{ key, label, value, min, max, step, unit }]
 * The phone's trigger detector reads params with its canonical keys
 * (trigOf in app.js), so moving a slider here retunes the next real
 * test run — that is the whole point of the loop. */
const paramsOf = sc => (Array.isArray(sc.params) ? sc.params : []);
const feedbackOf = sc => (Array.isArray(sc.feedback) ? sc.feedback : []);
const historyOf = sc => (Array.isArray(sc.history) ? sc.history : []);
const fmtVal = v => String(Math.abs(+v) >= 100 ? Math.round(+v) : Math.round(+v * 100) / 100);
const fillParams = (text, params) =>
  String(text == null ? '' : text).replace(/\{([a-z][a-z0-9_]*)\}/gi, (m, k) => {
    const p = (params || []).find(x => x && x.key === k);
    return p && isFinite(+p.value) ? fmtVal(p.value) : m;
  });
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
/* 1-2-5 slider step so ranges of any magnitude drag in sane increments */
function niceStep(min, max) {
  const raw = (Math.abs(max - min) || 1) / 60;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * mag;
}
/* Params arrive from the AI, the form, or an imported spec — normalise
 * hard so a bad row can never break a slider (or the phone's detector). */
function cleanParams(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  list.forEach(p => {
    if (!p) return;
    const key = slug(p.key || p.label);
    const value = parseFloat(p.value);
    if (!key || seen.has(key) || !isFinite(value)) return;
    seen.add(key);
    let min = parseFloat(p.min);
    let max = parseFloat(p.max);
    if (!isFinite(min)) min = Math.min(0, value);
    if (!isFinite(max) || max <= min) max = min + Math.max(Math.abs(value - min) * 2, 10);
    const step = isFinite(parseFloat(p.step)) && +p.step > 0 ? +p.step : niceStep(min, max);
    out.push({
      key,
      label: String(p.label || key).slice(0, 60),
      value: Math.min(max, Math.max(min, value)),
      min, max, step,
      unit: String(p.unit || '').slice(0, 8),
    });
  });
  return out;
}
/* Param keys the phone consumes live: the trigger detector's knobs
 * (trigOf in app.js) plus the pre-arrival reading rings
 * (notesRadiiOf — notes_radius / notes_rearm). */
const NOTES_KEYS = ['notes_radius', 'notes_rearm'];
const DETECTOR_KEYS = ['radius', 'exit_radius', 'pass_speed_max', 'pass_still_max_s',
  'passes_needed', 'stop_speed', 'stop_dwell_s', 'still_grace_s', 'stop_radius', 'resume_speed',
  'park_radius_max', 'park_stop_s', 'arrival_radius', 'min_walk_m', ...NOTES_KEYS];

/* ---------- versions ----------
 * Every change to the definition — a tuned slider, an applied feedback
 * proposal, a manual edit — cuts a new version; the old one goes to
 * sc.history in full, so any version can be inspected or restored. The
 * trail IS the record of how the trigger algorithm was arrived at. */
const SNAP_FIELDS = ['title', 'rule', 'ar_states', 'signals', 'timing', 'otto_says', 'learns', 'test_steps'];
const FIELD_LABELS = {
  title: 'Trigger scenario', rule: 'Trigger rule', ar_states: 'AR states', signals: 'Other signals',
  timing: 'Timing to talk', otto_says: 'Otto says', learns: 'Tip type', test_steps: 'How to test it',
};
function versionSnapshot(sc) {
  const fields = {};
  SNAP_FIELDS.forEach(k => { fields[k] = sc[k] == null ? null : sc[k]; });
  return {
    version: sc.version || 1,
    note: sc.version_note || ((sc.version || 1) === 1 ? 'created' : ''),
    at: sc.version_at || sc.created_at || null,
    fields,
    params: paramsOf(sc).map(p => ({ ...p })),
  };
}
async function saveNewVersion(sc, patch, note) {
  const history = historyOf(sc).concat([versionSnapshot(sc)]);
  await patchScenario(sc, {
    ...patch,
    history,
    version: (sc.version || 1) + 1,
    version_note: String(note || '').slice(0, 200),
    version_at: new Date().toISOString(),
  });
}
/* "Pass radius 150→120 m, Stop dwell 45→30 s" — the auto-changelog. */
function tuneDiff(saved, cur) {
  const out = [];
  (cur || []).forEach(p => {
    const s = (saved || []).find(x => x.key === p.key);
    if (s && +s.value !== +p.value) {
      out.push(`${p.label || p.key} ${fmtVal(s.value)}→${fmtVal(p.value)}${p.unit ? ' ' + p.unit : ''}`);
    }
  });
  return out.join(', ');
}

/* ---------- status model ---------- */
function msgsOf(sc) {
  return (sc.destination_id && messagesByDest[sc.destination_id]) || [];
}

/* ---------- debrief editing ----------
 * What Otto filed is not sacred: a mumbled take, a wrong word, a test
 * answer that must not be read to the next driver (or shown to a
 * client) gets reworded or removed right where it is displayed. Rows
 * are addressed by position in the card's own list — local-mode rows
 * may carry no id — and the backend call goes by the row's id. */
const persistMessagesLocal = () => {
  if (Backend.enabled) return;
  try {
    localStorage.setItem(LS_MSGS, JSON.stringify([].concat(...Object.values(messagesByDest))));
  } catch { /* private mode */ }
};
/* A live backend without the messages update/delete policies (a
 * schema.sql behind this build) matches zero rows without erroring —
 * an empty representation is the failure to report. */
const msgPolicyHint = rows => {
  if (!Array.isArray(rows) || rows.length) return;
  el('stats').textContent = 'The change did not reach the messages table — it lacks the update/delete policies. Re-run supabase/schema.sql, then ↻ REFRESH.';
};

function deleteMessage(sc, i) {
  const destId = sc.destination_id;
  const list = (destId && messagesByDest[destId]) || [];
  const m = list[i];
  if (!m) return;
  if (!confirm('Delete this debrief?\n\n' + String(m.title || m.transcript || '').slice(0, 120))) return;
  messagesByDest[destId] = list.filter(x => x !== m);
  msgEdit = null; // positions shifted — an open editor would rewrite the wrong row
  delete msgGrades[gradeKey(m)]; // grades follow their row — only the deleted one goes
  if (Backend.enabled && m.id != null) Backend.deleteMessage(m.id).then(msgPolicyHint).catch(warn);
  persistMessagesLocal();
  render();
  map.refresh(); // the badge and pin colour may drop back to AWAITING TEST
}

function saveMessageEdit() {
  if (!msgEdit) return;
  const list = (msgEdit.destId && messagesByDest[msgEdit.destId]) || [];
  const m = list[msgEdit.i];
  const patch = {
    title: String(msgEdit.title || '').trim() || null,
    transcript: String(msgEdit.transcript || '').trim() || null,
  };
  msgEdit = null;
  /* both fields emptied is a delete in disguise — the × is the honest
   * way to do that, so treat it as a cancel instead */
  if (!m || (!patch.title && !patch.transcript)) { render(); return; }
  Object.assign(m, patch);
  if (Backend.enabled && m.id != null) Backend.updateMessage(m.id, patch).then(msgPolicyHint).catch(warn);
  persistMessagesLocal();
  render();
}

/* ---------- debrief grading ----------
 * The scenario verdict says whether the TRIGGER got it; this says
 * whether the CONVERSATION did — the ground truth the agent's tuning
 * loop (elevenlabs/) scores the prompt against, on the five things a
 * scenario debrief is for. Only agent debriefs get graded: a recorded
 * clip asked nothing. The keys are fixed — the loop reads them by
 * name, and a false on any of them is what a regression test is cut
 * from. Stored on the row as
 *   { checks: {opener, followup, tip, brevity, language: true|false|null},
 *     note, at, agent_version }
 * null = not judged; "graded" = anything judged, or a note left. */
const GRADE_CHECKS = [
  ['opener', 'Opened with the scenario\'s question'],
  ['followup', 'Followed up on what the tester actually found'],
  ['tip', 'Got the tip type the scenario expects'],
  ['brevity', 'Kept it short — a couple of questions, then let them go'],
  ['language', 'Right language throughout'],
];
/* jsonb object from Supabase, plain object from localStorage, string if hand-fed */
const gradeOf = m => {
  let g = m && m.grade;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  return g && typeof g === 'object' ? g : null;
};
const gradeSummary = g => {
  const checks = (g && g.checks) || {};
  const judged = GRADE_CHECKS.filter(([k]) => checks[k] === true || checks[k] === false);
  const failed = GRADE_CHECKS.filter(([k]) => checks[k] === false);
  return {
    graded: judged.length > 0 || !!String((g && g.note) || '').trim(),
    bad: failed.length > 0,
    judged: judged.length,
    passed: judged.length - failed.length,
    failed: failed.map(([, label]) => label),
  };
};
/* a working copy seeded from the saved grade — anything not a boolean
 * on the row (older shape, hand-fed) reads as not judged */
const gradeDraft = saved => ({
  checks: Object.fromEntries(GRADE_CHECKS.map(([k]) =>
    [k, saved && saved.checks && typeof saved.checks[k] === 'boolean' ? saved.checks[k] : null])),
  note: String((saved && saved.note) || ''),
});
/* A backend row is its id; a local-mode row may carry none and is told
 * apart by when it was filed (the phone stamps every row it keeps). */
const gradeKey = m => m ? (m.id != null ? 'id:' + m.id : 'at:' + (m.created_at || '') + ':' + (m.conversation_id || '')) : null;
/* A reload can bring a list without a row that was mid-grade — deleted
 * from another dashboard, or a pin cleared. Its draft must not linger:
 * gradeBusy() would hold the poller off for good, over a row nobody
 * can see. */
function pruneGrades() {
  const live = new Set([].concat(...Object.values(messagesByDest)).map(gradeKey));
  Object.keys(msgGrades).forEach(k => { if (!live.has(k)) delete msgGrades[k]; });
}
function openGrade(sc, i) {
  const m = msgsOf(sc)[i];
  const k = gradeKey(m);
  if (!k) return gradeDraft(null); // the row is gone from under the widget — a draft nobody can save
  if (!msgGrades[k]) msgGrades[k] = gradeDraft(gradeOf(m));
  return msgGrades[k];
}
function toggleGradeCheck(sc, i, key, value) {
  const g = openGrade(sc, i);
  /* a second tap on the lit button clears it — "not judged" must stay
   * reachable, or every untouched row would count as a pass */
  g.checks[key] = g.checks[key] === value ? null : value;
  render();
}
/* A live backend without the grade column rejects the patch outright
 * (the via/convo fallback in otto-agent.js is the same story from the
 * phone's side) — name the column and what to run. */
const gradeHint = e => {
  warn(e);
  if (Backend.enabled && /grade|column/i.test(String(e && e.message))) {
    el('stats').textContent = 'The grade did not reach the messages table — it has no grade column yet. Re-run supabase/schema.sql, then ↻ REFRESH.';
  }
};
function saveMessageGrade(sc, i) {
  const m = msgsOf(sc)[i];
  const k = gradeKey(m);
  const g = msgGrades[k];
  delete msgGrades[k];
  if (!g || !m) { render(); return; }
  const prev = gradeOf(m);
  const grade = {
    checks: { ...g.checks },
    note: String(g.note || '').trim(),
    at: new Date().toISOString(),
    /* which agent version took the call is not known here — the loop
     * stamps it when it joins the conversation; a re-grade keeps it */
    agent_version: (prev && prev.agent_version) || null,
  };
  /* nothing judged and nothing said is not a grade — the row goes back
   * to ungraded rather than carrying five nulls as if it were */
  const patch = { grade: gradeSummary(grade).graded ? grade : null };
  m.grade = patch.grade;
  if (Backend.enabled && m.id != null) Backend.updateMessage(m.id, patch).then(msgPolicyHint).catch(gradeHint);
  persistMessagesLocal();
  render();
}
const runsOf = sc => runsByScenario[sc.id] || [];

/* Which stage did the run die at? The chip says it outright. */
function runOutcome(r) {
  if (r.fired) return { label: 'FIRED ✓', cls: 'ok' };
  const pw = runParkwalk(r);
  if (pw) {
    if (pw.parked_at) return { label: `PARKED ${pw.park_distance_m} M · NEVER ARRIVED`, cls: 'warn' };
    return { label: 'NO PARKING DETECTED', cls: 'bad' };
  }
  if (r.stop_seen) return { label: 'STOP SEEN · NEVER RESUMED', cls: 'warn' };
  if (r.passes > 0) return { label: `${r.passes} PASS${r.passes === 1 ? '' : 'ES'} · NO STOP`, cls: 'warn' };
  return { label: 'NO PASS REGISTERED', cls: 'bad' };
}
/* park-and-walk runs carry their measurements in the trace */
function runParkwalk(r) {
  let t = r.ar_trace;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = null; } }
  return (t && typeof t === 'object' && t.parkwalk) || null;
}
/* ---------- the agent suite ----------
 * elevenlabs/ runs one simulation test per scenario and persona
 * against the agent — from GitHub Actions, the "buttons" — and
 * publishes every suite run as one agent_runs row: the tests with
 * their pass rates, the first failing conversation per test, a
 * roll-up. Read back here so the simulated testers' results sit on
 * the card next to the field debriefs. jsonb from Supabase, strings
 * if hand-fed — parsed defensively, like convo and ar_trace. */
const jsonOf = v => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; };
const agentRunTests = r => { const t = jsonOf(r && r.tests); return Array.isArray(t) ? t.filter(x => x && typeof x === 'object') : []; };
const agentRunSummary = r => { const s = jsonOf(r && r.summary); return s && typeof s === 'object' ? s : null; };
const agentRanAt = r => (r && (r.ran_at || r.created_at)) || null;
const agentTime = r => new Date(agentRanAt(r) || 0).getTime() || 0;
/* Which runs matter: the deployed agent's (config.js), or — with none
 * configured here — whichever agent the newest run is for.
 *   main    the latest baseline on the live prompt (label 'main')
 *   prev    the baseline before it — what the trend is measured against
 *   branch  a proposed prompt's run on an agent branch, newer than that
 *           baseline: the candidate the designer is asked to promote */
function agentSuite() {
  const agentId = String(window.ELEVENLABS_AGENT_ID || '').trim() || String((agentRuns[0] && agentRuns[0].agent_id) || '');
  const mine = agentRuns.filter(r => r && String(r.agent_id || '') === agentId);
  const mains = mine.filter(r => r.label === 'main');
  const main = mains[0] || null;
  const branch = mine.find(r => r.branch_id && r !== main && (!main || agentTime(r) > agentTime(main))) || null;
  return { agentId, main, prev: mains[1] || null, branch };
}
/* A test belongs to the card by the sheet number it was generated for,
 * or by title when the numbers do not meet — a starter row renumbered
 * on load (loadSheet) still finds its tests. Two sheets share the run
 * now, so the kind decides which fields are read: a situation's tests
 * carry kind 'situation' and situation_num / situation_title, and must
 * never land on a trigger scenario's card (or the other way round). */
function agentTestsFor(run, row, kind) {
  if (!run || !row) return [];
  const situ = kind === 'situation';
  const num = row.num == null || row.num === '' ? null : +row.num;
  const title = normTitle(row.title);
  return agentRunTests(run).filter(t => {
    if (situ !== (t.kind === 'situation')) return false;
    const tNum = situ ? t.situation_num : t.scenario_num;
    const tTitle = situ ? t.situation_title : t.scenario_title;
    return (num != null && tNum != null && +tNum === num)
      || (!!title && normTitle(tTitle) === title);
  });
}
const agentTally = tests => tests.reduce(
  (a, t) => ({ runs: a.runs + (+t.runs || 0), passed: a.passed + (+t.passed || 0) }), { runs: 0, passed: 0 });
/* the run log's three colours: every run passed / half or better / worse */
const agentRate = t => (+t.runs > 0 ? (+t.passed || 0) / +t.runs : +t.pass_rate || 0);
const agentCls = t => { const r = agentRate(t); return r >= 1 ? 'ok' : r >= 0.5 ? 'warn' : 'bad'; };
/* A chip reads like the loop's own table: who the simulated tester
 * was, the Italian variant flagged, a regression cut from a graded
 * debrief named as such — then passed/runs. Ordered for the eye, not
 * worst-first like the loop prints: personas in the order
 * personas.json lists them, Italian after English, regressions last. */
const PERSONA_ORDER = ['cooperative', 'terse', 'sidetracked', 'vague'];
const agentWho = t => {
  const parts = [];
  if (t.persona) parts.push(String(t.persona));
  if (t.language === 'it') parts.push('🇮🇹 IT');
  if (t.kind === 'regression') parts.push('REGRESSION');
  if (!parts.length) parts.push(String(t.name || 'test').replace(/^Otto · /, '').slice(0, 40));
  return parts.join(' · ');
};
const agentTestOrder = (a, b) =>
  ((a.kind === 'regression') - (b.kind === 'regression'))
  || ((a.language === 'it') - (b.language === 'it'))
  || (PERSONA_ORDER.indexOf(a.persona) - PERSONA_ORDER.indexOf(b.persona))
  || String(a.name || '').localeCompare(String(b.name || ''));

function statusOf(sc) {
  if (sc.verdict === 'pass') return { key: 'pass', label: 'PASS', rgb: '70,211,154', labelColor: '#7ce0b8', icon: '✓' };
  if (sc.verdict === 'partial') return { key: 'partial', label: 'PARTIAL', rgb: '255,217,94', labelColor: '#ffd95e', icon: '~' };
  if (sc.verdict === 'fail') return { key: 'fail', label: 'FAIL', rgb: '255,120,69', labelColor: '#ffab8a', icon: '✗' };
  if (!sc.destination_id || !destById(sc.destination_id)) return { key: 'nopin', label: 'NEEDS ADDRESS', rgb: '255,217,94', labelColor: '#ffd95e', icon: '?' };
  const n = msgsOf(sc).length;
  if (!n) {
    /* runs without a debrief tell their own story — say it, don't hide
     * it behind "awaiting test" as if nobody had been out there */
    const runs = runsOf(sc);
    if (runs.some(r => r.fired)) return { key: 'ready', label: 'FIRED · NO DEBRIEF', rgb: '255,107,107', labelColor: '#ff9b9b', icon: '▲' };
    if (runs.length) return { key: 'ready', label: `RAN ${runs.length}× · NO FIRE`, rgb: '255,107,107', labelColor: '#ff9b9b', icon: '▲' };
    return { key: 'ready', label: 'AWAITING TEST', rgb: '255,107,107', labelColor: '#ff9b9b', icon: '▲' };
  }
  return { key: 'debriefed', label: 'DEBRIEFED · ' + n, rgb: '60,192,224', labelColor: '#7fd6ea', icon: '●' };
}

/* Does Otto's category line up with the expected tip type? Soft match:
 * the category word appearing anywhere in "What Otto learns" counts. */
const catMatches = (cat, learns) =>
  !!(cat && learns && String(learns).toLowerCase().includes(String(cat).toLowerCase()));

/* ---------- keyless Google Maps links ---------- */
const gmapUrl = d => `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`;
const panoUrl = d => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}`;

/* ---------- map ---------- */
const map = FieldMap.mount({
  el: '#map',
  zoom: 15,
  staticSize: [480, 840],
  showMe: false,
  markers: () => [
    /* the demo route's stops ride under the scenario pins — small,
     * numbered, blue; AMBER where notes are on file, so the map says
     * at a glance where Otto will speak. Stops sharing an address
     * stack exactly; the header ROUTE chip hides the layer (a view
     * choice, not a delete). Label priority: scenarios first, then
     * noted stops, then the rest (lower number claims label space
     * first — see renderPins in field-map.js). */
    ...shownRouteStops().map(d => {
      const noted = dispatchNotesOf(d).length > 0;
      return {
        id: 'route-' + d.id, lat: d.lat, lng: d.lng,
        label: (d.stop == null ? '' : d.stop + ' · ') + String(d.title || '').toUpperCase().slice(0, 18),
        color: noted ? '255,217,94' : '96,165,250',
        labelColor: noted ? '#ffd95e' : '#9ec5f2',
        icon: d.stop == null ? '·' : String(d.stop),
        size: 26,
        priority: noted ? 3 : 4,
      };
    }),
    ...scenarios.map(sc => {
      const d = sc.destination_id && destById(sc.destination_id);
      if (!d) return null;
      const st = statusOf(sc);
      return {
        id: sc.id, lat: d.lat, lng: d.lng,
        label: (sc.num ? '#' + sc.num + ' ' : '') + shortTitle(sc).toUpperCase().slice(0, 20),
        color: st.rgb,
        labelColor: st.labelColor,
        icon: st.icon,
        size: 40,
        priority: st.key === 'ready' ? 1 : 2,
      };
    }).filter(Boolean),
  ],
  onMarkerClick(m) {
    const sc = scenarios.find(x => x.id === m.id);
    if (sc) { expandedId = sc.id; render(); scrollToScenario(sc.id); return; }
    /* a route stop opens its notes — every stop behind that door */
    const d = typeof m.id === 'string' && m.id.slice(0, 6) === 'route-'
      ? destinations.find(x => 'route-' + x.id === m.id) : null;
    if (d) openStop(d);
  },
  onBackendChange(b) {
    el('backend').textContent = b.toUpperCase();
    el('map-zoom').hidden = b !== 'gmap'; // zoom buttons need the live Google map
  },
});
el('zoom-in').onclick = () => { const g = map.map; if (g) g.setZoom(Math.min(20, (g.getZoom() || 15) + 1)); };
el('zoom-out').onclick = () => { const g = map.map; if (g) g.setZoom(Math.max(3, (g.getZoom() || 15) - 1)); };

/* Centre the map by simulating a position — the desktop dashboard has no
 * GPS to follow, and the kit flags a simulated fix so nothing mistakes it
 * for a real one. */
function centerOn(lat, lng) {
  Geo.simulate({ lat, lng });
  map.center();
}
/* The MEDIAN pin, not the mean: one scenario pinned in another country
 * must not drag the opening view into an empty field between the pins
 * — the map should open where most of the pins actually are. A loaded
 * route counts too, so a route-heavy dashboard opens on the route. */
function centerOnScenarios() {
  const pins = scenarios.map(sc => sc.destination_id && destById(sc.destination_id)).filter(Boolean)
    .concat(shownRouteStops());
  if (!pins.length) { Geo.simulate({ lat: 52.5346, lng: 13.4109 }); return; }
  const mid = list => {
    const s = [...list].sort((a, b) => a - b);
    const h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };
  Geo.simulate({ lat: mid(pins.map(d => d.lat)), lng: mid(pins.map(d => d.lng)) });
}

/* ---------- load ---------- */
async function loadAll() {
  if (Backend.enabled) {
    try {
      const [de, ms] = await Promise.all([Backend.listDestinations(), Backend.listMessages(1000)]);
      destinations = de || [];
      messagesByDest = {};
      (ms || []).forEach(m => {
        if (m.destination_id) (messagesByDest[m.destination_id] = messagesByDest[m.destination_id] || []).push(m);
      });
      pruneGrades();
    } catch (e) { warn(e); }
    /* the situations ride their own request: they have no pin and no
     * debriefs, and a database still missing the table must cost the
     * scenarios nothing — the SITUATIONS tab says what to re-run */
    try {
      situations = (await Backend.listSituations()) || [];
      situationsMissing = false;
      if (/situations table/i.test(schemaMsg)) schemaMsg = '';
    } catch (e) {
      warn(e);
      situationsMissing = /\b404\b|PGRST205|42P01|schema cache/i.test(String((e && e.message) || ''));
      situations = [];
    }
    try {
      scenarios = (await Backend.listScenarios()) || [];
    } catch (e) {
      warn(e);
      el('stats').textContent = 'Could not load scenarios — re-run supabase/schema.sql to add the scenarios table.';
      scenarios = [];
      return;
    }
    runsByScenario = {};
    /* the suite's published runs ride the same refresh, fetched side by
     * side with the run log and picked up below — the failure kept as
     * a value, so a 404 that lands first is never an unhandled
     * rejection, and a cached backend.js from before the reader existed
     * (a deploy caught half-way) shows on the cards instead of killing
     * the boot */
    const suiteReq = Promise.resolve().then(() => Backend.listAgentRuns(60))
      .then(rows => ({ rows: rows || [] }), e => ({ error: e }));
    try {
      ((await Backend.listRuns(300)) || []).forEach(r => {
        if (r.scenario_id) (runsByScenario[r.scenario_id] = runsByScenario[r.scenario_id] || []).push(r);
      });
    } catch (e) { warn(e); /* runs table not created yet — the log just stays empty */ }
    const suite = await suiteReq;
    if (suite.error) {
      warn(suite.error);
      /* agent_runs is the newest table in schema.sql — a 404 is "not
       * created yet", said on every card; anything else keeps the last
       * good list and names the trouble instead */
      const msg = String((suite.error && suite.error.message) || '');
      agentRunsMissing = /\b404\b|PGRST205|42P01|schema cache/i.test(msg);
      agentRunsError = agentRunsMissing ? '' : msg.slice(0, 120);
      if (agentRunsMissing) agentRuns = [];
    } else {
      agentRunsMissing = false;
      agentRunsError = '';
      agentRuns = suite.rows.filter(r => r && typeof r === 'object').sort((a, b) => agentTime(b) - agentTime(a));
    }
    /* the designer's NOT A PROBLEM list rides the same refresh. The
     * table is the newest in schema.sql: a 404 is "not created yet" —
     * the list stays in memory for this session, and the moment a mark
     * is made the stats line says how to create the table. A mark made
     * before the table existed must not be lost by a refresh, so the
     * in-memory list is kept on any failure. */
    try {
      const rows = await Backend.listAccepted();
      accepted = (rows || []).filter(r => r && r.key);
      acceptedMissing = false;
      if (schemaMsg === ACCEPTED_HINT) schemaMsg = '';
    } catch (e) {
      warn(e);
      acceptedMissing = acceptedMissingErr(e);
    }
  } else {
    try { scenarios = JSON.parse(localStorage.getItem(LS_SCEN) || '[]'); } catch { scenarios = []; }
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { destinations = []; }
    try { situations = JSON.parse(localStorage.getItem(LS_SITU) || '[]'); } catch { situations = []; }
    messagesByDest = {};
    try {
      (JSON.parse(localStorage.getItem(LS_MSGS) || '[]')).forEach(m => {
        if (m.destination_id) (messagesByDest[m.destination_id] = messagesByDest[m.destination_id] || []).push(m);
      });
    } catch { /* private mode */ }
    pruneGrades();
    runsByScenario = {};
    try {
      (JSON.parse(localStorage.getItem(LS_RUNS) || '[]')).forEach(r => {
        if (r.scenario_id) (runsByScenario[r.scenario_id] = runsByScenario[r.scenario_id] || []).push(r);
      });
    } catch { /* private mode */ }
  }
  Object.values(messagesByDest).forEach(list =>
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))));
  Object.values(runsByScenario).forEach(list =>
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))));
  scenarios.sort((a, b) =>
    ((a.num == null ? 1e9 : a.num) - (b.num == null ? 1e9 : b.num))
    || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  sortSituations();
  /* a draft whose row is gone (deleted elsewhere, or a reload that no
   * longer carries it) has nothing left to save onto */
  if (sitEdit && !situations.some(s => s.id === sitEdit.id)) sitEdit = null;
  /* the run analysis is cached per run, and it reads the situation rows
   * for their tips — a reload that changed either invalidates it */
  runAnalysisCache = { id: null, out: null };
}

/* the order the backend already returns — kept here too, so a row added
 * keyless or by hand lands where its number says, not last */
function sortSituations() {
  situations.sort((a, b) =>
    ((a.num == null ? 1e9 : +a.num) - (b.num == null ? 1e9 : +b.num))
    || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/* ---------- rendering ---------- */
function fmtTime(iso) {
  const t = new Date(iso || 0);
  return isNaN(t) ? '' : t.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
/* "2 h ago" — how fresh a suite baseline is, at a glance; the exact
 * stamp rides in the title. Past a month the date says more. */
function fmtAgo(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : fmtTime(iso);
}

function renderStats() {
  /* a schema hint outlives one repaint: the save that raised it is what
   * the reader needs to see, not the counts they already had */
  if (schemaMsg) { el('stats').textContent = schemaMsg; return; }
  /* the line counts what the list is showing: on the SITUATIONS tab the
   * scenarios' pins and debriefs are not the subject, the situations and
   * how many of them the suite has results for are */
  const suite = agentSuite();
  const parts = [];
  if (runsTabOn()) {
    parts.push(`${agentRuns.length} suite run${agentRuns.length === 1 ? '' : 's'} on file`);
    const open = openRunId && runById(openRunId);
    if (open) {
      const roll = runRollup(open);
      parts.push(`reading the run of ${fmtAgo(agentRanAt(open))} · ${roll.passed} of ${roll.conv} test calls passed`);
    }
  } else if (sitTabOn()) {
    parts.push(`${situations.length} situation${situations.length === 1 ? '' : 's'}`);
    const withResults = situations.filter(s => agentTestsFor(suite.main, s, 'situation').length).length;
    if (withResults) parts.push(`${withResults} with results`);
    const out = situations.filter(s => s.active === false).length;
    if (out) parts.push(`${out} out of the suite`);
  } else {
    renderScenarioStats(parts);
  }
  /* the agent suite's latest baseline, rolled up — the simulated
   * testers' side of the same backlog; nothing until it has run */
  const sm = suite.main && agentRunSummary(suite.main);
  if (sm) {
    const rate = sm.pass_rate != null && isFinite(+sm.pass_rate) ? Math.round(+sm.pass_rate * 100)
      : +sm.runs > 0 ? Math.round(100 * (+sm.passed || 0) / +sm.runs) : null;
    const text = `agent suite ${rate == null ? '—' : rate + '%'}`
      + ` · ${sm.tests_at_100 == null ? '?' : +sm.tests_at_100}/${sm.tests == null ? '?' : +sm.tests} tests at 100%`
      + ` · ${fmtAgo(agentRanAt(suite.main))}`;
    const title = `Latest baseline · label ${suite.main.label || 'main'}`
      + (suite.main.branch_id ? ` · branch ${suite.main.branch_id}` : '')
      + ` · agent ${suite.main.agent_id || suite.agentId || '?'} · ran ${fmtTime(agentRanAt(suite.main))}`
      + (suite.branch ? ` · a proposed prompt ran on branch ${suite.branch.branch_id} since` : '');
    parts.push({ html: `<span class="stats-suite" title="${esc(title)}">${esc(text)}</span>` });
  }
  if (!sitTabOn() && !runsTabOn()) renderScenarioVerdicts(parts);
  for (const r of loadedRoutes()) {
    const rt = routeStops(r);
    const noted = rt.filter(d => dispatchNotesOf(d).length).length;
    parts.push(`route “${r.name}” · ${rt.length} stops on the phone`
      + (noted ? ` · ${noted} with notes (amber pins)` : ''));
  }
  parts.push('build ' + window.BUILD);
  /* every part is data (route names, the suite's numbers) and goes
   * through esc(); the suite part alone carries a tooltip, hence HTML */
  el('stats').innerHTML = parts.map(p => (typeof p === 'string' ? esc(p) : p.html)).join(' · ');
}

/* the scenarios' half of the line, in two pieces — the roll-up above
 * sits between them and is about both sheets, so it stays in place */
function renderScenarioStats(parts) {
  const by = { nopin: 0, ready: 0, debriefed: 0, pass: 0, partial: 0, fail: 0 };
  scenarios.forEach(sc => { by[statusOf(sc).key]++; });
  parts.push(`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`);
  if (by.nopin) parts.push(`${by.nopin} need an address`);
  if (by.ready) parts.push(`${by.ready} awaiting test`);
  if (by.debriefed) parts.push(`${by.debriefed} debriefed`);
  /* agent debriefs still waiting for a grade are the agent loop's backlog
   * — counted over the scenarios' pins only, the ones a grade can be
   * given on (a route stop's agent debrief has no card to grade it in) */
  const agentMsgs = [...new Set([].concat(...scenarios.map(msgsOf)))].filter(m => m && m.via === 'elevenlabs');
  if (agentMsgs.length) {
    const graded = agentMsgs.filter(m => gradeSummary(gradeOf(m)).graded).length;
    parts.push(`${graded}/${agentMsgs.length} agent debrief${agentMsgs.length === 1 ? '' : 's'} graded`);
  }
}

function renderScenarioVerdicts(parts) {
  const by = { pass: 0, partial: 0, fail: 0 };
  scenarios.forEach(sc => { const k = statusOf(sc).key; if (by[k] != null) by[k]++; });
  const verdicts = [];
  if (by.pass) verdicts.push(`${by.pass} pass`);
  if (by.partial) verdicts.push(`${by.partial} partial`);
  if (by.fail) verdicts.push(`${by.fail} fail`);
  if (verdicts.length) parts.push(verdicts.join(' / '));
  const fs = scenarios.filter(fromSheet).length;
  if (fs && fs < scenarios.length) parts.push(`${fs} from the starter sheet`);
}

function defCell(label, value) {
  return value ? `<div class="def"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '';
}

function renderMessages(sc) {
  const list = msgsOf(sc);
  if (!list.length) {
    const st = statusOf(sc);
    return `<p class="cmp-empty">${st.key === 'nopin'
      ? 'No debrief possible yet — set the address first so the scenario is on the tester\'s map.'
      : 'No debrief yet — run the test on the phone: open the pin, act out the scenario, then “Report to Otto”.'}</p>`;
  }
  return list.map((m, i) => {
    const match = catMatches(m.category, sc.learns);
    const editing = msgEdit && msgEdit.destId === sc.destination_id && msgEdit.i === i;
    /* observed activity, if the phone was tracking (jsonb object from
     * Supabase, plain object from localStorage, string if hand-fed) */
    let trace = m.ar_trace;
    if (typeof trace === 'string') { try { trace = JSON.parse(trace); } catch { trace = null; } }
    const trig = trace && trace.trigger;
    /* An agent debrief is a conversation, not a clip: the transcript is
     * still what the tester said, and this is what Otto asked to get it.
     * The follow-ups are half of what a trigger scenario is being tested
     * for, so they belong next to the answer. */
    let convo = m.convo;
    if (typeof convo === 'string') { try { convo = JSON.parse(convo); } catch { convo = null; } }
    if (!Array.isArray(convo) || convo.length < 2) convo = null;
    const grade = gradeOf(m);
    const gs = gradeSummary(grade);
    return `
      <div class="msg">
        <div class="msg-top">
          <span class="msg-cat${match ? ' match' : ''}">${esc(m.category || 'other')}${match ? ' · = EXPECTED TYPE' : ''}</span>
          ${m.demo ? '<span class="msg-demo">DEMO</span>' : ''}
          ${m.via === 'elevenlabs' ? `<span class="msg-via" title="${esc('Debriefed by your ElevenLabs agent — a live conversation, not a recorded clip' + (m.conversation_id ? ' · conversation ' + m.conversation_id : ''))}">◆ AGENT</span>` : ''}
          ${gs.graded ? `<span class="msg-graded${gs.bad ? ' bad' : ''}" title="${esc(gs.bad ? 'Failed: ' + gs.failed.join(' · ') : (grade.note || 'Every judged check passed'))}">GRADED · ${gs.bad ? '✗' : gs.judged ? gs.passed + '/' + gs.judged : 'NOTE'}</span>` : ''}
          <span class="msg-time">${esc(fmtTime(m.created_at))}</span>
          ${editing ? '' : `<button class="row-link" type="button" data-msg-edit="${i}" title="Reword what Otto filed — the phone reads this to the next driver">edit</button>
          <button class="note-del" type="button" data-msg-del="${i}" title="Delete this debrief">×</button>`}
        </div>
        ${editing ? `
        <div class="msg-edit">
          <label class="cmp-k">Filed title — what Otto reads to the next driver</label>
          <input type="text" data-msg-field="title" value="${esc(msgEdit.title)}">
          <label class="cmp-k">Raw transcript — the driver's words</label>
          <textarea data-msg-field="transcript">${esc(msgEdit.transcript)}</textarea>
          <div class="fb-rec-foot">
            <button class="mini-btn accent" type="button" data-act="msg-save">Save</button>
            <button class="mini-btn" type="button" data-act="msg-cancel">Cancel</button>
          </div>
        </div>` : `
        ${m.title ? `<div class="msg-title">${esc(m.title)}</div>` : ''}
        ${m.transcript ? `<p class="msg-tr">&ldquo;${esc(m.transcript)}&rdquo;</p>` : ''}`}
        ${trig ? `<span class="trig-chip" title="${esc(trig.tuning ? 'Ran with: ' + Object.entries(trig.tuning).map(([k, v]) => k + '=' + v).join(', ') : '')}">TRIGGER FIRED · ${esc(trig.passes)} PASS${trig.passes === 1 ? '' : 'ES'}${trig.stopped ? ' + STOP' : ''}${trig.scenario_version ? ' · v' + esc(trig.scenario_version) : ''}</span>` : ''}
        ${m.ar_summary ? `<div class="msg-ar" title="Activity observed on the device (${esc((trace && trace.source) || 'web')} inference)">AR&nbsp;·&nbsp;${esc(m.ar_summary)}</div>` : ''}
        ${convo ? `<details class="msg-convo">
          <summary>THE CONVERSATION · ${convo.length} TURNS</summary>
          ${convo.map(t => `<div class="msg-turn ${t.from === 'me' ? 'me' : 'ai'}"><b>${t.from === 'me' ? 'TESTER' : 'OTTO'}</b>${esc(t.text || '')}</div>`).join('')}
        </details>` : ''}
        ${m.via === 'elevenlabs' ? renderGrade(sc, i, grade, gs) : ''}
      </div>`;
  }).join('');
}

/* The grade widget under an agent debrief. Workshop chrome: it only
 * ever renders through the TESTING body (the DEMO body retells the
 * answers in its own lines and never calls renderMessages). Open while
 * ungraded — the one thing on the card still waiting for the designer
 * — and folded behind its chip once saved; a tap on the summary reopens
 * it. Buttons re-render (like the verdict row); the note rides in
 * msgGrades, so the repaint hands it straight back. */
function renderGrade(sc, i, saved, gs) {
  const work = msgGrades[gradeKey(msgsOf(sc)[i])];
  const g = work || gradeDraft(saved);
  const open = !!work || !gs.graded;
  return `
        <details class="msg-grade"${open ? ' open' : ''}>
          <summary>${gs.graded && !work ? 'GRADED · ' + esc(fmtTime(saved && saved.at)) + ' · CHANGE' : 'GRADE THE CONVERSATION'}</summary>
          <span class="cmp-k">Did Otto ask the right things? ✓ / ✗ per line — a second tap clears it; untouched = not judged.</span>
          ${GRADE_CHECKS.map(([key, label]) => `
          <div class="grade-row">
            <span class="grade-label">${esc(label)}</span>
            <button class="g-btn${g.checks[key] === true ? ' on-yes' : ''}" type="button" data-grade-check="${key}" data-grade-i="${i}" data-grade-val="1" title="Yes">✓</button>
            <button class="g-btn${g.checks[key] === false ? ' on-no' : ''}" type="button" data-grade-check="${key}" data-grade-i="${i}" data-grade-val="0" title="No">✗</button>
          </div>`).join('')}
          <textarea data-grade-note="${i}" placeholder="One line on what Otto got wrong (or right) — the prompt gets tuned on this">${esc(g.note)}</textarea>
          <div class="fb-rec-foot">
            <button class="mini-btn accent" type="button" data-act="grade-save" data-grade-i="${i}">Save grade</button>
            ${work ? `<button class="mini-btn" type="button" data-act="grade-cancel" data-grade-i="${i}">Cancel</button>` : ''}
            ${saved && saved.agent_version ? `<span class="fb-hint">agent ${esc(saved.agent_version)}</span>` : ''}
          </div>
        </details>`;
}

/* Sliders drag against a working copy (tune) so nothing persists until
 * "Save tuning" cuts the next version. */
function renderTune(sc, params, ver) {
  if (!params.length) return '';
  const diff = tune && tune.id === sc.id ? tuneDiff(paramsOf(sc), tune.params) : '';
  const drivesPhone = params.some(p => DETECTOR_KEYS.includes(p.key));
  return `
    <div class="tune-block">
      <span class="addr-tag">TUNABLE VALUES — DRAG AFTER A REAL RUN, SAVE AS A NEW VERSION</span>
      ${params.map(p => `
        <div class="tune-row">
          <span class="tune-label" title="{${esc(p.key)}} in the rule text">${esc(p.label || p.key)}</span>
          <input type="range" class="tune-slider" data-key="${esc(p.key)}"
            min="${+p.min}" max="${+p.max}" step="${+p.step || niceStep(+p.min, +p.max)}" value="${+p.value}">
          <span class="tune-val" data-val="${esc(p.key)}">${fmtVal(p.value)}${p.unit ? '&thinsp;' + esc(p.unit) : ''}</span>
        </div>`).join('')}
      <div class="tune-foot"${diff ? '' : ' hidden'}>
        <span class="tune-diff" data-diff>${esc(diff)}</span>
        <button class="mini-btn accent" type="button" data-act="tune-save">Save tuning as v${ver + 1}</button>
        <button class="mini-btn" type="button" data-act="tune-reset">Reset</button>
      </div>
      ${drivesPhone
    ? `<p class="tune-note">These values drive the phone live: ${[
      params.some(p => DETECTOR_KEYS.includes(p.key) && !NOTES_KEYS.includes(p.key)) ? 'the trigger detector on the next test run' : '',
      params.some(p => NOTES_KEYS.includes(p.key)) ? 'the pre-arrival reading ring as soon as they are saved' : '',
    ].filter(Boolean).join('; ')}.</p>`
    : `<p class="tune-note warn">⚠ None of these keys (${esc(params.map(p => p.key).join(', '))}) is a detector knob — the phone runs on its built-in defaults and these sliders only change the rule text. Rename them to detector keys (${esc(DETECTOR_KEYS.slice(0, 4).join(', '))}, …) to make them live.</p>`}
    </div>`;
}

function renderRecorder() {
  const live = Backend.enabled;
  const sr = !live && speechAvailable();
  const recording = fbRec.state === 'rec';
  const busyTr = fbRec.state === 'transcribing';
  return `
    <div class="fb-rec">
      <textarea data-fb-text placeholder="${live || sr
        ? 'Talk, then polish the transcript here — or just type. What fired, what didn’t, which value felt wrong?'
        : 'Type your test feedback — what fired, what didn’t, which value felt wrong.'}">${esc(fbRec.text || '')}</textarea>
      <div class="fb-rec-foot">
        ${live || sr ? `<button class="mini-btn${recording ? ' rec-on' : ''}" type="button" data-act="fb-mic"${busyTr ? ' disabled' : ''}>${recording ? '■ Stop' : '● Talk'}</button>` : ''}
        <span class="fb-hint">${busyTr ? 'Transcribing…'
          : recording ? (live ? 'Recording — stop to transcribe.' : 'Listening (on-device browser speech)…')
          : sr ? 'On-device speech recognition — keyless.' : ''}</span>
        <button class="mini-btn accent" type="button" data-act="fb-save"${busyTr ? ' disabled' : ''}>Save feedback</button>
        <button class="mini-btn" type="button" data-act="fb-cancel">Cancel</button>
      </div>
    </div>`;
}

function renderProposal(sc, p) {
  const ver = (sc.version || 1) + 1;
  const cur = paramsOf(sc);
  const paramRows = (p.params || []).map(np => {
    const op = cur.find(x => x.key === np.key);
    if (op && +op.value === +np.value) return '';
    return `
      <div class="prop-param">
        <span class="tune-label">${esc(np.label || np.key)}</span>
        <span class="prop-old">${op ? fmtVal(op.value) : '—'}</span><span class="prop-arrow">→</span>
        <input type="number" data-pparam="${esc(np.key)}" value="${+np.value}" min="${+np.min}" max="${+np.max}" step="${+np.step || 'any'}">
        <span class="tune-val">${esc(np.unit || '')}</span>
      </div>`;
  }).join('');
  const fieldRows = Object.entries(p.changes).map(([k, v]) => `
    <div class="prop-field">
      <span class="cmp-k">${esc(FIELD_LABELS[k] || k)}</span>
      <div class="prop-old-text">${esc(String(sc[k] || '—'))}</div>
      <textarea data-pfield="${esc(k)}">${esc(v)}</textarea>
    </div>`).join('');
  return `
    <div class="prop">
      <div class="fb-meta">
        <span class="fb-chip accent">PROPOSED v${ver} — FROM YOUR FEEDBACK</span>
        ${p.demo ? '<span class="msg-demo" title="Built-in heuristic — deploy the scenario-ai Edge Function for a real AI revision">DEMO HEURISTIC</span>' : ''}
      </div>
      ${p.none ? `
        <p class="cmp-empty">${esc(p.note)}</p>
        <div class="fb-rec-foot"><button class="mini-btn" type="button" data-act="p-discard">Close — the feedback stays on record</button></div>`
    : `
        ${fieldRows}
        ${paramRows ? `<div class="prop-params">${paramRows}</div>` : ''}
        <label class="cmp-k">Changelog note</label>
        <input type="text" data-pnote value="${esc(p.note)}">
        <div class="fb-rec-foot">
          <button class="mini-btn accent" type="button" data-act="p-apply">Apply as v${ver}</button>
          <button class="mini-btn" type="button" data-act="p-discard">Discard</button>
        </div>`}
    </div>`;
}

/* Feedback in, versions out — the loop's paper trail lives on the card. */
function renderFeedbackBlock(sc, ver) {
  const list = feedbackOf(sc).slice().reverse();
  const openFb = feedbackOf(sc).filter(f => f.status === 'open');
  const hist = historyOf(sc).slice().reverse();
  const rec = fbRec && fbRec.id === sc.id;
  const busy = proposalBusy === sc.id;
  const prop = proposal && proposal.id === sc.id ? proposal : null;
  return `
    <div class="fb-block">
      <div class="fb-head">
        <span class="addr-tag">TEST FEEDBACK → NEW VERSION</span>
        <span class="fb-actions">
          ${rec ? '' : '<button class="mini-btn accent" type="button" data-act="fb-open">🎙 Record test feedback</button>'}
          ${openFb.length && !busy && !prop ? `<button class="mini-btn" type="button" data-act="propose">✨ Propose v${ver + 1} from ${openFb.length} note${openFb.length > 1 ? 's' : ''}</button>` : ''}
        </span>
      </div>
      ${rec ? renderRecorder() : ''}
      ${busy ? '<p class="fb-busy">✨ Reading your feedback and drafting a revision…</p>' : ''}
      ${prop ? renderProposal(sc, prop) : ''}
      ${list.length ? list.map(f => `
        <div class="fb-item">
          <div class="fb-meta">
            <span class="fb-chip${f.status === 'applied' ? ' ok' : ''}">${f.status === 'applied' ? 'APPLIED IN v' + esc(f.applied_version || '?') : 'OPEN'}</span>
            <span class="fb-chip plain">ON v${esc(f.version || 1)}${f.via === 'voice' ? ' · 🎙' : ''}</span>
            <span class="msg-time">${esc(fmtTime(f.at))}</span>
          </div>
          <p class="fb-text">&ldquo;${esc(f.text)}&rdquo;</p>
        </div>`).join('')
    : '<p class="cmp-empty" style="margin-top:10px">No feedback yet — run the test, then say (or type) what worked and what fired wrong. A new version gets proposed from it.</p>'}
      ${hist.length ? `
        <div class="ver-list">
          <span class="addr-tag">VERSIONS</span>
          <div class="ver-item">
            <span class="fb-chip ok">v${ver} · CURRENT</span>
            <span class="ver-note" title="${esc(sc.version_note || '')}">${esc(sc.version_note || (ver === 1 ? 'created' : ''))}</span>
            <span class="msg-time">${esc(fmtTime(sc.version_at || sc.created_at))}</span>
          </div>
          ${hist.map(h => `
          <div class="ver-item">
            <span class="fb-chip plain">v${esc(h.version)}</span>
            <span class="ver-note" title="${esc(h.note || '')}">${esc(h.note || '')}</span>
            <span class="msg-time">${esc(fmtTime(h.at))}</span>
            <button class="row-link" type="button" data-act="restore" data-ver="${esc(h.version)}">restore</button>
          </div>`).join('')}
        </div>` : ''}
    </div>`;
}

/* The tester's in-the-field verdict on a run, as a chip. Runs judged
 * before the timing question existed only carry should_fire — those
 * fall back to the plain right/wrong reading. */
function runVerdictChip(r) {
  const tip = 'The tester’s verdict at run end — ground truth for tuning';
  const byVerdict = {
    on_time: ['ok', '✓ RIGHT TIMING'],
    quiet_right: ['ok', '✓ RIGHT CALL'],
    early: ['warn', '⏱ TOO EARLY'],
    late: ['warn', '⏱ TOO LATE'],
    false_alarm: ['bad', '✗ FALSE ALARM'],
    missed: ['bad', '✗ SHOULD HAVE SPOKEN'],
  }[r.verdict];
  const v = byVerdict || (r.should_fire == null ? null
    : r.should_fire === !!r.fired ? ['ok', '✓ RIGHT CALL']
    : r.fired ? ['bad', '✗ FALSE ALARM'] : ['bad', '✗ SHOULD HAVE SPOKEN']);
  return v ? `<span class="run-chip ${v[0]}" title="${esc(tip)}">${v[1]}</span>` : '';
}

/* The run log — one row per tracked test, fired or not. Sits under the
 * debriefs: together they are everything the device saw. */
function renderRuns(sc) {
  const runs = runsOf(sc);
  if (!runs.length) return '';
  const rows = runs.slice(0, 4).map(r => {
    const o = runOutcome(r);
    let tuning = r.tuning;
    if (typeof tuning === 'string') { try { tuning = JSON.parse(tuning); } catch { tuning = null; } }
    const tip = tuning ? 'Ran with: ' + Object.entries(tuning).map(([k, v]) => k + '=' + v).join(', ') : '';
    const durMin = r.started_at && r.ended_at
      ? Math.max(1, Math.round((new Date(r.ended_at) - new Date(r.started_at)) / 60000)) : null;
    return `
      <div class="run-item" title="${esc(tip)}">
        <div class="fb-meta">
          <span class="run-chip ${o.cls}">${esc(o.label)}</span>
          ${runVerdictChip(r)}
          <span class="fb-chip plain">v${esc(r.scenario_version || '?')}${durMin ? ' · ' + durMin + ' MIN' : ''}</span>
          <span class="msg-time">${esc(fmtTime(r.created_at || r.ended_at))}</span>
        </div>
        ${(() => {
    const pw = runParkwalk(r);
    return pw && pw.parked_at
      ? `<div class="msg-ar" title="Parking position vs walking distance, measured on the run">PARKED&nbsp;${esc(pw.park_distance_m)}&nbsp;M FROM PIN&nbsp;·&nbsp;WALKED&nbsp;${esc(pw.walk_m)}&nbsp;M</div>` : '';
  })()}
        ${r.ar_summary ? `<div class="msg-ar" title="Activity observed on the device">AR&nbsp;·&nbsp;${esc(r.ar_summary)}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="runs-block">
      <span class="cmp-k">Test runs — what the detector saw (hover a run for the knob values it used)</span>
      ${rows}
      ${runs.length > 4 ? `<p class="cmp-empty">+ ${runs.length - 4} earlier run${runs.length === 5 ? '' : 's'}</p>` : ''}
    </div>`;
}

/* What the suite block says when there is nothing to show yet — one
 * wording per state, used by the card block and by the RUNS tab, so the
 * reader is never told two different stories about the same absence.
 * Returns '' when there ARE runs to read. */
function suiteStateNote(situ) {
  if (!Backend.enabled) {
    return 'The suite runs from GitHub Actions (Actions → agent-suite → baseline) and publishes into the shared backend — keyless, this dashboard has nothing to read it from. Point config.js at the Supabase project and its results show here.';
  }
  if (agentRunsMissing) {
    return 'No agent_runs table yet — re-run supabase/schema.sql once, then ↻ REFRESH. The suite\'s runs land there from Actions → agent-suite.';
  }
  if (agentRunsError) {
    return `Could not read the suite\'s runs — ${esc(agentRunsError)}. ↻ REFRESH to try again.`;
  }
  if (!agentRuns.length) {
    return situ
      ? 'The suite has not run yet — Actions → agent-suite → Run workflow → baseline (suite: situations). Its results land here: one chip per voice, the failing conversations under them.'
      : 'The suite has not run yet — Actions → agent-suite → Run workflow → baseline. Its results land here: one chip per test, the failing conversations under them.';
  }
  return '';
}

/* The agent suite on the card — the other half of "what Otto
 * understood": what the SIMULATED testers got out of him, between the
 * field debriefs above and the run log below. Workshop chrome, like
 * the grade widget: only the TESTING body renders it. Every state the
 * data can be in says what to do next, because the suite runs
 * elsewhere (GitHub Actions) and this block is where its absence gets
 * noticed.
 *
 * One block, two sheets: `kind` says whether the row is a trigger
 * scenario or a situation. What differs is what a run's tests are
 * matched on, what the empty states tell you to press, and the field
 * line — a situation has no pin, so it has no debriefs to roll up. */
function renderAgentBlock(row, kind) {
  const situ = kind === 'situation';
  const noun = situ ? 'situation' : 'scenario';
  const box = inner => `
          <div class="agent-block">${inner}</div>`;
  const head = (rest, title, link) => `
            <div class="agent-head"><span class="addr-tag"${title ? ` title="${esc(title)}"` : ''}>AGENT SUITE${rest || ''}</span>${link || ''}</div>`;
  const note = html => `<p class="cmp-empty agent-note">${html}</p>`;
  /* the row is shared data — only a real web address becomes a link */
  const runLink = (r, what) => (r && /^https?:\/\//i.test(String(r.run_url || ''))
    ? `<a class="row-link" href="${esc(r.run_url)}" target="_blank" rel="noopener" title="${esc(what)}">open the run ↗</a>` : '');
  /* one wording per state, shared with the RUNS tab: the same absence
   * must not be explained two different ways on two surfaces */
  const state = suiteStateNote(situ);
  if (state) return box(head() + note(state));
  const { agentId, main, prev, branch } = agentSuite();
  if (!main && !branch) {
    return box(head() + note(`The runs on file are for another agent than this dashboard is configured for (${esc(agentId)}) — a baseline on this agent lands here.`));
  }
  const tests = agentTestsFor(main, row, kind).sort(agentTestOrder);
  const tally = agentTally(tests);

  /* the header line: how fresh, how many runs passed, and the trend
   * against the baseline before — in passed runs, both fractions in
   * the tooltip so a changed repeat count cannot pass for progress */
  let headLine = ' · NO BASELINE YET';
  let headTitle = '';
  if (main) {
    let trend = '';
    const pt = agentTestsFor(prev, row, kind);
    if (prev && pt.length && tests.length) {
      const pTally = agentTally(pt);
      const d = tally.passed - pTally.passed;
      trend = `<span class="agent-trend ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}" title="${esc(`vs the previous baseline (${fmtTime(agentRanAt(prev))}): ${pTally.passed}/${pTally.runs} → ${tally.passed}/${tally.runs} runs passed`)}">${d > 0 ? '↑ +' + d : d < 0 ? '↓ −' + (-d) : '='}</span>`;
    }
    headLine = ` · ${esc(fmtAgo(agentRanAt(main)))}` + (tests.length ? ` · ${tally.passed} of ${tally.runs} runs passed${trend}` : '');
    headTitle = `Latest baseline · label ${main.label || 'main'} · agent ${main.agent_id || agentId || '?'} · ran ${fmtTime(agentRanAt(main))}${main.repeat ? ` · ${main.repeat}× per test` : ''}`;
  }

  const chips = tests.length ? `
            <div class="agent-chips">${tests.map(t =>
    `<span class="agent-chip ${agentCls(t)}" title="${esc(`${t.name || ''} — ${+t.passed || 0} of ${+t.runs || 0} runs passed${t.why ? ' · first line of the evaluator\u2019s reasons: ' + t.why : ''}`)}">${esc(agentWho(t))} ${+t.passed || 0}/${+t.runs || 0}</span>`).join('')}</div>` : '';

  /* under every failing test: the evaluator's reason in one line, and
   * the conversation the simulated tester had — OTTO / TESTER turns
   * exactly like a field debrief's, so a failure is read here, not
   * hunted for in the ElevenLabs dashboard */
  const fails = tests.map(t => {
    const f = jsonOf(t.failure);
    const failure = f && typeof f === 'object' ? f : null;
    const why = String(t.why || (failure && failure.rationale) || '').trim();
    if (!why && !failure) return '';
    const turns = failure ? jsonOf(failure.transcript) : null;
    const list = Array.isArray(turns) ? turns.filter(u => u && typeof u === 'object') : [];
    const rationale = String((failure && failure.rationale) || '').trim();
    /* the passed run the loop keeps next to the failed one, folded the same way */
    const s = jsonOf(t.success);
    const goodRaw = s && typeof s === 'object' ? jsonOf(s.transcript) : null;
    const good = Array.isArray(goodRaw) ? goodRaw.filter(u => u && typeof u === 'object') : [];
    const turnHtml = u => `<div class="msg-turn ${u.role === 'user' ? 'me' : 'ai'}"><b>${u.role === 'user' ? 'TESTER' : 'OTTO'}</b>${esc(u.message || '')}${runToolNote(u)}</div>`;
    return `
            <div class="agent-fail">
              <span class="agent-fail-who">${esc(agentWho(t))}</span><span class="agent-why-tag" title="The evaluator writes one paragraph per criterion, passed or failed. This is only the FIRST LINE of that text, so it can quote a criterion that passed — it is not the reason the test failed. The full reasons, criterion by criterion, are on the RUNS tab.">FIRST LINE OF THE EVALUATOR’S REASONS · NOT THE VERDICT</span><span class="agent-why">${esc(why)}</span>
              ${list.length ? `<details class="msg-convo agent-convo">
                <summary>THE CONVERSATION · ${list.length} TURNS</summary>
                ${list.map(turnHtml).join('')}
                ${rationale && rationale !== why ? `<p class="agent-rationale"><b>EVALUATOR</b>${esc(rationale)}</p>` : ''}
              </details>` : ''}
              ${good.length ? `<details class="msg-convo agent-convo agent-good">
                <summary>A CALL THAT PASSED · ${good.length} TURNS</summary>
                ${good.map(turnHtml).join('')}
              </details>` : ''}
            </div>`;
  }).join('');

  /* a proposed prompt that ran on a branch since the baseline: which
   * branch, this row before → after, the loop's verdict — and, on
   * ACCEPT, where the promote button is and the id it asks for. The
   * prompt itself is confidential and the proposal's note with it, so
   * the branch id is all the line can say about WHAT was tried. */
  let branchLine = '';
  if (branch) {
    const bt = agentTestsFor(branch, row, kind);
    const bTally = agentTally(bt);
    const parts = ['PROPOSED PROMPT on branch ' + esc(branch.branch_id || '?')];
    if (bt.length) parts.push(`this ${noun} ${tests.length ? tally.passed + '/' + tally.runs : '—'} → ${bTally.passed}/${bTally.runs}`);
    if (branch.verdict) {
      const ok = branch.verdict === 'accept';
      parts.push(`<b class="${ok ? 'ok' : 'bad'}">${esc(String(branch.verdict).toUpperCase())}</b>`
        + (branch.verdict_reason ? ` (${esc(branch.verdict_reason)})` : '')
        + (ok ? ` — promote from GitHub Actions (agent-suite → promote, branch_id ${esc(branch.branch_id)})` : ''));
    }
    branchLine = `
            <p class="agent-branch" title="${esc(`branch ${branch.branch_id}${branch.version_id ? ' · version ' + branch.version_id : ''} · ran ${fmtTime(agentRanAt(branch))}`)}">${parts.join(' · ')} ${runLink(branch, 'The GitHub Actions run that proposed and tested this prompt')}</p>`;
  }

  /* the field half, from the grades on this card: a debrief counts as
   * ok when it was graded and nothing on it was marked ✗. A situation
   * has no pin and therefore no field debriefs — no line at all there,
   * rather than one that says "none" forever. */
  let fieldLine = '';
  if (!situ) {
    const agentMsgs = msgsOf(row).filter(m => m && m.via === 'elevenlabs');
    const grades = agentMsgs.map(m => gradeSummary(gradeOf(m))).filter(g => g.graded);
    const ok = grades.filter(g => !g.bad).length;
    const n = agentMsgs.length;
    const field = !n ? 'field: no agent debriefs on this card yet'
      : !grades.length ? `field: ${n} agent debrief${n === 1 ? '' : 's'} filed, none graded yet`
      : `field: ${ok}/${grades.length} agent debrief${grades.length === 1 ? '' : 's'} graded ✓${n > grades.length ? ` · ${n - grades.length} still to grade` : ''}`;
    fieldLine = `
            <p class="agent-field" title="From the grades on this card's ◆ AGENT debriefs — the field half of the same evidence">${esc(field)}</p>`;
  }

  const body = !main
    ? note('No baseline on the live prompt yet — Actions → agent-suite → baseline. A proposed prompt has run meanwhile:')
    : !tests.length
      ? note(situ
        ? 'No test for this situation in the latest run — it is generated from these rows at run time; press baseline again.'
        : 'No test for this scenario yet — generate the tests from your rows (cd elevenlabs &amp;&amp; node generate-tests.mjs --supabase), push them, then baseline again.')
      : chips + fails;
  /* the card shows this row's chips and its failing conversations; the
   * whole run — what went well, the ranked patterns, the suggestions,
   * and the evaluator's full reasons per criterion — is one link away,
   * landing on this row in the run's EVERY SITUATION table */
  const full = situ && main
    ? `<button class="row-link" type="button" data-runjump="${esc(main.id)}" data-runsit="${esc(row.id)}"
        title="Open this run's summary on the RUNS tab, scrolled to this situation">see the full reasons ↓</button>` : '';
  const links = full || runLink(main, 'The GitHub Actions run that produced this baseline');
  return box(head(headLine, headTitle,
    links ? `<span class="agent-links">${full}${runLink(main, 'The GitHub Actions run that produced this baseline')}</span>` : '')
    + body + branchLine + fieldLine);
}

/* ---------- DEMO / TESTING — the two faces of an open card ----------
 * TESTING is the full workbench below — address, notes, sliders,
 * feedback, versions, verdict. DEMO retells the same scenario for a
 * client across the table (a parcel company's management, not its
 * drivers): what Otto reads on approach, the moment he notices, what
 * he asks, and what came back — read-only, every edit control gone.
 * One choice for the whole dashboard, kept per browser like the list
 * tabs: flip to DEMO once and every card is ready for the meeting. */
const LS_VIEW = 'od_card_view';
let cardView = 'test';
try { cardView = localStorage.getItem(LS_VIEW) === 'demo' ? 'demo' : 'test'; } catch { /* private mode */ }
function setCardView(v) {
  cardView = v === 'demo' ? 'demo' : 'test';
  try { localStorage.setItem(LS_VIEW, cardView); } catch { /* private mode */ }
}

/* The spoken pre-arrival briefing, mirrored line for line from the
 * phone (briefingLines in app.js, caps included): consignee and floor
 * first, then the notes on file, then what earlier drivers reported —
 * so the DEMO tab shows the literal script of the approach. */
const DEMO_MAX_NOTES = 3;  // the phone's NOTES.maxNotes
const DEMO_MAX_DRIVER = 2; // the phone's NOTES.maxDriver
const spokenSentence = s => { const t = String(s || '').trim(); return /[.!?…]$/.test(t) ? t : t + '.'; };
const spokenFloor = f => (/^\d+$/.test(String(f).trim()) ? 'floor ' + String(f).trim() : String(f).trim());
function demoSpokenLines(sc, d) {
  const lines = [];
  const name = String(d.consignee || '').trim();
  const floor = String(d.floor || '').trim();
  if (name) lines.push({ text: `Delivery is for ${name}${floor ? ', ' + spokenFloor(floor) : ''}.`, by: 'CONSIGNEE' });
  else if (floor) lines.push({ text: `Delivery goes to ${spokenFloor(floor)}.`, by: 'CONSIGNEE' });
  dispatchNotesOf(d).slice(0, DEMO_MAX_NOTES).forEach(n => lines.push({
    text: (n.by === 'driver' ? 'A driver reported: ' : 'From dispatch: ') + spokenSentence(n.text),
    by: String(n.by || 'dispatch').toUpperCase(),
  }));
  msgsOf(sc).filter(m => m && !m.demo && (m.title || m.transcript)).slice(0, DEMO_MAX_DRIVER)
    .forEach(m => lines.push({ text: 'A driver reported: ' + spokenSentence(m.title || m.transcript), by: 'DEBRIEF' }));
  return lines;
}

/* The person in the client's story is a driver — "tester" is workshop
 * vocabulary that must not reach the DEMO view, however a rule was
 * worded. Display-time only: the TESTING tab keeps the literal text. */
const driverWord = t => String(t).replace(/\b([Tt])ester(s?)\b/g, (m, T, s) => (T === 'T' ? 'D' : 'd') + 'river' + s);

function renderDemoBody(sc, d) {
  /* staged slider drags ride along, like everywhere on the card — what
   * is on screen in TESTING is what the demo retells */
  const params = tune && tune.id === sc.id ? tune.params : paramsOf(sc);
  const fp = t => fillParams(t, params);
  /* {park_m}/{walk_m} in "Otto says" are run-measured on the phone
   * (resolveSays in app.js), 'some' its no-measurement fallback — the
   * quote must read as speech, never as template soup */
  const says = t => stripQuotes(fp(t)).replace(/\{(?:park_m|walk_m)\}/g, 'some');
  const rp = params.find(p => p && p.key === 'notes_radius');
  const radius = rp && isFinite(+rp.value) ? +rp.value : 350; // NOTES.approachRadius in app.js
  const spoken = d ? demoSpokenLines(sc, d) : [];
  /* the reading opens as the phone opens it (speakPreArrival in app.js),
   * with the ring where the reading starts standing in for the live
   * distance. Spoken by ADDRESS, not by pin name: a scenario pin is
   * named after its scenario ("Inside the building"), which announces
   * nonsense — "Str. delle Trincee 10, about 350 meters ahead" is what
   * a driver would actually want to hear. */
  const spokenDist = m => (m < 1000 ? Math.round(m / 10) * 10 + ' meters' : (m / 1000).toFixed(1) + ' kilometers');
  const spokenAddr = a => {
    /* street and house number only — the postal tail ("37135 Verona VR,
     * Italy") is for envelopes, not for speech */
    const parts = String(a || '').split(/\s*,\s*/).filter(Boolean);
    const cut = parts.findIndex(p => /^\d{4,}/.test(p));
    return (cut > 0 ? parts.slice(0, cut) : parts).join(', ');
  };
  const head = d ? `Heads up — ${d.stop != null ? 'stop ' + d.stop + ', ' : ''}${spokenAddr(d.addr) || d.title || shortTitle(sc)}, about ${spokenDist(radius)} ahead.` : '';
  const answers = msgsOf(sc).filter(m => m && (m.transcript || m.title)).slice(0, 2);
  const story = String(sc.described || '').trim();
  const sayLine = (ico, text, meta) => `
        <div class="say-line"><span class="say-ico">${ico}</span><span class="say-text">&ldquo;${esc(text)}&rdquo;</span><span class="note-meta">${esc(meta)}</span></div>`;
  return `
      <div class="demo-step reads">
        <span class="addr-tag">1 · ON APPROACH — OTTO READS ALOUD, ~${fmtVal(radius)} M BEFORE THE DOOR</span>
        ${spoken.length ? sayLine('🔊', head, 'APPROACH') + spoken.map(l => sayLine('🔊', l.text, l.by)).join('')
    : `<p class="demo-empty">${d
      ? 'Nothing on file at this address yet — the consignee, dispatch notes and earlier drivers’ tips would be read here, hands-free.'
      : 'No test address pinned yet — set one in the TESTING tab and the briefing on file appears here.'}</p>`}
      </div>
      <div class="demo-step trigger">
        <span class="addr-tag">2 · THE MOMENT — WHAT OTTO NOTICES</span>
        ${story ? `<p class="demo-sub demo-story"><b>The situation:</b> ${esc(driverWord(story))}</p>`
    : sc.rule ? `<p class="demo-sub"><b>The situation:</b> ${esc(driverWord(fp(sc.rule)))}</p>`
    : '<p class="demo-empty">No trigger rule defined yet — edit the scenario in the TESTING tab.</p>'}
        ${sc.timing ? `<p class="demo-sub"><b>When he speaks:</b> ${esc(driverWord(fp(sc.timing)))}</p>` : ''}
      </div>
      <div class="demo-step asks">
        <span class="addr-tag">3 · OTTO ASKS — ONE QUESTION, HANDS-FREE</span>
        ${sc.otto_says ? `<p class="demo-quote">&ldquo;${esc(says(sc.otto_says))}&rdquo;</p>` : '<p class="demo-empty">No question defined yet — edit the scenario in the TESTING tab.</p>'}
        ${sc.learns ? `<p class="demo-sub"><span class="cmp-k">The answer is filed for the next driver as</span><span class="tip-chip">${esc(sc.learns)}</span></p>` : ''}
      </div>
      ${answers.length ? `
      <div class="demo-step heard">
        <span class="addr-tag">4 · WHAT CAME BACK — THE DRIVER'S ANSWER${answers.length > 1 ? 'S' : ''}</span>
        ${answers.map(m => sayLine('🎙', m.transcript || m.title,
    (m.demo ? 'SIMULATED · ' : '') + (m.category || 'other') + ' · ' + fmtTime(m.created_at))).join('')}
      </div>` : ''}
      ${d ? `
      <div class="addr-actions">
        <button class="mini-btn" type="button" data-act="center">Show on map</button>
      </div>` : ''}`;
}

function renderScenario(sc) {
  const st = statusOf(sc);
  const d = sc.destination_id && destById(sc.destination_id);
  const open = expandedId === sc.id;
  const ver = sc.version || 1;
  const demo = cardView === 'demo';

  /* the missing-pin warning is workshop copy — in DEMO the body's
   * step 1 tells that story once, without the header shouting it */
  const addrLine = d
    ? `<div class="sc-addr-line">📍 ${esc(d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`)}</div>`
    : demo ? ''
    : `<div class="sc-addr-line warn">⚠ No test address yet — set one so the scenario lands on the map</div>`;

  const addrBlock = d ? `
    <div class="addr-block">
      <span class="addr-tag">TEST ADDRESS — WHERE THIS SCENARIO IS ACTED OUT</span>
      <span class="addr-text">${esc(d.addr || 'Dropped pin (no street name found yet)')}</span>
      <span class="addr-coords">${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}</span>
      <div class="addr-actions">
        <a class="mini-btn accent" href="${gmapUrl(d)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
        <a class="mini-btn" href="${panoUrl(d)}" target="_blank" rel="noopener">Street View ↗</a>
        <button class="mini-btn" type="button" data-act="addr">Change address</button>
        <button class="mini-btn" type="button" data-act="center">Show on map</button>
      </div>
    </div>` : `
    <div class="addr-block warn">
      <span class="addr-tag">NO TEST ADDRESS YET</span>
      <span class="addr-text">Give this scenario a clear Google-Maps address — that pin is where the tester goes to act it out.</span>
      <div class="addr-actions">
        <button class="mini-btn accent" type="button" data-act="addr">Set address</button>
      </div>
    </div>`;

  /* the pre-arrival notes live on the destination — no pin, no notes */
  const notesBlock = !d ? '' : (() => {
    const notes = dispatchNotesOf(d);
    /* the reading ring: the scenario's notes_radius param when it has
     * one, the phone's built-in 350 m otherwise (NOTES in app.js) */
    const rp = paramsOf(sc).find(p => p && p.key === 'notes_radius');
    const radius = rp && isFinite(+rp.value) ? +rp.value : 350;
    return `
    <div class="notes-block">
      <span class="addr-tag">PRE-ARRIVAL NOTES — OTTO READS THESE ALOUD ON APPROACH</span>
      <div class="notes-grid">
        <div>
          <label>Consignee</label>
          <input data-note-field="consignee" value="${esc(d.consignee || '')}" placeholder="Who the delivery is for — &ldquo;Maria Weber&rdquo;">
        </div>
        <div>
          <label>Floor / unit</label>
          <input data-note-field="floor" value="${esc(d.floor || '')}" placeholder="&ldquo;4th floor&rdquo;, &ldquo;Apt 12B&rdquo;">
        </div>
      </div>
      ${notes.map((n, i) => `
        <div class="note-item">
          <span class="note-text">${esc(n.text)}</span>
          <span class="note-meta">${esc(String(n.by || 'dispatch').toUpperCase())}${n.at ? ' · ' + esc(fmtTime(n.at)) : ''}</span>
          <button class="note-del" type="button" data-note-del="${i}" title="Remove this note">×</button>
        </div>`).join('')}
      <div class="note-add">
        <input data-note-new placeholder="Building note for the next driver — &ldquo;The elevator is broken, use the stairs&rdquo;">
        <button class="mini-btn accent" type="button" data-act="note-add">+ Add note</button>
      </div>
      <p class="notes-hint">Read out on the phone as the driver comes within ~${fmtVal(radius)} m of this pin — consignee and floor first, then these notes, then the latest driver debriefs from &ldquo;What Otto understood&rdquo;.
      ${rp
        ? `Tune &ldquo;${esc(rp.label || 'notes_radius')}&rdquo; under TUNABLE VALUES.`
        : `<button class="link-btn" type="button" data-act="notes-radius">⊕ make the read distance tunable</button>`}</p>
    </div>`;
  })();

  /* pending slider values (if any) drive what the definition shows */
  const params = tune && tune.id === sc.id ? tune.params : paramsOf(sc);
  const fp = t => fillParams(t, params);

  const viewTabs = `
      <div class="tabs sc-tabs">
        <button class="tab${demo ? '' : ' on'}" type="button" data-cardview="test"
          title="The full loop — address, notes, sliders, feedback, versions, verdict">⚙ TESTING</button>
        <button class="tab${demo ? ' on' : ''}" type="button" data-cardview="demo"
          title="The client view — what Otto reads on approach and what he says when this scenario fires; every edit control hidden">▶ DEMO</button>
      </div>`;

  const body = !open ? '' : demo ? `
    <div class="sc-body">
      ${viewTabs}
      ${renderDemoBody(sc, d)}
    </div>` : `
    <div class="sc-body">
      ${viewTabs}
      ${addrBlock}
      ${notesBlock}
      <div class="def-grid">
        ${sc.rule ? `<div class="def"><dt>Trigger rule (testable)</dt><dd data-rule>${esc(fp(sc.rule))}</dd></div>` : ''}
        ${defCell('Activity Recognition states', fp(sc.ar_states))}
        ${defCell('Other signals needed', fp(sc.signals))}
        ${defCell('Timing to talk', fp(sc.timing))}
      </div>
      ${renderTune(sc, params, ver)}
      <div class="compare">
        <div class="cmp-col cmp-defined">
          <h4>DEFINED — WHAT SHOULD HAPPEN</h4>
          ${sc.otto_says ? `<div class="cmp-row"><span class="cmp-k">Otto asks</span><span class="cmp-v say">&ldquo;${esc(stripQuotes(sc.otto_says))}&rdquo;</span></div>` : ''}
          ${sc.learns ? `<div class="cmp-row"><span class="cmp-k">Expected tip type</span><span class="tip-chip">${esc(sc.learns)}</span></div>` : ''}
          ${sc.ar_states ? `<div class="cmp-row"><span class="cmp-k">Expected activity (Google AR states)</span><span class="cmp-v mono-v">${esc(fp(sc.ar_states))}</span></div>` : ''}
          ${sc.test_steps ? `<div class="cmp-row"><span class="cmp-k">How to test it</span><span class="cmp-v">${esc(fp(sc.test_steps))}</span></div>` : ''}
          ${!sc.otto_says && !sc.learns && !sc.test_steps ? '<p class="cmp-empty">Nothing defined yet — edit the scenario.</p>' : ''}
        </div>
        <div class="cmp-col cmp-heard">
          <h4>WHAT OTTO UNDERSTOOD</h4>
          ${renderMessages(sc)}
          ${renderAgentBlock(sc, 'scenario')}
          ${renderRuns(sc)}
        </div>
      </div>
      ${renderFeedbackBlock(sc, ver)}
      <div class="verdict-row">
        <span class="verdict-label">Did Otto get it?</span>
        <button class="v-btn${sc.verdict === 'pass' ? ' on-pass' : ''}" type="button" data-verdict="pass">✓ PASS</button>
        <button class="v-btn${sc.verdict === 'partial' ? ' on-partial' : ''}" type="button" data-verdict="partial">~ PARTIAL</button>
        <button class="v-btn${sc.verdict === 'fail' ? ' on-fail' : ''}" type="button" data-verdict="fail">✗ FAIL</button>
        <span class="row-links">
          <button class="row-link" type="button" data-act="spec" title="Download this scenario as a JSON spec — tuned values, versions, feedback, results">Spec JSON ⇩</button>
          <button class="row-link" type="button" data-act="edit">Edit scenario</button>
          <button class="row-link danger" type="button" data-act="del">Delete</button>
        </span>
      </div>
    </div>`;

  /* In DEMO view the header sheds its workshop chrome — version,
   * starter origin, delete, workflow badges. Only a verdict is a
   * result worth showing a client. */
  const showBadge = !demo || sc.verdict;
  return `
    <article class="sc" data-id="${esc(sc.id)}">
      <header class="sc-header">
        <span class="sc-num">${sc.num != null && sc.num !== '' ? '#' + esc(sc.num) : '·'}</span>
        <div class="sc-head">
          <h3>${esc(sc.title)}</h3>
          ${addrLine}
        </div>
        ${!demo && fromSheet(sc) ? '<span class="origin" title="From the shipped starter sheet (trigger-scenarios.js). Rows without this tag were made on this dashboard — rename a starter row and it becomes yours too.">⇩ STARTER</span>' : ''}
        ${demo ? '' : `<span class="ver" title="${esc(sc.version_note || 'version')}">v${ver}</span>`}
        ${showBadge ? `<span class="badge badge-${st.key}">${esc(st.label)}</span>` : ''}
        ${demo ? '' : '<button class="sc-del" type="button" data-act="del" title="Delete scenario" aria-label="Delete scenario">×</button>'}
      </header>
      ${body}
    </article>`;
}

/* ---------- the situation card ----------
 * Collapsed it is the driver's opening line under the title — that is
 * what the whole row is about. Open it is the row itself, every field
 * an input: there is no separate form, because a situation IS its text
 * and editing it next to the suite's verdict is the work. The suite's
 * results sit underneath, the same block a scenario card carries.
 *
 * The starter sheet's seven categories, in the order the contract with
 * the generator fixes them — the select never offers an eighth, so a
 * typo can never reach the table's check constraint. */
const SIT_CATEGORIES = ['access', 'parking', 'gate_code', 'recipient', 'address', 'hazard', 'other'];
const SIT_COLS = ['num', 'title', 'category', 'stop', 'driver_says', 'driver_knows', 'follow_up', 'off_topic', 'tip', 'active'];
/* jsonb from Supabase, a plain array keyless, a string if hand-fed */
const sitList = v => { const a = jsonOf(v); return Array.isArray(a) ? a.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : []; };
const sitLines = t => String(t == null ? '' : t).split('\n').map(x => x.trim()).filter(Boolean);
/* only the table's own columns travel — an insert carrying anything
 * else is a 400 from PostgREST, and the lists are copied so an edit
 * can never reach back into the shipped sheet */
const sitRow = r => {
  const o = {};
  SIT_COLS.forEach(k => {
    if (r[k] === undefined) return;
    o[k] = (k === 'follow_up' || k === 'off_topic') ? sitList(r[k]) : r[k];
  });
  return o;
};
const sitCat = c => (SIT_CATEGORIES.includes(c) ? c : 'other');
/* the situations are set at the Kollwitzkiez stops — the same route the
 * phone walks, so the simulated driver and Otto share an address and a
 * consignee. No route file loaded: a plain number, which is all the
 * column holds anyway. */
const sitRoute = () => ROUTES.find(r => r.id === 'kollwitz-01') || null;

/* The draft is FORM values — strings as typed, the lists one item per
 * line — so a half-typed line never has to survive a round trip
 * through the row's shape. sitPatch turns it back into columns. */
function sitDraftOf(s) {
  return {
    id: s.id,
    title: String(s.title == null ? '' : s.title),
    category: sitCat(s.category),
    stop: s.stop == null || s.stop === '' ? '' : String(s.stop),
    driver_says: String(s.driver_says == null ? '' : s.driver_says),
    driver_knows: String(s.driver_knows == null ? '' : s.driver_knows),
    follow_up: sitList(s.follow_up).join('\n'),
    off_topic: sitList(s.off_topic).join('\n'),
    tip: String(s.tip == null ? '' : s.tip),
    active: s.active !== false,
  };
}
const sitDraft = s => (sitEdit && sitEdit.id === s.id ? sitEdit : sitDraftOf(s));
/* typing opens the draft — before that the inputs render straight from
 * the row, so a card can be opened and closed without dirtying anything */
function openSitEdit(s) {
  if (!sitEdit || sitEdit.id !== s.id) sitEdit = sitDraftOf(s);
  return sitEdit;
}
/* what would be written: only the columns that actually changed, so a
 * save never touches a field the designer did not look at */
function sitPatch(s, d) {
  const now = {
    title: String(d.title || '').trim() || 'Untitled situation',
    category: sitCat(d.category),
    stop: d.stop === '' || d.stop == null || !isFinite(+d.stop) ? null : Math.round(+d.stop),
    driver_says: String(d.driver_says || '').trim() || null,
    driver_knows: String(d.driver_knows || '').trim() || null,
    follow_up: sitLines(d.follow_up),
    off_topic: sitLines(d.off_topic),
    tip: String(d.tip || '').trim() || null,
    active: !!d.active,
  };
  const was = {
    title: String(s.title == null ? '' : s.title).trim() || 'Untitled situation',
    category: sitCat(s.category),
    stop: s.stop == null || s.stop === '' || !isFinite(+s.stop) ? null : Math.round(+s.stop),
    driver_says: String(s.driver_says == null ? '' : s.driver_says).trim() || null,
    driver_knows: String(s.driver_knows == null ? '' : s.driver_knows).trim() || null,
    follow_up: sitList(s.follow_up),
    off_topic: sitList(s.off_topic),
    tip: String(s.tip == null ? '' : s.tip).trim() || null,
    active: s.active !== false,
  };
  const patch = {};
  Object.keys(now).forEach(k => {
    if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) patch[k] = now[k];
  });
  return patch;
}
/* an open draft with real changes in it — the auto-refresh must not
 * repaint over it, and the header says so while it is unsaved */
function sitDirty() {
  if (!sitEdit) return false;
  const s = situations.find(x => x.id === sitEdit.id);
  return !!s && Object.keys(sitPatch(s, sitEdit)).length > 0;
}

function renderSituation(s) {
  const open = expandedSitId === s.id;
  const d = sitDraft(s);
  const dirty = sitEdit && sitEdit.id === s.id && sitDirty();
  const active = open ? d.active : s.active !== false;
  const says = String(s.driver_says || '').trim();
  const route = sitRoute();
  const stopField = route
    ? `<select data-sit-field="stop">
            <option value=""${d.stop === '' ? ' selected' : ''}>— no stop</option>
            ${route.stops.map(st => `<option value="${esc(st.stop)}"${String(st.stop) === d.stop ? ' selected' : ''}>${esc(st.stop)} · ${esc(st.title)}${st.consignee ? ' — ' + esc(st.consignee) : ''}</option>`).join('')}
          </select>`
    : `<input type="number" min="1" step="1" data-sit-field="stop" value="${esc(d.stop)}" placeholder="stop #">`;

  const body = !open ? '' : `
    <div class="sc-body">
      <div class="sit-edit">
        <div class="sit-grid">
          <div class="full">
            <label>Situation</label>
            <input type="text" data-sit-field="title" value="${esc(d.title)}" placeholder="What happened, in a few words">
          </div>
          <div>
            <label>Category</label>
            <select data-sit-field="category">
              ${SIT_CATEGORIES.map(c => `<option value="${esc(c)}"${c === d.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Stop it is set at <span class="pe-sub">— the address Otto and the driver share</span></label>
            ${stopField}
          </div>
          <div class="full">
            <label>What the driver says first</label>
            <textarea data-sit-field="driver_says" placeholder="&ldquo;I couldn't get to the address at all — the road is closed off.&rdquo;">${esc(d.driver_says)}</textarea>
          </div>
          <div class="full">
            <label>What the driver knows if asked <span class="pe-sub">— and only then; the simulated driver never volunteers it</span></label>
            <textarea data-sit-field="driver_knows">${esc(d.driver_knows)}</textarea>
          </div>
          <div class="full">
            <label>A relevant follow-up asks about <span class="pe-sub">— one per line</span></label>
            <textarea data-sit-field="follow_up" placeholder="how long the closure lasts&#10;whether there is a way round">${esc(d.follow_up)}</textarea>
          </div>
          <div class="full">
            <label>Off topic here <span class="pe-sub">— one per line; asking these is a fail</span></label>
            <textarea data-sit-field="off_topic" placeholder="gate codes&#10;the recipient">${esc(d.off_topic)}</textarea>
          </div>
          <div class="full">
            <label>The tip Otto should confirm</label>
            <input type="text" data-sit-field="tip" value="${esc(d.tip)}" placeholder="The one line the next driver gets to hear">
          </div>
        </div>
        <div class="fb-rec-foot">
          <button class="mini-btn${active ? ' accent' : ''}" type="button" data-sit-act="active"
            title="${esc(active ? 'In the suite — the next baseline acts this situation out' : 'Out of the suite — kept here, but no test is generated for it')}">${active ? '✓ in the suite' : '✗ out of the suite'}</button>
          <span class="fb-hint">${dirty ? 'Unsaved changes' : 'Edited here; the suite is generated from these rows at run time.'}</span>
          <button class="mini-btn accent" type="button" data-sit-act="save">Save</button>
          <button class="mini-btn" type="button" data-sit-act="cancel">Cancel</button>
          <span class="row-links"><button class="row-link danger" type="button" data-sit-act="del">Delete</button></span>
        </div>
      </div>
      ${renderAgentBlock(s, 'situation')}
    </div>`;

  return `
    <article class="sc sit" data-sit="${esc(s.id)}">
      <header class="sc-header">
        <span class="sc-num">${s.num != null && s.num !== '' ? '#' + esc(s.num) : '·'}</span>
        <div class="sc-head">
          <h3>${esc(s.title || 'Untitled situation')}</h3>
          ${says ? `<div class="sc-addr-line sit-says">&ldquo;${esc(says)}&rdquo;</div>` : '<div class="sc-addr-line warn">⚠ Nothing for the driver to say yet — open the row and write the first line</div>'}
        </div>
        <span class="tip-chip" title="What the tip that comes out of this is about">${esc(sitCat(s.category))}</span>
        ${dirty ? '<span class="badge badge-nopin" title="Edited but not saved">UNSAVED</span>' : ''}
        ${active ? '' : '<span class="badge badge-out" title="Kept here, but the suite generates no test for it">OUT OF THE SUITE</span>'}
        <button class="sc-del" type="button" data-sit-act="del" title="Delete situation" aria-label="Delete situation">×</button>
      </header>
      ${body}
    </article>`;
}

function renderSituationsEmpty() {
  const n = SIT_SHEET ? SIT_SHEET.situations.length : 0;
  return `
      <div class="empty">
        <b>No situations yet</b>
        <p>A situation is one thing a driver reports when they press REPORT on the phone — what they say first, what they know if Otto asks, what would be off topic, and the tip Otto should end up confirming. The suite acts each one out in four voices.</p>
        ${situationsMissing ? '<p class="cmp-empty">No situations table in the backend yet — re-run supabase/schema.sql once, then ↻ REFRESH.</p>' : ''}
        <div class="top-actions">
          <button class="chip primary" type="button" data-sit-empty="new">+ NEW SITUATION</button>
          ${n ? `<button class="chip" type="button" data-sit-empty="sheet">⇩ LOAD THE STARTER SITUATIONS · ${n}</button>` : ''}
        </div>
      </div>`;
}

/* ---------- the RUNS tab: one summary page per suite run ----------
 * The suite publishes a run and the cards show it a row at a time. That
 * answers "how did THIS situation go" and not the question actually
 * being asked after a baseline: what went well, what went wrong, and
 * what to change next. 240 conversations do not fit on twenty cards,
 * and nobody reads the Actions log.
 *
 * So: a tab that lists the runs, and per run one page that reads like a
 * report. It CHANGES NOTHING. Every number on it is computed here from
 * the row the suite published, and it says which of its two sources it
 * came from, because the two are not equally trustworthy:
 *
 *   OBSERVED FACTS come from the transcripts alone — counted, with the
 *     counting rule printed next to the count so it can be checked. The
 *     agent's opening line, how many questions were asked, whether the
 *     closing line carried the tip. Never from the evaluator's prose.
 *   THE EVALUATOR'S REASONS are shown verbatim, split into the
 *     "Criterion N:" paragraphs the evaluator writes, each labelled
 *     with what that criterion is about. They are NOT re-judged here: a
 *     paragraph about a criterion that PASSED reads much like one about
 *     a criterion that failed, and an earlier attempt to tell them
 *     apart by regex got it wrong in both directions. Where a count per
 *     criterion is given it counts only paragraphs carrying an
 *     unmistakable marker, is labelled as such, and shows the remainder
 *     as unclear rather than rounding it into a verdict.
 *
 * The prompt is confidential and is never read, shown or stored here —
 * the suggestions are text to paste, not a diff of anything. */

/* which run's summary is open (null = the list), and the situation row
 * its EVERY SITUATION table should be scrolled to on the way in */
let openRunId = null;
let runFocusSit = null;

const runById = id => agentRuns.find(r => r && String(r.id) === String(id)) || null;

/* ---------- words ----------
 * Every observed fact that compares two pieces of text compares CONTENT
 * words: lowercased, stripped of punctuation, three letters or more,
 * with the grammar dropped. Crude on purpose — the rule has to fit in
 * the one line printed above the count. */
const RUN_STOP = new Set(('a an the and or but if then than that this these those there here is are was were be been'
  + ' being am do does did done doing have has had having will would shall should can could may might must to of in'
  + ' on at by for with about from into over under again further once no not nor only own same so too very just now'
  + ' i you he she it we they me him her us them my your his its our their as out up down off when where why how'
  + ' what which who whom while because before after above below between both each few more most other some such'
  + ' also got get go going one two three four five six seven eight nine ten thing things something anything nothing'
  + ' ok okay yeah yes').split(' '));
/* the voice tags the agent emits ([slow], [happy]) are stage direction,
 * not speech — out before anything is counted, including the '?' count */
const runStrip = s => String(s == null ? '' : s).replace(/\[[^\]]*\]/g, ' ');
const runWords = s => runStrip(s).toLowerCase().replace(/[^a-z0-9äöüß\s-]/g, ' ')
  .split(/[\s-]+/).filter(w => w.length > 2 && !RUN_STOP.has(w));
const runBag = s => new Set(runWords(s));
const runHits = (set, text) => { const w = runBag(text); let n = 0; set.forEach(x => { if (w.has(x)) n++; }); return n; };

/* The sheet row a test was acted out from. TITLE first, then the
 * number: the suite numbers its situations itself, and after a renumber
 * (loadSituationSheet) those numbers collide with the sheet's — run
 * #5 was this sheet's row #1. A tip compared against the wrong row
 * would be worse than no tip line at all. */
function runSitRow(t) {
  const title = normTitle(t && t.situation_title);
  return (title && situations.find(s => normTitle(s.title) === title))
    || (t && t.situation_num != null && situations.find(s => s.num != null && +s.num === +t.situation_num))
    || null;
}

/* "he told the driver he had filed it" — the agent's own words, not the
 * evaluator's reading of them */
const RUN_FILED = /\b(I(?:'ve| have) (logged|noted|filed|recorded)|noted (that|down)|I'?ll (log|note|file)|logged that)\b/i;
/* capitalised words that open a sentence or an aside rather than name
 * anything — kept out of "asserted something unsaid" */
const RUN_NOTNAME = new Set(('thanks thank sorry okay oh wow perfect got glad great hello hi hey yes yeah nope ah'
  + ' right sure good safe have has had is are was were can could will would should do does did just well also let'
  + ' so and but that this it you we they if then there here no not what when where why how which who i im ill ive'
  + ' id noted understood appreciate').split(' '));

/* ---------- observed facts, one record per failing conversation ----------
 * The published row carries ONE conversation per failing test (the
 * first that failed), so every share below is over those conversations
 * — said in as many words wherever a share is printed, because "50% of
 * the failing tests" and "50% of the 240 runs" are different claims. */
/* A tool Otto used just before this line — the loop keeps the names on
 * the turn (`tools`). report_incident is the one that matters: it is
 * how the report leaves the call, so the reader sees where it went. */
function runToolNote(u) {
  const tools = Array.isArray(u && u.tools) ? u.tools.filter(Boolean) : [];
  if (!tools.length) return '';
  const words = tools.map(t => (t === 'report_incident' ? 'sent the report to the app just before this line' : `used ${t} just before this line`));
  return `<i class="rs-tool">${esc(words.join('; '))}</i>`;
}

function runFacts(run) {
  return agentRunTests(run).map(t => {
    const f = jsonOf(t.failure);
    const raw = f && typeof f === 'object' ? jsonOf(f.transcript) : null;
    const turns = Array.isArray(raw) ? raw.filter(u => u && typeof u === 'object') : [];
    if (!turns.length) return null;
    const agent = turns.filter(u => u.role !== 'user');
    const row = runSitRow(t);

    const opener = runStrip(agent[0] && agent[0].message).trim();
    /* the first thing the agent said AFTER the driver's report — the
     * turn check 1 is about */
    const iUser = turns.findIndex(u => u.role === 'user');
    /* questions: question marks in Otto's turns AFTER the driver's first
     * words. The greeting ("Hello! How can I help you today?") is his
     * chosen first line and not a follow-up — it is never counted, which
     * is also how the suite's LENGTH check reads now. */
    const questions = iUser < 0 ? 0 : turns.reduce((n, u, i) => n + (i > iUser && u.role !== 'user'
      ? (runStrip(u.message).match(/\?/g) || []).length : 0), 0);
    const iFollow = iUser < 0 ? -1 : turns.findIndex((u, i) => i > iUser && u.role !== 'user');
    const follow = iFollow < 0 ? '' : runStrip(turns[iFollow].message);

    const filed = agent.some(u => RUN_FILED.test(runStrip(u.message)));

    /* read the report back: an agent turn that repeats three or more
     * content words from the driver's previous turn and is not the last
     * turn of the call — a closing line is SUPPOSED to repeat the tip */
    let readback = '';
    for (let i = 1; i < turns.length - 1 && !readback; i++) {
      if (turns[i].role === 'user') continue;
      let prev = null;
      for (let j = i - 1; j >= 0 && !prev; j--) if (turns[j].role === 'user') prev = turns[j];
      if (prev && runHits(runBag(prev.message), turns[i].message) >= 3) readback = runStrip(turns[i].message);
    }

    /* the closing line against the tip this row exists to produce */
    const last = runStrip(agent[agent.length - 1] && agent[agent.length - 1].message);
    const tip = String((row && row.tip) || '').trim();
    let tipState = '';
    let tipHit = 0;
    let tipOf = 0;
    if (tip) {
      const w = runBag(tip);
      tipOf = w.size;
      tipHit = runHits(w, last);
      tipState = tipHit === 0 ? 'none' : tipHit * 2 < tipOf ? 'partial' : 'ok';
    }

    /* did the first follow-up go where the row says a relevant one goes?
     * Only an overlap that is bigger on the OFF-TOPIC side counts as
     * gone elsewhere: a question can fit perfectly and still share no
     * word with the sheet's phrasing, so "no overlap" proves nothing. */
    let onTopic = 0;
    let offTopic = 0;
    if (row && follow) {
      sitList(row.follow_up).forEach(s => { onTopic += runHits(runBag(s), follow); });
      sitList(row.off_topic).forEach(s => { offTopic += runHits(runBag(s), follow); });
    }

    /* asserted something unsaid: a name or a measurement the agent
     * STATES in that first follow-up which is in neither the driver's
     * words so far nor the row's opening line. Statements only — the
     * whole point of the rule is that asking is fine and asserting is
     * not — and mid-sentence capitals only, so a sentence opener is
     * never mistaken for a street. */
    const said = [row && row.driver_says, ...turns.slice(0, iFollow < 0 ? 0 : iFollow)
      .filter(u => u.role === 'user').map(u => u.message)].join(' ');
    const saidSet = new Set(runWords(said));
    const unsaid = [];
    follow.split(/(?<=[.!?])\s+/).forEach(sent => {
      if (/\?/.test(sent)) return;
      const toks = sent.trim().split(/\s+/);
      toks.forEach((tok0, i) => {
        const tok = tok0.replace(/^[^\wÄÖÜäöüß]+|[^\wÄÖÜäöüß]+$/g, '');
        if (!tok) return;
        const key = tok.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
        const number = /^\d+(?:[.,]\d+)?$/.test(tok)
          && /^(m|km|metres|meters|min|mins|minutes|hour|hours|h|kg|floor|floors|am|pm)\b/i.test(toks[i + 1] || '');
        const name = i > 0 && /^[A-ZÄÖÜ][a-zäöüß]{2,}/.test(tok) && !RUN_NOTNAME.has(key);
        if ((!number && !name) || !key || saidSet.has(key)) return;
        if (new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(said)) return;
        if (unsaid.indexOf(tok) < 0) unsaid.push(tok);
      });
    });

    return { test: t, row, turns, agentTurns: agent.length, opener, questions, follow, filed,
      readback, last, tip, tipState, tipHit, tipOf, onTopic, offTopic, unsaid,
      rationale: String((f && f.rationale) || '').trim() };
  }).filter(Boolean);
}

/* ---------- the judge's notes, word for word ----------
 * One paragraph per check, in a fixed order that is the same for every
 * situation test — so the paragraph can be labelled with what it is
 * about without reading it. The labels are the page's plain words for
 * the checks; the judge's own text is never changed. */
const RUN_CRITERIA = [
  'the first question fits what the driver reported',
  'never asks for something the driver already said',
  'sounds natural — no form-filling, no repeating the report back',
  'invents nothing the driver did not say',
  'at most three follow-up questions after the driver\'s report — one good one is enough, and the greeting does not count',
  'ends by confirming the tip in one line, then lets the driver go',
  'asks one open question first — the vague driver only',
];
/* The judge's own word at the head of a paragraph — every check asks
 * for "PASS or FAIL, then the reason" — so the count per check is its
 * word wherever it complied, and a reading of the prose only for runs
 * from before the ask (or a paragraph where it forgot). */
const runVerdictOf = text => {
  const m = /^\s*(?:\*{0,2}|_{0,2})(?:verdict\s*:\s*)?(PASS|FAIL)\b/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
};
const runReasonParas = text => String(text || '').split(/\n(?=Criterion\s+\d+\s*:)/)
  .map(p => p.trim()).filter(p => /^Criterion\s+\d+\s*:/.test(p))
  .map(p => ({ n: +p.match(/^Criterion\s+(\d+)/)[1], text: p.replace(/^Criterion\s+\d+\s*:\s*/, '') }));

/* Markers that are not open to reading: a paragraph carrying one is
 * SAYING the criterion was missed. Per criterion, because the same word
 * means opposite things under different ones — "invented" is the
 * complaint under criterion 4 and background under criterion 2. A
 * paragraph without a marker is counted as unclear, never as a pass. */
const RUN_MARKERS = {
  1: [/\bdoes not (?:ask|relate|address|fit|follow|connect)\b/i, /\bis not about\b/i, /\bunrelated to\b/i, /\bcould follow any\b/i],
  2: [/\bre-?asks?\b/i, /\bre-?asking\b/i, /\basks? (?:the driver )?again\b/i, /\basked again\b/i],
  3: [/\bform-?filling\b/i, /\bread(?:s|ing)? (?:the |his |her |it )?.{0,24}back\b/i, /\brobotic\b/i],
  4: [/\binvent(?:ed|s|ing|ion)\b/i, /\bfabricat/i, /\basserts? (?:a|the) fact\b/i],
  5: [/\bexceed/i, /\b(?:four|five|six|seven|4|5|6|7)\s+questions\b/i, /\btoo many questions\b/i, /\bmore than three\b/i],
  6: [/\bdoes not (?:end|provide|include|close|state|give|confirm|summari[sz]e)\b/i, /\bno (?:explicit|clear) (?:closing|tip|summary|one-line)\b/i, /\bomits\b/i, /\bnever (?:provides|states|confirms)\b/i],
  7: [/\brather than an open\b/i, /\bdoes not (?:ask|open|start|begin)\b/i, /\bwithout (?:asking|an open)\b/i, /\bimmediately asked a specific\b/i],
};
/* "doesn't re-ask", "no invented times" — a marker under a negation is
 * the evaluator saying the opposite, so the words just before it decide */
const RUN_NEG = /(?:n['’]t|\b(?:no|not|nothing|never|without|avoids?|avoided|absent|free of)\b)[^.;:]{0,26}$/i;
const runSaysPlainly = (n, text) => (RUN_MARKERS[n] || []).some(re => {
  const m = re.exec(text);
  return !!m && !RUN_NEG.test(text.slice(Math.max(0, m.index - 32), m.index));
});

/* ---------- the run, rolled up ---------- */
function runRollup(run) {
  const tests = agentRunTests(run);
  const sm = agentRunSummary(run) || {};
  const conv = +sm.runs > 0 ? +sm.runs : tests.reduce((a, t) => a + (+t.runs || 0), 0);
  const passed = sm.passed != null && isFinite(+sm.passed) ? +sm.passed : tests.reduce((a, t) => a + (+t.passed || 0), 0);
  const nTests = +sm.tests > 0 ? +sm.tests : tests.length;
  const perfect = sm.tests_at_100 != null && isFinite(+sm.tests_at_100) ? +sm.tests_at_100
    : tests.filter(t => +t.runs > 0 && +t.passed === +t.runs).length;
  const rate = sm.pass_rate != null && isFinite(+sm.pass_rate) ? +sm.pass_rate : (conv > 0 ? passed / conv : 0);
  const situ = tests.some(t => t.kind === 'situation');
  const trig = tests.some(t => t.kind && t.kind !== 'situation');
  const personas = [...new Set(tests.map(t => String(t.persona || '')).filter(Boolean))]
    .sort((a, b) => (PERSONA_ORDER.indexOf(a) + 1 || 99) - (PERSONA_ORDER.indexOf(b) + 1 || 99));
  const rows = [...new Set(tests.filter(t => t.kind === 'situation')
    .map(t => (t.situation_num == null ? '' : t.situation_num) + '|' + normTitle(t.situation_title)))];
  return { tests, conv, passed, nTests, perfect, rate,
    suite: situ && trig ? 'mixed' : situ ? 'situations' : trig ? 'triggers' : '',
    personas, rowCount: rows.length,
    repeat: +run.repeat > 0 ? +run.repeat : (tests[0] && +tests[0].runs) || 0 };
}

/* the run log's three colours, read at run scale: a baseline is green
 * only when nearly everything passed */
const runCls = r => (r >= 0.9 ? 'ok' : r >= 0.5 ? 'warn' : 'bad');
const runPct = r => Math.round((+r || 0) * 100) + '%';

/* ---------- per situation, from the run's own tests ---------- */
function runSituations(run, facts) {
  const by = new Map();
  agentRunTests(run).filter(t => t.kind === 'situation').forEach(t => {
    const key = normTitle(t.situation_title) || 'situation ' + t.situation_num;
    let o = by.get(key);
    if (!o) {
      o = { num: t.situation_num, title: String(t.situation_title || '').trim() || ('situation ' + t.situation_num),
        row: runSitRow(t), runs: 0, passed: 0, tests: [] };
      by.set(key, o);
    }
    o.runs += +t.runs || 0;
    o.passed += +t.passed || 0;
    o.tests.push(t);
  });
  const out = [...by.values()];
  out.forEach(o => {
    o.rate = o.runs > 0 ? o.passed / o.runs : 0;
    o.failing = Math.max(0, o.runs - o.passed);
    o.facts = facts.filter(f => o.tests.indexOf(f.test) >= 0);
  });
  /* worst first — that is the order the reader wants; ties broken by
   * how many conversations the row is costing */
  out.sort((a, b) => a.rate - b.rate || b.failing - a.failing
    || String(a.title).localeCompare(String(b.title)));
  return out;
}

/* ---------- the report's words ----------
 * Everything the report prints is for a busy reader whose first
 * language is not English: short sentences, common words, and one
 * plain line saying what each number means. The judge is "the judge",
 * a criterion is "a check", the rationale is "the judge's notes". */

/* the three chip colours, read per situation and per driver type:
 * red under half the calls passed, amber under all, green at all */
const runBarCls = r => (r >= 1 ? 'ok' : r >= 0.5 ? 'warn' : 'bad');

/* a real turn cut to one readable line: whole sentences when they fit,
 * otherwise the first words and an ellipsis — never mid-word */
function runClip(text, max = 88) {
  const s = runStrip(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (end >= 30) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut) + '…';
}
const runSentences = text => runStrip(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
/* the sentence that matches, with the one before it when both fit */
function runAround(text, re, max = 88) {
  const ss = runSentences(text);
  const i = ss.findIndex(s => re.test(s));
  if (i < 0) return runClip(text, max);
  const two = i > 0 ? ss[i - 1] + ' ' + ss[i] : ss[i];
  return two.length <= max ? two : runClip(ss[i], max);
}
/* the driver's turn just before turn i */
const runPrevUser = (turns, i) => { for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'user') return turns[j]; return null; };
/* the driver's report, as one line: the sidetracked driver opens with
 * an aside and reports after "anyway" — that part is the report */
function runReportLine(text) {
  const s = runStrip(text).replace(/\s+/g, ' ').trim();
  const m = /\banyway\b[\s,—–:-]*/i.exec(s);
  const rep = m && s.slice(m.index + m[0].length).trim().length > 12 ? s.slice(m.index + m[0].length).trim() : s;
  return runClip(rep.charAt(0).toUpperCase() + rep.slice(1));
}

/* The next thing Otto could ask, built from the situation's own row:
 * the follow-up on the sheet that the driver has said least about,
 * turned into one short question. Empty on the control row — there is
 * nothing to ask after "nothing to report". */
function runAskLine(row, saidText) {
  const items = row ? sitList(row.follow_up) : [];
  if (!items.length) return 'Is there anything the next driver should know?';
  if (/^nothing\b/i.test(items[0])) return '';
  const said = runBag(saidText || '');
  let pick = items[0];
  let best = Infinity;
  items.forEach(p => { const ov = runHits(said, p); if (ov < best) { best = ov; pick = p; } });
  let q = pick.trim();
  if (q.length > 60) q = q.split(/\s+[—–]\s+/)[0];
  /* one thing at a time: a sheet item that bundles two questions ("how
   * long it cost and whether the parcel was delivered") is cut at the
   * second one — Otto never asks two things in one breath */
  q = q.split(/\s+(?:and|or)\s+(?=(?:whether|how|which|where|what|when|who|if)\b)/i)[0];
  q = q.replace(/[.?!]+$/, '').trim();
  const lead = /^(how|whether|which|where|what|when|who|if)\b/i.test(q) ? 'Do you know '
    : /^(the|an?)\b/i.test(q) ? 'What is ' : 'Can you tell me ';
  return lead + q.charAt(0).toLowerCase() + q.slice(1) + '?';
}
/* the one-line close the row exists to produce */
function runCloseLine(row) {
  let tip = String((row && row.tip) || '').trim().replace(/\.+$/, '');
  if (!tip) return 'Thanks — that goes to the next driver. Safe trip.';
  if (/nothing to note/i.test(tip)) return 'Good — a normal one, nothing to note. Thanks, safe trip.';
  /* "Kollwitzstraße 48: the gate code…" — on the phone both sides know
   * the stop, so the address label in front of the tip is dropped */
  tip = tip.replace(/^[^:]{3,48}:\s+(?=[a-zäöü])/, '');
  return `For the next driver: ${tip}. Thanks, safe trip.`;
}

/* ---------- a call that passed ----------
 * The loop keeps one passed run per test (`success`, the shortest with
 * words in it). Per situation, the shortest of those — the call the
 * "after" side of a suggestion can quote instead of lines written from
 * the sheet: Otto's own words, judged good. */
function runGoodCalls(run) {
  const out = {};
  agentRunTests(run).forEach(t => {
    const s = jsonOf(t.success);
    const raw = s && typeof s === 'object' ? jsonOf(s.transcript) : null;
    const turns = Array.isArray(raw) ? raw.filter(u => u && typeof u === 'object' && u.message) : [];
    if (!turns.length) return;
    const k = String(t.situation_num);
    if (!out[k] || turns.length < out[k].turns.length) out[k] = { turns, test: t };
  });
  return out;
}
/* the same moment in a call that passed, in the shape the pattern's
 * "today" side has: the report and Otto's next line for the patterns
 * about the middle of the call, the last exchange for the ones about
 * the tip, the report and Otto's questions for the count */
function runGoodSlice(id, turns) {
  const iU = turns.findIndex(u => u.role === 'user');
  if (iU < 0) return null;
  const L = u => runLine(u.role === 'user' ? 'DRIVER' : 'OTTO', runClip(u.message));
  const after = turns.slice(iU + 1);
  const otto = after.filter(u => u.role !== 'user');
  if (!otto.length) return null;
  if (id === 'tip-partial' || id === 'tip-none') {
    const iL = turns.lastIndexOf(otto[otto.length - 1]);
    const prev = iL > 0 ? turns[iL - 1] : null;
    return [...(prev && prev.role === 'user' ? [L(prev)] : []), L(turns[iL])];
  }
  if (id === 'questions') return [L(turns[iU]), ...otto.slice(0, 4).map(L)];
  return [L(turns[iU]), L(otto[0])];
}

/* ---------- Today / After the change ----------
 * The "Today" side is a REAL call from this run — the shortest one the
 * pattern has. The "After" side is the same moment, written the way
 * the suggestion asks for, from the same situation's row. Each side is
 * two to four lines of DRIVER / OTTO. */
const runShorter = (a, b) => a.turns.length - b.turns.length
  || a.turns.reduce((n, u) => n + String(u.message || '').length, 0) - b.turns.reduce((n, u) => n + String(u.message || '').length, 0);
const runLine = (who, text) => ({ who, text });
function runExample(id, f, good) {
  if (!f) return null;
  const t = f.turns;
  const iU = t.findIndex(u => u.role === 'user');
  const report = iU < 0 ? '' : runReportLine(t[iU].message);
  const saidAll = t.filter(u => u.role === 'user').map(u => u.message).join(' ');
  const row = f.row;
  const close = runCloseLine(row);
  const today = [];
  const after = [];
  let note = '';
  if (id === 'readback') {
    const i = t.findIndex((u, k) => k > 0 && u.role !== 'user' && runStrip(u.message) === f.readback);
    const prev = i > 0 ? runPrevUser(t, i) : null;
    if (i < 0 || !prev) return null;
    const said = t.slice(0, i).filter(u => u.role === 'user').map(u => u.message).join(' ');
    const q = runAskLine(row, said);
    today.push(runLine('DRIVER', runClip(prev.message)), runLine('OTTO', runClip(t[i].message)));
    after.push(runLine('DRIVER', runClip(prev.message)), runLine('OTTO', q ? 'Got it. ' + q : close));
  } else if (id === 'filed') {
    const i = t.findIndex(u => u.role !== 'user' && RUN_FILED.test(runStrip(u.message)));
    if (i < 0) return null;
    const prev = runPrevUser(t, i);
    const isLast = !t.slice(i + 1).some(u => u.role !== 'user');
    const said = t.slice(0, i).filter(u => u.role === 'user').map(u => u.message).join(' ');
    const q = runAskLine(row, said);
    if (prev) { today.push(runLine('DRIVER', runClip(prev.message))); after.push(runLine('DRIVER', runClip(prev.message))); }
    else if (report) { today.push(runLine('DRIVER', report)); after.push(runLine('DRIVER', report)); }
    today.push(runLine('OTTO', runAround(t[i].message, RUN_FILED)));
    after.push(runLine('OTTO', isLast || !q ? close : 'Thanks. ' + q));
  } else if (id === 'tip-partial' || id === 'tip-none') {
    let iL = -1;
    t.forEach((u, k) => { if (u.role !== 'user') iL = k; });
    if (iL < 0) return null;
    const prev = runPrevUser(t, iL);
    if (prev) { today.push(runLine('DRIVER', runClip(prev.message))); after.push(runLine('DRIVER', runClip(prev.message))); }
    today.push(runLine('OTTO', runClip(t[iL].message)));
    after.push(runLine('OTTO', close));
  } else if (id === 'questions') {
    const qs = [];
    t.forEach((u, k) => { if (k > iU && u.role !== 'user') runSentences(u.message).forEach(s => { if (/\?$/.test(s)) qs.push(runClip(s)); }); });
    if (!qs.length || !report) return null;
    today.push(runLine('DRIVER', report), ...qs.slice(0, 3).map(q => runLine('OTTO', q)));
    after.push(runLine('DRIVER', report), ...qs.slice(0, 2).map(q => runLine('OTTO', q)), runLine('OTTO', close));
    note = `Today: ${f.questions} question${f.questions === 1 ? '' : 's'} in this call. The driver's answers are left out to keep it short.`;
  } else if (id === 'unsaid') {
    let tok = f.unsaid[0];
    if (!tok || !f.follow || !report) return null;
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (/^\d/.test(tok)) { const m = f.follow.match(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[\\wäöüß]+')); if (m) tok = m[0]; }
    today.push(runLine('DRIVER', report), runLine('OTTO', runAround(f.follow, re)));
    after.push(runLine('DRIVER', report), runLine('OTTO', `Was that ${tok}? I want the notes to be right.`));
  } else if (id === 'follow-elsewhere') {
    if (!f.follow || !report) return null;
    const q = runAskLine(row, saidAll);
    today.push(runLine('DRIVER', report), runLine('OTTO', runClip(f.follow)));
    after.push(runLine('DRIVER', report), runLine('OTTO', q ? 'Sorry to hear that. ' + q : close));
  } else return null;
  /* a call from this run that passed, same situation: the "after" side
   * becomes Otto's own words instead of lines written from the sheet */
  let real = null;
  const g = good && good[String(f.test.situation_num)];
  if (g) {
    const slice = runGoodSlice(id, g.turns);
    if (slice && slice.length) { after.length = 0; after.push(...slice); real = agentWho(g.test); }
  }
  return { today, after, note, real, who: agentWho(f.test), title: String((row && row.title) || f.test.situation_title || '').trim() };
}

/* ---------- what went wrong: the patterns ----------
 * One entry per pattern that actually happened in this run: its count,
 * the one plain sentence the list prints, the chart's short label, how
 * it was counted, and the calls it was found in. Ranked by count. The
 * greeting is not a pattern: "Hello! How can I help you today?" is the
 * agent's chosen first line, and the question count never includes it. */
const RUN_PATTERNS = [
  /* id = the NOT A PROBLEM key (fixed, never a count or a position);
   * name = the finding as the list words it; label = the chart's label */
  { id: 'readback', test: f => !!f.readback, label: 'Repeated the driver\'s words', name: 'Otto repeats what the driver just said',
    line: (k, of) => `In ${k} of ${of}, Otto repeated what the driver had just said.`,
    how: 'We looked for a turn where Otto used three or more of the same words as the driver\'s last answer. Otto\'s last line is not counted — there he should say the tip back.' },
  { id: 'tip-partial', test: f => f.tipState === 'partial', label: 'Tip missing its detail', name: 'Otto\'s last line has only part of the tip',
    line: (k, of) => `In ${k} of ${of}, Otto\'s last line had only part of the tip — the place without the time, the day, the door or the distance.`,
    how: 'We compared Otto\'s last line with the tip on the situation\'s row. At least one of the tip\'s main words was there, but fewer than half of them.' },
  { id: 'filed', test: f => f.filed, label: 'Said "I have noted that"', name: 'Otto says "I have noted that"',
    line: (k, of) => `In ${k} of ${of}, Otto said "I have noted that" or "I\'ll file that".`,
    how: 'We looked in Otto\'s turns for "I have noted / logged / filed / recorded", "noted that", "noted down" or "I\'ll note / log / file".' },
  { id: 'tip-none', test: f => f.tipState === 'none', label: 'No tip at the end', name: 'Otto ends without a tip',
    line: (k, of) => `In ${k} of ${of}, Otto ended without any tip for the next driver.`,
    how: 'Not one of the main words of the row\'s tip was in Otto\'s last line.' },
  { id: 'questions', test: f => f.questions > 3, label: 'More than three questions', name: 'Otto asks more than three questions',
    line: (k, of) => `In ${k} of ${of}, Otto asked more than three questions after the driver\'s report.`,
    how: 'We counted question marks in Otto\'s turns after the driver\'s first words. Otto\'s greeting is not counted. Three is the most the check allows. We count marks, not meaning, so the number is close, not exact.' },
  { id: 'unsaid', test: f => f.unsaid.length > 0, label: 'Said something the driver had not said', name: 'Otto says something the driver did not say',
    line: (k, of) => `In ${k} of ${of}, Otto said a street, a name or a number that the driver had not said.`,
    how: 'We looked at Otto\'s first question after the report. A name, or a number with a unit, that Otto stated (not asked) and that the driver had not said, counts. The first word of a sentence is never counted.' },
  { id: 'follow-elsewhere', test: f => f.offTopic > f.onTopic, label: 'First question off topic', name: 'Otto\'s first question is off topic',
    line: (k, of) => `In ${k} of ${of}, Otto\'s first question was about something else, not what the driver reported.`,
    how: 'We compared the words of Otto\'s first question with the row\'s "a good follow-up asks about" list and its "off topic here" list. It counts only when the off-topic list matches more.' },
];
function runFindings(run, facts) {
  const n = facts.length;
  if (!n) return [];
  const out = RUN_PATTERNS.map(p => {
    const hits = facts.filter(p.test).sort(runShorter);
    return hits.length ? { ...p, count: hits.length, n, hits } : null;
  }).filter(Boolean).sort((a, b) => b.count - a.count);
  const used = new Set();
  const good = runGoodCalls(run);
  out.forEach((fd, i) => {
    fd.text = fd.line(fd.count, i === 0 ? `the ${n} failed call${n === 1 ? '' : 's'}` : `${n} call${n === 1 ? '' : 's'}`);
    /* the shortest call that has the pattern AND yields a Today / After
     * example — from a situation no earlier card is showing, when there
     * is one, so the cards do not all quote the same call */
    fd.example = fd.hits[0];
    fd.ex = null;
    let first = null;
    for (const h of fd.hits) {
      const e = runExample(fd.id, h, good);
      if (!e) continue;
      if (!first) first = { e, h };
      if (!used.has(e.title)) { first = { e, h }; break; }
    }
    if (first) { fd.ex = first.e; fd.example = first.h; used.add(first.e.title); }
  });
  return out;
}

/* What a failed call looks like: the greeting Otto opens with, said
 * once and neutrally, then how much he talks and asks. Measurements,
 * not faults — the middle value and the range. */
function runShape(facts) {
  if (!facts.length) return '';
  const mid = list => {
    const v = [...list].sort((a, b) => a - b);
    const h = Math.floor(v.length / 2);
    return v.length % 2 ? v[h] : Math.round((v[h - 1] + v[h]) / 2);
  };
  const openers = new Map();
  facts.forEach(f => { const k = f.opener || ''; openers.set(k, (openers.get(k) || 0) + 1); });
  const [top, topN] = [...openers.entries()].sort((a, b) => b[1] - a[1])[0];
  const turns = facts.map(f => f.agentTurns);
  const qs = facts.map(f => f.questions);
  const greet = !top ? '' : topN === facts.length
    ? `Every call starts with Otto's greeting: “${top}” `
    : `Most calls (${topN} of ${facts.length}) start with Otto's greeting: “${top}” `;
  const mq = mid(qs);
  return `${greet}Then the driver reports. In a failed call, Otto speaks ${mid(turns)} times in all (${Math.min(...turns)} to ${Math.max(...turns)}) `
    + `and asks ${mq} question${mq === 1 ? '' : 's'} after the report (${Math.min(...qs)} to ${Math.max(...qs)}). `
    + 'We count question marks, so the question number is close, not exact.';
}

/* the checks that HELD — the same facts, counted the other way round,
 * so the good news is as counted as the bad */
function runHeld(facts) {
  const n = facts.length;
  if (!n) return [];
  const list = [
    [f => !(f.offTopic > f.onTopic), k => `In ${k} of ${n} failed calls, Otto's first question was still about what the driver reported.`],
    [f => !f.unsaid.length, k => `In ${k} of ${n} failed calls, Otto did not invent any street, name or number.`],
    [f => f.tipState === 'ok' || f.tipState === 'partial', k => `In ${k} of ${n} failed calls, Otto's last line still had at least part of the tip.`],
    [f => f.questions <= 3, k => `In ${k} of ${n} failed calls, Otto still kept to three questions or fewer.`],
    [f => !f.filed, k => `In ${k} of ${n} failed calls, Otto did not talk about noting or filing.`],
    [f => !f.readback, k => `In ${k} of ${n} failed calls, Otto did not repeat the driver's words back.`],
  ];
  return list.map(([test, line]) => [facts.filter(test).length, line])
    .filter(([k]) => k / n >= 0.6).sort((a, b) => b[0] - a[0]).map(([k, line]) => line(k));
}

/* ---------- per driver type ---------- */
const RUN_TYPES = {
  cooperative: 'answers fully and adds one useful detail of their own.',
  terse: 'answers in three to six words and adds nothing until asked.',
  sidetracked: 'starts with small talk, then answers.',
  vague: 'says “it did not really work out” and no more until Otto asks what happened.',
};
function runPersonas(roll) {
  return roll.personas.map(p => {
    const tests = roll.tests.filter(x => x.persona === p);
    const runs = tests.reduce((s, x) => s + (+x.runs || 0), 0);
    const passed = tests.reduce((s, x) => s + (+x.passed || 0), 0);
    return { persona: p, runs, passed, rate: runs ? passed / runs : 0 };
  });
}

/* ---------- the old rule ----------
 * Runs graded before the LENGTH check was reworded sometimes counted
 * Otto's greeting as a question. Where a stored note under check 5 did
 * that, the page says so — it is the old rule, not a fault in Otto. A
 * note that calls the greeting "not a question" is the new rule. */
const RUN_OLD_RULE = [
  /\b(plus|including|combined with|counting|with)\s+(the|his|an?)\s+opening\s*(greeting|message|line|['‘"]|[,.;—–-]|$)/i,
  /\bopening\s+(greeting|message|question|line)\s+counts?\b/i,
  /['’"]\s*\(opening\)/i,
  /\bhow can i help[^.]{0,40}\(opening\)/i,
  /\(\s*1\s*\)\s*(the\s+)?opening\s+['‘"]?(hello|how can)/i,
  /\b(hello|how can i help)[^.]*\b(counts?|counted|totall?ing)\b/i,
];
const RUN_OLD_NOT = [
  /\b(opening|greeting)[^.]{0,60}\b(not|n['’]t)\s+(a\s+)?(real\s+|relevant\s+|genuine\s+|substantive\s+)?question\b/i,
  /\b(not|n['’]t)\s+count(?:ed)?\b/i,
  /\bexclud(?:e|es|ed|ing)\s+the\s+(opening|greeting)/i,
];
const runOldRule = (n, text) => n === 5 && RUN_OLD_RULE.some(re => re.test(text)) && !RUN_OLD_NOT.some(re => re.test(text));
const RUN_OLD_NOTE = 'Graded by the old rule — the greeting was counted as a question. The next run counts only follow-ups.';

/* ---------- the analysis, memoised ----------
 * A published run never changes, so the whole analysis is computed once
 * per run and kept — the page re-renders on every click. */
let runAnalysisCache = { id: null, out: null };
function runAnalysis(run) {
  if (!run) return null;
  if (runAnalysisCache.id === run.id && runAnalysisCache.out) return runAnalysisCache.out;
  const facts = runFacts(run);
  const roll = runRollup(run);
  const out = {
    roll,
    facts,
    findings: runFindings(run, facts),
    held: runHeld(facts),
    sits: runSituations(run, facts),
    personas: runPersonas(roll),
    shape: runShape(facts),
  };
  /* the judge's notes by check: only a paragraph that says clearly the
   * check was missed counts; the rest stays "unclear", never guessed.
   * A check-5 paragraph written under the old rule is kept apart. */
  const crit = {};
  facts.forEach(f => runReasonParas(f.rationale).forEach(p => {
    const o = crit[p.n] || (crit[p.n] = { paras: 0, plain: 0, old: 0, fail: 0, pass: 0 });
    o.paras++;
    const v = runVerdictOf(p.text);
    if (v === 'fail') o.fail++;
    else if (v === 'pass') o.pass++;
    else if (runOldRule(p.n, p.text)) o.old++;
    else if (runSaysPlainly(p.n, p.text)) o.plain++;
  }));
  out.criteria = Object.keys(crit).map(Number).sort((a, b) => a - b)
    .map(k => ({ idx: k, ...crit[k] }));
  /* the judge's word over EVERY call of the run, passed ones included —
   * the loop counts it per test (checks) and per suite (by_check) */
  const sum = jsonOf(run.summary);
  out.byCheck = sum && sum.by_check && typeof sum.by_check === 'object' ? sum.by_check : null;
  runAnalysisCache = { id: run.id, out };
  return out;
}

/* The suggestion text, on the clipboard. The <pre> is selectable
 * anyway — this is the one-tap version of the same thing, and it fails
 * visibly rather than silently: an insecure origin or a browser without
 * the clipboard API gets the text selected instead, ready for ⌘C. */
function copySuggestion(btn) {
  const pre = document.getElementById(btn.dataset.copy);
  if (!pre) return;
  const text = pre.textContent;
  const said = ok => {
    const was = btn.textContent;
    btn.textContent = ok ? '✓ copied' : 'selected — press ⌘C / Ctrl-C';
    setTimeout(() => { btn.textContent = was; }, 2200);
  };
  const select = () => {
    try {
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { warn(e); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => said(true), () => { select(); said(false); });
  } else { select(); said(false); }
}

/* ---------- the run list ---------- */
function renderRunList() {
  const note = suiteStateNote(true);
  if (note) return `<div class="rl-empty"><p class="cmp-empty agent-note">${note}</p></div>`;
  const rows = agentRuns.map(r => {
    const roll = runRollup(r);
    const label = r.label === 'branch' || r.branch_id ? 'PROPOSED PROMPT' : 'LIVE PROMPT';
    const verdict = r.verdict ? `<span class="rl-verdict ${r.verdict === 'accept' ? 'ok' : 'bad'}"
        title="${esc('The loop\'s own verdict on this run' + (r.verdict_reason ? ': ' + r.verdict_reason : ''))}">${esc(String(r.verdict).toUpperCase())}</span>` : '';
    return `
      <article class="rl-row" data-run="${esc(r.id)}" tabindex="0"
        title="${esc(`ran ${fmtTime(agentRanAt(r))} · label ${r.label || '?'} · agent ${r.agent_id || '?'}${r.branch_id ? ' · branch ' + r.branch_id : ''}`)}">
        <span class="rl-when" title="${esc(fmtTime(agentRanAt(r)))}">${esc(fmtAgo(agentRanAt(r)) || '—')}</span>
        <span class="rl-label">${esc(label)}${roll.suite ? ' · ' + esc(roll.suite) : ''}${roll.repeat ? ' · ×' + roll.repeat : ''}</span>
        <span class="agent-chip ${runCls(roll.rate)}">${esc(runPct(roll.rate))}</span>
        <span class="rl-tests">${roll.passed} of ${roll.conv} calls passed · ${roll.perfect} of ${roll.nTests} tests passed every time</span>
        ${verdict}
        ${/^https?:\/\//i.test(String(r.run_url || '')) ? `<a class="row-link" href="${esc(r.run_url)}" target="_blank" rel="noopener">open the GitHub run ↗</a>` : ''}
        <span class="rl-go">open the report →</span>
      </article>`;
  }).join('');
  return `
    <div class="rl-list">
      <p class="rl-intro">One report per test run: what went well, what went wrong, and what to change. Reading it changes nothing on the agent.</p>
      ${rows}
    </div>`;
}

/* ---------- one real call, as evidence ----------
 * Two folded blocks, both closed to start: the conversation as DRIVER /
 * OTTO turns, and the judge's notes on it word for word, one paragraph
 * per check, each labelled with what the check is about. */
function renderRunCall(f) {
  if (!f) return '';
  const paras = runReasonParas(f.rationale);
  const who = `${agentWho(f.test)} driver · ${String(f.test.situation_title || f.test.name || '').slice(0, 60)} · ${f.turns.length} turns`;
  return `
      <details class="rs-more rs-call"><summary>show a real call</summary>
        <p class="rs-call-who">${esc(who)}</p>
        ${f.turns.map(u => `<div class="msg-turn ${u.role === 'user' ? 'me' : 'ai'}"><b>${u.role === 'user' ? 'DRIVER' : 'OTTO'}</b>${esc(u.message || '')}${runToolNote(u)}</div>`).join('')}
      </details>
      ${paras.length || f.rationale ? `<details class="rs-more rs-notes"><summary>the judge&rsquo;s notes on this call</summary>
        <p class="rs-how">Word for word, one paragraph per check. Nothing is shortened.</p>
        ${paras.length ? paras.map(p => `<p class="rs-reason"><b>${p.n}. ${esc(RUN_CRITERIA[p.n - 1] || 'check ' + p.n)}</b>${esc(p.text)}${
    runOldRule(p.n, p.text) ? `<span class="rs-old">${esc(RUN_OLD_NOTE)}</span>` : ''}</p>`).join('')
    : `<p class="rs-reason">${esc(f.rationale)}</p>`}
      </details>` : ''}`;
}

/* the Today / After box of a suggestion */
function renderRunExampleBox(ex) {
  const side = (k, cls, lines) => `
        <div class="rs-ex-side${cls}"><span class="rs-ex-k">${k}</span>${lines.map(l =>
    `<div class="rs-ex-line ${l.who === 'DRIVER' ? 'me' : 'ai'}"><b>${l.who}</b><span>${esc(l.text)}</span></div>`).join('')}</div>`;
  return `
      <div class="rs-ex-wrap">
        <p class="rs-sug-p"><b>Example</b>${ex.title ? `<span class="rs-ex-from">“Today” is a real call from this run — the ${esc(ex.who)} driver, “${esc(ex.title)}”.${ex.real
          ? ` “After” is a real call too: one from this run that passed, the ${esc(ex.real)} driver at the same situation.`
          : ' “After” is written from the situation\'s row — no call at this situation passed in this run.'}</span>` : ''}</p>
        <div class="rs-ex2">${side('Today', '', ex.today)}${side(ex.real ? 'After — a call that passed' : 'After the change', ' after', ex.after)}</div>
        ${ex.note ? `<p class="rs-how">${esc(ex.note)}</p>` : ''}
      </div>`;
}

/* ---------- the suggestions ----------
 * One card per pattern that happened, in the findings' own order, each
 * in the same shape: a plain title, what happened (with the count), why
 * it matters to the driver, a Today / After example, and the line to
 * paste. The rows at 0% get a card of their own with no prompt line. */
const RUN_FIXES = {
  readback: { title: 'Stop repeating what the driver said',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto repeated the driver's report back to them.`,
    why: 'It wastes the driver\'s time and sounds like a form being filled in. The driver is standing in a doorway. Every wasted sentence costs them time. Ask the next question instead.',
    text: 'Do not repeat the driver\'s report back to them. Say "Got it" or "Thanks", then ask your next question.' },
  'tip-partial': { title: 'Keep the important detail in the final summary',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto's last line had the place but not the condition.`,
    why: 'The next driver needs the condition — the time, the day, the door, the distance. "Loading bay on Husemannstraße" is useless without "free before ten".',
    text: 'When you confirm the tip, include the detail that makes it useful: the time of day, the day of the week, the door, or the distance. A place without its condition is not a tip.' },
  filed: { title: 'Do not say "I have noted that"',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto told the driver he had noted or filed the report.`,
    why: 'The app files the report by itself. The sentence adds nothing, and it often ends the call before the tip is confirmed.',
    text: 'Never say that you have noted, logged or filed anything. The app files the report by itself. Go straight to your next question, or to the tip.' },
  questions: { title: 'Ask at most three questions, then stop',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto asked more than three questions after the driver's report.`,
    why: 'The driver is in a doorway or a running van. A long call means they stop pressing REPORT.',
    text: 'Ask at most three questions, one at a time. When the driver has already said the rest, one is enough. After the third question, say the tip and end the call.' },
  'tip-none': { title: 'Always end with the one-line tip',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto ended without any tip for the next driver.`,
    why: 'The tip is the whole point of the call. Without it, nothing useful is filed for the next driver.',
    text: 'Your last line must be the tip for the next driver: the place and its condition, in one sentence. Then thank the driver and stop.' },
  unsaid: { title: 'Ask, don\'t tell, about the notes on file',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto said a street, a name or a number the driver had not said.`,
    why: 'Otto put a detail from the notes in the driver\'s mouth. If the notes are wrong, a wrong tip gets filed, and the next driver follows it.',
    text: 'Never name a street, a time, a person or a distance the driver has not named, even if it is in the notes. Ask if it was that, instead of saying it was.' },
  'follow-elsewhere': { title: 'Make the first question about what the driver reported',
    what: (k, n) => `In ${k} of the ${n} failed calls, Otto's first question was about something else.`,
    why: 'The driver feels not listened to and stops talking. The first question shows whether Otto heard them.',
    text: 'Your first question must be about the thing the driver just reported. Name it in the question.' },
};

/* "#6 The pin is wrong" — the sheet's own row number where the row is
 * found, so the name matches the SITUATIONS tab; the run's number
 * otherwise */
const runSitName = s => `${s.row && s.row.num != null ? '#' + s.row.num + ' ' : s.num != null ? '#' + s.num + ' ' : ''}${s.title}`;
/* the same, with the title in quotes — for a sentence, where a title
 * with a dash of its own would otherwise run into the sentence's */
const runSitQuote = s => `${s.row && s.row.num != null ? '#' + s.row.num + ' ' : s.num != null ? '#' + s.num + ' ' : ''}“${s.title}”`;
const runTestName = t => {
  if (t.kind === 'situation') { const row = runSitRow(t); return `${row && row.num != null ? '#' + row.num + ' ' : ''}“${String(t.situation_title || '').trim()}”`; }
  return `“${String(t.scenario_title || t.name || '').replace(/^Otto · /, '').trim()}”`;
};

/* one horizontal bar: the name, the bar, and the number on it */
function renderRunBar(name, rate, val, cls, attrs, title) {
  const w = Math.max(0, Math.min(100, (+rate || 0) * 100)).toFixed(1);
  return `
        <div class="rs-bar-row${attrs ? ' link' : ''}" ${attrs || ''} title="${esc(title)}">
          <span class="rs-bar-name">${name}</span>
          <span class="rs-bar-track"><span class="rs-bar-fill ${cls}" style="width:${w}%"></span></span>
          <span class="rs-bar-val">${esc(val)}</span>
        </div>`;
}

/* ---------- the NOT A PROBLEM list ----------
 * A finding the designer has ruled fine by design. Marking it keeps
 * the pattern and its suggestion out of EVERY run report, and lists
 * it under "You said these are fine" with an UNDO. The pass rate is
 * the suite's and is never touched. Saved to the backend when the
 * table exists; kept in memory for this session when it does not,
 * with a persistent hint saying how to create it. The key is the
 * pattern's fixed id — never a count or a position — so it holds
 * across reloads and runs; a suggestion shares its pattern's key, so
 * marking either hides both. The rows-at-0% card has its own key. */
const ACCEPTED_HINT = 'The NOT A PROBLEM list needs a new table. Paste the accepted_findings block from supabase/schema.sql into Supabase → SQL editor once, then ↻ REFRESH.';
const ROWS_KEY = 'rows-at-zero';
const ROWS_NAME = 'Situations that fail with every driver type';
const acceptedMissingErr = e => /\b404\b|PGRST205|42P01|schema cache/i.test(String((e && e.message) || ''));
const acceptedHint = () => {
  if (!Backend.enabled) return;
  schemaMsg = ACCEPTED_HINT;
  el('stats').textContent = schemaMsg;
};
function acceptFinding(key, title) {
  if (!key) return;
  const note = window.prompt('Why is this fine? One line, optional. (No prompt text — this list is public.)', '');
  if (note === null) return;  // cancelled: nothing marked
  const row = { key, title: String(title || key), note: String(note).trim() || null, decided_at: new Date().toISOString() };
  accepted = [row, ...accepted.filter(r => r.key !== key)];
  acceptedOpen = true;
  render();
  if (!Backend.enabled) return;
  if (acceptedMissing) { acceptedHint(); return; }
  Backend.acceptFinding({ key: row.key, title: row.title, note: row.note }).then(rows => {
    const saved = Array.isArray(rows) ? rows[0] : null;
    if (saved && saved.key) accepted = accepted.map(r => (r.key === saved.key ? { ...r, ...saved } : r));
  }).catch(e => {
    warn(e);
    if (acceptedMissingErr(e)) { acceptedMissing = true; acceptedHint(); return; }
    el('stats').textContent = `The mark did not reach the backend — ${String((e && e.message) || '').slice(0, 80)}. It is kept in this browser until ↻ REFRESH.`;
  });
}
function unacceptFinding(key) {
  accepted = accepted.filter(r => r.key !== key);
  render();
  if (!Backend.enabled || acceptedMissing) return;
  Backend.unacceptFinding(key).catch(e => {
    warn(e);
    if (acceptedMissingErr(e)) { acceptedMissing = true; acceptedHint(); }
  });
}
const renderNapBtn = (key, title) => `<button class="mini-btn rs-nap" type="button" data-nap="${esc(key)}" data-nap-title="${esc(title)}"
            title="Mark this as fine by design. It leaves every run report and the suggestions; UNDO is at the end of the report.">NOT A PROBLEM</button>`;

/* ---------- the report ---------- */
function renderRunSummary(run) {
  const a = runAnalysis(run);
  const { roll, facts, findings, held, sits, criteria, personas, shape, byCheck } = a;
  const n = facts.length;
  const back = '<button class="mini-btn rs-back" type="button" data-run-act="all">← all runs</button>';
  const link = /^https?:\/\//i.test(String(run.run_url || ''))
    ? `<a class="row-link" href="${esc(run.run_url)}" target="_blank" rel="noopener">open the GitHub run ↗</a>` : '';
  const failed = Math.max(0, roll.conv - roll.passed);
  const pct = Math.round(roll.rate * 100);
  const calls = k => `${k} call${k === 1 ? '' : 's'}`;
  const sitN = roll.rowCount;
  const perN = roll.personas.length;
  const shapeLine = sitN && perN && roll.repeat
    ? `${sitN} situation${sitN === 1 ? '' : 's'} × ${perN} driver type${perN === 1 ? '' : 's'} × ${roll.repeat} run${roll.repeat === 1 ? '' : 's'} each = ${calls(roll.conv)}.` : '';
  /* the NOT A PROBLEM list applies to every run: a pattern on it is not
   * a problem here, not in the chart, and not a suggestion */
  const onList = new Set(accepted.map(r => r.key));
  const shown = findings.filter(fd => !onList.has(fd.id));
  const hiddenN = findings.length - shown.length;
  const rowsHidden = onList.has(ROWS_KEY);

  /* (a) the big number and the stacked bar */
  const head = `
      <div class="rs-head">
        <div class="rs-head-top">${back}${link}</div>
        <div class="rs-hero">
          <div class="rs-hero-n"><span class="rs-big">${pct}%</span><span class="rs-big-k">of test calls passed</span></div>
          <div class="rs-hero-t">
            <p class="rs-lead">Otto passed <b>${roll.passed} of ${roll.conv}</b> test calls. That is ${pct} out of 100.</p>
            <div class="rs-stack" role="img" aria-label="${esc(`${roll.passed} passed, ${failed} failed`)}">
              ${roll.passed > 0 ? `<span class="rs-stack-seg ok" style="width:${(100 * roll.passed / Math.max(1, roll.conv)).toFixed(2)}%"></span>` : ''}
              ${failed > 0 ? '<span class="rs-stack-seg bad"></span>' : ''}
            </div>
            <p class="rs-legend"><span><span class="rs-sw ok"></span>${roll.passed} passed</span><span><span class="rs-sw bad"></span>${failed} failed</span></p>
            <p class="rs-sub">${roll.perfect} of ${roll.nTests} tests passed every time. ${esc(shapeLine)}</p>
          </div>
        </div>
        <p class="rs-note">${n ? `The judge kept one conversation for each failed test — <b>${n}</b> of them. The counts below are out of those ${n}.`
      : 'The judge kept no failed conversation from this run, so nothing below is counted from calls.'}</p>
        ${shape ? `<p class="rs-note">${esc(shape)}</p>` : ''}
        <p class="rs-meta">
          <span title="${esc(fmtTime(agentRanAt(run)))}">ran ${esc(fmtAgo(agentRanAt(run)) || '—')}</span>
          · <span>${esc(run.label === 'branch' || run.branch_id ? 'a proposed prompt on a branch' : 'the live prompt')}</span>
          · <span>agent ${esc(run.agent_id || '?')}</span>
          ${run.branch_id ? `· <span>branch ${esc(run.branch_id)}</span>` : ''}
          ${run.verdict ? `· <span class="${run.verdict === 'accept' ? 'ok' : 'bad'}">${esc(String(run.verdict).toUpperCase())}${run.verdict_reason ? ' — ' + esc(run.verdict_reason) : ''}</span>` : ''}
        </p>
      </div>`;

  /* (b) Otto by situation — one bar each, worst first, click = the card */
  const sitChart = !sits.length ? '<p class="cmp-empty">This run has no situation tests.</p>' : `
        <div class="rs-bars">${sits.map(s => renderRunBar(esc(runSitName(s)), s.rate, `${s.passed} of ${s.runs}`, runBarCls(s.rate),
    s.row ? `data-sitjump="${esc(s.row.id)}" tabindex="0" role="button"` : '',
    `${s.title} — ${s.passed} of ${s.runs} calls passed. ${s.row ? 'Click to open this situation on the SITUATIONS tab.' : 'No row with this title on the SITUATIONS tab.'}`)).join('')}
        </div>
        <p class="rs-legend"><span><span class="rs-sw bad"></span>under half passed</span><span><span class="rs-sw warn"></span>half or more</span><span><span class="rs-sw ok"></span>all passed</span></p>`;
  const perSit = sits.length ? sits[0].runs : 0;

  /* (c) Otto by driver type */
  const typeChart = !personas.length ? '<p class="cmp-empty">This run has no driver types.</p>' : `
        <div class="rs-bars">${personas.map(p => renderRunBar(esc(p.persona), p.rate, `${p.passed} of ${p.runs}`, runBarCls(p.rate), '',
    `${p.persona}: ${p.passed} of ${p.runs} calls passed`)).join('')}
        </div>
        <ul class="rs-types">${personas.map(p => `<li><b>${esc(p.persona)}</b> ${esc(RUN_TYPES[p.persona] || 'a driver type from personas.json.')}</li>`).join('')}</ul>`;

  /* what went well — three short lines at most */
  const perfect = roll.tests.filter(t => +t.runs > 0 && +t.passed === +t.runs).sort(agentTestOrder);
  const best = sits.filter(s => s.passed > 0).sort((x, y) => y.rate - x.rate || y.passed - x.passed)[0];
  const well = [];
  if (perfect.length) {
    well.push(`${perfect.length} of ${roll.nTests} tests passed every time: ${perfect.slice(0, 3).map(t =>
      `${runTestName(t)}${t.persona ? ' with the ' + t.persona + ' driver' : ''}`).join(', ')}${perfect.length > 3 ? `, and ${perfect.length - 3} more` : ''}.`);
  }
  if (best) well.push(`Best situation: ${runSitQuote(best)} — ${best.passed} of ${best.runs} calls passed.`);
  if (held.length) well.push(held[0]);
  const wellBody = well.length ? `<ul class="rs-ul rs-well">${well.slice(0, 3).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p class="cmp-empty">Nothing passed in this run. There is no good news to report here.</p>';

  /* (d) what went wrong — the chart, then the list in the same order */
  const zero = sits.filter(s => s.runs > 0 && s.passed === 0);
  const wrongChart = !shown.length ? '' : `
        <div class="rs-bars rs-bars-wide">${shown.map(fd => renderRunBar(esc(fd.label), fd.count / n, `${fd.count} of ${n}`, 'acc', '',
    `${fd.label}: ${fd.count} of ${n} failed calls`)).join('')}
        </div>`;
  const wrongList = !shown.length ? '' : `
        <ol class="rs-wrong">${shown.map((fd, i) => `
          <li class="rs-item" data-finding="${esc(fd.id)}">
            <p class="rs-item-line"><span class="rs-rank">${i + 1}</span><span>${esc(fd.text)}</span></p>
            <div class="rs-item-more">
              ${renderRunCall(fd.example)}
              <details class="rs-more"><summary>how we counted this</summary><p class="rs-how">${esc(fd.how)}</p></details>
              ${renderNapBtn(fd.id, fd.name)}
            </div>
          </li>`).join('')}
        </ol>`;
  const hiddenLine = !hiddenN ? '' : `
        <p class="rs-how rs-hidden">${hiddenN === 1 ? '1 pattern is' : hiddenN + ' patterns are'} on your NOT A PROBLEM list and not shown here — see the end of the report.</p>`;
  const zeroLine = !zero.length || rowsHidden ? '' : `
        <p class="rs-item-line rs-zero"><span class="rs-rank">·</span><span>${zero.length} of ${sits.length} situations failed with every driver type: ${
    zero.map(s => esc(runSitName(s))).join(' · ')}. See the last card under WHAT TO CHANGE.</span></p>`;

  /* the suggestions, in the findings' order, the rows at 0% last */
  const sugg = shown.map(fd => (RUN_FIXES[fd.id] ? { ...RUN_FIXES[fd.id], id: fd.id, name: fd.name, what: RUN_FIXES[fd.id].what(fd.count, n), ex: fd.ex } : null)).filter(Boolean);
  if (zero.length && !rowsHidden) {
    sugg.push({ id: ROWS_KEY, name: ROWS_NAME, title: 'Check these rows on the SITUATIONS tab',
      what: `${zero.length} of ${sits.length} situations failed with every driver type.`,
      why: 'When no driver type gets through, the problem is often the row, not Otto. The driver\'s first words, or the follow-up the row expects, may not match how real drivers talk. Read the row and change it if it sounds wrong.',
      rows: zero });
  }
  const suggBody = sugg.map((s, i) => `
        <section class="rs-sug" data-sug="${esc(s.id)}">
          <div class="rs-sug-head"><span class="rs-rank">${i + 1}</span><h4>${esc(s.title)}</h4></div>
          <p class="rs-sug-p"><b>What happened</b>${esc(s.what)}</p>
          <p class="rs-sug-p"><b>Why it matters</b>${esc(s.why)}</p>
          ${s.ex ? renderRunExampleBox(s.ex) : ''}
          ${s.rows ? `<ul class="rs-ul rs-rows">${s.rows.map(z => `<li>${z.row
    ? `<button class="row-link" type="button" data-sitjump="${esc(z.row.id)}">${esc(runSitName(z))} — open the row →</button>`
    : `${esc(runSitName(z))} — no row with this title on the SITUATIONS tab`}</li>`).join('')}</ul>` : ''}
          ${s.text ? `
          <p class="rs-sug-p"><b>Add this to the prompt</b></p>
          <pre class="rs-pre" id="rs-fix-${i}">${esc(s.text)}</pre>` : ''}
          <div class="rs-sug-foot">
            ${s.text ? `<button class="mini-btn" type="button" data-copy="rs-fix-${i}">⎘ copy this text</button>
            <span class="fb-hint">Nothing is applied until you paste it into the prompt yourself.</span>` : ''}
            ${renderNapBtn(s.id, s.name)}
          </div>
        </section>`).join('');
  const suggEmpty = sugg.length ? '' : findings.length || zero.length
    ? '<p class="cmp-empty">Nothing left to change — every pattern found in this run is on your NOT A PROBLEM list.</p>'
    : '<p class="cmp-empty">No pattern in this run calls for a change.</p>';

  /* every situation, worst first — the detail behind the bars */
  const cols = roll.personas;
  const table = !sits.length ? '<p class="cmp-empty">This run has no situation tests.</p>' : `
        <table class="rs-tbl rs-sits">
          <thead><tr><th>#</th><th>situation</th><th>passed</th>${cols.map(p => `<th>${esc(p)}</th>`).join('')}<th>failed calls</th></tr></thead>
          <tbody>${sits.map(s => `
            <tr class="rs-sit-row${s.row ? '' : ' nolink'}" data-sitjump="${esc(s.row ? s.row.id : '')}" tabindex="0"
              title="${esc(s.row ? `Row #${s.row.num == null ? '?' : s.row.num} on the SITUATIONS tab — click to open it`
    : 'No row with this title on the SITUATIONS tab — load the starter situations, or it was renamed')}">
              <td>${s.row && s.row.num != null ? esc(s.row.num) : s.num == null ? '·' : esc(s.num)}</td>
              <td class="rs-sit-t">${esc(s.title)}</td>
              <td><span class="agent-chip ${runBarCls(s.rate)}">${s.passed} of ${s.runs}</span></td>
              ${cols.map(p => {
    const t = s.tests.find(x => x.persona === p);
    return `<td>${t ? `<span class="agent-chip ${agentCls(t)}">${+t.passed || 0}/${+t.runs || 0}</span>` : '<span class="rs-na">—</span>'}</td>`;
  }).join('')}
              <td class="rs-fail-n">${s.failing}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;

  /* the judge's notes by check — folded, at the bottom */
  const oldN = criteria.reduce((s, c) => s + c.old, 0);
  const worded = criteria.reduce((s, c) => s + c.fail + c.pass, 0);
  const bcKeys = byCheck ? Object.keys(byCheck).map(Number).filter(Number.isFinite).sort((x, y) => x - y) : [];
  const allCalls = !bcKeys.length ? '' : `
          <p class="rs-how">The judge&rsquo;s own word, over every call of this run, passed calls included:</p>
          <table class="rs-tbl">
            <thead><tr><th>#</th><th>the check</th><th>failed</th><th>of calls judged</th></tr></thead>
            <tbody>${bcKeys.map(n => `
              <tr><td>${n}</td><td>${esc(RUN_CRITERIA[n - 1] || 'check ' + n)}</td>
              <td>${(byCheck[n] && byCheck[n].fail) || 0}</td><td>${((byCheck[n] && byCheck[n].fail) || 0) + ((byCheck[n] && byCheck[n].pass) || 0)}</td></tr>`).join('')}
            </tbody>
          </table>
          <p class="rs-how">And in the failed calls kept on file:</p>`;
  const critBlock = !criteria.length ? '' : `
      <section class="rs-sec">
        <details class="rs-more rs-crit"><summary>the judge&rsquo;s notes by check</summary>
          <p class="rs-how">The judge writes one paragraph per check. ${worded
            ? 'It starts each one with PASS or FAIL, and those words are what we count.'
            : 'In this run it did not say PASS or FAIL, so we count only the paragraphs that say clearly that the check was missed. The rest is &ldquo;unclear&rdquo; &mdash; not guessed.'}
            The full notes are under &ldquo;show a real call&rdquo; above and on each situation&rsquo;s card.</p>${allCalls}
          <table class="rs-tbl">
            <thead><tr><th>#</th><th>the check</th><th>failed</th><th>passed</th><th>unclear</th>${oldN ? '<th>old rule</th>' : ''}</tr></thead>
            <tbody>${criteria.map(c => `
              <tr><td>${c.idx}</td><td>${esc(RUN_CRITERIA[c.idx - 1] || 'check ' + c.idx)}</td>
              <td>${c.fail + c.plain} of ${c.paras}</td><td>${c.pass || '·'}</td><td>${c.paras - c.fail - c.pass - c.plain - c.old || '·'}</td>${oldN ? `<td>${c.old || '·'}</td>` : ''}</tr>`).join('')}
            </tbody>
          </table>
          ${oldN ? `<p class="rs-how">${oldN} note${oldN === 1 ? '' : 's'} under check 5 counted Otto&rsquo;s greeting as a question. Graded by the old rule — the next run counts only follow-ups.</p>` : ''}
          <p class="rs-how">Checks 1, 5 and 6 are different for the &ldquo;Nothing to report&rdquo; row, and check 7 is only for the vague driver — so that row has fewer notes.</p>
        </details>
      </section>`;

  /* what the designer said is fine — every run, folded, with UNDO */
  const napBlock = !accepted.length ? '' : `
      <section class="rs-sec rs-nap-sec">
        <details class="rs-more rs-nap-det"${acceptedOpen ? ' open' : ''}><summary>You said these are fine (${accepted.length})</summary>
          <ul class="rs-nap-list">${accepted.map(r => `
            <li data-accepted="${esc(r.key)}">
              <span class="rs-nap-t"><b>${esc(r.title)}</b>${r.note ? `<span class="rs-nap-note">&ldquo;${esc(r.note)}&rdquo;</span>` : ''}</span>
              <span class="rs-nap-when" title="${esc(r.decided_at || '')}">${esc(fmtTime(r.decided_at) || '—')}</span>
              <button class="mini-btn" type="button" data-unap="${esc(r.key)}" title="Take this off the list — it shows in the reports again">UNDO</button>
            </li>`).join('')}
          </ul>
          <p class="rs-how">Marked findings still count in the pass rate — the suite&rsquo;s rules decide that; this only keeps them out of the report and out of prompt suggestions.</p>
          ${acceptedMissing ? `<p class="rs-how rs-nap-warn">${esc(ACCEPTED_HINT)} Until then the list lives in this browser only.</p>` : ''}
        </details>
      </section>`;

  return `
    <div class="rs">
      ${head}
      <div class="rs-two">
        <section class="rs-sec">
          <h3 class="rs-h2">Otto by situation</h3>
          <p class="rs-how">Worst first.${perSit ? ` Each situation was called ${perSit} times.` : ''} Click a bar to open the situation.</p>
          ${sitChart}
        </section>
        <div class="rs-two-right">
          <section class="rs-sec">
            <h3 class="rs-h2">Otto by driver type</h3>
            <p class="rs-how">The same situations, played by four kinds of driver.</p>
            ${typeChart}
          </section>
          <section class="rs-sec">
            <h3 class="rs-h2">What went well</h3>
            ${wellBody}
          </section>
        </div>
      </div>
      <section class="rs-sec">
        <h3 class="rs-h2">What went wrong</h3>
        ${n ? `<p class="rs-how">Counted from the ${n} failed calls. One call can be in more than one line.</p>${wrongChart}${wrongList}${
    !shown.length && findings.length ? '<p class="cmp-empty">Every pattern found in this run is on your NOT A PROBLEM list.</p>' : ''}${hiddenLine}`
      : '<p class="cmp-empty">This run kept no failed call to read, so nothing can be counted here.</p>'}
        ${zeroLine}
      </section>
      <section class="rs-sec">
        <h3 class="rs-h2">What to change</h3>
        <p class="rs-warn">Nothing here is applied by itself. These are lines to paste into Otto&rsquo;s prompt, if you decide to.
          The prompt itself is never shown, read or stored on this page.</p>
        ${suggBody}${suggEmpty}
      </section>
      <section class="rs-sec">
        <h3 class="rs-h2">Every situation</h3>
        <p class="rs-how">Worst first. Click a row to open that situation on the SITUATIONS tab.</p>
        ${table}
      </section>
      ${critBlock}
      ${napBlock}
    </div>`;
}

/* The list's tabs. The two scenario tabs only split a MIXED list (one
 * kind of row needs no tab of its own), but SITUATIONS is a top-level
 * tab: the other sheet is always there, empty or not, because loading
 * it is the first thing done on it. */
function renderTabs() {
  const own = scenarios.filter(sc => !fromSheet(sc)).length;
  const sit = cardView === 'demo' ? '' : `
      <button class="tab${sitTabOn() ? ' on' : ''}" type="button" data-tab="situations"
        title="What a driver reports when they press REPORT — the pilot's other sheet, tested by the agent suite in four voices">SITUATIONS · ${situations.length}</button>
      <button class="tab${runsTabOn() ? ' on' : ''}" type="button" data-tab="runs"
        title="Every test run, newest first — one report each: what went well, what went wrong, and what to change. Reading only; nothing on it changes the agent.">RUNS · ${agentRuns.length}</button>`;
  const scen = !scenarios.length ? '' : !listMixed()
    ? `<button class="tab${sitTabOn() ? '' : ' on'}" type="button" data-tab="${scenarios.every(fromSheet) ? 'sheet' : 'own'}"
        title="The trigger scenarios — when Otto speaks, and what he asks">${scenarios.every(fromSheet) ? '⇩ STARTER SHEET' : 'YOUR SCENARIOS'} · ${scenarios.length}</button>`
    : `<button class="tab${!sitTabOn() && listTab !== 'sheet' ? ' on' : ''}" type="button" data-tab="own"
        title="Rows made on this dashboard">YOUR SCENARIOS · ${own}</button>
      <button class="tab${!sitTabOn() && listTab === 'sheet' ? ' on' : ''}" type="button" data-tab="sheet"
        title="Rows loaded from the shipped starter sheet — rename one and it moves to your tab">⇩ STARTER SHEET · ${scenarios.length - own}</button>`;
  return !scen && !sit ? '' : `
    <div class="tabs">${scen}${sit}</div>`;
}

function render() {
  renderStats();
  renderRouteToggle();
  /* the top bar follows the tab: a situation has no pin to import, no
   * spec to export and no Excel sheet behind it */
  const sit = sitTabOn();
  const runs = runsTabOn();
  el('new-situation').hidden = !sit;
  el('new-open').hidden = sit || runs;
  el('import-open').hidden = sit || runs;
  el('spec-all').hidden = sit || runs;
  /* the RUNS tab is a report with no pins to show: the map column goes
   * away and the report takes the full width. Leaving the tab brings
   * the map back and tells it its box changed size. */
  const wrap = document.querySelector('main.wrap');
  if (wrap && wrap.classList.contains('report') !== runs) {
    wrap.classList.toggle('report', runs);
    if (!runs) {
      requestAnimationFrame(() => {
        try {
          if (map.map && window.google && google.maps && google.maps.event) google.maps.event.trigger(map.map, 'resize');
        } catch (e) { warn(e); }
        map.refresh();
      });
    }
  }
  const box = el('list');
  /* the RUNS tab is a report, not a list of rows: either the runs
   * themselves or ONE run's summary in their place, with the way back
   * at the top of it */
  if (runs) {
    const run = openRunId && runById(openRunId);
    if (openRunId && !run) openRunId = null;  // the row is gone (another agent's run, a refresh that dropped it)
    box.innerHTML = renderTabs() + (run ? renderRunSummary(run) : renderRunList());
    /* arriving from a situation card's "see the full reasons" link:
     * put that row on screen, then forget the request */
    if (run && runFocusSit) {
      /* the table row, not the chart bar that carries the same id */
      const node = box.querySelector(`.rs-sits [data-sitjump="${CSS.escape(runFocusSit)}"]`)
        || box.querySelector(`[data-sitjump="${CSS.escape(runFocusSit)}"]`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      runFocusSit = null;
    }
    return;
  }
  if (sit) {
    box.innerHTML = renderTabs()
      + (situations.length ? situations.map(renderSituation).join('') + renderSitSheetLink() : renderSituationsEmpty());
    return;
  }
  if (!scenarios.length) {
    box.innerHTML = renderTabs() + `
      <div class="empty">
        <b>No trigger scenarios yet</b>
        <p>Define what the tester should act out and what Otto should understand — then pin each scenario to a real address.</p>
        <div class="top-actions">
          <button class="chip primary" type="button" data-empty="new">+ NEW SCENARIO</button>
          <button class="chip" type="button" data-empty="import">⎘ PASTE FROM EXCEL</button>
          ${SHEET ? `<button class="chip" type="button" data-empty="sheet">⇩ LOAD THE STARTER SHEET · ${SHEET.scenarios.length}</button>` : ''}
          ${ROUTES.length && !routeStops().length ? '<button class="chip" type="button" data-empty="route">⇪ LOAD A DEMO ROUTE</button>' : ''}
        </div>
      </div>`;
    return;
  }
  box.innerHTML = renderTabs() + scenarios.filter(inTab).map(renderScenario).join('');
}

function scrollToScenario(id) {
  /* revealing a row that lives in another tab switches there first */
  const sc = scenarios.find(x => x.id === id);
  if (sc && !inTab(sc)) { setListTab(fromSheet(sc) ? 'sheet' : 'own'); render(); }
  const node = el('list').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToSituation(id) {
  const node = el('list').querySelector(`[data-sit="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- scenario CRUD ---------- */
async function saveScenarioRow(row) {
  if (Backend.enabled) {
    try {
      const saved = await Backend.insertScenarios([row]);
      if (Array.isArray(saved) && saved[0]) return saved[0];
    } catch (e) { schemaHint(e); }
  }
  return { ...row, id: localId('s'), created_at: new Date().toISOString() };
}

async function patchScenario(sc, patch) {
  Object.assign(sc, patch);
  if (Backend.enabled) Backend.updateScenario(sc.id, patch).catch(schemaHint);
  persistLocal();
}

async function deleteScenario(sc) {
  const d = sc.destination_id && destById(sc.destination_id);
  const what = d ? 'this scenario, its map pin and its debriefs' : 'this scenario';
  if (!confirm(`Delete ${what}?\n\n#${sc.num || '·'} ${sc.title}`)) return;
  scenarios = scenarios.filter(x => x !== sc);
  if (d) {
    destinations = destinations.filter(x => x !== d);
    delete messagesByDest[d.id];
  }
  delete runsByScenario[sc.id];
  if (Backend.enabled) {
    Backend.deleteScenario(sc.id).catch(warn); // runs cascade in SQL
    if (d) Backend.deleteDestination(d.id).catch(warn); // messages cascade in SQL
  } else {
    try {
      localStorage.setItem(LS_RUNS, JSON.stringify(
        (JSON.parse(localStorage.getItem(LS_RUNS) || '[]')).filter(r => r.scenario_id !== sc.id)));
    } catch { /* private mode */ }
  }
  if (expandedId === sc.id) expandedId = null;
  persistLocal();
  render();
  map.refresh();
}

async function setVerdict(sc, v) {
  await patchScenario(sc, { verdict: sc.verdict === v ? null : v });
  render();
  map.refresh();
}

/* ---------- scenario form ---------- */
let editing = null;    // scenario being edited, or null for a new one
let formParams = [];   // param editor rows while the form is open

/* The test address lives right in the form — same search cascade as the
 * address sheet (coordinates fast-path, then searchAddress). Nothing is
 * pinned until the scenario is saved. */
let formAddr = null;   // { label, lat, lng, pin, dirty } — dirty = picked in this form session
let formAddrTimer = null;
let formAddrSeq = 0;

function setFormAddr(c, dirty) {
  formAddr = c ? { label: c.label, lat: c.lat, lng: c.lng, pin: !!c.pin, dirty: !!dirty } : null;
  const cur = el('f-addr-current');
  cur.hidden = !formAddr;
  cur.textContent = formAddr ? '📍 ' + formAddr.label : '';
  el('f-addr-results').innerHTML = '';
  if (formAddr) el('f-addr-input').value = '';
}

function onFormAddrInput(q) {
  clearTimeout(formAddrTimer);
  const seq = ++formAddrSeq;
  const show = list => {
    const box = el('f-addr-results');
    box.innerHTML = '';
    list.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cand';
      b.textContent = c.label;
      b.onclick = () => setFormAddr(c, true);
      box.appendChild(b);
    });
  };
  const m = q.match(/(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/);
  if (m) {
    show([{ label: `Dropped pin — ${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, lat: +m[1], lng: +m[2], pin: true }]);
    return;
  }
  if (q.trim().length < 3) { show([]); return; }
  formAddrTimer = setTimeout(async () => {
    const found = await searchAddress(q.trim());
    if (seq === formAddrSeq) show(found);
  }, 350);
}
el('f-addr-input').addEventListener('input', e => onFormAddrInput(e.target.value));

function renderFormParams() {
  el('f-params').innerHTML = formParams.map((p, i) => `
    <div class="pe-row">
      <input type="text" data-pe="${i}:label" placeholder="Label" value="${esc(p.label == null ? '' : p.label)}">
      <input type="text" data-pe="${i}:key" placeholder="key_in_rule" class="pe-mono" value="${esc(p.key == null ? '' : p.key)}">
      <input type="number" data-pe="${i}:value" placeholder="value" step="any" value="${esc(p.value == null ? '' : p.value)}">
      <input type="number" data-pe="${i}:min" placeholder="min" step="any" value="${esc(p.min == null ? '' : p.min)}">
      <input type="number" data-pe="${i}:max" placeholder="max" step="any" value="${esc(p.max == null ? '' : p.max)}">
      <input type="text" data-pe="${i}:unit" placeholder="unit" value="${esc(p.unit == null ? '' : p.unit)}">
      <button type="button" class="pe-del" data-pe-del="${i}" title="Remove this value">×</button>
    </div>`).join('');
}

function openForm(sc) {
  editing = sc || null;
  el('form-title').textContent = sc ? 'Edit trigger scenario' : 'New trigger scenario';
  el('form-save').textContent = sc ? `Save as v${(sc.version || 1) + 1}` : 'Save & set address';
  el('form-hint').textContent = '';
  const next = scenarios.reduce((m, s) => Math.max(m, s.num || 0), 0) + 1;
  el('f-num').value = sc ? (sc.num != null ? sc.num : '') : next;
  el('f-desc').value = sc ? sc.described || '' : '';
  el('f-title').value = sc ? sc.title || '' : '';
  el('f-rule').value = sc ? sc.rule || '' : '';
  el('f-ar').value = sc ? sc.ar_states || '' : '';
  el('f-signals').value = sc ? sc.signals || '' : '';
  el('f-timing').value = sc ? sc.timing || '' : '';
  el('f-says').value = sc ? sc.otto_says || '' : '';
  el('f-learns').value = sc ? sc.learns || '' : '';
  el('f-steps').value = sc ? sc.test_steps || '' : '';
  formParams = sc ? paramsOf(sc).map(p => ({ ...p })) : [];
  renderFormParams();
  const d = sc && sc.destination_id ? destById(sc.destination_id) : null;
  el('f-addr-input').value = '';
  setFormAddr(d ? { label: d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`, lat: d.lat, lng: d.lng } : null, false);
  el('form-sheet').hidden = false;
  /* new scenario: the describe-first flow starts in the describe box */
  el(sc ? 'f-title' : 'f-desc').focus();
}

/* Describe → draft: one plain-language description in, every sheet column
 * out, tunable numbers extracted as params. AI when the backend is up;
 * otherwise a built-in template, clearly labelled as such. */
async function runDraft() {
  const desc = el('f-desc').value.trim();
  if (!desc) { el('form-hint').textContent = 'Describe the scenario first — one or two sentences are enough.'; return; }
  const btn = el('f-draft');
  btn.disabled = true;
  btn.textContent = '✨ Drafting…';
  let out = null;
  let demo = !Backend.enabled;
  if (Backend.enabled) {
    try { out = await Backend.scenarioAI({ op: 'draft', description: desc }); }
    catch (e) { warn(e); demo = true; } // function not deployed — fall through to the template
  }
  if (!out) out = demoDraft(desc);
  btn.disabled = false;
  btn.textContent = '✨ Draft the fields from this';
  const f = (out && out.fields) || {};
  const put = (id, v) => { if (typeof v === 'string' && v.trim()) el(id).value = v.trim(); };
  put('f-title', f.title);
  put('f-rule', f.rule);
  put('f-ar', f.ar_states);
  put('f-signals', f.signals);
  put('f-timing', f.timing);
  put('f-says', f.otto_says);
  put('f-learns', f.learns);
  put('f-steps', f.test_steps);
  formParams = (cleanParams(out && out.params) || []).map(p => ({ ...p }));
  renderFormParams();
  /* an address mentioned in the description comes back as a search to
   * confirm — the designer still picks the exact candidate */
  if (typeof f.address === 'string' && f.address.trim() && !(formAddr && formAddr.dirty)) {
    el('f-addr-input').value = f.address.trim();
    onFormAddrInput(f.address.trim());
  }
  /* two words in → generic draft out; say so instead of leaving the
   * mismatch to be discovered on the card */
  const vague = desc.split(/\s+/).length < 6
    ? 'Short description — the draft can only be as specific as it. Say what happens, on foot or driving, and what Otto should learn. '
    : '';
  el('form-hint').textContent = vague + (demo
    ? 'Demo draft from a built-in template (no AI backend). Numbers in {braces} are the tunable values below — edit anything, then save.'
    : 'AI draft — numbers in {braces} are the tunable values below. Check every field, then save.');
}

async function submitForm() {
  const title = el('f-title').value.trim();
  if (!title) { el('form-hint').textContent = 'The scenario needs a name — describe it above and hit ✨ Draft, or type one.'; return; }
  const numRaw = el('f-num').value.trim();
  const params = cleanParams(formParams) || [];
  const fields = {
    title,
    rule: el('f-rule').value.trim() || null,
    ar_states: el('f-ar').value.trim() || null,
    signals: el('f-signals').value.trim() || null,
    timing: el('f-timing').value.trim() || null,
    otto_says: el('f-says').value.trim() || null,
    learns: el('f-learns').value.trim() || null,
    test_steps: el('f-steps').value.trim() || null,
  };
  const extra = {
    num: numRaw === '' ? null : parseInt(numRaw, 10),
    described: el('f-desc').value.trim() || null,
  };
  el('form-sheet').hidden = true;
  if (editing) {
    /* definition changes cut a version; num/description alone do not */
    const changed = SNAP_FIELDS.filter(k => String(fields[k] || '') !== String(editing[k] || ''));
    const paramsChanged = JSON.stringify(params) !== JSON.stringify(paramsOf(editing));
    if (changed.length || paramsChanged) {
      const what = changed.map(k => FIELD_LABELS[k] || k).concat(paramsChanged ? ['tunable values'] : []);
      tune = null;
      await saveNewVersion(editing, { ...fields, ...extra, params }, 'Manual edit: ' + what.join(', '));
    } else {
      await patchScenario(editing, extra);
    }
    if (formAddr && formAddr.dirty) await applyAddress(editing, formAddr); // re-pinned inside the form
    render();
    map.refresh();
  } else {
    const sc = await saveScenarioRow({ ...fields, ...extra, params, version: 1, version_at: new Date().toISOString() });
    scenarios.push(sc);
    expandedId = sc.id;
    persistLocal();
    render();
    map.refresh();
    scrollToScenario(sc.id);
    /* address picked in the form pins straight away; otherwise the
     * picker opens — a scenario without an address cannot be tested */
    if (formAddr && formAddr.dirty) await applyAddress(sc, formAddr);
    else openAddr(sc);
  }
}

/* ---------- demo drafts ----------
 * With no AI backend the describe→draft flow still works: keyword
 * archetypes from the deck (parking, entrance, waiting, closure) plus a
 * generic arrive-dwell-leave shape. Same philosophy as Otto's scripted
 * demo — a labelled stand-in, never pretending to be the real thing.
 * Detector-keyed params mean even a template draft tunes the phone. */
const firstSentence = d => String(d).replace(/\s+/g, ' ').trim().replace(/[.!?].*$/, '').slice(0, 90);
const DRAFT_TEMPLATES = [
  {
    /* before the loops template — "park" alone would swallow these */
    re: /park.*(walk|distance|position|far)|walk.*(park|from the car)|best (parking|spot)|parking position/i,
    name: 'Park & walk',
    fields: {
      rule: 'Driver parks within {park_radius_max} m of the pin (vehicle→walking flip, or the vehicle standing ≥{park_stop_s} s), then walks ≥{min_walk_m} m and arrives within {arrival_radius} m of the pin on foot.',
      ar_states: 'IN_VEHICLE → WALKING (the flip marks the parking spot) → STILL at the destination',
      signals: 'Parking position vs pin; walked path length; walk time',
      timing: 'On arrival at the destination, on foot — only then is the walking distance a fact',
      otto_says: '“You parked about {park_m} m away and walked {walk_m} m — was there nothing closer, or is that the smart spot for this address?”',
      learns: 'parking — the real parking spot for this address',
      test_steps: 'Drive to a few hundred meters from the pin, park properly, walk the rest of the way. Otto speaks when you reach the destination, quoting your measured distances.',
    },
    params: [
      { key: 'park_radius_max', label: 'Parking counts within', value: 400, min: 100, max: 800, step: 25, unit: 'm' },
      { key: 'park_stop_s', label: 'Vehicle standstill = parked', value: 30, min: 10, max: 120, step: 5, unit: 's' },
      { key: 'arrival_radius', label: 'Arrived within', value: 25, min: 10, max: 60, step: 5, unit: 'm' },
      { key: 'min_walk_m', label: 'Minimum walk', value: 50, min: 20, max: 300, step: 10, unit: 'm' },
    ],
  },
  {
    re: /park|spot|loop|circl|kurv|stellplatz/i,
    name: 'Parking loops',
    fields: {
      rule: 'Vehicle passes within ~{radius} m of the pin {passes_needed}× below {pass_speed_max} m/s without stopping, then stands ≥{stop_dwell_s} s within {stop_radius} m of the pin, then moves again.',
      ar_states: 'IN_VEHICLE throughout the loops → STILL at the stop → IN_VEHICLE again',
      signals: 'GPS trace vs pin; speed; pass count',
      timing: 'Wait — ask once moving again after the stop',
      otto_says: '“Is it hard to park here at this time? Where did you find a spot?”',
      learns: 'parking — the loading-zone tip',
      test_steps: 'Drive to the pin, circle the block twice slowly without stopping, then park and stand ≥1 min, then drive off. Answer Otto when he speaks up.',
    },
    params: [
      { key: 'radius', label: 'Pass radius', value: 150, min: 40, max: 400, step: 5, unit: 'm' },
      { key: 'passes_needed', label: 'Slow passes needed', value: 2, min: 0, max: 5, step: 1, unit: '×' },
      { key: 'pass_speed_max', label: 'Max pass speed', value: 9, min: 2, max: 15, step: 0.5, unit: 'm/s' },
      { key: 'stop_dwell_s', label: 'Stop dwell', value: 45, min: 10, max: 180, step: 5, unit: 's' },
      { key: 'stop_radius', label: 'Stop radius', value: 250, min: 50, max: 500, step: 10, unit: 'm' },
    ],
  },
  {
    re: /entrance|door|gate|eingang|way in|find the (entry|way)|access point|without finding|can.?t find|looking for/i,
    name: 'Entrance hunt',
    fields: {
      rule: 'Vehicle stops within {stop_radius} m of the pin, then ON_FOOT for ≥{foot_search_s} s inside ~{radius} m of the pin without the debrief starting — the tester is hunting for the way in.',
      ar_states: 'IN_VEHICLE → STILL (arrival) → ON_FOOT (searching) → STILL at the real entrance',
      signals: 'GPS trace on foot vs pin; time on foot; no arrival confirmation',
      timing: 'Wait — ask when back at the vehicle, not mid-search',
      otto_says: '“Was the entrance easy to find? Where is it, exactly?”',
      learns: 'access — where the real way in is',
      test_steps: 'Park near the pin, walk to the wrong side of the building first, spend ~2 min searching, then return to the car and answer Otto.',
    },
    params: [
      { key: 'stop_radius', label: 'Arrival stop radius', value: 120, min: 30, max: 300, step: 5, unit: 'm' },
      { key: 'stop_dwell_s', label: 'Arrival stop dwell', value: 20, min: 5, max: 120, step: 5, unit: 's' },
      { key: 'foot_search_s', label: 'On-foot search time', value: 90, min: 20, max: 300, step: 10, unit: 's' },
      { key: 'radius', label: 'Search radius', value: 80, min: 20, max: 200, step: 5, unit: 'm' },
      { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
    ],
  },
  {
    re: /wait|queue|reception|schlange|warten|line at/i,
    name: 'Long wait',
    fields: {
      rule: 'STILL within {radius} m of the pin for ≥{stop_dwell_s} s — longer than a normal handover.',
      ar_states: 'ON_FOOT or STILL near the pin — the long STILL is the signal',
      signals: 'Dwell time vs pin; opening hours',
      timing: 'Wait — ask on leaving, when hands are free',
      otto_says: '“That took a while — how long did you wait, and is there a faster way here?”',
      learns: 'other — realistic waiting time and how to skip it',
      test_steps: 'Go to the pin, stand in the waiting area ≥5 min, then leave and answer Otto.',
    },
    params: [
      { key: 'radius', label: 'Waiting radius', value: 60, min: 15, max: 200, step: 5, unit: 'm' },
      { key: 'stop_dwell_s', label: 'Wait threshold', value: 300, min: 60, max: 1200, step: 30, unit: 's' },
      { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
    ],
  },
  {
    re: /closed|blocked|block|construction|detour|shut|gesperrt|baustelle/i,
    name: 'Blocked route',
    fields: {
      rule: 'Approach within {radius} m of the pin, then turn away without a stop of ≥{stop_dwell_s} s — the way is blocked.',
      ar_states: 'IN_VEHICLE approach → slow / brief STILL → IN_VEHICLE away without arrival',
      signals: 'GPS trace turning short of the pin; speed drop',
      timing: 'Soon after turning away, once driving smoothly',
      otto_says: '“Looks like you couldn’t get through — what’s blocking it, and is there a way around?”',
      learns: 'hazard — blocked route and the detour that works',
      test_steps: 'Drive toward the pin, stop short as if blocked, turn around and drive off; answer Otto when he asks.',
    },
    params: [
      { key: 'radius', label: 'Approach radius', value: 100, min: 30, max: 300, step: 5, unit: 'm' },
      { key: 'stop_dwell_s', label: 'Real-stop threshold', value: 30, min: 10, max: 120, step: 5, unit: 's' },
      { key: 'pass_speed_max', label: 'Max approach speed', value: 8, min: 2, max: 15, step: 0.5, unit: 'm/s' },
      { key: 'passes_needed', label: 'Slow passes needed', value: 1, min: 0, max: 3, step: 1, unit: '×' },
    ],
  },
  {
    re: /./,
    name: 'On-site debrief',
    fields: {
      rule: 'Arrive within {radius} m of the pin, dwell ≥{stop_dwell_s} s, then leave — Otto debriefs on departure.',
      ar_states: 'Arrival → STILL near the pin → moving again',
      signals: 'GPS trace vs pin; dwell time',
      timing: 'On departure',
      otto_says: '“What did you find here that the next driver should know?”',
      learns: 'other — local knowledge for the next driver',
      test_steps: 'Go to the pin, act out the described situation, then leave and answer Otto.',
    },
    params: [
      { key: 'radius', label: 'Arrival radius', value: 100, min: 25, max: 300, step: 5, unit: 'm' },
      { key: 'stop_dwell_s', label: 'Dwell threshold', value: 60, min: 10, max: 600, step: 10, unit: 's' },
      { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
    ],
  },
];
function demoDraft(desc) {
  const t = DRAFT_TEMPLATES.find(x => x.re.test(desc));
  return {
    fields: { ...t.fields, title: `${t.name} — ${firstSentence(desc)}` },
    params: t.params.map(p => ({ ...p })),
  };
}

/* ---------- tuning sliders ---------- */
function onTuneInput(sc, card, slider) {
  if (!tune || tune.id !== sc.id) tune = { id: sc.id, params: paramsOf(sc).map(p => ({ ...p })) };
  const p = tune.params.find(x => x.key === slider.dataset.key);
  if (!p) return;
  p.value = +slider.value;
  /* live DOM updates only — a full render would kill the drag */
  const val = card.querySelector(`[data-val="${CSS.escape(p.key)}"]`);
  if (val) val.textContent = fmtVal(p.value) + (p.unit ? ' ' + p.unit : '');
  const rule = card.querySelector('[data-rule]');
  if (rule) rule.textContent = fillParams(sc.rule, tune.params);
  const diff = tuneDiff(paramsOf(sc), tune.params);
  const dEl = card.querySelector('[data-diff]');
  if (dEl) dEl.textContent = diff;
  const foot = card.querySelector('.tune-foot');
  if (foot) foot.hidden = !diff;
  if (!diff) tune = null; // slid back onto the saved values
}

async function saveTuning(sc) {
  if (!tune || tune.id !== sc.id) return;
  const diff = tuneDiff(paramsOf(sc), tune.params);
  const params = tune.params;
  tune = null;
  if (!diff) { render(); return; }
  await saveNewVersion(sc, { params }, 'Tuned: ' + diff);
  render();
}

async function restoreVersion(sc, verNum) {
  const h = historyOf(sc).find(x => x.version === verNum);
  if (!h) return;
  tune = null;
  await saveNewVersion(sc, { ...h.fields, params: (h.params || []).map(p => ({ ...p })) }, `Restored v${verNum}`);
  render();
  map.refresh(); // the title (and with it the pin label) may have changed
}

/* ---------- feedback capture ----------
 * Live backend: MediaRecorder → the voice-note function transcribes.
 * No backend: the browser's own SpeechRecognition — on-device, keyless.
 * Either way the transcript lands in a textarea to be polished (or the
 * whole note just typed) before it is saved against the scenario. */
let fbMedia = null;  // MediaRecorder while a live clip is being taken
let fbSpeech = null; // SpeechRecognition while on-device dictation runs
const speechAvailable = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

async function toggleFbMic(sc) {
  if (!fbRec || fbRec.id !== sc.id) return;
  if (fbRec.state === 'rec') { stopFbCapture(); return; }
  if (Backend.enabled) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        fbMedia = null;
        if (!fbRec || fbRec.id !== sc.id) return; // cancelled while recording
        fbRec.state = 'transcribing';
        render();
        try {
          const d = await Backend.transcribe(
            new Blob(chunks, { type: rec.mimeType || 'audio/webm' }),
            `test feedback on trigger scenario "${shortTitle(sc)}" v${sc.version || 1}`,
          );
          if (fbRec && fbRec.id === sc.id) {
            fbRec.text = (fbRec.text ? fbRec.text.trim() + ' ' : '') + (d.transcript || '');
            fbRec.via = 'voice';
          }
        } catch (e) { warn(e); }
        if (fbRec && fbRec.id === sc.id) { fbRec.state = 'idle'; render(); }
      };
      fbMedia = rec;
      rec.start();
      fbRec.state = 'rec';
      render();
    } catch { /* mic denied — typing still works */ }
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const sr = new SR();
  sr.continuous = true;
  sr.interimResults = false;
  sr.onresult = ev => {
    if (!fbRec || fbRec.id !== sc.id) return;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) {
        const t = ev.results[i][0].transcript.trim();
        if (t) fbRec.text = (fbRec.text ? fbRec.text.trim() + ' ' : '') + t;
      }
    }
    fbRec.via = 'voice';
    const ta = el('list').querySelector('[data-fb-text]');
    if (ta) ta.value = fbRec.text;
  };
  sr.onend = () => {
    fbSpeech = null;
    if (fbRec && fbRec.state === 'rec') { fbRec.state = 'idle'; render(); }
  };
  fbSpeech = sr;
  try {
    sr.start();
    fbRec.state = 'rec';
    render();
  } catch { fbSpeech = null; }
}

function stopFbCapture() {
  if (fbMedia) { try { fbMedia.stop(); } catch { /* already stopped */ } } // onstop carries on
  if (fbSpeech) {
    const s = fbSpeech;
    fbSpeech = null;
    try { s.onend = null; s.stop(); } catch { /* already stopped */ }
    if (fbRec && fbRec.state === 'rec') { fbRec.state = 'idle'; render(); }
  }
}

async function saveFeedback(sc) {
  if (!fbRec || fbRec.id !== sc.id) return;
  stopFbCapture();
  const ta = el('list').querySelector('[data-fb-text]');
  const text = String((ta ? ta.value : fbRec.text) || '').trim();
  const via = fbRec.via === 'voice' ? 'voice' : 'typed';
  fbRec = null;
  if (!text) { render(); return; }
  const entry = {
    id: localId('f'),
    at: new Date().toISOString(),
    version: sc.version || 1,
    via, text,
    status: 'open',
  };
  await patchScenario(sc, { feedback: feedbackOf(sc).concat([entry]) });
  render();
  runPropose(sc); // feedback in → a proposed next version comes straight back
}

/* ---------- propose a new version ---------- */
async function runPropose(sc) {
  const open = feedbackOf(sc).filter(f => f.status === 'open');
  if (!open.length || proposalBusy) return;
  proposal = null;
  proposalBusy = sc.id;
  render();
  let out = null;
  let demo = !Backend.enabled;
  if (Backend.enabled) {
    try {
      out = await Backend.scenarioAI({
        op: 'revise',
        scenario: {
          version: sc.version || 1,
          fields: Object.fromEntries(SNAP_FIELDS.map(k => [k, sc[k] || null])),
          params: paramsOf(sc),
        },
        feedback: open.map(f => f.text),
        results: msgsOf(sc).slice(0, 3).map(m => ({
          category: m.category || null,
          title: m.title || null,
          transcript: m.transcript || null,
          ar_summary: m.ar_summary || null,
        })),
      });
    } catch (e) { warn(e); demo = true; } // function not deployed — heuristic instead
  }
  if (!out) out = demoRevise(sc, open);
  proposalBusy = null;
  proposal = cleanProposal(sc, out, demo, open.map(f => f.id));
  render();
}

function cleanProposal(sc, out, demo, fbIds) {
  const changes = {};
  const src = (out && (out.changes || out.fields)) || {};
  SNAP_FIELDS.forEach(k => {
    const v = src[k];
    if (typeof v === 'string' && v.trim() && v.trim() !== String(sc[k] || '').trim()) changes[k] = v.trim();
  });
  let params = cleanParams(out && out.params);
  if (params && JSON.stringify(params) === JSON.stringify(paramsOf(sc))) params = null;
  const none = !Object.keys(changes).length && !params;
  return {
    id: sc.id, changes, params, demo, fb_ids: fbIds || [], none,
    note: String((out && out.note) || '').trim().slice(0, 200)
      || (none ? 'No concrete change derived from the feedback — it stays on record for the next pass.' : 'Revised from test feedback'),
  };
}

/* The keyless stand-in for op:"revise": explicit numbers in the feedback
 * move the nearest matching value; otherwise clear too-eager / never-fired
 * wording nudges the thresholds. Anything subtler needs the real AI. */
function demoRevise(sc, notes) {
  const params = paramsOf(sc).map(p => ({ ...p }));
  const text = notes.map(n => n.text).join(' \n ').toLowerCase();
  const changed = new Set();
  const setVal = (p, v) => {
    v = Math.max(+p.min, Math.min(+p.max, v));
    const step = +p.step || niceStep(+p.min, +p.max);
    v = Math.round(v / step) * step;
    if (+p.value !== v) { p.value = +v.toFixed(4); changed.add(p.key); }
  };
  /* "make it 80 m", "wait 2 minutes" — unit-matched, nearest current value */
  const UNITS = [
    [/^m\/s$/, 'm/s', 1], [/^km\/h$/, 'm/s', 1 / 3.6],
    [/^(m|meters?|metres?)$/, 'm', 1],
    [/^(s|secs?|seconds?)$/, 's', 1], [/^(min|minutes?)$/, 's', 60],
    [/^(x|times?|pass(?:es)?|loops?)$/, '×', 1],
  ];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(m\/s|km\/h|meters?|metres?|minutes?|seconds?|secs?|times?|pass(?:es)?|loops?|min|m|s|x)\b/g)) {
    const u = UNITS.find(([re]) => re.test(m[2]));
    if (!u) continue;
    const val = parseFloat(m[1].replace(',', '.')) * u[2];
    const cands = params.filter(p => String(p.unit || '×') === u[1]);
    if (!cands.length) continue;
    setVal(cands.reduce((a, b) => (Math.abs(+a.value - val) <= Math.abs(+b.value - val) ? a : b)), val);
  }
  if (!changed.size) {
    const eager = /(too (early|often|eager|sensitive|soon)|fired too|false (trigger|alarm)|zu früh|zu oft)/.test(text);
    const late = /(never fired|didn.?t fire|did not fire|no trigger|too late|missed|nicht ausgelöst|zu spät)/.test(text);
    const nudge = (key, f) => { const p = params.find(x => x.key === key); if (p) setVal(p, +p.value * f); };
    const bump = (key, d) => { const p = params.find(x => x.key === key); if (p) setVal(p, +p.value + d); };
    if (eager && !late) { bump('passes_needed', 1); nudge('stop_dwell_s', 1.5); nudge('radius', 0.8); }
    if (late && !eager) { bump('passes_needed', -1); nudge('stop_dwell_s', 0.67); nudge('radius', 1.25); }
  }
  const diffs = tuneDiff(paramsOf(sc), params);
  return {
    changes: {},
    params: changed.size ? params : null,
    note: changed.size
      ? 'Demo heuristic from feedback: ' + diffs
      : 'Demo heuristic found no tunable change in the feedback — edit by hand, or deploy the scenario-ai function for a real analysis.',
  };
}

async function applyProposal(sc) {
  const p = proposal;
  if (!p || p.id !== sc.id || p.none) { proposal = null; render(); return; }
  const nextVer = (sc.version || 1) + 1;
  const fields = {};
  Object.entries(p.changes).forEach(([k, v]) => {
    if (SNAP_FIELDS.includes(k) && String(v).trim() && String(v).trim() !== String(sc[k] || '').trim()) {
      fields[k] = String(v).trim();
    }
  });
  const feedback = feedbackOf(sc).map(f =>
    (p.fb_ids.includes(f.id) && f.status === 'open') ? { ...f, status: 'applied', applied_version: nextVer } : f);
  const patch = { ...fields, feedback };
  if (p.params) patch.params = cleanParams(p.params) || paramsOf(sc);
  proposal = null;
  tune = null;
  await saveNewVersion(sc, patch, p.note);
  render();
  map.refresh();
}

/* ---------- spec export ----------
 * The end product of the loop: a machine-readable spec per scenario —
 * tuned values, full version history, the feedback that drove it, and
 * every structured test result — ready to build the real algorithm from. */
const traceOf = m => {
  let t = m.ar_trace;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = null; } }
  return (t && typeof t === 'object') ? t : null;
};
function specOf(sc) {
  const d = sc.destination_id && destById(sc.destination_id);
  return {
    num: sc.num == null ? null : sc.num,
    title: sc.title,
    version: sc.version || 1,
    version_note: sc.version_note || null,
    described: sc.described || null,
    fields: Object.fromEntries(SNAP_FIELDS.filter(k => k !== 'title').map(k => [k, sc[k] || null])),
    rule_resolved: sc.rule ? fillParams(sc.rule, paramsOf(sc)) : null,
    params: paramsOf(sc),
    destination: d ? {
      addr: d.addr || null, lat: d.lat, lng: d.lng,
      /* the pre-arrival briefing on file — part of what the production
       * trigger's Otto is expected to say on approach */
      consignee: d.consignee || null,
      floor: d.floor || null,
      notes: dispatchNotesOf(d),
    } : null,
    verdict: sc.verdict || null,
    feedback: feedbackOf(sc),
    history: historyOf(sc),
    results: msgsOf(sc).map(m => {
      const trace = traceOf(m);
      return {
        created_at: m.created_at || null,
        category: m.category || null,
        title: m.title || null,
        transcript: m.transcript || null,
        ar_summary: m.ar_summary || null,
        trigger: (trace && trace.trigger) || null,
        /* who took the debrief, and — for an agent conversation — the
         * follow-ups it took to get the answer. Whoever builds the
         * production trigger reads this to see what Otto had to ask. */
        via: m.via || 'recorded',
        conversation: (() => {
          let c = m.convo;
          if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
          return Array.isArray(c) ? c : null;
        })(),
        /* the ElevenLabs conversation this came out of, and the grade the
         * designer gave that conversation — together one labelled example
         * for the agent's tuning loop */
        conversation_id: m.conversation_id || null,
        grade: gradeOf(m),
        demo: !!m.demo,
      };
    }),
    runs: runsOf(sc).map(r => ({
      started_at: r.started_at || null,
      ended_at: r.ended_at || null,
      scenario_version: r.scenario_version || null,
      fired: !!r.fired,
      passes: r.passes || 0,
      stop_seen: !!r.stop_seen,
      ar_summary: r.ar_summary || null,
      tuning: r.tuning || null,
    })),
    /* the agent suite's latest baseline for this scenario — the
     * simulated testers' results, failing conversations included, so
     * the spec carries both halves of the evidence */
    agent_suite: (() => {
      const { main } = agentSuite();
      const tests = agentTestsFor(main, sc, 'scenario');
      return main && tests.length ? {
        ran_at: agentRanAt(main),
        label: main.label || null,
        branch_id: main.branch_id || null,
        run_url: main.run_url || null,
        tests,
      } : null;
    })(),
  };
}
function downloadJson(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const fileSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function exportSpec(sc) {
  downloadJson(
    `otto-scenario-${sc.num != null ? sc.num + '-' : ''}${fileSlug(shortTitle(sc))}-v${sc.version || 1}.json`,
    { kind: 'otto-trigger-scenario', exported_at: new Date().toISOString(), build: window.BUILD, scenario: specOf(sc) },
  );
}
function exportAllSpecs() {
  if (!scenarios.length) return;
  downloadJson(
    `otto-trigger-scenarios-${new Date().toISOString().slice(0, 10)}.json`,
    { kind: 'otto-trigger-scenarios', exported_at: new Date().toISOString(), build: window.BUILD, scenarios: scenarios.map(specOf) },
  );
}

/* ---------- address picker ----------
 * Same cascade as the phone app's add-sheet: pasted "lat, lng" first
 * (works anywhere, offline), then the geocode Edge Function, then
 * OpenStreetMap — every leg time-boxed. */
let addrFor = null;
let addrTimer = null;
let addrSeq = 0;
let candidates = [];

function openAddr(sc) {
  addrFor = sc;
  const d = sc.destination_id && destById(sc.destination_id);
  el('addr-for').textContent = `#${sc.num || '·'} ${sc.title}`;
  el('addr-current').innerHTML = d
    ? `Current: <b>${esc(d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`)}</b>`
    : 'No address yet. Search one, or paste coordinates — long-press a spot in Google Maps to copy them.';
  el('addr-input').value = '';
  el('addr-results').innerHTML = '';
  el('addr-hint').textContent = '';
  el('addr-sheet').hidden = false;
  el('addr-input').focus();
}
function closeAddr() { el('addr-sheet').hidden = true; addrFor = null; }

function onAddrInput(q) {
  clearTimeout(addrTimer);
  const seq = ++addrSeq;
  const m = q.match(/(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/);
  if (m) {
    candidates = [{ label: `Dropped pin — ${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, lat: +m[1], lng: +m[2], pin: true }];
    renderCandidates();
    return;
  }
  if (q.trim().length < 3) { candidates = []; renderCandidates(); return; }
  addrTimer = setTimeout(async () => {
    el('addr-hint').textContent = 'Searching…';
    const found = await searchAddress(q.trim());
    if (seq !== addrSeq) return; // they kept typing — this answer is stale
    candidates = found;
    renderCandidates();
    if (!found.length) el('addr-hint').textContent = 'Nothing found — try adding the city, or paste coordinates like "52.5346, 13.4109".';
    else el('addr-hint').textContent = houseNumberHint(q, found);
  }, 350);
}

async function searchAddress(q) {
  if (Backend.enabled) {
    try {
      const r = await Backend.search(q);
      if (r.length) return r;
    } catch { /* function not deployed — fall through */ }
  }
  /* With the Maps JS API on the page (browser key set), Google's own
   * geocoder resolves house numbers Nominatim often lacks — e.g. Italian
   * street numbers. Referrer-locked browser keys are valid here, unlike
   * on the REST geocoding endpoint. */
  const g = await googleGeocode(q);
  if (g.length) return g;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=4&q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return [];
    return (await r.json()).map(x => ({ label: x.display_name, lat: +x.lat, lng: +x.lon }));
  } catch { return []; }
}

function googleGeocode(q) {
  if (!(window.google && google.maps && google.maps.Geocoder)) return Promise.resolve([]);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve([]), 6000); // a hung lookup degrades, never blocks
    try {
      new google.maps.Geocoder().geocode({ address: q }, (res, status) => {
        clearTimeout(t);
        resolve(status === 'OK' && Array.isArray(res) ? res.slice(0, 4).map(x => ({
          label: x.formatted_address,
          lat: x.geometry.location.lat(),
          lng: x.geometry.location.lng(),
        })) : []);
      });
    } catch { clearTimeout(t); resolve([]); }
  });
}

/* The typed house number not appearing in any candidate is the one miss
 * people don't notice until the pin is wrong — say it, and teach the
 * exact-pin path. */
function houseNumberHint(q, found) {
  const num = (q.match(/\b(\d{1,4})\b/) || [])[1];
  if (!found.length || !num || found.some(c => String(c.label).includes(num))) return '';
  return `No exact match for house number ${num} — the pin may sit mid-street. For a precise pin, long-press the spot in Google Maps, copy the coordinates ("41.9524, 12.4622") and paste them here.`;
}

function renderCandidates() {
  const box = el('addr-results');
  box.innerHTML = '';
  el('addr-hint').textContent = '';
  candidates.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cand';
    b.textContent = c.label;
    b.onclick = () => applyAddress(addrFor, candidates[i]);
    box.appendChild(b);
  });
}

async function applyAddress(sc, c) {
  if (!sc) return;
  closeAddr();
  const patch = { title: shortTitle(sc), addr: c.pin ? null : c.label, lat: c.lat, lng: c.lng };
  let d = sc.destination_id ? destById(sc.destination_id) : null;
  if (d) {
    Object.assign(d, patch);
    if (Backend.enabled) Backend.updateDestination(d.id, patch).catch(warn);
  } else {
    d = { ...patch };
    if (Backend.enabled) {
      try {
        const saved = await Backend.insertDestination(d);
        if (Array.isArray(saved) && saved[0]) Object.assign(d, saved[0]);
      } catch (e) { warn(e); d.id = localId('d'); }
    } else {
      d.id = localId('d');
    }
    destinations.push(d);
    await patchScenario(sc, { destination_id: d.id });
  }
  persistLocal();
  expandedId = sc.id;
  render();
  map.refresh();
  centerOn(d.lat, d.lng);
  /* a dropped pin gets its street name when the geocoder finds one —
   * the whole point is a clear, readable address on the dashboard */
  if (!d.addr) {
    Geo.reverseGeocode(d.lat, d.lng).then(r => {
      if (!r || !(r.street || r.area)) return;
      d.addr = [r.street, r.area].filter(Boolean).join(', ');
      if (Backend.enabled) Backend.updateDestination(d.id, { addr: d.addr }).catch(warn);
      persistLocal();
      render();
    });
  }
}

/* ---------- Excel paste import ----------
 * Excel puts copied rows on the clipboard as TSV; a cell that contains
 * newlines or tabs arrives quoted with "" escapes. This parses that. */
function parseClipboardTable(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      inQ = true;
    } else if (ch === '\t') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

const isHeaderRow = r =>
  String(r[0] || '').trim() === '#' || /^trigger scenario/i.test(String(r[1] || '').trim());

function rowsToScenarios(text) {
  const val = c => { const t = String(c == null ? '' : c).trim(); return t || null; };
  return parseClipboardTable(text)
    .filter(r => !isHeaderRow(r))
    .map(r => ({
      num: /^\d+$/.test(String(r[0] || '').trim()) ? parseInt(r[0], 10) : null,
      title: String(r[1] || '').trim(),
      rule: val(r[2]),
      ar_states: val(r[3]),
      signals: val(r[4]),
      timing: val(r[5]),
      otto_says: val(r[6]),
      learns: val(r[7]),
      test_steps: val(r[8]),
    }))
    .filter(s => s.title);
}

function openImport() {
  el('import-text').value = '';
  el('import-preview').textContent = '';
  renderSheetLink();
  renderRouteToggle();
  el('import-sheet').hidden = false;
  el('import-text').focus();
}

function previewImport() {
  const list = rowsToScenarios(el('import-text').value);
  el('import-preview').textContent = !list.length
    ? (el('import-text').value.trim() ? 'No scenario rows recognised — is the "Trigger scenario" column the second one?' : '')
    : `${list.length} scenario${list.length === 1 ? '' : 's'} recognised: `
      + list.slice(0, 3).map(s => `#${s.num || '·'} ${shortTitle(s)}`).join(', ')
      + (list.length > 3 ? ', …' : '')
      + ' — each still needs its test address after import.';
}

async function runImport() {
  const list = rowsToScenarios(el('import-text').value);
  if (!list.length) { previewImport(); return; }
  el('import-sheet').hidden = true;
  let added = [];
  if (Backend.enabled) {
    try { added = (await Backend.insertScenarios(list)) || []; } catch (e) { warn(e); }
  }
  if (!added.length) {
    added = list.map(r => ({ ...r, id: localId('s'), created_at: new Date().toISOString() }));
  }
  scenarios.push(...added);
  scenarios.sort((a, b) =>
    ((a.num == null ? 1e9 : a.num) - (b.num == null ? 1e9 : b.num))
    || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  expandedId = added[0] ? added[0].id : expandedId;
  persistLocal();
  render();
  map.refresh();
  if (added[0]) scrollToScenario(added[0].id);
}

/* ---------- the starter sheet ----------
 * trigger-scenarios.js ships the deck's "Otto triggers" sheet as ten
 * finished rows — the worked example first, then the rest of one
 * delivery front to back, ending in the clean-run control. Loading is
 * idempotent by title: rows already in the list are skipped, so a
 * deleted row comes back by loading again, and a list that started
 * from the old single-sample load gains only the nine missing rows.
 * The sheet's own numbering is kept while it is free; if any incoming
 * number is already taken, the new rows are numbered after the list's
 * max instead — in sheet order, never doubling up a pin label. */
const SHEET = window.TRIGGER_SHEET || null;
const normTitle = t => String(t || '').trim().toLowerCase();
const SHEET_TITLES = new Set(SHEET ? SHEET.scenarios.map(r => normTitle(r.title)) : []);
/* A row is "the sheet's" exactly when the loader would skip it: same
 * title. Rename one and it is yours — the ⇩ STARTER chip goes, and the
 * loader offers the original row back. One identity rule, two faces. */
const fromSheet = sc => SHEET_TITLES.has(normTitle(sc.title));

/* Three tabs: the dashboard's own scenario rows, the starter sheet's
 * (those two only when the list is actually mixed — one kind of row
 * needs no tab of its own), and the situations. A view choice per
 * browser, like the ROUTE chip: the map keeps every pin, and revealing
 * a row that lives in another tab (a pin click, a load, a paste)
 * switches there first.
 *
 * SITUATIONS is workshop chrome like the grade widget, so the DEMO view
 * does not carry it — the choice is kept, not cleared, and flipping
 * back to TESTING lands on it again. */
const LS_TAB = 'od_scen_tab';
const LIST_TABS = ['own', 'sheet', 'situations', 'runs'];
let listTab = 'own';
try { const t = localStorage.getItem(LS_TAB); if (LIST_TABS.includes(t)) listTab = t; } catch { /* private mode */ }
const sitTabOn = () => listTab === 'situations' && cardView !== 'demo';
/* RUNS is workshop chrome too — a per-run report of what the simulated
 * drivers got out of Otto is the last thing a client demo wants on
 * screen, so the DEMO view hides it exactly as it hides SITUATIONS */
const runsTabOn = () => listTab === 'runs' && cardView !== 'demo';
const listMixed = () => scenarios.some(fromSheet) && scenarios.some(sc => !fromSheet(sc));
const inTab = sc => !sitTabOn() && !runsTabOn() && (!listMixed() || ((listTab === 'sheet') === fromSheet(sc)));
function setListTab(t) {
  listTab = LIST_TABS.includes(t) ? t : 'own';
  /* leaving the RUNS tab closes whatever summary was open: coming back
   * should land on the list of runs, not halfway down an old report */
  if (listTab !== 'runs') { openRunId = null; runFocusSit = null; }
  try { localStorage.setItem(LS_TAB, listTab); } catch { /* private mode */ }
}

const sheetMissing = () => {
  if (!SHEET) return [];
  const have = new Set(scenarios.map(sc => normTitle(sc.title)));
  return SHEET.scenarios.filter(r => !have.has(normTitle(r.title)));
};

function renderSheetLink() {
  const btn = el('sheet-load');
  if (!SHEET) { btn.hidden = true; return; }
  const n = sheetMissing().length;
  const total = SHEET.scenarios.length;
  btn.hidden = false;
  btn.disabled = !n;
  btn.textContent = n === total
    ? `…or load the ${total}-scenario starter sheet (the deck's “${SHEET.name}”)`
    : n
      ? `…or restore the ${n} starter-sheet row${n === 1 ? '' : 's'} not in the list`
      : `all ${total} starter-sheet scenarios are in the list`;
}

async function loadSheet() {
  const missing = sheetMissing();
  if (!missing.length) return;
  el('import-sheet').hidden = true;
  const taken = new Set(scenarios.map(sc => sc.num).filter(n => n != null));
  let next = Math.max(0, ...scenarios.map(sc => sc.num || 0));
  const clash = missing.some(r => taken.has(r.num));
  const at = new Date().toISOString();
  const rows = missing.map(r => ({
    ...r,
    num: clash ? ++next : r.num,
    params: (r.params || []).map(p => ({ ...p })),
    version: 1,
    version_note: 'from the starter sheet',
    version_at: at,
  }));
  let added = [];
  if (Backend.enabled) {
    try { added = (await Backend.insertScenarios(rows)) || []; } catch (e) { warn(e); }
  }
  if (!added.length) {
    added = rows.map(r => ({ ...r, id: localId('s'), created_at: new Date().toISOString() }));
  }
  scenarios.push(...added);
  scenarios.sort((a, b) =>
    ((a.num == null ? 1e9 : a.num) - (b.num == null ? 1e9 : b.num))
    || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  persistLocal();
  render();
  map.refresh();
  if (added[0]) scrollToScenario(added[0].id);
}

/* ---------- the starter situations ----------
 * situations-starter.js ships twenty things a driver reports, from a
 * closed road to a normal delivery with nothing to note. Loaded the
 * same way as the trigger sheet — idempotent by title, so a deleted row
 * comes back by loading again and the sheet's numbering is kept while
 * it is free. Keyless that lands in localStorage, live it is one
 * insert: twenty requests are twenty chances to half-load a sheet. */
const SIT_SHEET = window.SITUATIONS_SHEET || null;
const sitSheetMissing = () => {
  if (!SIT_SHEET) return [];
  const have = new Set(situations.map(s => normTitle(s.title)));
  return SIT_SHEET.situations.filter(r => !have.has(normTitle(r.title)));
};

/* under a non-empty list: the way back to the rows that were deleted */
function renderSitSheetLink() {
  const n = sitSheetMissing().length;
  return n ? `
    <p class="sit-restore"><button class="link-btn" type="button" data-sit-restore>…or restore the ${n} starter situation${n === 1 ? '' : 's'} not in the list</button></p>` : '';
}

async function loadSituationSheet() {
  const missing = sitSheetMissing();
  if (!missing.length) return;
  const taken = new Set(situations.map(s => s.num).filter(n => n != null));
  let next = Math.max(0, ...situations.map(s => +s.num || 0));
  const clash = missing.some(r => taken.has(r.num));
  const rows = missing.map(r => sitRow({ ...r, num: clash ? ++next : r.num, active: true }));
  let added = [];
  if (Backend.enabled) {
    try { added = (await Backend.insertSituations(rows)) || []; } catch (e) { schemaHint(e); }
  }
  if (!added.length) {
    added = rows.map(r => ({ ...r, id: localId('q'), created_at: new Date().toISOString() }));
  }
  situations.push(...added);
  sortSituations();
  persistLocal();
  render();
  if (added[0]) scrollToSituation(added[0].id);
}

/* ---------- situation CRUD ----------
 * A new situation is a real row from the first click: the card IS the
 * editor, so there is nothing to fill in before it exists. */
async function newSituation() {
  /* the button can be pressed from anywhere the browser still shows it
   * (an old cached page, a stale stylesheet) — a new row must never be
   * created onto a list that is not on screen, or the press reads as
   * "nothing happened" */
  setListTab('situations');
  const row = sitRow({
    num: Math.max(0, ...situations.map(s => +s.num || 0)) + 1,
    title: 'New situation',
    category: 'other',
    stop: null,
    driver_says: null,
    driver_knows: null,
    follow_up: [],
    off_topic: [],
    tip: null,
    active: true,
  });
  let saved = null;
  if (Backend.enabled) {
    try {
      const out = await Backend.insertSituations([row]);
      if (Array.isArray(out) && out[0]) saved = out[0];
    } catch (e) { schemaHint(e); }
  }
  if (!saved) saved = { ...row, id: localId('q'), created_at: new Date().toISOString() };
  situations.push(saved);
  sortSituations();
  expandedSitId = saved.id;
  sitEdit = sitDraftOf(saved);
  persistLocal();
  render();
  scrollToSituation(saved.id);
}

/* one writer for both the input and the change event — true when the
 * event was a situation field's and the draft has taken it */
function onSitFieldInput(e) {
  const k = e.target.getAttribute && e.target.getAttribute('data-sit-field');
  if (!k) return false;
  const card = e.target.closest('.sit');
  const s = card && situations.find(x => x.id === card.dataset.sit);
  if (s) openSitEdit(s)[k] = e.target.value;
  return true;
}

async function saveSituation(s) {
  const d = sitEdit && sitEdit.id === s.id ? sitEdit : null;
  const patch = d ? sitPatch(s, d) : {};
  sitEdit = null;
  if (Object.keys(patch).length) {
    Object.assign(s, patch);
    if (Backend.enabled) Backend.updateSituation(s.id, patch).catch(schemaHint);
    persistLocal();
  }
  render();
}

async function deleteSituation(s) {
  if (!confirm(`Delete this situation?\n\n#${s.num || '·'} ${s.title}`)) return;
  situations = situations.filter(x => x !== s);
  if (Backend.enabled) Backend.deleteSituation(s.id).catch(warn);
  if (expandedSitId === s.id) expandedSitId = null;
  if (sitEdit && sitEdit.id === s.id) sitEdit = null;
  persistLocal();
  render();
}

/* ---------- the demo route ----------
 * route-schoeneberg.js ships one realistic delivery tour through
 * Berlin-Schöneberg: up to a hundred ordered stops, several of them
 * behind one front door, with pre-arrival notes on file at many —
 * delivery info from dispatch and what drivers reported on earlier
 * tours. Loading turns every stop into a destination row (the route
 * and stop columns keep the grouping), so the phone shows the pins
 * and Otto reads the notes on approach — the pre-arrival loop at the
 * scale of a real tour instead of one hand-made pin. */
const ROUTES = (window.DEMO_ROUTES || (window.DEMO_ROUTE ? [window.DEMO_ROUTE] : []))
  .filter(r => r && r.id && Array.isArray(r.stops));
/* the stops of one route — or of every loaded route when none is named */
const routeStops = r => destinations.filter(d => (r ? d.route === r.id : !!d.route));
const loadedRoutes = () => ROUTES.filter(r => routeStops(r).length);
const routeById = id => ROUTES.find(r => r.id === id) || null;
/* The header chip is an ON/OFF switch for this dashboard's map, like
 * the phone's ROUTE chip is for its own screen — hiding is a view
 * choice per browser, never a delete. Removing the route (data and
 * all) stays behind the link in the import sheet. */
const LS_ROUTE_SHOW = 'od_route_show';
let routeShown = true;
try { routeShown = localStorage.getItem(LS_ROUTE_SHOW) !== '0'; } catch { /* private mode */ }
const shownRouteStops = () => (routeShown ? destinations.filter(d => d.route) : []);

/* The route rides two controls: the header chip — load once, then an
 * on/off switch for this dashboard's map — and the import-sheet link,
 * which is where the destructive remove lives. */
function renderRouteToggle() {
  const box = el('route-toggles');
  const chip = el('route-chip');
  if (!ROUTES.length) { box.innerHTML = ''; chip.hidden = true; return; }
  /* one link per route in the import sheet — load it, or remove it */
  box.innerHTML = ROUTES.map(r => {
    const n = routeStops(r).length;
    return n
      ? `<button class="link-btn" type="button" data-route="${esc(r.id)}" data-route-act="unload">✕ remove the “${esc(r.name)}” route (${n} stops loaded)</button>`
      : `<button class="link-btn" type="button" data-route="${esc(r.id)}" data-route-act="load">…or load the “${esc(r.name)}” route — ${r.stops.length} ${esc(r.area)} stops to ${r.walking ? 'walk' : 'drive'}, delivery + driver notes on file</button>`;
  }).join('');
  const n = routeStops().length;
  chip.hidden = false;
  chip.classList.toggle('off', !!n && !routeShown);
  if (!n) {
    chip.textContent = '⇪ ROUTE';
    chip.title = ROUTES.length === 1
      ? `Load the “${ROUTES[0].name}” demo route — ${ROUTES[0].stops.length} ${ROUTES[0].area} stops, delivery + driver notes on file`
      : 'Load a demo route — ' + ROUTES.map(r => `${r.name} (${r.stops.length} stops, ${r.walking ? 'walk' : 'drive'})`).join(' or ');
  } else if (routeShown) {
    chip.textContent = `ROUTE · ${n}`;
    chip.title = 'Hide the route stops on this dashboard — the phones keep them; loading and removing routes lives in the ⎘ PASTE FROM EXCEL sheet';
  } else {
    chip.textContent = 'ROUTE OFF';
    chip.title = `Show the ${n} route stops on the map again`;
  }
}

/* nothing loaded yet: a single route on file loads straight away, more
 * than one goes through the sheet, where each has its own link */
function loadSomeRoute() {
  if (routeStops().length) return;
  if (ROUTES.length === 1) loadRoute(ROUTES[0]);
  else openImport();
}

function toggleRouteShown() {
  routeShown = !routeShown;
  try { localStorage.setItem(LS_ROUTE_SHOW, routeShown ? '1' : '0'); } catch { /* private mode */ }
  renderRouteToggle();
  map.refresh();
  if (routeShown) { centerOnScenarios(); map.center(); } // switching it on means "show me"
}

async function loadRoute(r) {
  if (!r || routeStops(r).length) return;
  el('import-sheet').hidden = true;
  const now = Date.now();
  const rows = r.stops.map(s => ({
    title: s.title, addr: s.addr, lat: s.lat, lng: s.lng,
    route: r.id, stop: s.stop,
    consignee: s.consignee || null, floor: s.floor || null,
    /* array order in the data file IS the reading order (newest first)
     * — the stamped times, a day apart, just say so */
    notes: (s.notes || []).map((n, j) => ({
      id: localId('n'), text: n.text, by: n.by || 'dispatch',
      at: new Date(now - 36e5 - j * 864e5).toISOString(),
    })),
  }));
  let added = [];
  if (Backend.enabled) {
    /* live: one bulk insert or nothing — a schema without the route
     * columns fails whole, and schemaHint names the fix */
    try { added = (await Backend.insertDestinations(rows)) || []; } catch (e) { schemaHint(e); return; }
  } else {
    const at = new Date().toISOString();
    added = rows.map(r => ({ ...r, id: localId('d'), created_at: at }));
  }
  destinations.push(...added);
  routeShown = true; // loading means "show me"
  try { localStorage.setItem(LS_ROUTE_SHOW, '1'); } catch { /* private mode */ }
  const first = added[0];
  if (first) await createRouteScenario(r, first);
  persistLocal();
  render();
  map.refresh();
  if (first) centerOn(first.lat, first.lng);
}

/* The route is a scenario of its OWN — one row in the list to find it
 * by, pinned at stop 1, with the reading rings as its tunable values.
 * The phone applies those rings to EVERY stop of the route
 * (notesRadiiOf in app.js), so this row is where the route is tuned,
 * tested and judged — not a rider on someone else's row. */
async function createRouteScenario(r, first) {
  /* on foot the rings shrink: 350 m would arm a whole block at once */
  const walk = !!r.walking;
  const go = walk ? 'Walk' : 'Drive';
  const sc = await saveScenarioRow({
    num: Math.max(0, ...scenarios.map(s => s.num || 0)) + 1,
    title: `${r.name} route — ${go.toLowerCase()} the tour, Otto reads the notes`,
    rule: `Come within {notes_radius} m of any stop with notes on file — Otto reads consignee, floor, dispatch and driver notes aloud, once per approach; ${walk ? 'walking' : 'driving'} back out past {notes_rearm} m re-arms the reading.`,
    ar_states: walk ? 'ON_FOOT between stops; STILL at the door' : 'IN_VEHICLE between stops; STILL / ON_FOOT at the door',
    signals: 'GPS vs the stop pins; notes on file (dispatch + driver)',
    timing: 'On approach — before the driver is at the door',
    otto_says: '“Were the notes right — anything to correct for the next driver?”',
    learns: 'access / other — corrections to the notes on file',
    test_steps: `${go} the route in stop order (stop 1: ${first.title}). Otto reads ~{notes_radius} m ahead of each noted stop; ✕ on the banner stops a reading, and the phone's ROUTE chip hides the whole route for clean scenario tests. At each door tap ✓ Delivered or ✕ Not delivered on the stop card — that tap stands in for the scan.`,
    params: walk ? [
      { key: 'notes_radius', label: 'Notes read distance', value: 40, min: 10, max: 300, step: 5, unit: 'm' },
      { key: 'notes_rearm', label: 'Re-arm distance', value: 120, min: 30, max: 600, step: 10, unit: 'm' },
    ] : [
      { key: 'notes_radius', label: 'Notes read distance', value: 350, min: 50, max: 1000, step: 10, unit: 'm' },
      { key: 'notes_rearm', label: 'Re-arm distance', value: 700, min: 100, max: 2000, step: 25, unit: 'm' },
    ],
    version: 1,
    version_note: 'created with the route',
    version_at: new Date().toISOString(),
    destination_id: first.id,
  });
  scenarios.push(sc);
  scenarios.sort((a, b) =>
    ((a.num == null ? 1e9 : a.num) - (b.num == null ? 1e9 : b.num))
    || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/* A route loaded before the scenario row existed heals itself: stops
 * on file but no scenario pinned at any of them → cut the row now.
 * Idempotent — the guard is the row's own existence. */
async function ensureRouteScenario() {
  let cut = false;
  for (const r of loadedRoutes()) {
    const mine = routeStops(r);
    const ids = new Set(mine.map(d => d.id));
    if (scenarios.some(sc => sc.destination_id && ids.has(sc.destination_id))) continue;
    const first = mine.reduce((a, b) => ((a.stop == null ? 1e9 : a.stop) <= (b.stop == null ? 1e9 : b.stop) ? a : b));
    await createRouteScenario(r, first);
    cut = true;
  }
  if (cut) persistLocal();
}

async function unloadRoute(r) {
  const mine = r ? routeStops(r) : [];
  if (!mine.length) return;
  if (!confirm(`Remove the “${r.name}” demo route — all ${mine.length} stops, their notes and debriefs, and the route's scenario row?`)) return;
  el('import-sheet').hidden = true;
  const ids = new Set(mine.map(d => d.id));
  /* the route's own scenario (the loader pins it at a stop — nothing
   * else ever points a scenario at a route stop) leaves with it */
  const routeScs = scenarios.filter(sc => sc.destination_id && ids.has(sc.destination_id));
  if (Backend.enabled) {
    try {
      for (const sc of routeScs) await Backend.deleteScenario(sc.id);
      await Backend.deleteDestinationsByRoute(r.id);
    } catch (e) { warn(e); return; }
  }
  scenarios = scenarios.filter(sc => !routeScs.includes(sc));
  destinations = destinations.filter(d => !ids.has(d.id));
  el('stop-sheet').hidden = true; // an open stop just left with the route
  stopFor = null;
  persistLocal();
  render();
  map.refresh();
}

/* ---------- the stop sheet ----------
 * Click a route pin and see what is on file behind that door: every
 * stop at the address (stacked pins are one building, several
 * parcels), each with its consignee, its notes — dispatch adds and
 * removes them right here, exactly what Otto reads on approach — and
 * the latest real driver debriefs, read-only. */
let stopFor = null; // the tapped stop; the sheet shows its whole door

function renderStopSheet() {
  const d = stopFor;
  if (!d) return;
  const here = destinations
    .filter(x => x.route && x.lat === d.lat && x.lng === d.lng)
    .sort((a, b) => (a.stop == null ? 1e9 : a.stop) - (b.stop == null ? 1e9 : b.stop));
  el('stop-title').textContent =
    (here.length > 1 ? 'Stops ' + here.map(x => x.stop).join(' + ') : 'Stop ' + d.stop) + ' · ' + d.title;
  el('stop-addr').textContent = (d.addr || `${d.lat}, ${d.lng}`)
    + (here.length > 1 ? ` — ${here.length} parcels behind one door` : '');
  el('stop-links').innerHTML = `
    <a class="mini-btn accent" href="${gmapUrl(d)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
    <a class="mini-btn" href="${panoUrl(d)}" target="_blank" rel="noopener">Street View ↗</a>`;
  el('stop-body').innerHTML = here.map(s => {
    const notes = dispatchNotesOf(s);
    const msgs = (messagesByDest[s.id] || []).filter(m => m && !m.demo && (m.title || m.transcript)).slice(0, 2);
    return `
    <div class="stop-sec" data-dest="${esc(s.id)}">
      <span class="addr-tag">STOP ${esc(s.stop)}${s.consignee ? ' — ' + esc(s.consignee) : ''}${s.floor ? ' · ' + esc(s.floor) : ''}</span>
      ${notes.map((n, i) => `
        <div class="note-item">
          <span class="note-text">${esc(n.text)}</span>
          <span class="note-meta">${esc(String(n.by || 'dispatch').toUpperCase())}${n.at ? ' · ' + esc(fmtTime(n.at)) : ''}</span>
          <button class="note-del" type="button" data-stop-note-del="${i}" title="Remove this note">×</button>
        </div>`).join('')}
      ${msgs.map(m => `
        <div class="note-item">
          <span class="note-text">${esc(m.title || m.transcript)}</span>
          <span class="note-meta">DRIVER DEBRIEF${m.created_at ? ' · ' + esc(fmtTime(m.created_at)) : ''}</span>
        </div>`).join('')}
      ${!notes.length && !msgs.length ? '<p class="notes-hint">Nothing on file yet — Otto reads only the consignee here.</p>' : ''}
      <div class="note-add">
        <input data-stop-note-new placeholder="Note for the next driver — read aloud on approach">
        <button class="mini-btn accent" type="button" data-stop-note-add>+ Add note</button>
      </div>
    </div>`;
  }).join('');
}

function openStop(d) {
  stopFor = d;
  renderStopSheet();
  el('stop-sheet').hidden = false;
}

/* ---------- events ---------- */
el('list').addEventListener('click', e => {
  const empty = e.target.closest('[data-empty]');
  if (empty) {
    const act = empty.dataset.empty;
    if (act === 'new') openForm(null);
    else if (act === 'import') openImport();
    else if (act === 'sheet') loadSheet();
    else if (act === 'route') loadSomeRoute();
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) { setListTab(tab.dataset.tab); render(); return; }

  /* ---- the runs tab ----
   * Asked about before the cards: the "see the full reasons" link lives
   * INSIDE a situation card, and the card's own handler would swallow
   * it. Everything here only navigates or copies text — nothing on the
   * RUNS tab writes anything anywhere. */
  const jump = e.target.closest('[data-runjump]');
  if (jump) {
    openRunId = jump.dataset.runjump;
    runFocusSit = jump.dataset.runsit || null;
    setListTab('runs');  // switching TO runs keeps openRunId; only leaving clears it
    render();
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) { copySuggestion(copy); return; }
  if (runsTabOn()) {
    /* NOT A PROBLEM and its UNDO — the one thing on this tab that
     * writes anywhere, and it writes the designer's decision only */
    const nap = e.target.closest('[data-nap]');
    if (nap) { acceptFinding(nap.dataset.nap, nap.dataset.napTitle); return; }
    const unap = e.target.closest('[data-unap]');
    if (unap) { unacceptFinding(unap.dataset.unap); return; }
    const act = e.target.closest('[data-run-act]');
    if (act) {
      if (act.dataset.runAct === 'all') { openRunId = null; runFocusSit = null; render(); }
      return;
    }
    /* a row of the EVERY SITUATION table opens that situation's card —
     * the row is where it gets edited, and this page never edits */
    const sj = e.target.closest('[data-sitjump]');
    if (sj) {
      const id = sj.dataset.sitjump;
      if (!id) return;  // no row of that title on the sheet — nothing to open
      expandedSitId = id;
      setListTab('situations');
      render();
      scrollToSituation(id);
      return;
    }
    const row = e.target.closest('[data-run]');
    if (row && !e.target.closest('a')) {  // the GitHub link goes to GitHub
      openRunId = row.dataset.run;
      runFocusSit = null;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    return;
  }

  /* ---- the situations tab ---- */
  const sitEmpty = e.target.closest('[data-sit-empty]');
  if (sitEmpty) {
    if (sitEmpty.dataset.sitEmpty === 'new') newSituation(); else loadSituationSheet();
    return;
  }
  if (e.target.closest('[data-sit-restore]')) { loadSituationSheet(); return; }
  /* a situation card wears .sc for the chrome, so it must be asked
   * about FIRST — .sit is the one that carries the row */
  const sitCard = e.target.closest('.sit');
  if (sitCard) {
    const s = situations.find(x => x.id === sitCard.dataset.sit);
    if (!s) return;
    const sa = e.target.closest('[data-sit-act]');
    if (sa) {
      const a = sa.dataset.sitAct;
      if (a === 'save') saveSituation(s);
      else if (a === 'cancel') { sitEdit = null; render(); }
      else if (a === 'del') deleteSituation(s);
      else if (a === 'active') { const d = openSitEdit(s); d.active = !d.active; render(); }
      return;
    }
    if (e.target.closest('a')) return;
    /* a click on an input must not fold the card back up */
    if (e.target.closest('.sc-header')) {
      expandedSitId = expandedSitId === s.id ? null : s.id;
      render();
    }
    return;
  }

  const card = e.target.closest('.sc');
  if (!card) return;
  const sc = scenarios.find(x => x.id === card.dataset.id);
  if (!sc) return;

  const cv = e.target.closest('[data-cardview]');
  if (cv) {
    stopFbCapture(); // a hot mic must never ride into the DEMO view unseen
    setCardView(cv.dataset.cardview);
    render();
    return;
  }

  const v = e.target.closest('[data-verdict]');
  if (v) { setVerdict(sc, v.dataset.verdict); return; }

  const nd = e.target.closest('[data-note-del]');
  if (nd) { deleteDestNote(sc, parseInt(nd.dataset.noteDel, 10)); return; }

  const me = e.target.closest('[data-msg-edit]');
  if (me) {
    const m = msgsOf(sc)[parseInt(me.dataset.msgEdit, 10)];
    if (m) {
      msgEdit = { destId: sc.destination_id, i: parseInt(me.dataset.msgEdit, 10), title: m.title || '', transcript: m.transcript || '' };
      render();
    }
    return;
  }
  const md = e.target.closest('[data-msg-del]');
  if (md) { deleteMessage(sc, parseInt(md.dataset.msgDel, 10)); return; }
  const gc = e.target.closest('[data-grade-check]');
  if (gc) { toggleGradeCheck(sc, parseInt(gc.dataset.gradeI, 10), gc.dataset.gradeCheck, gc.dataset.gradeVal === '1'); return; }

  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'addr') openAddr(sc);
    else if (a === 'edit') openForm(sc);
    else if (a === 'del') deleteScenario(sc);
    else if (a === 'center') {
      const d = sc.destination_id && destById(sc.destination_id);
      if (d) centerOn(d.lat, d.lng);
    }
    else if (a === 'tune-save') saveTuning(sc);
    else if (a === 'tune-reset') { tune = null; render(); }
    else if (a === 'fb-open') { fbRec = { id: sc.id, text: '', via: null, state: 'idle' }; render(); }
    else if (a === 'fb-mic') toggleFbMic(sc);
    else if (a === 'fb-save') saveFeedback(sc);
    else if (a === 'fb-cancel') { stopFbCapture(); fbRec = null; render(); }
    else if (a === 'propose') runPropose(sc);
    else if (a === 'p-apply') applyProposal(sc);
    else if (a === 'p-discard') { proposal = null; render(); }
    else if (a === 'restore') restoreVersion(sc, parseInt(act.dataset.ver, 10));
    else if (a === 'spec') exportSpec(sc);
    else if (a === 'note-add') addDestNote(sc, card);
    else if (a === 'notes-radius') addNotesRadiusParam(sc);
    else if (a === 'msg-save') saveMessageEdit();
    else if (a === 'msg-cancel') { msgEdit = null; render(); }
    else if (a === 'grade-save') saveMessageGrade(sc, parseInt(act.dataset.gradeI, 10));
    else if (a === 'grade-cancel') { delete msgGrades[gradeKey(msgsOf(sc)[parseInt(act.dataset.gradeI, 10)])]; render(); }
    return;
  }

  if (e.target.closest('a')) return; // Google Maps links pass through
  if (e.target.closest('.sc-header')) {
    expandedId = expandedId === sc.id ? null : sc.id;
    render();
  }
});

/* sliders, the feedback textarea and the proposal edits all live inside
 * the list — one delegated input handler, no re-render mid-typing */
el('list').addEventListener('input', e => {
  /* the situation card's fields write straight into the draft — no
   * repaint, so a cursor mid-word stays where it is */
  if (onSitFieldInput(e)) return;
  const card = e.target.closest('.sc');
  if (!card) return;
  const sc = scenarios.find(x => x.id === card.dataset.id);
  if (!sc) return;
  if (e.target.classList.contains('tune-slider')) { onTuneInput(sc, card, e.target); return; }
  if (msgEdit) {
    const mf = e.target.getAttribute('data-msg-field');
    if (mf) { msgEdit[mf] = e.target.value; return; }
  }
  const gn = e.target.getAttribute('data-grade-note');
  if (gn != null) { openGrade(sc, parseInt(gn, 10)).note = e.target.value; return; }
  if (e.target.hasAttribute('data-fb-text')) {
    if (fbRec && fbRec.id === sc.id) fbRec.text = e.target.value;
    return;
  }
  if (proposal && proposal.id === sc.id) {
    const pf = e.target.getAttribute('data-pfield');
    if (pf) { proposal.changes[pf] = e.target.value; return; }
    const pp = e.target.getAttribute('data-pparam');
    if (pp) {
      const p = (proposal.params || []).find(x => x.key === pp);
      if (p && isFinite(parseFloat(e.target.value))) p.value = parseFloat(e.target.value);
      return;
    }
    if (e.target.hasAttribute('data-pnote')) proposal.note = e.target.value;
  }
});

/* consignee / floor save on change (blur or Enter) — the value already
 * sits in the input exactly as typed, so no repaint is needed */
el('list').addEventListener('change', e => {
  /* a <select> is the one field that can change without an input event
   * on every browser — the same writer, once more on change */
  if (onSitFieldInput(e)) return;
  const k = e.target.getAttribute && e.target.getAttribute('data-note-field');
  if (!k) return;
  const card = e.target.closest('.sc');
  const sc = card && scenarios.find(x => x.id === card.dataset.id);
  const d = sc && sc.destination_id && destById(sc.destination_id);
  if (!d) return;
  const v = String(e.target.value).trim() || null;
  if ((d[k] || null) === v) return;
  saveDestPatch(d, { [k]: v });
});

/* The RUNS tab's rows are focusable, so the keyboard must open them the
 * way the mouse does — one synthetic click through the same handler
 * above, no second copy of the navigation. */
el('list').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest && e.target.closest('[data-run], [data-sitjump]');
  if (!row || !runsTabOn()) return;
  e.preventDefault();
  row.click();
});

/* Enter in the note field adds it, like the button */
el('list').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !(e.target.hasAttribute && e.target.hasAttribute('data-note-new'))) return;
  e.preventDefault();
  const card = e.target.closest('.sc');
  const sc = card && scenarios.find(x => x.id === card.dataset.id);
  if (sc) addDestNote(sc, card);
});

el('new-open').onclick = () => openForm(null);
el('new-situation').onclick = newSituation;
el('form-cancel').onclick = () => { el('form-sheet').hidden = true; };
el('form-save').onclick = submitForm;
el('f-draft').onclick = runDraft;
el('f-param-add').onclick = () => {
  formParams.push({ key: '', label: '', value: '', min: '', max: '', unit: '' });
  renderFormParams();
};
el('f-params').addEventListener('input', e => {
  const spec = e.target.getAttribute('data-pe');
  if (!spec) return;
  const [i, prop] = spec.split(':');
  if (formParams[+i]) formParams[+i][prop] = e.target.value;
});
el('f-params').addEventListener('click', e => {
  const del = e.target.getAttribute('data-pe-del');
  if (del != null) { formParams.splice(+del, 1); renderFormParams(); }
});
el('spec-all').onclick = exportAllSpecs;
el('import-open').onclick = openImport;
el('import-cancel').onclick = () => { el('import-sheet').hidden = true; };
el('import-go').onclick = runImport;
el('sheet-load').onclick = loadSheet;
el('route-toggles').onclick = e => {
  const b = e.target.closest('[data-route]');
  const r = b && routeById(b.dataset.route);
  if (!r) return;
  if (b.dataset.routeAct === 'unload') unloadRoute(r); else loadRoute(r);
};
el('route-chip').onclick = () => (routeStops().length ? toggleRouteShown() : loadSomeRoute());
el('stop-close').onclick = () => { el('stop-sheet').hidden = true; stopFor = null; };
/* add / delete notes straight from the stop sheet — the map's amber
 * marking and the "with notes" count follow the edit live */
el('stop-body').addEventListener('click', e => {
  const sec = e.target.closest('[data-dest]');
  if (!sec) return;
  const d = destinations.find(x => x.id === sec.dataset.dest);
  if (!d) return;
  const del = e.target.closest('[data-stop-note-del]');
  if (del) {
    const notes = dispatchNotesOf(d);
    const i = parseInt(del.dataset.stopNoteDel, 10);
    if (!(i >= 0 && i < notes.length)) return;
    notes.splice(i, 1);
    saveDestPatch(d, { notes });
  } else if (e.target.closest('[data-stop-note-add]')) {
    const input = sec.querySelector('[data-stop-note-new]');
    const text = String((input && input.value) || '').trim();
    if (!text) return;
    saveDestPatch(d, { notes: [{ id: localId('n'), text, at: new Date().toISOString(), by: 'dispatch' }, ...dispatchNotesOf(d)] });
  } else {
    return;
  }
  renderStopSheet();
  renderStats();
  map.refresh();
});
el('import-text').addEventListener('input', previewImport);
el('addr-close').onclick = closeAddr;
el('addr-input').addEventListener('input', e => onAddrInput(e.target.value));

el('refresh').onclick = async () => {
  await loadAll();
  await ensureRouteScenario();
  render();
  map.refresh();
};

/* Esc closes whichever sheet is open. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['form-sheet', 'addr-sheet', 'import-sheet', 'stop-sheet'].forEach(id => { el(id).hidden = true; });
  addrFor = null;
  stopFor = null;
});

/* ---------- boot ---------- */
(async () => {
  await loadAll();
  await ensureRouteScenario();
  centerOnScenarios();
  render();
  map.refresh();

  if (Backend.enabled) {
    /* a dashboard left open while testers are out in the field: poll for
     * fresh debriefs (REST only — no realtime channel in this kit).
     * uiBusy: never repaint over a slider drag, a recording or an open
     * proposal — ↻ REFRESH is there when it matters. */
    setInterval(async () => {
      if (document.hidden || uiBusy()) return;
      await loadAll();
      render();
      map.refresh();
    }, 30000);
  } else {
    /* local demo mode: the phone app in another tab writes the same
     * localStorage — the storage event keeps this page live */
    window.addEventListener('storage', async e => {
      if (e.key && ![LS_DEST, LS_MSGS, LS_SCEN, LS_RUNS, LS_SITU].includes(e.key)) return;
      if (uiBusy()) return;
      await loadAll();
      render();
      map.refresh();
    });
  }
})();
