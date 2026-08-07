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

let scenarios = [];
let destinations = [];
let messagesByDest = {};
let runsByScenario = {};
let expandedId = null;

/* in-flight UI state for the tuning loop — all per one scenario at a time */
let tune = null;         // { id, params } — slider values not yet saved as a version
let fbRec = null;        // { id, text, via, state } — the open feedback recorder
let proposal = null;     // { id, changes, params, note, demo, fb_ids, none } — a proposed next version
let proposalBusy = null; // scenario id while the revision round-trip runs

const destById = id => destinations.find(d => d.id === id) || null;
const localId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const warn = e => console.warn('dashboard:', e && e.message ? e.message : e);
/* A write failing against a live backend usually means the scenarios
 * table predates the tuning-loop columns — say so where it is seen. */
const schemaHint = e => {
  warn(e);
  if (Backend.enabled && /column|schema|400/i.test(String(e && e.message))) {
    el('stats').textContent = 'Save failed — the scenarios table is missing newer columns. Re-run supabase/schema.sql, then ↻ REFRESH.';
  }
};
/* Auto-refresh must not repaint over a drag, a recording, or an open
 * proposal — those live only in the DOM until saved. */
const uiBusy = () => !!(tune || fbRec || proposal || proposalBusy) || !el('form-sheet').hidden;

