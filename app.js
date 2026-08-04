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

let destinations = [];
const messagesByDest = {};
const reportedIds = new Set();
let current = null; // destination in the open card / Otto session

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
  markers: () => destinations.map(d => {
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
  }),
  onMarkerClick(m) {
    const d = destinations.find(x => x.id === m.id);
    if (d) openCard(d);
  },
  onBackendChange(b) { el('backend').textContent = b.toUpperCase(); },
});

/* ---------- Otto ---------- */
const voice = VoiceNote.mount({
  el: '#otto',
  assistant: 'Otto',
  context: () => current
    ? current.title + (current.addr ? ' — ' + current.addr : '')
    : 'this spot',
  greeting: () => current
    ? `This is ${current.title}${current.addr ? ' — ' + current.addr : ''}. What's the situation there? Tap the mic and describe what you see.`
    : 'Tap the mic and tell me what you found.',
  demo: [
    { q: "Here's the spot. What's going on?", a: 'The passage is blocked — scaffolding right across the entrance.' },
    { q: 'Got it. Can you still get through somehow?', a: "Yes — there's a side door on the left, maybe 20 metres on." },
    { q: 'Anything else worth noting?', a: "The scaffolding looks like it'll be up for weeks." },
    ],
  demoFinal: 'Saved to the destination — your note is on the record.',
  extra: () => ({
    destination_id: current ? current.id : null,
    lat: Geo.position ? Geo.position.lat : null,
    lng: Geo.position ? Geo.position.lng : null,
  }),
  onSaved(res) {
    if (!current) return;
    recordMessage(current.id, {
      ...res.row,
      destination_id: current.id,
      demo: !!res.demo,
      created_at: (res.row && res.row.created_at) || new Date().toISOString(),
    });
    persistLocal();
    map.refresh(); // the pin flips to reported
  },
});

function openOtto(d) {
  current = d;
  el('card').hidden = true;
  el('otto-dest').textContent = d.title;
  el('otto-screen').hidden = false;
  voice.start();
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
  const p = Geo.position;
  el('card-dist').textContent = p
    ? '~' + fmtDist(distM(p, current)) + ' away' + (Geo.stale ? ' (from last known position)' : '')
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
  }, 350);
}

/* Both legs are time-boxed: a geocoder that hangs must degrade to the
 * "nothing found" hint (which teaches the coordinate-paste path), not
 * leave the sheet sitting silent. */
async function searchAddress(q) {
  if (Backend.enabled) {
    try {
      const r = await Backend.search(q);
      if (r.length) return r;
    } catch { /* function not deployed — fall through */ }
  }
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=4&q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return [];
    return (await r.json()).map(x => ({ label: x.display_name, lat: +x.lat, lng: +x.lon }));
  } catch { return []; }
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
el('add-fab').onclick = openAdd;
el('add-close').onclick = closeAdd;
el('add-demo').onclick = addDemoSpot;
el('add-input').oninput = e => onAddrInput(e.target.value);
el('card-close').onclick = () => { el('card').hidden = true; };
el('card-otto').onclick = () => current && openOtto(current);
el('card-remove').onclick = removeCurrent;
el('otto-back').onclick = closeOtto;

async function boot() {
  if (Backend.enabled) {
    try {
      destinations = (await Backend.listDestinations()) || [];
      const msgs = (await Backend.listMessages(500)) || [];
      msgs.forEach(m => { if (m.destination_id) recordMessage(m.destination_id, m); });
    } catch (e) { console.warn('load failed — run schema.sql?', e.message); }
  } else {
    try { destinations = JSON.parse(localStorage.getItem(LS_DEST) || '[]'); } catch { /* private mode */ }
    try {
      (JSON.parse(localStorage.getItem(LS_MSGS) || '[]')).forEach(m => {
        if (m.destination_id) recordMessage(m.destination_id, m);
      });
    } catch { /* private mode */ }
  }
  renderEmpty();
  map.refresh();
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
