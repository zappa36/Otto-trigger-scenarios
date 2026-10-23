'use strict';

/* ============================================================
 * The driver's screen — the route in the van.
 *
 * A third screen on the phone, behind the van icon in Otto's header
 * (and at index.html#driver straight from the dashboard): today's
 * deliveries, in driving order, as a list and on a map. The route is
 * whatever the dashboard loaded — every destination row that carries
 * a route id and a stop number (the ⇪ ROUTE chip there) — so a route
 * built on the dashboard shows up here on every phone, keyless or
 * live, exactly like the pins do everywhere else.
 *
 * It reuses the app rather than redoing it: the same destinations,
 * visits and debriefs app.js already holds, the same field-map kit
 * (a second mount, in daylight colours), the same Delivered /
 * Not delivered tap (markVisit — one row in `visits`), the same
 * pre-arrival briefing (briefingLines, spoken by speakOtto), and
 * the same Otto: Report to Otto on a stop is the REPORT flow, filed
 * against that stop. Otto's own screen, the tester's map and the
 * dashboard are untouched; this file only adds.
 *
 * The look is the PostNord app's: a PostNord-blue bar with two tabs,
 * white cards on a light page, a dotted timeline down the list,
 * numbered blue pins, blue pill chips over the map, one big button
 * for the next thing to do. driver.css has the palette.
 *
 * In the van: the next stop is the top card with NAVIGATE (the real
 * Google Maps app, driving), ✓ DELIVERED and ✕ NOT DELIVERED; a tap
 * on any stop opens its sheet — consignee, floor, the notes Otto
 * reads on approach, what drivers reported, the other parcels behind
 * the same door; the screen keeps the display awake while it is up.
 * ============================================================ */

