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

let scenarios = [];
let destinations = [];
let messagesByDest = {};
let expandedId = null;

const destById = id => destinations.find(d => d.id === id) || null;
const localId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const warn = e => console.warn('dashboard:', e && e.message ? e.message : e);

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

/* ---------- status model ---------- */
function msgsOf(sc) {
  return (sc.destination_id && messagesByDest[sc.destination_id]) || [];
}
function statusOf(sc) {
  if (sc.verdict === 'pass') return { key: 'pass', label: 'PASS', rgb: '70,211,154', labelColor: '#7ce0b8', icon: '✓' };
  if (sc.verdict === 'partial') return { key: 'partial', label: 'PARTIAL', rgb: '255,217,94', labelColor: '#ffd95e', icon: '~' };
  if (sc.verdict === 'fail') return { key: 'fail', label: 'FAIL', rgb: '255,120,69', labelColor: '#ffab8a', icon: '✗' };
  if (!sc.destination_id || !destById(sc.destination_id)) return { key: 'nopin', label: 'NEEDS ADDRESS', rgb: '255,217,94', labelColor: '#ffd95e', icon: '?' };
  const n = msgsOf(sc).length;
  if (!n) return { key: 'ready', label: 'AWAITING TEST', rgb: '255,107,107', labelColor: '#ff9b9b', icon: '▲' };
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
  } else {
    try { scenarios = JSON.parse(localStorage.getItem(LS_SCEN) || '[]'); } catch { scenarios = []; }
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { destinations = []; }
    messagesByDest = {};
    try {
      (JSON.parse(localStorage.getItem(LS_MSGS) || '[]')).forEach(m => {
        if (m.destination_id) (messagesByDest[m.destination_id] = messagesByDest[m.destination_id] || []).push(m);
      });
    } catch { /* private mode */ }
  }
  Object.values(messagesByDest).forEach(list =>
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
        ${trig ? `<span class="trig-chip">TRIGGER FIRED · ${esc(trig.passes)} PASS${trig.passes === 1 ? '' : 'ES'}${trig.stopped ? ' + STOP' : ''}</span>` : ''}
        ${m.ar_summary ? `<div class="msg-ar" title="Activity observed on the device (${esc((trace && trace.source) || 'web')} inference)">AR&nbsp;·&nbsp;${esc(m.ar_summary)}</div>` : ''}
      </div>`;
  }).join('');
}

function renderScenario(sc) {
  const st = statusOf(sc);
  const d = sc.destination_id && destById(sc.destination_id);
  const open = expandedId === sc.id;

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

  const body = !open ? '' : `
    <div class="sc-body">
      ${addrBlock}
      <div class="def-grid">
        ${defCell('Trigger rule (testable)', sc.rule)}
        ${defCell('Activity Recognition states', sc.ar_states)}
        ${defCell('Other signals needed', sc.signals)}
        ${defCell('Timing to talk', sc.timing)}
      </div>
      <div class="compare">
        <div class="cmp-col cmp-defined">
          <h4>DEFINED — WHAT SHOULD HAPPEN</h4>
          ${sc.otto_says ? `<div class="cmp-row"><span class="cmp-k">Otto asks</span><span class="cmp-v say">&ldquo;${esc(stripQuotes(sc.otto_says))}&rdquo;</span></div>` : ''}
          ${sc.learns ? `<div class="cmp-row"><span class="cmp-k">Expected tip type</span><span class="tip-chip">${esc(sc.learns)}</span></div>` : ''}
          ${sc.ar_states ? `<div class="cmp-row"><span class="cmp-k">Expected activity (Google AR states)</span><span class="cmp-v mono-v">${esc(sc.ar_states)}</span></div>` : ''}
          ${sc.test_steps ? `<div class="cmp-row"><span class="cmp-k">How to test it</span><span class="cmp-v">${esc(sc.test_steps)}</span></div>` : ''}
          ${!sc.otto_says && !sc.learns && !sc.test_steps ? '<p class="cmp-empty">Nothing defined yet — edit the scenario.</p>' : ''}
        </div>
        <div class="cmp-col cmp-heard">
          <h4>WHAT OTTO UNDERSTOOD</h4>
          ${renderMessages(sc)}
        </div>
      </div>
      <div class="verdict-row">
        <span class="verdict-label">Did Otto get it?</span>
        <button class="v-btn${sc.verdict === 'pass' ? ' on-pass' : ''}" type="button" data-verdict="pass">✓ PASS</button>
        <button class="v-btn${sc.verdict === 'partial' ? ' on-partial' : ''}" type="button" data-verdict="partial">~ PARTIAL</button>
        <button class="v-btn${sc.verdict === 'fail' ? ' on-fail' : ''}" type="button" data-verdict="fail">✗ FAIL</button>
        <span class="row-links">
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
    } catch (e) { warn(e); }
  }
  return { ...row, id: localId('s'), created_at: new Date().toISOString() };
}

