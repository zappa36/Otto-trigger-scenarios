'use strict';

/* ============================================================
 * A live map with HTML markers pinned to real coordinates.
 *
 * Three backends, picked automatically and swapped at runtime:
 *
 *   gmap    Maps JavaScript API — pans and pinches like real
 *           Google Maps
 *   static  Static Maps API image — a postcard, but it renders
 *           when the JS API is blocked or the key lacks it
 *   grid    no key at all: a plain backdrop
 *
 * The markers are OUR HTML in every case, reprojected from the
 * viewport's centre and zoom on each move. That is the whole
 * design: Google draws the world, we draw everything on it, and
 * losing the map layer never costs us the markers.
 *
 *   FieldMap.mount({ el: '#map', markers: () => [...] })
 * ============================================================ */

const FieldMap = (() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* Dark styling, in the two shapes Google demands: objects for the JS API,
   * pipe-delimited strings for the static endpoint. Same palette, so the
   * backend swap is invisible. */
  const DARK_JS = [
    { elementType: 'geometry', stylers: [{ color: '#0e1b17' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#6b8f85' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#081513' }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1e3a33' }] },
    { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#24443c' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c5148' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e3346' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#123f2c' }] },
    { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];
  const DARK_STATIC = [
    'feature:all|element:geometry|color:0x0e1b17',
    'feature:all|element:labels.text.fill|color:0x6b8f85',
    'feature:all|element:labels.text.stroke|color:0x081513',
    'feature:all|element:labels.icon|visibility:off',
    'feature:road|element:geometry|color:0x1e3a33',
    'feature:road.arterial|element:geometry|color:0x24443c',
    'feature:road.highway|element:geometry|color:0x2c5148',
    'feature:water|element:geometry|color:0x0e3346',
    'feature:poi.park|element:geometry|color:0x123f2c',
    'feature:poi|element:labels|visibility:off',
    'feature:transit|visibility:off',
  ];

  /* Loaded once per page even if several maps mount. */
  let gmapsJsPromise = null;
  let gmapAuthFailed = false;
  const authFailListeners = [];

  function ensureGmapsJs() {
    if (gmapAuthFailed) return Promise.reject(new Error('gmaps key rejected'));
    if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve();
    if (gmapsJsPromise) return gmapsJsPromise;
    gmapsJsPromise = new Promise((resolve, reject) => {
      /* Google calls this asynchronously, AFTER map creation, when the key is
       * not enabled for the JS API. So a map can come up and then be revoked —
       * every instance has to be able to fall back mid-flight. */
      window.gm_authFailure = () => {
        gmapAuthFailed = true;
        authFailListeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
      };
      window.__fmGmapsReady = resolve;
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${window.GMAPS_KEY}&callback=__fmGmapsReady`;
      s.onerror = () => { gmapsJsPromise = null; reject(new Error('gmaps js unreachable')); };
      document.head.appendChild(s);
    });
    return gmapsJsPromise;
  }

  const DEFAULTS = {
    el: '#field-map',
    zoom: 17,
    staticSize: [390, 640],   // pixel size requested from the Static Maps API
    markers: () => [],
    renderMarker: null,       // (marker, showLabel) => html — overrides the default pin
    onMarkerClick: null,
    onBackendChange: null,
    follow: true,
    interactive: true,        // false pins it to the static image
    showMe: true,
    cull: 60,                 // px beyond the edges before a marker is dropped
    geo: null,                // defaults to the global Geo
  };

  const SHELL_STYLE = 'position:absolute;text-align:center;pointer-events:auto;cursor:pointer;';

  function mount(options) {
    const opt = { ...DEFAULTS, ...(options || {}) };
    const root = typeof opt.el === 'string' ? document.querySelector(opt.el) : opt.el;
    if (!root) throw new Error('FieldMap: mount target not found — ' + opt.el);
    const geo = opt.geo || (typeof Geo !== 'undefined' ? Geo : null);
    if (!geo) throw new Error('FieldMap: geolocate.js must be loaded, or pass opt.geo');

    root.classList.add('fm');
    root.innerHTML = `
      <div class="fm-grid"></div>
      <img class="fm-static" alt="">
      <div class="fm-gmap"></div>
      <div class="fm-pins"></div>
      <div class="fm-me" hidden><span class="fm-me-dot"></span><span class="fm-me-halo"></span></div>
      <div class="fm-veil" hidden><span class="fm-veil-text">Finding you…</span></div>
      <button class="fm-recenter" type="button" hidden title="Recenter" aria-label="Recenter the map on your location">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
      </button>`;

    const ui = {
      grid: root.querySelector('.fm-grid'),
      img: root.querySelector('.fm-static'),
      host: root.querySelector('.fm-gmap'),
      pins: root.querySelector('.fm-pins'),
      me: root.querySelector('.fm-me'),
      veil: root.querySelector('.fm-veil'),
      recenter: root.querySelector('.fm-recenter'),
    };

    let gmap = null;
    let gmapOn = false;
    let staticState = 'off';  // 'off' | 'loading' | 'on' | 'failed'
    let view = null;          // { lat, lng, zoom } — the live viewport
    let follow = opt.follow;
    let pinsRaf = 0;
    let lastBackend = null;
    let destroyed = false;

    const backend = () => gmapOn ? 'gmap'
      /* 'loading' counts as live: the grid must not flash back in while the
       * image is still on its way. */
      : (staticState === 'on' || staticState === 'loading') ? 'static'
        : 'grid';

    const schedulePins = () => {
      if (!pinsRaf) pinsRaf = requestAnimationFrame(() => { pinsRaf = 0; renderPins(); });
    };

    /* ---------- projection ----------
     * Web Mercator at the viewport's zoom. The static image is requested at a
     * fixed size and displayed with object-fit:cover, so its effective scale
     * is the cover factor — get this wrong and pins drift as the viewport
     * changes shape. The interactive map fills the element, so cover is 1. */
    function projector() {
      const W = root.clientWidth || opt.staticSize[0];
      const H = root.clientHeight || opt.staticSize[1];
      const pos = geo.position;
      const v = (gmapOn && view) ? view : { lat: pos.lat, lng: pos.lng, zoom: opt.zoom };
      const cover = gmapOn ? 1 : Math.max(W / opt.staticSize[0], H / opt.staticSize[1]);
      const world = 256 * Math.pow(2, v.zoom);
      const px = (lat, lng) => {
        const s = Math.min(.9999, Math.max(-.9999, Math.sin(lat * Math.PI / 180)));
        return { x: world * (lng / 360 + .5), y: world * (.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) };
      };
      const c = px(v.lat, v.lng);
      return {
        W, H,
        xy: (lat, lng) => {
          const q = px(lat, lng);
          return { x: W / 2 + (q.x - c.x) * cover, y: H / 2 + (q.y - c.y) * cover };
        },
      };
    }

    /* ---------- default marker ----------
     * translate() anchors the ICON CENTRE on the coordinate. The label above
     * and the glow below are decoration and must not shift it: a marker that
     * sits next to its coordinate is worse than no marker. */
    function defaultMarker(m, showLabel) {
      const color = m.color || '60,192,224';
      const size = m.size || 38;
      const icon = m.icon || '';
      const label = showLabel && m.label
        ? `<span class="fm-label" style="border-color:rgba(${color},.55);color:${m.labelColor || '#cfe9f2'};transform:translateX(${m.labelShift || 0}px);">${esc(m.label)}</span>`
        : '';
      return `
        <div class="fm-pin-inner">
          ${label}
          <div class="fm-icon" style="width:${size}px;height:${size}px;background:${m.background || `linear-gradient(180deg,rgba(${color},.95),rgba(${color},.6))`};box-shadow:0 7px 16px rgba(${color},.5),inset 0 1px 0 rgba(255,255,255,.4);">${icon}</div>
        </div>
        <div class="fm-glow" style="background:radial-gradient(circle,rgba(${color},.45),transparent 70%);"></div>`;
    }

    function renderPins() {
      if (destroyed) return;
      const pos = geo.position;
      const b = backend();

      if (lastBackend !== b) {
        lastBackend = b;
        if (opt.onBackendChange) opt.onBackendChange(b);
      }

      if (!pos) {
        ui.pins.innerHTML = '';
        ui.pins.hidden = true;
        ui.me.hidden = true;
        return;
      }

      const { W, H, xy } = projector();
      const pad = opt.cull;
      const place = (lat, lng) => {
        const q = xy(lat, lng);
        return (q.x < -pad || q.x > W + pad || q.y < -pad || q.y > H + pad) ? null : q;
      };

      if (opt.showMe) {
        const q = xy(pos.lat, pos.lng);
        ui.me.hidden = false;
        ui.me.style.left = Math.round(q.x) + 'px';
        ui.me.style.top = Math.round(q.y) + 'px';
        ui.me.classList.toggle('fm-me-stale', geo.stale);
      }

      const list = (opt.markers() || [])
        .map((m, index) => {
          if (typeof m.lat !== 'number' || typeof m.lng !== 'number') return null;
          const q = place(m.lat, m.lng);
          return q ? { ...m, index, x: q.x, y: q.y } : null;
        })
        .filter(Boolean);

      /* Labels are decoration and may be moved; icons are truth and may not.
       * So a label near the edge slides back into view (labelShift) and a
       * label that would collide with a higher-priority one is dropped
       * outright. Nothing is lost either way — tapping the marker still has
       * the full text. */
      const taken = [];
      [...list].sort((a, b2) => (a.priority || 0) - (b2.priority || 0)).forEach(m => {
        m.labelShift = 0;
        if (!m.label) { m.showLabel = false; return; }
        const w = Math.min(180, 26 + String(m.label).length * 5.4);
        const overLeft = 4 - (m.x - w / 2);
        const overRight = (m.x + w / 2) - (W - 4);
        if (overLeft > 0) m.labelShift = Math.round(overLeft);
        else if (overRight > 0) m.labelShift = -Math.round(overRight);

        const cx = m.x + m.labelShift;
        const cy = m.y - ((m.anchor || (m.size || 38) * .9) + (m.size || 38) / 2 + 12);
        const r = { l: cx - w / 2, r: cx + w / 2, t: cy - 9, b: cy + 9 };
        m.showLabel = !taken.some(o => o.l < r.r && r.l < o.r && o.t < r.b && r.t < o.b);
        if (m.showLabel) taken.push(r);
      });

      const render = opt.renderMarker || defaultMarker;
      ui.pins.innerHTML = list.map(m => `
        <div class="fm-pin" data-index="${m.index}" style="${SHELL_STYLE}left:${Math.round(m.x)}px;top:${Math.round(m.y)}px;transform:translate(-50%,calc(-100% + ${m.anchor || (m.size || 38) * .9}px));">
          ${render(m, m.showLabel)}
        </div>`).join('');
      ui.pins.hidden = false;
    }

    /* ---------- static image backend ---------- */
    function updateStatic() {
      const gkey = window.GMAPS_KEY || '';
      const pos = geo.position;
      if (gmapOn) return; /* the interactive layer owns the screen */
      if (!gkey || !pos) {
        ui.img.hidden = true;
        staticState = 'off';
        return;
      }
      const [sw, sh] = opt.staticSize;
      const src = 'https://maps.googleapis.com/maps/api/staticmap'
        + `?center=${pos.lat},${pos.lng}&zoom=${opt.zoom}&size=${sw}x${sh}&scale=2`
        + '&' + DARK_STATIC.map(s => 'style=' + encodeURIComponent(s)).join('&')
        + `&key=${gkey}`;
      if (ui.img.src === src) return;

      ui.img.onload = () => {
        if (gmapOn) return; /* the interactive layer took over mid-flight */
        ui.img.hidden = false;
        staticState = 'on';
        renderPins();
      };
      ui.img.onerror = () => {
        if (gmapOn) return;
        ui.img.hidden = true;
        staticState = 'failed';
        renderPins();
      };
      if (staticState !== 'on') staticState = 'loading';
      ui.img.src = src;
    }

    /* ---------- interactive backend ---------- */
    function initGmap() {
      if (!opt.interactive || !geo.position || !window.GMAPS_KEY || gmapAuthFailed) return;

      if (gmap) { /* revive after a position loss hid it */
        if (!gmapOn) {
          ui.host.hidden = false;
          ui.img.hidden = true;
          gmapOn = true;
          gmap.setCenter({ lat: geo.position.lat, lng: geo.position.lng });
          ui.recenter.hidden = follow;
          schedulePins();
        }
        return;
      }

      ensureGmapsJs().then(() => {
        if (destroyed || gmap || !geo.position || gmapAuthFailed) return;
        try {
          gmap = new google.maps.Map(ui.host, {
            center: { lat: geo.position.lat, lng: geo.position.lng },
            zoom: opt.zoom,
            disableDefaultUI: true,
            clickableIcons: false,
            keyboardShortcuts: false,
            gestureHandling: 'greedy',
            backgroundColor: '#0e1b17',
            styles: DARK_JS,
          });
        } catch { return; /* API surprise — the static image stays */ }

        const sync = () => {
          const c = gmap.getCenter();
          if (c) view = { lat: c.lat(), lng: c.lng(), zoom: gmap.getZoom() || opt.zoom };
          schedulePins();
        };
        gmap.addListener('center_changed', sync);
        gmap.addListener('zoom_changed', sync);
        gmap.addListener('dragstart', () => api.setFollow(false));

        ui.host.hidden = false;
        ui.img.hidden = true;
        gmapOn = true;
        sync();
      }).catch(() => { /* offline or blocked — the static path is untouched */ });
    }

    function teardownGmap() {
      ui.host.hidden = true;
      ui.host.innerHTML = '';
      gmap = null;
      gmapOn = false;
      view = null;
      updateStatic();
      renderPins();
    }
    authFailListeners.push(teardownGmap);

    /* ---------- position changes ---------- */
    function onGeo(snap) {
      if (destroyed) return;
      /* Veil whatever is on screen until the FIRST fresh fix lands. A cached
       * position under a moving map reads as current truth, and it isn't. */
      ui.veil.hidden = !(snap.state === 'locating' && (!snap.position || snap.stale));

      if (!snap.position) {
        ui.img.hidden = true;
        staticState = 'off';
        if (gmapOn) { ui.host.hidden = true; gmapOn = false; view = null; }
        renderPins();
        return;
      }
      updateStatic();
      initGmap();
      if (gmap && gmapOn && follow) gmap.setCenter({ lat: snap.position.lat, lng: snap.position.lng });
      renderPins();
    }

    const off = geo.on(onGeo);

    /* ---------- interaction ---------- */
    function onClick(e) {
      const pin = e.target.closest('.fm-pin');
      if (!pin || !opt.onMarkerClick) return;
      const m = (opt.markers() || [])[Number(pin.dataset.index)];
      if (m) opt.onMarkerClick(m);
    }
    ui.pins.addEventListener('click', onClick);
    ui.recenter.addEventListener('click', () => api.center());

    const onResize = () => renderPins();
    window.addEventListener('resize', onResize);

    const api = {
      /* Call after your marker data changes. */
      refresh() { renderPins(); return api; },

      setFollow(on) {
        follow = on;
        ui.recenter.hidden = on || !gmapOn;
        return api;
      },

      center() {
        api.setFollow(true);
        if (gmap && geo.position) gmap.setCenter({ lat: geo.position.lat, lng: geo.position.lng });
        renderPins();
        return api;
      },

      get backend() { return backend(); },
      get follow() { return follow; },
      get map() { return gmap; },
      get view() { return view; },

      /* lat/lng -> pixel in the element, or null when off screen. */
      project(lat, lng) {
        if (!geo.position) return null;
        return projector().xy(lat, lng);
      },

      destroy() {
        destroyed = true;
        off();
        window.removeEventListener('resize', onResize);
        ui.pins.removeEventListener('click', onClick);
        const i = authFailListeners.indexOf(teardownGmap);
        if (i >= 0) authFailListeners.splice(i, 1);
        if (pinsRaf) cancelAnimationFrame(pinsRaf);
        root.innerHTML = '';
        root.classList.remove('fm');
      },
    };

    onGeo(geo.snapshot);
    return api;
  }

  return { mount, DARK_JS, DARK_STATIC };
})();