window.DriverScreen = (() => {
  const $ = id => document.getElementById(id);
  const root = $('driver');
  const stub = { open() {}, back() {}, hide() {}, refresh() {}, openStop() {}, readingDone() {}, get opened() { return false; } };
  /* a phone can hold yesterday's app.js next to today's page (a WebView
   * that skipped revalidation) — without the app's seams, this screen
   * stays out of the way and the rest of the page boots as before */
  if (!root || typeof destinations === 'undefined' || typeof markVisit !== 'function'
    || typeof FieldMap === 'undefined' || typeof LiveGeo === 'undefined') return stub;

  const LS_ROUTE = 'od_driver_route'; // the route picked on this phone
  const LS_VIEW = 'od_driver_view';   // split | map | list
  const DIR_URL = d => `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=driving`;

  let opened = false;
  /* app.js hides this section itself when the card or Otto's own screen
   * takes over — "showing" is the flag AND the DOM */
  const showing = () => opened && !root.hidden;
  let routeId = null;
  let tab = 'todo';
  let view = 'split';
  let selected = null;   // destination id in the open sheet
  let dvMap = null;      // the field-map kit's second mount
  let svg = null;        // the route line overlay
  let gmapStyled = false;
  let needFit = false;   // frame me + the next stop once the live map is there
  let wake = null;
  let busy = false;
  /* live, the rows come from Supabase after boot() — until app.js has
   * called refresh() once, an empty list means "still loading", not
   * "no route on file"; keyless the rows are there before this runs */
  let loaded = typeof Backend === 'undefined' || !Backend.enabled;
  const distEls = new Map(); // destination id -> the elements showing its distance
  try { view = ['split', 'map', 'list'].includes(localStorage.getItem(LS_VIEW)) ? localStorage.getItem(LS_VIEW) : 'split'; } catch { /* private mode */ }

  /* ---------- icons (Material shapes, drawn in currentColor) ---------- */
  const ICON = {
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm7-3a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11Z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    box: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4l16-.02V7z',
    note: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    nav: 'M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z',
    speaker: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    map: 'M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM10 5.47l4 1.4v11.66l-4-1.4V5.47zm-5 .99l3-1.01v11.7l-3 1.16V6.46zm14 11.08l-3 1.01V6.86l3-1.16v11.84z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
    chevron: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    pencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.41-1.83z',
    route: 'M19 15.18V7c0-2.21-1.79-4-4-4s-4 1.79-4 4v10c0 1.1-.9 2-2 2s-2-.9-2-2V8.82C8.16 8.4 9 7.3 9 6c0-1.66-1.34-3-3-3S3 4.34 3 6c0 1.3.84 2.4 2 2.82V17c0 2.21 1.79 4 4 4s4-1.79 4-4V7c0-1.1.9-2 2-2s2 .9 2 2v8.18c-1.16.42-2 1.52-2 2.82 0 1.66 1.34 3 3 3s3-1.34 3-3c0-1.3-.84-2.4-2-2.82z',
    flag: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z',
  };
  const svgIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON[name]}"/></svg>`;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /* build an element: tag, class, text — and children */
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const withIcon = (node, name) => { node.insertAdjacentHTML('afterbegin', svgIcon(name)); return node; };

  /* ---------- the data: the route, its stops, their state ----------
   * Nothing is kept here — destinations, visitsByDest and reportedIds
   * are app.js's own, read fresh at every render, so the dashboard's
   * loads, the ↻ chip and a Delivered tap on the tester's card all
   * show up here without a seam. */
  const byStop = (a, b) => ((a.stop == null ? 1e9 : a.stop) - (b.stop == null ? 1e9 : b.stop))
    || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const routesOnFile = () => {
    const seen = [];
    destinations.forEach(d => { if (d.route && !seen.includes(d.route)) seen.push(d.route); });
    return seen;
  };
  /* no route picked means no stops: a plain pin's route is null on a
   * live row, and null === null would adopt every tester pin */
  const stops = r => { const id = r || routeId; return id ? destinations.filter(d => d.route === id).sort(byStop) : []; };
  const demoRoutes = () => (window.DEMO_ROUTES || []).concat(window.DEMO_ROUTE ? [window.DEMO_ROUTE] : []);
  /* the route's name: the data file's when it is on this page, else the
   * route's own scenario row's title ("Kollwitzkiez 01 route — …"),
   * else the id made readable */
  const routeNameOf = id => {
    const r = demoRoutes().find(x => x && x.id === id);
    if (r && r.name) return r.name;
    const sc = typeof routeScenarios !== 'undefined' && routeScenarios[id];
    if (sc && sc.title) { const t = String(sc.title).split(/\s+route\b/i)[0].trim(); if (t) return t; }
    return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };
  /* which route the van is on: the one picked on this phone if it is
   * still on file, else the most recently loaded */
  function pickRoute() {
    const on = routesOnFile();
    if (!on.length) { routeId = null; return; }
    if (routeId && on.includes(routeId)) return;
    let want = null;
    try { want = localStorage.getItem(LS_ROUTE); } catch { /* private mode */ }
    routeId = want && on.includes(want) ? want : on[on.length - 1];
  }
  function setRoute(id) {
    routeId = id;
    try { localStorage.setItem(LS_ROUTE, id); } catch { /* private mode */ }
    selected = null;
    needFit = true;
    tab = 'todo';
    render();
    fitNext();
  }
  const visitOf = d => (visitsByDest && visitsByDest[d.id]) || null;
  /* open → done (delivered) | failed (not delivered); a debrief alone
   * does not finish a stop — the parcel still has to be handed over */
  const stateOf = d => { const v = visitOf(d); return v ? (v.outcome === 'failed' ? 'failed' : 'done') : 'open'; };
  const nextOf = list => list.find(d => stateOf(d) === 'open') || null;
  const position = () => LiveGeo.position;
  const distTo = d => { const p = position(); return p ? distM(p, d) : null; };
  const floorText = f => { f = String(f == null ? '' : f).trim(); return !f ? '' : /^\d+$/.test(f) ? 'floor ' + f : f; };
  /* name · entrance · floor — the three things a bell panel answers */
  const whoLine = d => [String(d.consignee || '').trim(), String(d.entrance || '').trim(), floorText(d.floor)].filter(Boolean).join(' · ');
  const hhmm = iso => { const t = new Date(iso); return isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const sameDoor = (a, b) => a.lat === b.lat && a.lng === b.lng;
  const doorMates = d => stops().filter(x => x.id !== d.id && sameDoor(x, d));
  const byId = id => destinations.find(x => x.id === id) || null;
  const statusText = (d, isNext) => {
    const v = visitOf(d);
    if (v) return (v.outcome === 'failed' ? 'Not delivered' : 'Delivered') + (hhmm(v.delivered_at || v.created_at) ? ' · ' + hhmm(v.delivered_at || v.created_at) : '');
    return isNext ? 'Next stop' : 'On the way';
  };

  /* ---------- the map: the kit's second mount, in daylight ---------- */
  const LIGHT_JS = [
    { elementType: 'geometry', stylers: [{ color: '#eef1f4' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#5b6b7c' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#eceff2' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#dcecd9' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#dfe5ea' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6b7a8a' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#f6e9a8' }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#e6d487' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#bcd9ef' }] },
  ];

  /* one marker per door: several parcels behind one bell stack exactly,
   * so they are one pin with a count — the first stop still open leads */
  function markerList() {
    drawRoute();
    const list = stops();
    const next = nextOf(list);
    const groups = new Map();
    list.forEach(d => {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      const k = d.lat.toFixed(6) + ',' + d.lng.toFixed(6);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    });
    const out = [];
    groups.forEach(door => {
      const lead = door.find(d => stateOf(d) === 'open') || door[0];
      const st = stateOf(lead);
      const isNext = !!next && door.some(d => d.id === next.id);
      const isSel = !!selected && door.some(d => d.id === selected);
      const size = isNext ? 44 : isSel ? 40 : 32;
      out.push({
        id: lead.id, lat: lead.lat, lng: lead.lng,
        size, anchor: size / 2, // the circle's centre sits on the coordinate
        label: isNext || isSel ? String(lead.title || '') : '',
        priority: isNext ? 3 : isSel ? 2 : st === 'open' ? 1 : 0,
        dv: {
          n: lead.stop, state: st, next: isNext, sel: isSel,
          notes: st === 'open' && notesOnFile(lead).length > 0,
          count: door.length,
        },
      });
    });
    /* drawn in this order, so the next stop lands on top of the stack */
    return out.sort((a, b) => a.priority - b.priority);
  }
  function renderPin(m, showLabel) {
    const v = m.dv || {};
    const cls = ['dv-pin', v.state, v.next ? 'next' : '', v.sel ? 'sel' : ''].filter(Boolean).join(' ');
    const glyph = v.state === 'done' ? '✓' : v.state === 'failed' ? '✕' : esc(v.n != null ? v.n : '•');
    return `<div class="dv-mk">${showLabel && m.label ? `<span class="dv-lbl">${esc(m.label)}</span>` : ''}`
      + `<div class="${cls}" style="width:${m.size}px;height:${m.size}px">${glyph}`
      + (v.notes ? '<i class="dv-pin-notes">✎</i>' : '')
      + (v.count > 1 ? `<b class="dv-pin-count">${v.count}</b>` : '')
      + '</div></div>';
  }
  /* the route line, re-projected with the pins on every move: the whole
   * tour faint, then from the van to the next stop and on through the
   * stops still open, in PostNord blue */
  function drawRoute() {
    if (!dvMap || !svg) return;
    const host = $('dv-map');
    const W = host.clientWidth, H = host.clientHeight;
    const list = stops().filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
    if (!W || !H || list.length < 2 || !position()) { svg.innerHTML = ''; return; }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pt = q => `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    const all = list.map(d => dvMap.project(d.lat, d.lng)).filter(Boolean);
    const rest = list.filter(d => stateOf(d) === 'open').map(d => dvMap.project(d.lat, d.lng)).filter(Boolean);
    const p = position();
    const me = p && !LiveGeo.stale && rest.length ? dvMap.project(p.lat, p.lng) : null;
    svg.innerHTML = `<polyline class="dv-rt-all" points="${all.map(pt).join(' ')}"/>`
      + (rest.length > 1 ? `<polyline class="dv-rt-rest" points="${rest.map(pt).join(' ')}"/>` : '')
      + (me ? `<polyline class="dv-rt-me" points="${pt(me)} ${pt(rest[0])}"/>` : '');
  }
  function mountMap() {
    if (dvMap || !$('dv-map')) return;
    dvMap = FieldMap.mount({
      el: $('dv-map'),
      geo: LiveGeo,
      zoom: 15,
      cull: 80,
      markers: markerList,
      renderMarker: renderPin,
      onMarkerClick: m => { const d = byId(m.id); if (d) openSheet(d); },
      onBackendChange: b => {
        /* framing is the live map's; on the keyless grid — centred on the
         * van by the kit — the two chips would only disappoint */
        $('dv-fit-next').hidden = $('dv-fit-all').hidden = b !== 'gmap';
        if (b === 'gmap') styleGmap();
      },
    });
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dv-route');
    const pins = $('dv-map').querySelector('.fm-pins');
    if (pins) $('dv-map').insertBefore(svg, pins); else $('dv-map').appendChild(svg);
  }
  const gmap = () => (dvMap && dvMap.map) || null;
  function styleGmap() {
    const g = gmap();
    if (!g) return;
    if (!gmapStyled) {
      gmapStyled = true;
      try { g.setOptions({ styles: LIGHT_JS }); } catch { /* an API surprise — the dark style stays */ }
    }
    if (needFit) fitNext();
  }
  /* the map was sized while hidden, or its share of the screen changed */
  function resizeGmap() {
    const g = gmap();
    if (!g || !window.google) return;
    try {
      const c = g.getCenter();
      google.maps.event.trigger(g, 'resize');
      if (c) g.setCenter(c);
    } catch { /* optional */ }
  }
  function fitTo(points) {
    const g = gmap();
    const pts = points.filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
    if (!g || !window.google || !pts.length) return false;
    try {
      dvMap.setFollow(false);
      if (pts.length === 1) { g.setCenter({ lat: pts[0].lat, lng: pts[0].lng }); g.setZoom(16); return true; }
      const b = new google.maps.LatLngBounds();
      pts.forEach(p => b.extend({ lat: p.lat, lng: p.lng }));
      g.fitBounds(b, 48);
      /* two points a street apart would zoom to the pavement */
      google.maps.event.addListenerOnce(g, 'idle', () => { if ((g.getZoom() || 0) > 17) g.setZoom(17); });
      return true;
    } catch { return false; }
  }
  /* frame the van and the next stop — or the next stop alone when the
   * van is far away (a tour started from the depot), or the whole route
   * when every stop is done */
  function fitNext() {
    const list = stops();
    const next = nextOf(list);
    if (!next) return fitAll();
    const p = position();
    const ok = fitTo(p && distM(p, next) < 15000 ? [p, next] : [next]);
    if (ok) needFit = false;
    return ok;
  }
  function fitAll() {
    const ok = fitTo(stops());
    if (ok) needFit = false;
    return ok;
  }
  function panTo(d) {
    const g = gmap();
    if (!g) return;
    try { dvMap.setFollow(false); g.panTo({ lat: d.lat, lng: d.lng }); } catch { /* optional */ }
  }

  /* ---------- the header ---------- */
  function renderHeader() {
    const list = stops();
    const done = list.filter(d => stateOf(d) !== 'open').length;
    const failed = list.filter(d => stateOf(d) === 'failed').length;
    const many = routesOnFile().length > 1;
    const day = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    $('dv-route-name').innerHTML = routeId ? esc(routeNameOf(routeId)) + (many ? '<span class="dv-caret">▾</span>' : '') : 'Deliveries';
    $('dv-route-sub').textContent = !routeId ? day + ' · no route on file'
      : day + ' · ' + (done ? `${done} of ${list.length} done` : `${list.length} stop${list.length === 1 ? '' : 's'}`)
        + (failed ? ` · ${failed} not delivered` : '');
    $('dv-title').disabled = !many && !!routeId;
    const open = list.length - done;
    $('dv-tab-todo').textContent = 'To do' + (routeId ? ' · ' + open : '');
    $('dv-tab-done').textContent = 'Done' + (routeId ? ' · ' + done : '');
    $('dv-tab-todo').classList.toggle('on', tab === 'todo');
    $('dv-tab-done').classList.toggle('on', tab === 'done');
    $('dv-progress-bar').style.width = list.length ? Math.round(100 * done / list.length) + '%' : '0';
  }
  function renderGps(snap) {
    const chip = $('dv-gps');
    if (!chip) return;
    const s = snap || LiveGeo.snapshot;
    const street = s.address && (s.address.street || s.address.area);
    /* anything but a fresh fix wears the kit's own words (last known
     * position, location off, denied…), in sentence case */
    const label = typeof Geo !== 'undefined' && Geo.label ? String(Geo.label) : '';
    const plain = label ? label.charAt(0) + label.slice(1).toLowerCase() : '';
    chip.textContent = s.state === 'fix' && !s.stale ? (street || 'Located')
      : s.state === 'locating' ? 'Finding you…'
        : plain || (s.position ? 'Last known position' : 'Location off — tap');
    chip.classList.toggle('warn', !!s.stale || s.state !== 'fix' || !s.position);
  }

  /* ---------- the list ---------- */
  function noteEl(n) {
    const row = h('p', 'dv-note' + (n.by === 'driver' ? ' driver' : ''));
    row.appendChild(h('b', null, n.by === 'driver' ? 'DRIVER' : 'DISPATCH'));
    row.appendChild(h('span', null, String(n.text)));
    return row;
  }
  function distEl(d, cls) {
    const n = h('span', cls);
    const m = distTo(d);
    n.textContent = m == null ? '' : fmtDist(m);
    distEls.set(d.id, (distEls.get(d.id) || []).concat(n));
    return n;
  }
  function nextCard(d) {
    const card = h('div', 'dv-next');
    const head = h('div', 'dv-next-head');
    head.appendChild(h('span', 'dv-cap', 'Next stop'));
    head.appendChild(distEl(d, 'dv-dist'));
    card.appendChild(head);
    const title = h('button', 'dv-next-title');
    title.type = 'button';
    title.title = 'Open the stop — notes, the other parcels at this door, Report to Otto';
    if (d.stop != null) title.appendChild(h('span', 'dv-n', d.stop + ' · '));
    title.appendChild(document.createTextNode(String(d.title || 'Stop')));
    title.appendChild(h('span', 'dv-more', 'Details ›'));
    title.onclick = () => openSheet(d);
    card.appendChild(title);
    card.appendChild(h('p', 'dv-next-sub', whoLine(d)));
    const notes = notesOnFile(d);
    if (notes.length) {
      const first = noteEl(notes[0]);
      if (notes.length > 1) first.appendChild(h('small', null, ` +${notes.length - 1} more`));
      card.appendChild(first);
    }
    const mates = doorMates(d).filter(x => stateOf(x) === 'open');
    if (mates.length) card.appendChild(h('p', 'dv-hint', `${mates.length} more parcel${mates.length === 1 ? '' : 's'} at this door — stop${mates.length === 1 ? '' : 's'} ${mates.map(x => x.stop).join(', ')}.`));
    const nav = withIcon(h('a', 'dv-btn primary', 'Navigate'), 'nav');
    nav.href = DIR_URL(d);
    nav.target = '_blank';
    nav.rel = 'noopener';
    card.appendChild(nav);
    const row = h('div', 'dv-btn-row');
    const ok = withIcon(h('button', 'dv-btn ok', 'Delivered'), 'check');
    ok.type = 'button';
    ok.onclick = () => visit(d, 'delivered');
    const bad = withIcon(h('button', 'dv-btn bad', 'Not delivered'), 'close');
    bad.type = 'button';
    bad.onclick = () => visit(d, 'failed');
    row.append(ok, bad);
    card.appendChild(row);
    return card;
  }
  function rowEl(d, isNext) {
    const st = stateOf(d);
    const row = h('button', 'dv-row ' + (isNext ? 'next' : st));
    row.type = 'button';
    row.dataset.id = d.id;
    const ic = h('span', 'dv-ic');
    if (st === 'done') ic.innerHTML = svgIcon('check');
    else if (st === 'failed') ic.innerHTML = svgIcon('close');
    else ic.textContent = d.stop != null ? d.stop : '•';
    if (st === 'open' && notesOnFile(d).length) { const b = h('i', 'dv-ic-notes'); b.innerHTML = svgIcon('pencil'); ic.appendChild(b); }
    row.appendChild(ic);
    const body = h('span', 'dv-body');
    body.appendChild(h('b', 'dv-t', String(d.title || 'Stop')));
    body.appendChild(h('span', 'dv-s', whoLine(d)));
    const status = h('span', 'dv-st ' + (isNext ? 'next' : st), statusText(d, isNext));
    const n = notesOnFile(d).length;
    if (st === 'open' && n) status.appendChild(h('span', 'dv-tag', n === 1 ? '1 note' : n + ' notes'));
    if (reportedIds.has(d.id)) status.appendChild(h('span', 'dv-tag', 'Reported'));
    body.appendChild(status);
    row.appendChild(body);
    row.appendChild(distEl(d, 'dv-r'));
    row.onclick = () => openSheet(d);
    return row;
  }
  function groupEl(list, title) {
    const g = h('div', 'dv-group');
    if (title) g.appendChild(h('h3', 'dv-group-title', title));
    list.forEach(d => g.appendChild(rowEl(d, false)));
    return g;
  }
  function emptyEl(icon, title, text, green) {
    const box = h('div', 'dv-empty');
    const big = h('div', 'dv-big' + (green ? ' green' : ''));
    big.innerHTML = svgIcon(icon);
    box.appendChild(big);
    box.appendChild(h('h2', null, title));
    box.appendChild(h('p', null, text));
    return box;
  }
  function renderList() {
    const box = $('dv-list');
    box.innerHTML = '';
    distEls.clear();
    if (!routeId) {
      if (!loaded) { box.appendChild(emptyEl('refresh', 'Loading today\'s route…', 'One moment — the stops are on their way from the store.')); return; }
      const e = emptyEl('route', 'No route on file',
        'Load today\'s route on the dashboard — the ⇪ ROUTE chip — and its stops show up here, in driving order.');
      const r = withIcon(h('button', 'dv-btn outline', 'Check again'), 'refresh');
      r.type = 'button';
      r.onclick = reload;
      e.appendChild(r);
      box.appendChild(e);
      return;
    }
    const list = stops();
    const next = nextOf(list);
    const todo = list.filter(d => stateOf(d) === 'open');
    const done = list.filter(d => stateOf(d) !== 'open');
    if (tab === 'todo') {
      if (!todo.length) {
        const failed = done.filter(d => stateOf(d) === 'failed').length;
        box.appendChild(emptyEl('check', 'Route done',
          `Every stop is finished — ${done.length - failed} delivered${failed ? `, ${failed} not delivered` : ''}. The DONE tab has the list.`, true));
        return;
      }
      box.appendChild(nextCard(next));
      const rest = todo.filter(d => d.id !== next.id);
      if (rest.length) box.appendChild(groupEl(rest, rest.length === 1 ? 'Then' : `Then · ${rest.length} stops`));
    } else {
      if (!done.length) {
        box.appendChild(emptyEl('box', 'Nothing done yet',
          'Tap ✓ DELIVERED or ✕ NOT DELIVERED on a stop and it moves here, newest first.'));
        return;
      }
      /* newest first — the way the PostNord parcel timeline reads */
      const sorted = done.slice().sort((a, b) => {
        const va = visitOf(a), vb = visitOf(b);
        return String((vb && (vb.delivered_at || vb.created_at)) || '').localeCompare(String((va && (va.delivered_at || va.created_at)) || ''));
      });
      box.appendChild(groupEl(sorted, null));
    }
    box.appendChild(h('p', 'dv-foot', 'Tap a stop for its notes, the other parcels at that door, and Report to Otto.'));
  }
  /* a fresh fix moves every distance on the screen, in place — no
   * rebuild, so a thumb on the list is never pulled away */
  function updateDistances() {
    distEls.forEach((els, id) => {
      const d = byId(id);
      const m = d ? distTo(d) : null;
      els.forEach(n => { n.textContent = m == null ? '' : fmtDist(m); });
    });
    if (selected && !$('dv-sheet').hidden) updateSheetDistance(byId(selected));
  }
  /* the sheet's one distance element serves every stop in turn, so it is
   * the open stop's — never a list entry a previous stop still holds */
  function updateSheetDistance(d) {
    const n = $('dv-sheet-dist');
    if (!n) return;
    const m = d ? distTo(d) : null;
    n.textContent = m == null ? '' : fmtDist(m);
  }

  /* ---------- the Delivered tap ----------
   * The same row the tester's card writes (markVisit in app.js —
   * `visits`, with the phone's position and the door's dwell); the
   * screen re-renders itself from the result, so the next stop moves
   * on and the pin turns. */
  let settling = false; // the moment after a tap, while the next stop's button takes the same place
  async function visit(d, outcome) {
    if (busy || settling) return;
    busy = true;
    let ok = false;
    try { ok = await markVisit(outcome, d); } finally {
      busy = false;
      /* the card re-renders with the NEXT stop's button under the same
       * thumb — a bounced double tap must not file that one too */
      settling = true;
      setTimeout(() => { settling = false; }, 700);
    }
    render();
    if (!visitOf(d)) {
      if (ok === false) flash('Not saved — no connection to the store. Try again in a moment.');
      return;
    }
    /* the new next stop is at the top of the list — show it there */
    if (!selected && $('dv-list-wrap')) $('dv-list-wrap').scrollTop = 0;
    /* the tap, named, with the way back right there */
    const name = d.stop != null ? 'Stop ' + d.stop : String(d.title || 'Stop');
    flash(name + ' · ' + (outcome === 'failed' ? 'Not delivered' : 'Delivered'), () => unvisit(d));
    if (!selected && nextOf(stops())) { needFit = true; fitNext(); }
  }
  async function unvisit(d) {
    if (busy) return;
    busy = true;
    try { await undoVisit(d); } finally { busy = false; }
    render();
  }
  /* a line at the foot of the screen, gone by itself; with an undo, the
   * tap that takes the last Delivered back stays a while longer */
  function flash(text, undo) {
    const n = $('dv-flash');
    if (!n) return;
    $('dv-flash-text').textContent = text;
    const b = $('dv-flash-undo');
    b.hidden = !undo;
    b.onclick = undo ? () => { n.hidden = true; undo(); } : null;
    n.hidden = false;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { n.hidden = true; }, undo ? 7000 : 4000);
  }

  /* ---------- the stop sheet ---------- */
  function openSheet(d) {
    selected = d.id;
    renderSheet(d);
    $('dv-sheet').hidden = false;
    $('dv-routes').hidden = true;
    if (dvMap) dvMap.refresh();
    panTo(d);
  }
  function closeSheet() {
    selected = null;
    $('dv-sheet').hidden = true;
    if (dvMap) dvMap.refresh();
  }
  function kv(iconName, iconCls, title, sub, subCls) {
    const row = h('div', 'dv-kv');
    const ic = h('span', 'dv-ic' + (iconCls ? ' ' + iconCls : ''));
    ic.innerHTML = svgIcon(iconName);
    row.appendChild(ic);
    const body = h('span', 'dv-body');
    if (title) body.appendChild(h('b', 'dv-t', title));
    if (sub) body.appendChild(h('span', 'dv-s' + (subCls ? ' ' + subCls : ''), sub));
    row.appendChild(body);
    return row;
  }
  function renderSheet(d) {
    const list = stops();
    $('dv-sheet-cap').textContent = (d.stop != null ? `Stop ${d.stop}` : 'Stop') + (list.length ? ` of ${list.length}` : '');
    const body = $('dv-sheet-body');
    body.innerHTML = '';
    updateSheetDistance(d);

    const title = h('h2');
    if (d.stop != null) title.appendChild(h('span', 'dv-n', d.stop + ' · '));
    title.appendChild(document.createTextNode(String(d.title || 'Stop')));
    body.appendChild(title);
    body.appendChild(h('p', 'dv-addr', d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`));

    /* the scan moment, or its result */
    const v = visitOf(d);
    if (v) {
      const line = h('div', 'dv-done-line' + (v.outcome === 'failed' ? ' failed' : ''));
      line.innerHTML = svgIcon(v.outcome === 'failed' ? 'close' : 'check');
      line.appendChild(h('span', null, statusText(d, false)));
      const undo = h('button', null, 'Undo');
      undo.type = 'button';
      undo.onclick = () => unvisit(d);
      line.appendChild(undo);
      body.appendChild(line);
    } else {
      const nav = withIcon(h('a', 'dv-btn primary', 'Navigate'), 'nav');
      nav.href = DIR_URL(d);
      nav.target = '_blank';
      nav.rel = 'noopener';
      body.appendChild(nav);
      const row = h('div', 'dv-btn-row');
      const ok = withIcon(h('button', 'dv-btn ok', 'Delivered'), 'check');
      ok.type = 'button';
      ok.onclick = () => visit(d, 'delivered');
      const bad = withIcon(h('button', 'dv-btn bad', 'Not delivered'), 'close');
      bad.type = 'button';
      bad.onclick = () => visit(d, 'failed');
      row.append(ok, bad);
      body.appendChild(row);
    }

    /* who it is for, and what Otto reads on the way in */
    const who = whoLine(d);
    const notes = notesOnFile(d);
    const reports = driverReportsOf(d);
    if (who || notes.length || reports.length) {
      body.appendChild(h('h3', 'dv-sec', 'On file for this door'));
      if (who) body.appendChild(kv('home', null, String(d.consignee || '').trim() || 'Delivery',
        [String(d.entrance || '').trim(), floorText(d.floor)].filter(Boolean).join(' · '), 'muted'));
      notes.forEach(n => body.appendChild(kv(n.by === 'driver' ? 'person' : 'note', n.by === 'driver' ? 'green' : null,
        n.by === 'driver' ? 'A driver reported' : 'From dispatch', String(n.text))));
      reports.slice(0, 3).forEach(r => body.appendChild(kv('mic', 'green', 'Reported to Otto' + (r.category ? ' · ' + r.category : ''),
        String(r.title || r.transcript))));
      const lines = briefingLines(d);
      if (lines.length) {
        const hear = withIcon(h('button', 'dv-btn quiet', 'Hear the briefing'), 'speaker');
        hear.type = 'button';
        hear.onclick = () => speakOtto(lines.join(' '), () => {}, null, speechLangOf());
        body.appendChild(hear);
      }
    }

    /* the other parcels behind the same bell */
    const mates = doorMates(d);
    if (mates.length) {
      body.appendChild(h('h3', 'dv-sec', 'Also at this door'));
      mates.forEach(x => {
        const st = stateOf(x);
        const row = h('button', 'dv-kv');
        row.type = 'button';
        const ic = h('span', 'dv-ic' + (st === 'done' ? ' green' : st === 'failed' ? ' amber' : ''));
        if (st === 'done') ic.innerHTML = svgIcon('check'); else if (st === 'failed') ic.innerHTML = svgIcon('close'); else ic.textContent = x.stop != null ? x.stop : '•';
        row.appendChild(ic);
        const b = h('span', 'dv-body');
        b.appendChild(h('b', 'dv-t', whoLine(x) || 'Stop ' + x.stop));
        b.appendChild(h('span', 'dv-s muted', statusText(x, false)));
        row.appendChild(b);
        const chev = h('span', 'dv-chev');
        chev.innerHTML = svgIcon('chevron');
        row.appendChild(chev);
        row.onclick = () => openSheet(x);
        body.appendChild(row);
      });
    }

    /* Otto: the report, filed against this stop */
    body.appendChild(h('h3', 'dv-sec', 'Something to report?'));
    const otto = withIcon(h('button', 'dv-btn outline', 'Report to Otto'), 'mic');
    otto.type = 'button';
    otto.onclick = () => report(d);
    body.appendChild(otto);
    body.appendChild(h('p', 'dv-hint', 'A closed road, a dog at the door, a bell that does nothing — say it, Otto files it for the next driver.'));
    /* a finished stop points on to the next one still open, wherever
     * that is on the route */
    const nxt = stateOf(d) !== 'open' ? nextOf(list) : null;
    if (nxt && nxt.id !== d.id) {
      const go = withIcon(h('button', 'dv-btn quiet', `Next: ${nxt.stop != null ? nxt.stop + ' · ' : ''}${nxt.title}`), 'chevron');
      go.type = 'button';
      go.onclick = () => openSheet(nxt);
      body.appendChild(go);
    }
  }

  /* ---------- Otto from here ----------
   * Report to Otto on a stop is the REPORT flow (a driver saying what
   * they found, no scenario, no run), filed against that stop; the mic
   * in the header is Otto's own button — the nearest stop of this
   * route within the report radius, or none at all. Either way the
   * conversation screen covers this one and hands it back after. */
  function report(d) {
    if (typeof openOtto !== 'function') return;
    closeSheet();
    /* the hand-back is app.js's own `let ottoReturn` — the global lexical
     * scope classic scripts share; a window property would not reach it.
     * An older app.js without the binding throws here, and the screen
     * simply stays underneath Otto's, as before. */
    try { ottoReturn = open; } catch { /* older app.js */ }
    openOtto(d || null, true);
  }
  function reportNearest() {
    const p = LiveGeo.stale ? null : position();
    let near = null;
    if (p) {
      const radius = typeof REPORT_RADIUS === 'number' ? REPORT_RADIUS : 150;
      for (const d of stops()) {
        const m = distM(p, d);
        if (m <= radius && (!near || m < near.m)) near = { d, m };
      }
    }
    report(near ? near.d : null);
  }

  /* ---------- the route pick ---------- */
  function renderRoutes() {
    const box = $('dv-routes-body');
    box.innerHTML = '';
    routesOnFile().forEach(id => {
      const list = stops(id);
      const done = list.filter(d => stateOf(d) !== 'open').length;
      const row = h('button', 'dv-kv dv-route-row');
      row.type = 'button';
      const ic = h('span', 'dv-ic' + (id === routeId ? ' navy' : ''));
      ic.innerHTML = svgIcon('route');
      row.appendChild(ic);
      const b = h('span', 'dv-body');
      b.appendChild(h('b', 'dv-t', routeNameOf(id)));
      b.appendChild(h('span', 'dv-s', `${list.length} stop${list.length === 1 ? '' : 's'}` + (done ? ` · ${done} done` : '')));
      row.appendChild(b);
      if (id === routeId) { const c = h('span', 'dv-check'); c.innerHTML = svgIcon('check'); row.appendChild(c); }
      row.onclick = () => { $('dv-routes').hidden = true; if (id !== routeId) setRoute(id); };
      box.appendChild(row);
    });
  }

  /* ---------- the map's share of the screen ---------- */
  function setView(v) {
    view = v;
    root.dataset.view = v;
    try { localStorage.setItem(LS_VIEW, v); } catch { /* private mode */ }
    const handle = $('dv-handle');
    handle.innerHTML = v === 'map' ? svgIcon('list') + '<i></i><span>Show the list</span>'
      : v === 'list' ? svgIcon('map') + '<i></i><span>Show the map</span>'
        : '<i></i>';
    handle.title = v === 'split' ? 'Tap for a bigger map' : v === 'map' ? 'Tap for the list' : 'Tap for the map';
    if (dvMap) { requestAnimationFrame(() => { resizeGmap(); dvMap.refresh(); }); }
  }
  const cycleView = () => setView(view === 'split' ? 'map' : view === 'map' ? 'list' : 'split');

  /* ---------- the screen itself ---------- */
  async function acquireWake() {
    try {
      if (navigator.wakeLock && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch { /* optional — the screen dims like any page */ }
  }
  function releaseWake() {
    try { if (wake) wake.release(); } catch { /* optional */ }
    wake = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (showing() && document.visibilityState === 'visible') acquireWake();
  });

  function render() {
    pickRoute();
    renderHeader();
    renderList();
    renderGps();
    if (dvMap) dvMap.refresh();
    if (selected) { const d = byId(selected); if (d && !$('dv-sheet').hidden) renderSheet(d); else if (!d) closeSheet(); }
    if (!$('dv-routes').hidden) renderRoutes();
  }
  function open() {
    /* the sheets and the card belong to the other screens; nothing of
     * theirs stays over this one */
    show('card', false);
    show('settings', false);
    show('reports', false);
    show('home', false);
    root.hidden = false;
    opened = true;
    needFit = true;
    mountMap();
    setView(view);
    render();
    acquireWake();
    requestAnimationFrame(() => { resizeGmap(); if (dvMap) dvMap.refresh(); fitNext(); });
  }
  function back() {
    opened = false;
    root.hidden = true;
    releaseWake();
    showHome();
  }
  async function reload() {
    if (busy || typeof boot !== 'function') return;
    busy = true;
    const b = $('dv-reload');
    if (b) b.style.opacity = '.5';
    try { await boot(); } finally { busy = false; if (b) b.style.opacity = ''; }
    render();
  }
  /* app.js calls this after every load and every visit change */
  function refresh() {
    loaded = true;
    if (!showing()) { pickRoute(); return; }
    render();
    /* rows that arrived after the screen opened (live, the deep link;
     * keyless, the dashboard in the next tab) get their framing now */
    if (needFit) fitNext();
  }
  /* app.js hides this section itself when the card or Otto's own screen
   * takes over (showMap / showHome) — the flag and the wake lock follow */
  function hide() {
    opened = false;
    root.hidden = true;
    releaseWake();
  }
  /* a tap on Otto's reading banner while this screen is up: the stop
   * opens here when it is on the route, on the map's card otherwise */
  function openStop(d) {
    if (!d) return;
    if (d.route && stops().some(x => x.id === d.id)) { if (!showing()) open(); openSheet(d); }
    else if (typeof openCard === 'function') openCard(d);
  }
  /* Otto's reading banner is the other screens' record of what was said
   * and stays until dismissed there; here it would sit over the map or
   * the next stop for the whole drive, so it leaves by itself a while
   * after the reading ends — never mid-reading, never a newer one */
  let readingGen = 0;
  function readingDone() {
    const gen = ++readingGen;
    setTimeout(() => {
      const b = $('notes-banner');
      const speaking = typeof notesSpeaking !== 'undefined' && notesSpeaking;
      if (b && gen === readingGen && showing() && !speaking) b.hidden = true;
    }, 10000);
  }

  /* ---------- wiring ---------- */
  $('dv-back').onclick = back;
  $('dv-reload').onclick = reload;
  $('dv-otto').onclick = reportNearest;
  $('dv-title').onclick = () => { if (routesOnFile().length > 1 || !routeId) { renderRoutes(); $('dv-routes').hidden = routesOnFile().length < 2; } };
  $('dv-tab-todo').onclick = () => { tab = 'todo'; render(); $('dv-list-wrap').scrollTop = 0; };
  $('dv-tab-done').onclick = () => { tab = 'done'; render(); $('dv-list-wrap').scrollTop = 0; };
  $('dv-handle').onclick = cycleView;
  $('dv-fit-next').onclick = () => { needFit = true; if (!fitNext()) flash('No live map on this phone — the grid stays centred on you; the list has the distances.'); };
  $('dv-fit-all').onclick = () => { if (!fitAll()) flash('No live map on this phone — the grid stays centred on you; the list has the distances.'); };
  $('dv-gps').onclick = () => Geo.locate();
  $('dv-sheet-x').onclick = closeSheet;
  $('dv-sheet').onclick = e => { if (e.target === $('dv-sheet')) closeSheet(); };
  $('dv-routes-x').onclick = () => { $('dv-routes').hidden = true; };
  $('dv-routes').onclick = e => { if (e.target === $('dv-routes')) $('dv-routes').hidden = true; };
  const openBtn = $('open-driver');
  if (openBtn) openBtn.onclick = open;
  LiveGeo.on(snap => { if (!showing()) return; renderGps(snap); updateDistances(); });
  root.dataset.view = view;

  /* the dashboard's DRIVER ↗ link lands straight on this screen */
  if (location.hash === '#driver') open();

  return { open, back, hide, refresh, openStop, readingDone, get opened() { return showing(); } };
})();
