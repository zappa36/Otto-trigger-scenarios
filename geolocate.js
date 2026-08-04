'use strict';

/* ============================================================
 * Device position, honestly reported.
 *
 * Wraps navigator.geolocation with the things a field app learns
 * the hard way:
 *
 *   - a cached last fix, so a returning user does not watch the
 *     map fly in from a default city on every boot;
 *   - a "stale" flag, so that cached position is never mistaken
 *     for current truth;
 *   - failure reasons that name the actual cause (denied / no
 *     signal / timeout) instead of one generic message;
 *   - a lost fix that is NOT a permission denial keeps the last
 *     known position — indoors and tunnels should not throw away
 *     a map that was true thirty seconds ago;
 *   - reverse geocoding through a cascade, because no single
 *     provider covers the whole world.
 *
 *   Geo.configure({ ... }); Geo.on(render); Geo.prime(); Geo.locate();
 * ============================================================ */

const Geo = (() => {
  const cfg = {
    storageKey: 'fieldmap_last_fix',
    highAccuracy: true,
    timeout: 15000,
    maximumAge: 300000,
    /* Override to plug in your own provider; return { street, area }. */
    reverseGeocode: null,
  };

  let state = 'idle';     // 'idle' | 'locating' | 'fix' | 'off'
  let position = null;    // { lat, lng, acc }
  let address = null;     // { street, area }
  let reason = null;      // 'denied' | 'unavailable' | 'timeout' | 'unsupported'
  let stale = false;      // position came from cache, no fresh fix yet
  let waiters = [];
  const listeners = [];

  const snapshot = () => ({ state, position, address, reason, stale });
  const emit = () => listeners.forEach(fn => { try { fn(snapshot()); } catch (e) { console.error(e); } });
  const settle = () => { waiters.forEach(fn => fn()); waiters = []; };

  /* ---------- cached fix ---------- */
  const readCache = () => {
    try { return JSON.parse(localStorage.getItem(cfg.storageKey) || 'null'); } catch { return null; }
  };
  const writeCache = extra => {
    if (!position) return;
    try {
      const prev = readCache() || {};
      localStorage.setItem(cfg.storageKey, JSON.stringify({
        area: prev.area || null, ...position, ...(extra || {}),
      }));
    } catch { /* private mode */ }
  };

  /* ---------- reverse geocoding ----------
   * Server-side Google first (worldwide, key stays in Supabase secrets),
   * then a browser Maps key, then OpenStreetMap. The order is by coverage,
   * not preference: Nominatim is thin outside Europe, and Google's web
   * geocoder refuses the referrer-locked browser key — which is why the
   * server-side function exists at all. */
  async function defaultReverse(lat, lng) {
    if (typeof Backend !== 'undefined' && Backend.enabled) {
      try {
        const d = await Backend.geocode({ lat, lng });
        if (d && (d.street || d.area)) return d;
      } catch { /* function not deployed — fall through */ }
    }

    const gkey = window.GMAPS_KEY || '';
    if (gkey) {
      try {
        const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${gkey}`);
        if (r.ok) {
          const d = await r.json();
          if (d.status === 'OK' && d.results && d.results.length) {
            const comp = type => {
              for (const res of d.results) {
                const c = (res.address_components || []).find(x => x.types.includes(type));
                if (c) return c.long_name;
              }
              return null;
            };
            const road = comp('route');
            const num = comp('street_number');
            const area = comp('neighborhood') || comp('sublocality_level_1') || comp('sublocality') || comp('locality');
            if (road) return { street: num ? `${road} ${num}` : road, area };
          }
        }
      } catch { /* fall through to Nominatim */ }
    }

    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`);
      if (!r.ok) return null;
      const d = await r.json();
      const a = d.address || {};
      const road = a.road || a.pedestrian || a.footway || a.square || null;
      return {
        street: road ? (a.house_number ? `${road} ${a.house_number}` : road) : (d.name || null),
        area: a.suburb || a.city_district || a.neighbourhood || null,
      };
    } catch { return null; }
  }

  const reverse = (lat, lng) => (cfg.reverseGeocode || defaultReverse)(lat, lng);

  /* ---------- failures ---------- */
  function fail(err) {
    const code = err && err.code;
    reason = code === 1 ? 'denied' : code === 2 ? 'unavailable' : code === 3 ? 'timeout' : 'unsupported';
    state = 'off';

    /* A denial means we must stop showing their position. Anything else —
     * indoors, tunnel, cold start — means the sensor failed, not that the
     * last position became wrong. Keeping it beats falling back to nothing. */
    if (position && reason !== 'denied') {
      stale = true;
      settle();
      emit();
      return;
    }
    position = null;
    address = null;
    settle();
    emit();
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

    get state() { return state; },
    get position() { return position; },
    get address() { return address; },
    get reason() { return reason; },
    get stale() { return stale; },
    get snapshot() { return snapshot(); },

    /* Human-readable status, matched to what actually happened. */
    get label() {
      if (state === 'locating') return 'LOCATING…';
      if (state === 'fix' && position) return 'GPS ±' + Math.max(1, Math.round(position.acc)) + ' m';
      if (reason === 'simulated') return 'SIMULATED POSITION · NOT A REAL FIX';
      if (stale && position) return 'LAST KNOWN POSITION · TAP TO REFRESH';
      return {
        denied: 'LOCATION BLOCKED · ALLOW IT FOR THIS SITE',
        unavailable: 'NO GPS SIGNAL · TAP TO RETRY',
        timeout: 'GPS TIMEOUT · TAP TO RETRY',
        unsupported: 'LOCATION UNAVAILABLE ON THIS DEVICE',
      }[reason] || 'LOCATION OFF · TAP TO LOCATE';
    },

    /* Boot from the cached fix, but ONLY when permission is already granted.
     * On a prompt-or-denied state the cached position is not ours to show. */
    prime() {
      if (position || !navigator.permissions || !navigator.permissions.query) return this;
      const cached = readCache();
      if (!cached || typeof cached.lat !== 'number' || typeof cached.lng !== 'number') return this;
      navigator.permissions.query({ name: 'geolocation' })
        .then(s => {
          if (s.state !== 'granted' || position) return;
          position = { lat: cached.lat, lng: cached.lng, acc: cached.acc || 50 };
          address = cached.area ? { street: null, area: cached.area } : null;
          stale = true;
          emit();
        })
        .catch(() => { /* permissions API unavailable */ });
      return this;
    },

    locate() {
      if (!('geolocation' in navigator)) { fail({ code: 0 }); return this; }
      state = 'locating';
      reason = null;
      emit();

      navigator.geolocation.getCurrentPosition(pos => {
        position = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
        state = 'fix';
        stale = false;
        reason = null;
        writeCache();
        settle();
        emit();

        reverse(position.lat, position.lng).then(res => {
          if (!res || !position) return;
          address = res;
          writeCache({ area: res.area || null });
          emit();
        });
      }, fail, {
        enableHighAccuracy: cfg.highAccuracy,
        timeout: cfg.timeout,
        maximumAge: cfg.maximumAge,
      });
      return this;
    },

    /* Drop in a position by hand: desktop development, a replayed route, a
     * demo with no GPS. Flagged stale and reason 'simulated' so nothing
     * downstream can mistake it for a real fix — the map greys the marker
     * and Geo.label says so. */
    simulate(pos) {
      if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') return this;
      position = { lat: pos.lat, lng: pos.lng, acc: pos.acc || 0 };
      address = pos.street || pos.area ? { street: pos.street || null, area: pos.area || null } : null;
      state = 'off';
      reason = 'simulated';
      stale = true;
      settle();
      emit();
      return this;
    },

    /* Resolves once the attempt has settled, or after ms. Lets a save wait
     * for coordinates without blocking forever on a sensor that never answers. */
    wait(ms = 9000) {
      if (state !== 'locating') return Promise.resolve();
      return new Promise(res => {
        const t = setTimeout(res, ms);
        waiters.push(() => { clearTimeout(t); res(); });
      });
    },

    reverseGeocode: (lat, lng) => reverse(lat, lng),
  };
})();