const persistLocal = () => {
  if (Backend.enabled) return;
  try {
    localStorage.setItem(LS_SCEN, JSON.stringify(scenarios));
    localStorage.setItem(LS_DEST, JSON.stringify(destinations));
  } catch { /* private mode */ }
};

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
/* Param keys the phone's live detector consumes (trigOf in app.js). */
const DETECTOR_KEYS = ['radius', 'exit_radius', 'pass_speed_max', 'pass_still_max_s',
  'passes_needed', 'stop_speed', 'stop_dwell_s', 'stop_radius', 'resume_speed'];

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
  markers: () => scenarios.map(sc => {
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
  onMarkerClick(m) {
    const sc = scenarios.find(x => x.id === m.id);
    if (sc) { expandedId = sc.id; render(); scrollToScenario(sc.id); }
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
function centerOnScenarios() {
  const pins = scenarios.map(sc => sc.destination_id && destById(sc.destination_id)).filter(Boolean);
  if (!pins.length) { Geo.simulate({ lat: 52.5346, lng: 13.4109 }); return; }
  const lat = pins.reduce((s, d) => s + d.lat, 0) / pins.length;
  const lng = pins.reduce((s, d) => s + d.lng, 0) / pins.length;
  Geo.simulate({ lat, lng });
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
    } catch (e) { warn(e); }
    try {
      scenarios = (await Backend.listScenarios()) || [];
    } catch (e) {
      warn(e);
      el('stats').textContent = 'Could not load scenarios — re-run supabase/schema.sql to add the scenarios table.';
      scenarios = [];
      return;
    }
    runsByScenario = {};
    try {
      ((await Backend.listRuns(300)) || []).forEach(r => {
        if (r.scenario_id) (runsByScenario[r.scenario_id] = runsByScenario[r.scenario_id] || []).push(r);
      });
    } catch (e) { warn(e); /* runs table not created yet — the log just stays empty */ }
  } else {
    try { scenarios = JSON.parse(localStorage.getItem(LS_SCEN) || '[]'); } catch { scenarios = []; }
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { destinations = []; }
    messagesByDest = {};
    try {
      (JSON.parse(localStorage.getItem(LS_MSGS) || '[]')).forEach(m => {
        if (m.destination_id) (messagesByDest[m.destination_id] = messagesByDest[m.destination_id] || []).push(m);
      });
    } catch { /* private mode */ }
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
}

/* ---------- rendering ---------- */
function fmtTime(iso) {
  const t = new Date(iso || 0);
  return isNaN(t) ? '' : t.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderStats() {
  const by = { nopin: 0, ready: 0, debriefed: 0, pass: 0, partial: 0, fail: 0 };
  scenarios.forEach(sc => { by[statusOf(sc).key]++; });
  const parts = [`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`];
  if (by.nopin) parts.push(`${by.nopin} need an address`);
  if (by.ready) parts.push(`${by.ready} awaiting test`);
  if (by.debriefed) parts.push(`${by.debriefed} debriefed`);
  const verdicts = [];
  if (by.pass) verdicts.push(`${by.pass} pass`);
  if (by.partial) verdicts.push(`${by.partial} partial`);
  if (by.fail) verdicts.push(`${by.fail} fail`);
  if (verdicts.length) parts.push(verdicts.join(' / '));
  parts.push('build ' + window.BUILD);
  el('stats').textContent = parts.join(' · ');
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
  return list.map(m => {
    const match = catMatches(m.category, sc.learns);
    /* observed activity, if the phone was tracking (jsonb object from
     * Supabase, plain object from localStorage, string if hand-fed) */
    let trace = m.ar_trace;
    if (typeof trace === 'string') { try { trace = JSON.parse(trace); } catch { trace = null; } }
    const trig = trace && trace.trigger;
    return `
      <div class="msg">
        <div class="msg-top">
          <span class="msg-cat${match ? ' match' : ''}">${esc(m.category || 'INFO')}${match ? ' · = EXPECTED TYPE' : ''}</span>
          ${m.demo ? '<span class="msg-demo">DEMO</span>' : ''}
          <span class="msg-time">${esc(fmtTime(m.created_at))}</span>
        </div>
        ${m.title ? `<div class="msg-title">${esc(m.title)}</div>` : ''}
        ${m.transcript ? `<p class="msg-tr">&ldquo;${esc(m.transcript)}&rdquo;</p>` : ''}
        ${trig ? `<span class="trig-chip" title="${esc(trig.tuning ? 'Ran with: ' + Object.entries(trig.tuning).map(([k, v]) => k + '=' + v).join(', ') : '')}">TRIGGER FIRED · ${esc(trig.passes)} PASS${trig.passes === 1 ? '' : 'ES'}${trig.stopped ? ' + STOP' : ''}${trig.scenario_version ? ' · v' + esc(trig.scenario_version) : ''}</span>` : ''}
        ${m.ar_summary ? `<div class="msg-ar" title="Activity observed on the device (${esc((trace && trace.source) || 'web')} inference)">AR&nbsp;·&nbsp;${esc(m.ar_summary)}</div>` : ''}
      </div>`;
  }).join('');
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
      ${drivesPhone ? '<p class="tune-note">These values drive the phone’s live trigger detector on the next test run.</p>' : ''}
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

function renderScenario(sc) {
  const st = statusOf(sc);
  const d = sc.destination_id && destById(sc.destination_id);
  const open = expandedId === sc.id;
  const ver = sc.version || 1;

  const addrLine = d
    ? `<div class="sc-addr-line">📍 ${esc(d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`)}</div>`
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

  /* pending slider values (if any) drive what the definition shows */
  const params = tune && tune.id === sc.id ? tune.params : paramsOf(sc);
  const fp = t => fillParams(t, params);

  const body = !open ? '' : `
    <div class="sc-body">
      ${addrBlock}
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

  return `
    <article class="sc" data-id="${esc(sc.id)}">
      <header class="sc-header">
        <span class="sc-num">${sc.num != null && sc.num !== '' ? '#' + esc(sc.num) : '·'}</span>
        <div class="sc-head">
          <h3>${esc(sc.title)}</h3>
          ${addrLine}
        </div>
        <span class="ver" title="${esc(sc.version_note || 'version')}">v${ver}</span>
        <span class="badge badge-${st.key}">${esc(st.label)}</span>
      </header>
      ${body}
    </article>`;
}

function render() {
  renderStats();
  const box = el('list');
  if (!scenarios.length) {
    box.innerHTML = `
      <div class="empty">
        <b>No trigger scenarios yet</b>
        <p>Define what the tester should act out and what Otto should understand — then pin each scenario to a real address.</p>
        <div class="top-actions">
          <button class="chip primary" type="button" data-empty="new">+ NEW SCENARIO</button>
          <button class="chip" type="button" data-empty="import">⎘ PASTE FROM EXCEL</button>
          <button class="chip" type="button" data-empty="sample">LOAD THE SAMPLE SCENARIO</button>
        </div>
      </div>`;
    return;
  }
  box.innerHTML = scenarios.map(renderScenario).join('');
}

function scrollToScenario(id) {
  const node = el('list').querySelector(`[data-id="${CSS.escape(id)}"]`);
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
      learns: 'ACCESS — the real parking spot for this address',
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
      learns: 'ACCESS — parking / loading-zone tip',
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
      learns: 'ENTRANCE — where the real way in is',
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
      learns: 'INFO — realistic waiting time and how to skip it',
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
      learns: 'CLOSURE — blocked route and the detour that works',
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
      learns: 'INFO — local knowledge for the next driver',
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
    destination: d ? { addr: d.addr || null, lat: d.lat, lng: d.lng } : null,
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

/* The one worked example from the deck's "Otto triggers" sheet — its
 * numbers as {key} placeholders so the sliders are live from the start. */
const SAMPLE = {
  num: 1,
  title: 'Parking loops — driver circles the block looking for parking',
  described: 'The driver has a delivery but cannot find parking, so they circle the block a few times slowly before finally stopping.',
  rule: 'Vehicle passes within ~{radius} m of the stop {passes_needed}× below {pass_speed_max} m/s without stopping, then stands ≥{stop_dwell_s} s within {stop_radius} m. Deck says 3 slow loops; every number here is a slider.',
  ar_states: 'IN_VEHICLE the whole time',
  signals: 'GPS trace vs stop pin; speed',
  timing: 'Wait — ask when back in the car after the stop',
  otto_says: '“Is it hard to park here at this time? Where did you find a spot?”',
  learns: 'ACCESS — parking / loading-zone tip',
  test_steps: 'Simulate a delivery address, drive around the block twice, then stop',
  params: [
    { key: 'radius', label: 'Pass radius', value: 150, min: 40, max: 400, step: 5, unit: 'm' },
    { key: 'passes_needed', label: 'Slow passes needed', value: 2, min: 0, max: 5, step: 1, unit: '×' },
    { key: 'pass_speed_max', label: 'Max pass speed', value: 9, min: 2, max: 15, step: 0.5, unit: 'm/s' },
    { key: 'stop_dwell_s', label: 'Stop dwell', value: 45, min: 10, max: 180, step: 5, unit: 's' },
    { key: 'stop_radius', label: 'Stop radius', value: 250, min: 50, max: 500, step: 10, unit: 'm' },
  ],
  version: 1,
};

async function loadSample() {
  el('import-sheet').hidden = true;
  const sc = await saveScenarioRow({ ...SAMPLE, version_at: new Date().toISOString() });
  scenarios.push(sc);
  expandedId = sc.id;
  persistLocal();
  render();
  map.refresh();
  scrollToScenario(sc.id);
  openAddr(sc);
}

/* ---------- events ---------- */
el('list').addEventListener('click', e => {
  const empty = e.target.closest('[data-empty]');
  if (empty) {
    const act = empty.dataset.empty;
    if (act === 'new') openForm(null);
    else if (act === 'import') openImport();
    else if (act === 'sample') loadSample();
    return;
  }
  const card = e.target.closest('.sc');
  if (!card) return;
  const sc = scenarios.find(x => x.id === card.dataset.id);
  if (!sc) return;

  const v = e.target.closest('[data-verdict]');
  if (v) { setVerdict(sc, v.dataset.verdict); return; }

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
  const card = e.target.closest('.sc');
  if (!card) return;
  const sc = scenarios.find(x => x.id === card.dataset.id);
  if (!sc) return;
  if (e.target.classList.contains('tune-slider')) { onTuneInput(sc, card, e.target); return; }
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

el('new-open').onclick = () => openForm(null);
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
el('import-sample').onclick = loadSample;
el('import-text').addEventListener('input', previewImport);
el('addr-close').onclick = closeAddr;
el('addr-input').addEventListener('input', e => onAddrInput(e.target.value));

el('refresh').onclick = async () => {
  await loadAll();
  render();
  map.refresh();
};

/* Esc closes whichever sheet is open. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['form-sheet', 'addr-sheet', 'import-sheet'].forEach(id => { el(id).hidden = true; });
  addrFor = null;
});

/* ---------- boot ---------- */
(async () => {
  await loadAll();
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
      if (e.key && ![LS_DEST, LS_MSGS, LS_SCEN, LS_RUNS].includes(e.key)) return;
      if (uiBusy()) return;
      await loadAll();
      render();
      map.refresh();
    });
  }
})();
