'use strict';

/* ============================================================
 * Activity recognition, honestly approximated.
 *
 * The trigger deck is written against Google's Activity
 * Recognition API (Play Services): IN_VEHICLE, ON_FOOT, STILL…
 * That API exists on Android only — a browser cannot call it.
 * This module keeps the vocabulary and the shape of the data
 * (committed states with confidence, transitions, a trace) and
 * fills it from what the web platform does have:
 *
 *   - GPS speed, from its own watchPosition (the Geo kit stays
 *     untouched and one-shot);
 *   - accelerometer step cadence via devicemotion — the thing
 *     that separates a slow drive from a walk at the same speed.
 *
 * Every snapshot carries source: 'web' | 'native' | 'simulated',
 * so nothing downstream mistakes the approximation for the real
 * thing. Wrap the page in an Android WebView/TWA and the real
 * API plugs into the same seam, overriding the heuristic:
 *
 *   ActivityRec.inject('IN_VEHICLE', 92);  // ActivityRecognitionClient
 *   ActivityRec.feed({lat, lng, speed});   // optional: fused location
 *
 * feed() also replays recorded routes with their own timestamps,
 * which is how the trigger detector is tested without a car.
 *
 *   ActivityRec.start(); ActivityRec.on(snap => ...);
 * ============================================================ */

