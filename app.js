'use strict';

/* ============================================================
 * Destination debrief — the app glue.
 *
 * Composes the two extracted kits WITHOUT modifying them:
 *   geolocate.js + field-map.js  (field-map-kit)   position + live map
 *   voice-note.js                (voice-notes-kit) the Otto debrief
 *
 * This file owns the domain the kits deliberately left out:
 * destinations (real addresses pinned on the map), the card,
 * and the wiring that points Otto at a destination and files
 * his structured message against it.
 *
 * What the original challenge flow had and this drops, on
 * purpose: the cash payout, the 2-device consensus, and the
 * 75 m proximity gate — the gate existed so nobody could claim
 * money without being on site; with no money it is only
 * friction. Distance is still shown on the card.
 * ============================================================ */

const el = id => document.getElementById(id);

/* ---------- destinations & messages ---------- */
const LS_DEST = 'od_destinations';
const LS_MSGS = 'od_messages';
const LS_SCEN = 'od_scenarios';

let destinations = [];
const messagesByDest = {};
const reportedIds = new Set();
let current = null; // destination in the open card / Otto session

/* Trigger scenarios (defined on dashboard.html) — read-only here. A
 * destination that belongs to a scenario carries the test steps on its
 * card, and Otto opens the debrief with the scenario's own question. */