async function patchScenario(sc, patch) {
  Object.assign(sc, patch);
  if (Backend.enabled) Backend.updateScenario(sc.id, patch).catch(warn);
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
  if (Backend.enabled) {
    Backend.deleteScenario(sc.id).catch(warn);
    if (d) Backend.deleteDestination(d.id).catch(warn); // messages cascade in SQL
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
let editing = null; // scenario being edited, or null for a new one

function openForm(sc) {
  editing = sc || null;
  el('form-title').textContent = sc ? 'Edit trigger scenario' : 'New trigger scenario';
  el('form-save').textContent = sc ? 'Save changes' : 'Save & set address';
  el('form-hint').textContent = '';
  const next = scenarios.reduce((m, s) => Math.max(m, s.num || 0), 0) + 1;
  el('f-num').value = sc ? (sc.num != null ? sc.num : '') : next;
  el('f-title').value = sc ? sc.title || '' : '';
  el('f-rule').value = sc ? sc.rule || '' : '';
  el('f-ar').value = sc ? sc.ar_states || '' : '';
  el('f-signals').value = sc ? sc.signals || '' : '';
  el('f-timing').value = sc ? sc.timing || '' : '';
  el('f-says').value = sc ? sc.otto_says || '' : '';
  el('f-learns').value = sc ? sc.learns || '' : '';
  el('f-steps').value = sc ? sc.test_steps || '' : '';
  el('form-sheet').hidden = false;
  el('f-title').focus();
}

async function submitForm() {
  const title = el('f-title').value.trim();
  if (!title) { el('form-hint').textContent = 'The scenario needs a name — the "Trigger scenario" column.'; return; }
  const numRaw = el('f-num').value.trim();
  const fields = {
    num: numRaw === '' ? null : parseInt(numRaw, 10),
    title,
    rule: el('f-rule').value.trim() || null,
    ar_states: el('f-ar').value.trim() || null,
    signals: el('f-signals').value.trim() || null,
    timing: el('f-timing').value.trim() || null,
    otto_says: el('f-says').value.trim() || null,
    learns: el('f-learns').value.trim() || null,
    test_steps: el('f-steps').value.trim() || null,
  };
  el('form-sheet').hidden = true;
  if (editing) {
    await patchScenario(editing, fields);
    render();
    map.refresh();
  } else {
    const sc = await saveScenarioRow(fields);
    scenarios.push(sc);
    expandedId = sc.id;
    persistLocal();
    render();
    map.refresh();
    scrollToScenario(sc.id);
    openAddr(sc); // a scenario without an address cannot be tested — ask right away
  }
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

/* The one worked example from the deck's "Otto triggers" sheet. */
const SAMPLE = {
  num: 1,
  title: 'Parking loops — driver circles the block looking for parking',
  rule: 'Vehicle passes within ~150 m of the stop 2–3 times at low speed without stopping. Deck says 3 slow loops; radius and count are drafts to tune.',
  ar_states: 'IN_VEHICLE the whole time',
  signals: 'GPS trace vs stop pin; speed',
  timing: 'Wait — ask when back in the car after the stop',
  otto_says: '“Is it hard to park here at this time? Where did you find a spot?”',
  learns: 'Parking / loading-zone tip',
  test_steps: 'Simulate a delivery address, drive around the block twice, then stop',
};

async function loadSample() {
  el('import-sheet').hidden = true;
  const sc = await saveScenarioRow({ ...SAMPLE });
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
    return;
  }

  if (e.target.closest('a')) return; // Google Maps links pass through
  if (e.target.closest('.sc-header')) {
    expandedId = expandedId === sc.id ? null : sc.id;
    render();
  }
});

el('new-open').onclick = () => openForm(null);
el('form-cancel').onclick = () => { el('form-sheet').hidden = true; };
el('form-save').onclick = submitForm;
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
     * fresh debriefs (REST only — no realtime channel in this kit) */
    setInterval(async () => {
      if (document.hidden) return;
      await loadAll();
      render();
      map.refresh();
    }, 30000);
  } else {
    /* local demo mode: the phone app in another tab writes the same
     * localStorage — the storage event keeps this page live */
    window.addEventListener('storage', async e => {
      if (e.key && ![LS_DEST, LS_MSGS, LS_SCEN].includes(e.key)) return;
      await loadAll();
      render();
      map.refresh();
    });
  }
})();