const ActivityRec = (() => {
  const cfg = {
    vehicleSpeed: 6.5,   // m/s — above this it is a vehicle, cadence or not
    footSpeed: 3.5,      // m/s — below this, step cadence means ON_FOOT
    stillSpeed: 0.7,     // m/s — below this with no cadence we may be STILL
    commitMs: 8000,      // evidence must persist this long before a flip
    stillCommitMs: 20000, // STILL commits slower — red lights are not stops
    nativeFreshMs: 90000, // injected native states silence the heuristic
    maxSegments: 120,
  };

  let active = false;
  let watchId = null;
  let tickId = null;
  let committed = { state: 'UNKNOWN', conf: 0, since: 0 };
  let pending = null;          // { state, conf, since }
  let segments = [];           // { state, conf, start, end } — epoch ms
  let lastFix = null;          // { lat, lng, t }
  let lastFixWall = 0;
  let lastSpeed = null;        // raw m/s of the latest fix
  let speeds = [];             // recent speeds, for the median
  let motionBuf = [];          // { t, mag } accelerometer magnitudes
  let motionOn = false;
  let motionHooked = false;
  let injected = null;         // { state, conf, t } from the native bridge
  let simulated = null;        // manually pinned state
  const listeners = [];

  const src = () => simulated ? 'simulated'
    : (injected && Date.now() - injected.t < cfg.nativeFreshMs) ? 'native' : 'web';

  const snapshot = () => ({
    on: active,
    state: committed.state,
    confidence: committed.conf,
    since: committed.since,
    speed: lastSpeed,
    cadence: cadence().stepping,
    motion: motionOn,
    source: src(),
    position: lastFix ? { lat: lastFix.lat, lng: lastFix.lng } : null,
    t: lastFix ? lastFix.t : Date.now(),
  });

  const emit = () => {
    const s = snapshot();
    listeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
  };

  /* ---------- accelerometer cadence ----------
   * Walking is a strong 1–2.5 Hz rhythm in the acceleration magnitude;
   * vehicle vibration is faster and flatter. Count spaced peaks over a
   * rolling 4 s window. */
  function onMotion(e) {
    const a = e.acceleration && e.acceleration.x != null ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    motionOn = true;
    const t = Date.now();
    motionBuf.push({ t, mag: Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) });
    while (motionBuf.length && t - motionBuf[0].t > 6000) motionBuf.shift();
  }

  function cadence() {
    const t = Date.now();
    const win = motionBuf.filter(s => t - s.t <= 4000);
    if (win.length < 20) return { stepping: false, hz: 0 };
    const mean = win.reduce((s, x) => s + x.mag, 0) / win.length;
    const variance = win.reduce((s, x) => s + (x.mag - mean) ** 2, 0) / win.length;
    let peaks = 0, lastPeak = 0;
    for (let i = 1; i < win.length - 1; i++) {
      const s = win[i];
      if (s.mag > mean + 1.0 && s.mag >= win[i - 1].mag && s.mag >= win[i + 1].mag
        && s.t - lastPeak > 300) { peaks++; lastPeak = s.t; }
    }
    const hz = peaks / 4;
    return { stepping: hz >= 0.7 && hz <= 3 && variance > 1.2, hz };
  }

  /* ---------- state machine ---------- */
  function commitState(state, conf, t) {
    if (committed.state !== state) {
      const prev = segments[segments.length - 1];
      if (prev && !prev.endFinal) prev.end = t;
      segments.push({ state, conf, start: t, end: t });
      if (segments.length > cfg.maxSegments) segments.shift();
      committed = { state, conf, since: t };
      emit();
    } else {
      committed.conf = conf;
    }
    const cur = segments[segments.length - 1];
    if (cur) { cur.end = t; cur.conf = conf; }
  }

  function classify(t) {
    if (simulated) { commitState(simulated, 85, t); return; }
    if (injected && Date.now() - injected.t < cfg.nativeFreshMs) {
      commitState(injected.state, injected.conf, t);
      return;
    }

    const recent = speeds.slice(-3).sort((a, b) => a - b);
    const smooth = recent.length ? recent[Math.floor(recent.length / 2)] : null;
    const { stepping } = cadence();

    let state = 'UNKNOWN', conf = 30;
    if (smooth == null) { state = 'UNKNOWN'; conf = 20; }
    else if (smooth >= cfg.vehicleSpeed) { state = 'IN_VEHICLE'; conf = Math.min(96, Math.round(55 + smooth * 4)); }
    else if (stepping && smooth < cfg.footSpeed) { state = 'ON_FOOT'; conf = 82; }
    else if (smooth <= cfg.stillSpeed && !stepping) { state = 'STILL'; conf = 75; }
    else if (committed.state === 'IN_VEHICLE' && !stepping) { state = 'IN_VEHICLE'; conf = 55; } // creeping in traffic
    /* hysteresis: a candidate must hold before it commits */
    if (state === committed.state) { pending = null; commitState(state, conf, t); return; }
    if (!pending || pending.state !== state) pending = { state, conf, since: t };
    const need = state === 'STILL' ? cfg.stillCommitMs : cfg.commitMs;
    if (t - pending.since >= need) { pending = null; commitState(state, conf, t); }
    else { const cur = segments[segments.length - 1]; if (cur) cur.end = t; }
  }

  /* ---------- fixes ---------- */
  function process(fix) {
    const t = fix.t || Date.now();
    let sp = (typeof fix.speed === 'number' && isFinite(fix.speed) && fix.speed >= 0) ? fix.speed : null;
    if (sp == null && lastFix && t > lastFix.t) {
      const dt = (t - lastFix.t) / 1000;
      if (dt >= 0.5 && dt <= 30 && !(fix.acc > 60)) {
        const R = 6371000, toR = x => x * Math.PI / 180;
        const dLat = toR(fix.lat - lastFix.lat), dLng = toR(fix.lng - lastFix.lng);
        const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toR(lastFix.lat)) * Math.cos(toR(fix.lat)) * Math.sin(dLng / 2) ** 2;
        sp = (2 * R * Math.asin(Math.sqrt(h))) / dt;
      }
    }
    lastFix = { lat: fix.lat, lng: fix.lng, t };
    lastFixWall = Date.now();
    if (sp != null) { lastSpeed = sp; speeds.push(sp); if (speeds.length > 8) speeds.shift(); }
    classify(t);
    emit();
  }

  function onWatch(pos) {
    process({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      speed: pos.coords.speed,
      acc: pos.coords.accuracy,
      t: pos.timestamp || Date.now(),
    });
  }

  return {
    configure(options) { Object.assign(cfg, options || {}); return this; },

    on(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    get active() { return active; },
    get state() { return committed.state; },
    get confidence() { return committed.conf; },
    get snapshot() { return snapshot(); },

    start() {
      if (active) return this;
      active = true;
      const now = Date.now();
      committed = { state: 'UNKNOWN', conf: 0, since: now };
      pending = null;
      segments = [{ state: 'UNKNOWN', conf: 0, start: now, end: now }];
      speeds = [];
      lastSpeed = null;
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(onWatch,
          err => console.warn('ActivityRec: no position —', err && err.message),
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
      }
      if (!motionHooked && typeof DeviceMotionEvent !== 'undefined'
        && typeof DeviceMotionEvent.requestPermission !== 'function') {
        window.addEventListener('devicemotion', onMotion);
        motionHooked = true;
      }
      /* No fixes for a while usually means nothing is moving — synthesise
       * a still-ish reading so the state can settle. Replayed routes feed
       * faster than this, so the tick never interferes with them. */
      tickId = setInterval(() => {
        if (!active || Date.now() - lastFixWall <= 7000) return;
        lastSpeed = 0;
        speeds.push(0); if (speeds.length > 8) speeds.shift();
        classify(Date.now());
        emit();
      }, 5000);
      emit();
      return this;
    },

    stop() {
      if (!active) return this;
      active = false;
      if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      clearInterval(tickId);
      const cur = segments[segments.length - 1];
      if (cur) { cur.end = Math.max(cur.end, Date.now()); cur.endFinal = true; }
      emit();
      return this;
    },

    /* iOS gates devicemotion behind a permission that must be requested
     * from a user gesture — call this from the tap that starts tracking. */
    async requestMotionPermission() {
      if (typeof DeviceMotionEvent === 'undefined') return false;
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
        } catch { return false; }
      }
      if (!motionHooked) { window.addEventListener('devicemotion', onMotion); motionHooked = true; }
      return true;
    },

    /* ---------- external truth ---------- */
    /* Native bridge: a real Google Activity Recognition transition. */
    inject(state, conf) {
      if (!state) { injected = null; return this; }
      injected = { state: String(state), conf: typeof conf === 'number' ? conf : 90, t: Date.now() };
      if (active) classify(lastFix ? lastFix.t : Date.now());
      emit();
      return this;
    },

    /* A GPS fix from outside: fused location, or a replayed route. */
    feed(fix) {
      if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number') return this;
      if (active) process(fix);
      return this;
    },

    /* Pin a state by hand (demos); simulate(null) releases it. */
    simulate(state) {
      simulated = state || null;
      if (active) { classify(lastFix ? lastFix.t : Date.now()); emit(); }
      return this;
    },

    /* ---------- the trace ---------- */
    segments(sinceT) {
      return segments
        .filter(s => s.end > (sinceT || 0))
        .map(s => ({ state: s.state, conf: s.conf, start: Math.max(s.start, sinceT || 0), end: s.end }));
    },

    /* "IN_VEHICLE 4m → STILL 50s → ON_FOOT 1m" — for message rows. */
    summary(sinceT) {
      const fmt = ms => ms >= 60000 ? Math.round(ms / 60000) + 'm' : Math.max(1, Math.round(ms / 1000)) + 's';
      const merged = [];
      this.segments(sinceT).forEach(s => {
        const last = merged[merged.length - 1];
        if (last && last.state === s.state) last.end = s.end;
        else merged.push({ ...s });
      });
      const parts = merged
        .filter(s => s.end - s.start >= 3000 || merged.length === 1)
        .map(s => `${s.state} ${fmt(s.end - s.start)}`);
      const tail = parts.slice(-6);
      return (parts.length > 6 ? '… → ' : '') + tail.join(' → ');
    },
  };
})();