let scenarios = [];
let scenarioByDest = {};
const rebuildScenarioIndex = () => {
  scenarioByDest = {};
  scenarios.forEach(s => { if (s.destination_id) scenarioByDest[s.destination_id] = s; });
};
const scenarioOf = d => (d && scenarioByDest[d.id]) || null;
const stripQuotes = s => String(s || '').trim().replace(/^[“”"']+/, '').replace(/[“”"']+$/, '');
const scenarioShort = sc => String(sc.title || '').split(/\s+—\s+|\s+-\s+/)[0].trim();

/* ---------- test tracking: activity recognition + the trigger ----------
 * "Start test tracking" on a scenario card arms ActivityRec (states in
 * Google AR vocabulary — see activity-rec.js for what feeds them) and a
 * detector for the deck's sample rule: slow passes near the pin without
 * stopping, then the stop, then back in the vehicle -> Otto speaks up.
 * The numbers mirror the sheet ("radius and count are drafts to tune"). */
const TRIG = {
  radius: 150,        // m — a pass is being inside this circle around the pin
  exitRadius: 190,    // m — hysteresis: the pass counts once you are back out
  passSpeedMax: 9,    // m/s — faster than this inside is through-traffic, not a loop
  passStillMax: 25e3, // ms — standing longer than this inside makes it a stop, not a pass
  passesNeeded: 2,    // deck says 2–3 slow loops
  stopSpeed: 0.6,     // m/s — below this you are standing
  stopDwellMs: 45e3,  // ms — standing this long near the pin is THE stop
  stopRadius: 250,    // m — where that stop may happen
  resumeSpeed: 3,     // m/s — moving again afterwards = back in the car -> fire
};
let tracking = null;  // { sc, d, startedAt, passes, ... } while a test runs
let wakeLock = null;

async function acquireWakeLock() {
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (tracking && document.visibilityState === 'visible') acquireWakeLock();
});

function startTracking(sc, d) {
  ActivityRec.requestMotionPermission(); // needs the tap gesture on iOS
  ActivityRec.start();
  tracking = {
    sc, d, startedAt: Date.now(),
    passes: 0, inside: false, insideMaxStill: 0, insideSpeedSum: 0, insideN: 0,
    stillStart: null, stopped: false, resumeN: 0, fired: false, firedAt: null,
  };
  acquireWakeLock();
  updateArChip(ActivityRec.snapshot);
  updateCardTrack();
}

function stopTracking() {
  ActivityRec.stop();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  tracking = null;
  el('trigger-banner').hidden = true;
  updateArChip(ActivityRec.snapshot);
  updateCardTrack();
}

function detectorStep(snap) {
  const tr = tracking;
  const t = snap.t || Date.now();
  const sp = snap.speed;
  const dist = distM(snap.position, tr.d);

  /* the stop: standing near the pin long enough, after the loops */
  if (sp <= TRIG.stopSpeed && dist <= TRIG.stopRadius) {
    if (!tr.stillStart) tr.stillStart = t;
    const dwell = t - tr.stillStart;
    if (tr.inside) tr.insideMaxStill = Math.max(tr.insideMaxStill, dwell);
    if (!tr.stopped && tr.passes >= TRIG.passesNeeded && dwell >= TRIG.stopDwellMs) {
      tr.stopped = true;
      updateCardTrack();
    }
  } else {
    tr.stillStart = null;
  }

  /* pass episodes: in through the 150 m circle and out again, slow, no stop */
  if (!tr.inside && dist <= TRIG.radius) {
    tr.inside = true;
    tr.insideMaxStill = 0;
    tr.insideSpeedSum = 0;
    tr.insideN = 0;
  }
  if (tr.inside) { tr.insideSpeedSum += sp; tr.insideN++; }
  if (tr.inside && dist >= TRIG.exitRadius) {
    tr.inside = false;
    const mean = tr.insideN ? tr.insideSpeedSum / tr.insideN : 0;
    if (mean > 0.3 && mean <= TRIG.passSpeedMax && tr.insideMaxStill < TRIG.passStillMax) {
      tr.passes++;
      updateCardTrack();
    }
  }

  /* back in the car after the stop — the deck's timing to talk */
  if (tr.stopped && !tr.fired) {
    if (sp >= TRIG.resumeSpeed) { if (++tr.resumeN >= 2) fireTrigger(t); }
    else tr.resumeN = 0;
  }
}

function fireTrigger(t) {
  tracking.fired = true;
  tracking.firedAt = t;
  el('tb-text').textContent = `${scenarioShort(tracking.sc)} — tap to answer Otto.`;
  el('trigger-banner').hidden = false;
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  updateCardTrack();
}

function updateArChip(snap) {
  const chip = el('ar');
  if (!snap.on) {
    chip.textContent = 'AR OFF · TAP TO TRACK';
    chip.classList.add('off');
    return;
  }
  chip.classList.remove('off');
  const suffix = snap.source !== 'web' ? ' · ' + snap.source.toUpperCase() : '';
  const test = tracking ? ` · TEST${tracking.sc.num != null ? ' #' + tracking.sc.num : ''}` : '';
  chip.textContent = `AR · ${snap.state}${suffix}${test}`;
}

function updateCardTrack() {
  const btn = el('card-sc-start');
  const line = el('card-sc-track');
  const sc = current && scenarioOf(current);
  const isThis = tracking && current && tracking.d.id === current.id;
  btn.textContent = isThis ? '■ Stop tracking' : '▶ Start test tracking';
  if (!sc || !isThis) { line.textContent = tracking || !sc ? '' : 'GPS + activity are recorded while tracking'; return; }
  const tr = tracking;
  const bits = [`${tr.passes} SLOW PASS${tr.passes === 1 ? '' : 'ES'}`];
  if (tr.fired) bits.push('TRIGGER FIRED');
  else if (tr.stopped) bits.push('STOP SEEN — DRIVE ON TO FIRE');
  else if (tr.passes >= TRIG.passesNeeded) bits.push('WAITING FOR YOUR STOP');
  line.textContent = 'TRACKING · ' + bits.join(' · ');
}

/* ---------- live position while tracking ----------
 * The Geo kit is one-shot by design (tap the chip to refresh), but a
 * driving test wants the map to follow the car. ActivityRec already
 * watches position continuously while armed — mirror its fixes into a
 * thin Geo lookalike the map mounts instead of Geo. Untracked, it is
 * exactly Geo; tracked, the dot moves and loses its stale grey. */
let liveFix = null; // { lat, lng, wall }
const liveFresh = () => !!liveFix && ActivityRec.active && Date.now() - liveFix.wall < 15000;
const liveGeoListeners = [];
const LiveGeo = {
  on(fn) {
    liveGeoListeners.push(fn);
    const offGeo = Geo.on(() => fn(LiveGeo.snapshot));
    return () => {
      offGeo();
      const i = liveGeoListeners.indexOf(fn);
      if (i >= 0) liveGeoListeners.splice(i, 1);
    };
  },
  get state() { return Geo.state; },
  get address() { return Geo.address; },
  get reason() { return Geo.reason; },
  get position() { return liveFresh() ? { lat: liveFix.lat, lng: liveFix.lng, acc: 15 } : Geo.position; },
  get stale() { return liveFresh() ? false : Geo.stale; },
  get snapshot() { return { ...Geo.snapshot, position: LiveGeo.position, stale: LiveGeo.stale }; },
};
/* Throttled: every emit reprojects pins, and the static-image backend
 * refetches its map per new centre — 1 Hz GPS would spam it. */
let lastLiveEmit = 0;
function emitLiveGeo() {
  const now = Date.now();
  if (now - lastLiveEmit < 2000) return;
  lastLiveEmit = now;
  const s = LiveGeo.snapshot;
  liveGeoListeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
}

ActivityRec.on(snap => {
  updateArChip(snap);
  if (snap.on && snap.position) {
    liveFix = { lat: snap.position.lat, lng: snap.position.lng, wall: Date.now() };
    emitLiveGeo();
    if (!el('card').hidden) updateCardDistance(); // the distance readout drives along
  }
  if (tracking && snap.on && snap.position && typeof snap.speed === 'number') detectorStep(snap);
});

/* What the device observed while the test ran — stamped onto every saved
 * debrief; the dashboard puts it next to the scenario's expected states. */
function arExtras() {
  if (!ActivityRec.active) return { ar_summary: null, ar_trace: null };
  const since = tracking ? tracking.startedAt : Date.now() - 15 * 60e3;
  return {
    ar_summary: ActivityRec.summary(since) || null,
    ar_trace: {
      source: ActivityRec.snapshot.source,
      segments: ActivityRec.segments(since),
      ...(tracking && (tracking.passes || tracking.fired) ? {
        trigger: {
          scenario_id: tracking.sc.id,
          passes: tracking.passes,
          stopped: !!tracking.stopped,
          fired_at: tracking.firedAt ? new Date(tracking.firedAt).toISOString() : null,
        },
      } : {}),
    },
  };
}

const localId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const persistLocal = () => {
  if (Backend.enabled) return; // Supabase is the source of truth when configured
  try {
    localStorage.setItem(LS_DEST, JSON.stringify(destinations));
    localStorage.setItem(LS_MSGS, JSON.stringify([].concat(...Object.values(messagesByDest))));
  } catch { /* private mode */ }
};

const recordMessage = (destId, row) => {
  (messagesByDest[destId] = messagesByDest[destId] || []).unshift(row);
  reportedIds.add(destId);
};

/* ---------- geometry & keyless Google Maps links ---------- */
const distM = (a, b) => {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
/* Maps URLs API — no key needed; opens the real Google Maps app on a phone */
const dirUrl = d => `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=walking`;
const panoUrl = d => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}`;

/* ---------- map ---------- */
const map = FieldMap.mount({
  el: '#map',
  geo: LiveGeo, // Geo, plus ActivityRec's continuous fixes while tracking
  markers: () => {
    const list = destinations.map(d => {
      const done = reportedIds.has(d.id);
      return {
        id: d.id, lat: d.lat, lng: d.lng,
        label: (done ? '✓ ' : '') + String(d.title || 'Destination').toUpperCase().slice(0, 22),
        color: done ? '70,211,154' : '255,107,107',
        labelColor: done ? '#7ce0b8' : '#ff9b9b',
        icon: done ? '✓' : '▲',
        size: 44,
        priority: done ? 2 : 1, // open spots outrank finished ones for label space
      };
    });
    /* during a tracked test, you are on the map too — as what AR says you are */
    if (tracking && liveFresh()) {
      const st = ActivityRec.state;
      list.push({
        id: '__live', lat: liveFix.lat, lng: liveFix.lng,
        icon: st === 'IN_VEHICLE' ? '🚗'
          : (st === 'ON_FOOT' || st === 'WALKING' || st === 'RUNNING') ? '🚶' : '●',
        color: '96,165,250',
        size: 34,
        priority: 3,
      });
    }
    return list;
  },
  onMarkerClick(m) {
    const d = destinations.find(x => x.id === m.id);
    if (d) openCard(d);
  },
  onBackendChange(b) {
    el('backend').textContent = b.toUpperCase();
    /* zoom buttons only make sense on the live Google map — the static
     * image and the grid are fixed-zoom (pinch/scroll work there too) */
    el('map-zoom').hidden = b !== 'gmap';
  },
});

/* ---------- Otto ---------- */
/* The widget is remounted per debrief (the kit reads its demo script once
 * at mount), so the scripted demo can open with the scenario's own
 * question exactly like the live greeting does. */
const voiceOpts = () => {
  const sc = current && scenarioOf(current);
  return {
    el: '#otto',
    assistant: 'Otto',
    context: () => {
      if (!current) return 'this spot';
      const base = current.title + (current.addr ? ' — ' + current.addr : '');
      const s = scenarioOf(current);
      return s ? `trigger scenario "${scenarioShort(s)}" at ${base}` : base;
    },
    greeting: () => {
      const s = scenarioOf(current);
      /* the sheet's "Otto says" column IS the debrief opener */
      if (s && s.otto_says) return stripQuotes(s.otto_says);
      return current
        ? `This is ${current.title}${current.addr ? ' — ' + current.addr : ''}. What's the situation there? Tap the mic and describe what you see.`
        : 'Tap the mic and tell me what you found.';
    },
    demo: sc && sc.otto_says ? [
      { q: stripQuotes(sc.otto_says), a: 'Scripted demo answer — with the backend live you would answer by voice here.' },
      { q: 'Got it. Anything else the next driver should know?', a: "That's everything — end of the scripted demo." },
    ] : [
      { q: "Here's the spot. What's going on?", a: 'The passage is blocked — scaffolding right across the entrance.' },
      { q: 'Got it. Can you still get through somehow?', a: "Yes — there's a side door on the left, maybe 20 metres on." },
      { q: 'Anything else worth noting?', a: "The scaffolding looks like it'll be up for weeks." },
    ],
    demoFinal: sc
      ? 'Saved — the dashboard now compares this with what the scenario expected.'
      : 'Saved to the destination — your note is on the record.',
    extra: () => ({
      destination_id: current ? current.id : null,
      lat: LiveGeo.position ? LiveGeo.position.lat : null,
      lng: LiveGeo.position ? LiveGeo.position.lng : null,
      ...arExtras(),
    }),
    onSaved(res) {
      if (!current) return;
      recordMessage(current.id, {
        ...res.row,
        /* the scripted demo bypasses extra() — stamp the observed activity here too */
        ...(res.demo ? arExtras() : {}),
        destination_id: current.id,
        demo: !!res.demo,
        created_at: (res.row && res.row.created_at) || new Date().toISOString(),
      });
      persistLocal();
      map.refresh(); // the pin flips to reported
      /* debrief delivered for a fired trigger — that test run is complete */
      if (tracking && tracking.fired && tracking.d.id === current.id) stopTracking();
    },
  };
};
let voice = VoiceNote.mount(voiceOpts());

function openOtto(d) {
  current = d;
  el('card').hidden = true;
  el('otto-dest').textContent = d.title;
  el('otto-screen').hidden = false;
  voice.destroy();
  voice = VoiceNote.mount(voiceOpts()); // mount() starts it
}

function closeOtto() {
  voice.stop();
  el('otto-screen').hidden = true;
  if (current) openCard(current); // back to the card, now with the new message
}

/* ---------- destination card ---------- */
function openCard(d) {
  current = d;
  el('card-title').textContent = d.title;
  el('card-addr').textContent = d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`;
  updateCardDistance();
  el('card-dir').href = dirUrl(d);
  el('card-sv').href = panoUrl(d);

  /* a scenario pin carries its instructions — and is managed from the
   * dashboard, so the card's remove link goes away */
  const sc = scenarioOf(d);
  el('card-scenario').hidden = !sc;
  if (sc) {
    el('card-sc-name').textContent = (sc.num != null ? '#' + sc.num + ' · ' : '') + sc.title;
    el('card-sc-steps').textContent = sc.test_steps || sc.rule || '';
    el('card-sc-steps').hidden = !(sc.test_steps || sc.rule);
    updateCardTrack();
  }
  el('card-remove').hidden = !!sc;

  const list = messagesByDest[d.id] || [];
  const box = el('card-msgs');
  box.innerHTML = '';
  list.slice(0, 5).forEach(m => {
    const row = document.createElement('div');
    row.className = 'msg';
    const cat = document.createElement('span');
    cat.className = 'msg-cat';
    cat.textContent = (m.category || 'INFO') + (m.demo ? ' · DEMO' : '');
    const txt = document.createElement('span');
    txt.textContent = m.title || m.transcript;
    row.append(cat, txt);
    box.appendChild(row);
  });
  el('card-empty').hidden = list.length > 0;
  el('card').hidden = false;
}

function updateCardDistance() {
  if (!current) return;
  const p = LiveGeo.position;
  el('card-dist').textContent = p
    ? '~' + fmtDist(distM(p, current)) + ' away' + (LiveGeo.stale ? ' (from last known position)' : '')
    : 'distance unknown — no GPS fix';
}

function removeCurrent() {
  if (!current || !confirm(`Remove "${current.title}" and its messages?`)) return;
  const id = current.id;
  destinations = destinations.filter(d => d.id !== id);
  delete messagesByDest[id];
  reportedIds.delete(id);
  if (Backend.enabled) Backend.deleteDestination(id).catch(e => console.warn('delete failed', e.message));
  persistLocal();
  el('card').hidden = true;
  current = null;
  renderEmpty();
  map.refresh();
}

/* ---------- add a destination · real address -> pin ---------- */
/* Cascade mirrors reverse geocoding, ordered by coverage: pasted
 * "lat, lng" first (works anywhere, offline), then the geocode Edge
 * Function (server-side Google), then OpenStreetMap. */
let addrTimer = null;
let addrSeq = 0; // stale-result guard: only the latest query may render
let candidates = [];

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
    el('add-hint').textContent = 'Searching…';
    const found = await searchAddress(q.trim());
    if (seq !== addrSeq) return; // they kept typing — this answer is stale
    candidates = found;
    renderCandidates();
    if (!found.length) el('add-hint').textContent = 'Nothing found — try adding the city, or paste coordinates like "52.5346, 13.4109" (long-press a spot in Google Maps to copy them).';
    else el('add-hint').textContent = houseNumberHint(q, found);
  }, 350);
}

/* All legs are time-boxed: a geocoder that hangs must degrade to the
 * "nothing found" hint (which teaches the coordinate-paste path), not
 * leave the sheet sitting silent. */
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
    const t = setTimeout(() => resolve([]), 6000);
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

/* A candidate list that silently dropped the typed house number puts the
 * pin mid-street — say so, and teach the exact-pin path. */
function houseNumberHint(q, found) {
  const num = (q.match(/\b(\d{1,4})\b/) || [])[1];
  if (!found.length || !num || found.some(c => String(c.label).includes(num))) return '';
  return `No exact match for house number ${num} — for a precise pin, long-press the spot in Google Maps, copy the coordinates and paste them here.`;
}

function renderCandidates() {
  const box = el('add-results');
  box.innerHTML = '';
  el('add-hint').textContent = '';
  candidates.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cand';
    b.textContent = c.label;
    b.onclick = () => addDestination(candidates[i]);
    box.appendChild(b);
  });
}

async function addDestination(c) {
  const title = c.pin ? 'Dropped pin' : String(c.label).split(',')[0].trim();
  const row = { title, addr: c.pin ? null : c.label, lat: c.lat, lng: c.lng };
  if (Backend.enabled) {
    try {
      const saved = await Backend.insertDestination(row);
      if (Array.isArray(saved) && saved[0]) Object.assign(row, saved[0]);
    } catch (e) { console.warn('insert failed — kept locally', e.message); row.id = localId(); }
  } else {
    row.id = localId();
  }
  destinations.push(row);
  persistLocal();
  closeAdd();
  renderEmpty();
  map.refresh();
  openCard(row);
  /* a dropped pin gets its street name when the geocoder finds one */
  if (!row.addr) {
    Geo.reverseGeocode(row.lat, row.lng).then(r => {
      if (!r || !(r.street || r.area)) return;
      row.title = r.street || row.title;
      row.addr = [r.street, r.area].filter(Boolean).join(', ');
      persistLocal();
      map.refresh();
      if (current === row && el('otto-screen').hidden) openCard(row);
    });
  }
}

function addDemoSpot() {
  const p = Geo.position;
  if (!p) return;
  /* ~250 m north-east: close enough to walk to, far enough to be a pin */
  addDestination({ label: `Dropped pin — near you`, lat: p.lat + 0.0018, lng: p.lng + 0.0012, pin: true });
}

function openAdd() {
  el('add-sheet').hidden = false;
  el('add-input').value = '';
  el('add-results').innerHTML = '';
  el('add-hint').textContent = '';
  el('add-demo').hidden = !Geo.position;
  el('add-input').focus();
}
function closeAdd() { el('add-sheet').hidden = true; }

/* ---------- empty state ---------- */
function renderEmpty() { el('hint').hidden = destinations.length > 0; }

/* ---------- GPS chip ---------- */
Geo.on(snap => {
  const chip = el('gps');
  const street = snap.address && (snap.address.street || snap.address.area);
  chip.textContent = snap.state === 'fix' && street ? street.toUpperCase() : Geo.label;
  chip.classList.toggle('warn', snap.stale || snap.state === 'off');
  if (!el('card').hidden) updateCardDistance();
});

/* ---------- boot ---------- */
el('gps').onclick = () => Geo.locate();
el('zoom-in').onclick = () => { const g = map.map; if (g) g.setZoom(Math.min(20, (g.getZoom() || 17) + 1)); };
el('zoom-out').onclick = () => { const g = map.map; if (g) g.setZoom(Math.max(3, (g.getZoom() || 17) - 1)); };
el('add-fab').onclick = openAdd;
el('add-close').onclick = closeAdd;
el('add-demo').onclick = addDemoSpot;
el('add-input').oninput = e => onAddrInput(e.target.value);
el('card-close').onclick = () => { el('card').hidden = true; };
el('card-otto').onclick = () => current && openOtto(current);
el('card-remove').onclick = removeCurrent;
el('otto-back').onclick = closeOtto;

/* activity recognition + test tracking */
el('ar').onclick = () => {
  if (tracking) { stopTracking(); return; }
  if (ActivityRec.active) { ActivityRec.stop(); updateArChip(ActivityRec.snapshot); return; }
  ActivityRec.requestMotionPermission(); // inside the tap gesture, for iOS
  ActivityRec.start();
};
el('card-sc-start').onclick = () => {
  const sc = current && scenarioOf(current);
  if (!sc) return;
  if (tracking && tracking.d.id === current.id) { stopTracking(); return; }
  if (tracking) stopTracking();
  startTracking(sc, current);
};
el('trigger-banner').onclick = () => {
  el('trigger-banner').hidden = true;
  if (tracking) openOtto(tracking.d);
};
el('tb-close').onclick = e => {
  e.stopPropagation();
  el('trigger-banner').hidden = true;
};

async function boot() {
  if (Backend.enabled) {
    try {
      destinations = (await Backend.listDestinations()) || [];
      const msgs = (await Backend.listMessages(500)) || [];
      msgs.forEach(m => { if (m.destination_id) recordMessage(m.destination_id, m); });
    } catch (e) { console.warn('load failed — run schema.sql?', e.message); }
    try {
      scenarios = (await Backend.listScenarios()) || [];
    } catch (e) { console.warn('no scenarios — re-run schema.sql to add the table?', e.message); }
  } else {
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { /* private mode */ }
    try {
      (JSON.parse(localStorage.getItem(LS_MSGS) || '[]')).forEach(m => {
        if (m.destination_id) recordMessage(m.destination_id, m);
      });
    } catch { /* private mode */ }
    try { scenarios = JSON.parse(localStorage.getItem(LS_SCEN) || '[]'); } catch { /* private mode */ }
  }
  rebuildScenarioIndex();
  renderEmpty();
  map.refresh();
}

/* Local demo mode: the dashboard in another tab writes the same
 * localStorage — pick up its new scenarios and pins as they land. */
if (!Backend.enabled) {
  window.addEventListener('storage', e => {
    if (e.key && ![LS_DEST, LS_SCEN].includes(e.key)) return;
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { return; }
    try { scenarios = JSON.parse(localStorage.getItem(LS_SCEN) || '[]'); } catch { /* keep old */ }
    rebuildScenarioIndex();
    renderEmpty();
    map.refresh();
    if (current && !el('otto-screen').hidden) return; // don't yank an open debrief
    if (current) {
      const d = destinations.find(x => x.id === current.id);
      if (d) { if (!el('card').hidden) openCard(d); }
      else { el('card').hidden = true; current = null; }
    }
  });
}

boot();
Geo.prime();
Geo.locate();

/* No GPS on a desktop browser, and none in CI: drop in a simulated
 * position rather than an empty map. Geo flags it — the marker greys out
 * and the chip says it is not a real fix. On a phone the real fix wins. */
setTimeout(() => {
  if (!Geo.position) Geo.simulate({ lat: 52.5346, lng: 13.4109, street: 'Kollwitzstraße 18' });
}, 3000);
