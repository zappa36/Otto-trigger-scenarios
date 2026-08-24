#!/usr/bin/env node
'use strict';

/* ============================================================
 * The driver-side demo video, recorded from the REAL app.
 *
 * This harness serves the repo, opens index.html in headless
 * Chromium and screen-records one full run of the loop the README
 * describes — scenario #1 of the starter sheet, "Parking loops",
 * pinned at a real Akazienkiez address:
 *
 *   pre-arrival briefing → two slow loops past the door → the stop
 *   → Otto's question → the driver's answer, transcribed and filed
 *   as an ACCESS tip → the pin flips green → the run verdict → and
 *   the payoff: on the NEXT approach Otto reads that driver's tip
 *   to the next driver.
 *
 * Everything on screen is the app itself, untouched. What the
 * harness stages, it stages through the app's own seams:
 *
 *   - the drive is a scripted GPS trace pushed through
 *     ActivityRec.feed() — the seam activity-rec.js documents as
 *     "how the trigger detector is tested without a car". Fix
 *     timestamps run ahead of wall time, so five minutes of
 *     driving fit a few seconds of video (a time-lapse, not a fake:
 *     the detector sees the full five minutes);
 *   - speechSynthesis is replaced by a silent stand-in that paces
 *     itself like speech and mirrors every line Otto ACTUALLY
 *     speaks into the caption bar — the captions cannot drift from
 *     the app because the app writes them;
 *   - the debrief backend (transcription + structuring) is a shim
 *     that answers with the driver's scripted reply, so the video
 *     shows the live hands-free flow (Otto asks, the mic opens
 *     itself, the answer comes back structured) exactly as a
 *     deployed build behaves — the corner badge says so.
 *
 * Run it (repo root):
 *   node demo/record-driver-demo.mjs
 * Output:
 *   demo/otto-driver-demo.webm  (+ .mp4 when ffmpeg with libx264
 *   is found — imageio-ffmpeg's binary is picked up automatically)
 * ============================================================ */

import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const req = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = req('playwright')); }
catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/x.js')('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'demo');
const WORK = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'otto-demo-'));
const FRAMES = path.join(WORK, 'frames');
fs.mkdirSync(FRAMES, { recursive: true });
const PORT = 8123;

/* ---------- the place ----------
 * Akazienstraße 15, 10823 Berlin — a real address, lifted from the
 * repo's own Schöneberg demo route. x = meters east of the pin,
 * y = meters north; the block the route circles is the double block
 * east of Akazienstraße. */
const PIN = { lat: 52.48907, lng: 13.35359 };
const M_LAT = 111320;                                  // m per ° latitude
const M_LNG = 111320 * Math.cos(PIN.lat * Math.PI / 180); // ≈ 67 790 m per ° longitude
const at = (x, y) => ({ lat: PIN.lat + y / M_LAT, lng: PIN.lng + x / M_LNG });

const BOOT = at(30, -155);      // where the van starts: 158 m short of the pin
const PARK = at(175, -80);      // the spot that finally works: 192 m out

/* ---------- what is on file for the address ---------- */
const DEST = {
  id: 'demo-akazien-15',
  title: 'Akazienstraße 15',
  addr: 'Akazienstraße 15, 10823 Berlin',
  lat: PIN.lat, lng: PIN.lng,
  consignee: 'C. Schulz', floor: '3',
  notes: [{ by: 'dispatch', text: 'Bell panel is inside the archway — “Schulz” is the top row. The bakery next door takes parcels if nobody answers.' }],
  created_at: '2026-08-24T06:40:00.000Z',
};

/* Neighbouring stops of the same tour (verbatim from
 * route-schoeneberg.js) so the map reads like a delivery day.
 * Deliberately bare — no consignee, floor or notes — so none of them
 * has a briefing that could talk over the scenario pin's. */
const NEIGHBOURS = [
  { stop: 23, title: 'Apostel-Paulus-Straße 5', addr: 'Apostel-Paulus-Straße 5, 10823 Berlin', lat: 52.48844, lng: 13.34973 },
  { stop: 24, title: 'Eisenacher Straße 44', addr: 'Eisenacher Straße 44, 10823 Berlin', lat: 52.48881, lng: 13.34899 },
  { stop: 27, title: 'Vorbergstraße 9', addr: 'Vorbergstraße 9, 10823 Berlin', lat: 52.48939, lng: 13.35468 },
  { stop: 28, title: 'Belziger Straße 21', addr: 'Belziger Straße 21, 10823 Berlin', lat: 52.48715, lng: 13.35414 },
].map(d => ({ ...d, id: 'demo-stop-' + d.stop, route: 'schoeneberg-01', created_at: '2026-08-24T06:40:00.000Z' }));

/* Scenario #1, verbatim from the starter sheet (single source of truth). */
const sheetSrc = fs.readFileSync(path.join(ROOT, 'trigger-scenarios.js'), 'utf8');
const sheet = (() => { const window = {}; new Function('window', sheetSrc)(window); return window.TRIGGER_SHEET; })();
const row1 = sheet.scenarios.find(s => s.num === 1);
const SCEN = {
  id: 'demo-sc-parking-loops', destination_id: DEST.id,
  version: 1, origin: 'starter', created_at: '2026-08-24T06:41:00.000Z',
  ...row1,
};

/* ---------- the driver's side of the debrief ---------- */
const ANSWER = {
  transcript: 'No chance on the street side — I looped the block twice. There’s a loading bay behind the bakery on the Belziger corner, it’s free after six. I parked there and walked it over.',
  title: 'Loading bay behind the bakery (Belziger corner) is free after 18:00 — park there and walk',
  category: 'ACCESS',
  reply: 'Got it — loading bay behind the bakery, Belziger corner, free after six. Filed for this address; the next driver hears it on the way in.',
};

/* ---------- the drive ----------
 * Fixes are emitted every 1 VIRTUAL second along a polyline; `comp`
 * is virtual seconds per wall second (the time-lapse factor). The
 * detector runs on the virtual clock (fix timestamps), the video on
 * the wall clock. */
function leg(pts, sp, comp, fixes = []) {
  let [cx, cy] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const [tx, ty] = pts[i];
    let dx = tx - cx, dy = ty - cy;
    let d = Math.hypot(dx, dy);
    while (d > 1e-6) {
      const step = Math.min(sp, d);
      cx += dx / d * step; cy += dy / d * step;
      const p = at(cx, cy);
      fixes.push({ lat: p.lat, lng: p.lng, sp, vdt: 1000, wdt: Math.round(1000 / comp) });
      dx = tx - cx; dy = ty - cy; d = Math.hypot(dx, dy);
    }
    [cx, cy] = [tx, ty];
  }
  return fixes;
}
const still = (xy, secs, comp, sp = 0) => Array.from({ length: secs }, () => {
  const p = at(xy[0], xy[1]);
  return { lat: p.lat, lng: p.lng, sp, vdt: 1000, wdt: Math.round(1000 / comp) };
});

/* join the block from the boot kerb, then two circuits, then the park */
const DRIVE = {
  join: leg([[30, -155], [120, -152], [172, -128], [175, -60], [175, 115]], 7, 9),
  loop1: leg([[175, 115], [-45, 115], [-45, -125], [175, -125]], 6.3, 12),
  loop2: leg([[175, -125], [175, 115], [-45, 115], [-45, -125], [148, -125]], 6.3, 12),
  toPark: [
    ...leg([[148, -125], [175, -125], [175, -98]], 4.5, 6),
    ...leg([[175, -98], [175, -88]], 2.5, 3),
    ...leg([[175, -88], [175, -83]], 1.2, 3),
    ...still([175, -81], 1, 3, 0.4),
  ],
  dwell: still([175, -80], 58, 8),
  driveOff: [1.4, 2.2, 3.4, 4.6, 6, 7.2, 8].map((sp, i, a) => {
    const y = -80 + a.slice(0, i + 1).reduce((s, v) => s + v, 0);
    const p = at(175, y);
    return { lat: p.lat, lng: p.lng, sp, vdt: 1000, wdt: 800 };
  }),
  coda: leg([[560, 640], [300, 340], [60, 150]], 10, 10),
};

/* ---------- what the harness injects into the page ---------- */
const SEED = {
  dest: [DEST, ...NEIGHBOURS], scen: [SCEN],
  boot: BOOT,
  firstFixDelayMs: 2600, // hold the first fix so the title card owns the open
};

const INIT_SCRIPT = `((seed) => {
  /* -- seed the keyless app exactly as the dashboard would have -- */
  try {
    localStorage.setItem('od_destinations', JSON.stringify(seed.dest));
    localStorage.setItem('od_scenarios', JSON.stringify(seed.scen));
    localStorage.setItem('od_lang', 'en');
    localStorage.setItem('od_route_on', '1');
    localStorage.removeItem('od_messages');
    localStorage.removeItem('od_runs');
    localStorage.removeItem('fieldmap_last_fix');
  } catch (e) {}

  /* -- scripted GPS: the harness moves __geo, the app reads it -- */
  window.__geo = { lat: seed.boot.lat, lng: seed.boot.lng };
  let firstDelay = seed.firstFixDelayMs;
  const mkPos = () => ({
    coords: { latitude: __geo.lat, longitude: __geo.lng, accuracy: 12,
      speed: null, heading: null, altitude: null, altitudeAccuracy: null },
    timestamp: Date.now(),
  });
  const later = fn => { const d = firstDelay; firstDelay = 160; setTimeout(fn, d); };
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: ok => later(() => ok(mkPos())),
    watchPosition: ok => { later(() => ok(mkPos())); return 42; },
    clearWatch: () => {},
  }});

  /* -- silent speech that PACES like speech and captions itself -- */
  const durMs = t => Math.min(15000, 900 + String(t || '').length * 52);
  let cur = null;
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [], onvoiceschanged: null,
    addEventListener() {}, removeEventListener() {},
    cancel() {
      if (!cur) return;
      clearTimeout(cur.timer);
      const u = cur.u; cur = null; synth.speaking = false;
      try { u.onend && u.onend({}); } catch (e) {}
    },
    speak(u) {
      synth.cancel();
      const ms = durMs(u.text);
      if (u.text && window.__cap) window.__cap.otto(u.text, ms);
      synth.speaking = true;
      cur = { u, timer: setTimeout(() => {
        cur = null; synth.speaking = false;
        try { u.onend && u.onend({}); } catch (e) {}
      }, ms) };
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text == null ? '' : String(text);
    this.lang = ''; this.voice = null; this.rate = 1; this.pitch = 1;
    this.onend = null; this.onerror = null; this.onstart = null;
  };

  /* -- the production layer: phone framing, captions, title cards -- */
  const boot = () => {
    if (!location.pathname.endsWith('/') && !location.pathname.endsWith('index.html')) return;
    const style = document.createElement('style');
    style.textContent = \`
      body { align-items: flex-start !important; padding-top: 26px; overflow: hidden; }
      .phone { zoom: 2; }
      #dv { position: fixed; inset: 0; pointer-events: none; z-index: 99990;
        font-family: Inter, system-ui, sans-serif; }
      #dv-veil { position: absolute; inset: 0; background: #05080e;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 26px; text-align: center; opacity: 1; transition: opacity .8s ease; }
      #dv-veil.off { opacity: 0; }
      #dv-veil .t1 { font-family: Saira, Inter, sans-serif; font-weight: 700; font-size: 138px;
        line-height: 1; letter-spacing: .01em;
        background: linear-gradient(120deg, #aab6ff, #7c8cff 40%, #3cc0e0 85%);
        -webkit-background-clip: text; background-clip: text; color: transparent; }
      #dv-veil .t2 { font-size: 33px; font-weight: 500; color: #dfe6f2; max-width: 760px; line-height: 1.4; }
      #dv-veil .t3 { font-family: 'JetBrains Mono', monospace; font-size: 17px;
        letter-spacing: .14em; color: #94a1b2; text-transform: uppercase; }
      #dv-cap { position: absolute; left: 50%; bottom: 46px; transform: translateX(-50%);
        width: 950px; padding: 22px 30px 24px; border-radius: 20px;
        background: rgba(6, 11, 19, .88); border: 1px solid rgba(140,165,200,.24);
        opacity: 0; transition: opacity .35s ease; }
      #dv-cap.on { opacity: 1; }
      #dv-cap .who { display: block; font-family: 'JetBrains Mono', monospace; font-size: 16px;
        letter-spacing: .18em; margin-bottom: 8px; }
      #dv-cap .txt { font-size: 30px; line-height: 1.38; color: #eef2f7; font-weight: 450; }
      #dv-note { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center;
        font-family: 'JetBrains Mono', monospace; font-size: 14px; letter-spacing: .16em;
        color: #5c6a7d; }
      /* the app sets hidden on HUD chips, but .chip's display rule outranks
         the UA [hidden] style — enforce the app's own intent */
      .chip[hidden] { display: none !important; }
      .dv-rip { position: fixed; width: 66px; height: 66px; border-radius: 50%;
        border: 4px solid #7fd6ea; background: rgba(127,214,234,.25);
        transform: translate(-50%,-50%) scale(.35); opacity: .95; pointer-events: none;
        z-index: 99999; transition: transform .5s ease-out, opacity .5s ease-out; }
    \`;
    document.head.appendChild(style);
    const dv = document.createElement('div');
    dv.id = 'dv';
    dv.innerHTML = \`
      <div id="dv-veil"><div class="t1">Otto</div>
        <div class="t2"></div><div class="t3"></div></div>
      <div id="dv-cap"><span class="who"></span><span class="txt"></span></div>
      <div id="dv-note">SIMULATED GPS RUN · SCREEN CAPTURE OF THE REAL APP · VOICE SHOWN AS CAPTIONS</div>\`;
    document.body.appendChild(dv);

    const capEl = dv.querySelector('#dv-cap');
    const whoEl = capEl.querySelector('.who');
    const txtEl = capEl.querySelector('.txt');
    const KINDS = {
      otto:   { who: 'OTTO · SPEAKING 🔊', color: '#7fd6ea', rank: 2 },
      driver: { who: 'DRIVER · INTO THE MIC 🎙', color: '#ffd95e', rank: 2 },
      narr:   { who: '', color: '#94a1b2', rank: 1 },
    };
    let capState = { rank: 0, until: 0, timer: null };
    const show = (kind, text, ms) => {
      const k = KINDS[kind];
      const now = performance.now();
      if (capState.rank > k.rank && capState.until > now) return; // a voice outranks narration
      clearTimeout(capState.timer);
      capState = { rank: k.rank, until: now + ms, timer: setTimeout(() => {
        capEl.classList.remove('on'); capState.rank = 0;
      }, ms) };
      whoEl.textContent = k.who;
      whoEl.style.color = k.color;
      whoEl.style.display = k.who ? '' : 'none';
      txtEl.textContent = text;
      capEl.classList.add('on');
    };
    window.__cap = {
      otto: (t, ms) => show('otto', t, ms + 500),
      driver: (t, ms) => show('driver', t, ms),
      narr: (t, ms) => show('narr', t, ms),
      clear: () => { clearTimeout(capState.timer); capState.rank = 0; capEl.classList.remove('on'); },
    };
    window.__title = {
      show(t2, t3) {
        dv.querySelector('.t2').textContent = t2 || '';
        dv.querySelector('.t3').textContent = t3 || '';
        dv.querySelector('#dv-veil').classList.remove('off');
      },
      hide() { dv.querySelector('#dv-veil').classList.add('off'); },
    };
    window.__ripple = (x, y) => {
      const r = document.createElement('div');
      r.className = 'dv-rip';
      r.style.left = x + 'px'; r.style.top = y + 'px';
      document.body.appendChild(r);
      requestAnimationFrame(() => {
        r.style.transform = 'translate(-50%,-50%) scale(1.25)';
        r.style.opacity = '0';
      });
      setTimeout(() => r.remove(), 700);
    };
    __title.show('The debrief copilot for parcel drivers',
      'A live run of the real app · scripted GPS · Berlin-Schöneberg');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(${JSON.stringify(SEED)});`;

/* Bridge into the app's top-level lexical scope (map, Geo, ActivityRec,
 * Backend, tracking…) — a classic <script> tag shares it; evaluate()
 * worlds may not. Everything below reaches the app through here. */
const BRIDGE_SCRIPT = `
window.__vclock = { now: Date.now() };
window.__app = {
  feed: f => ActivityRec.feed(f),
  arStart: () => ActivityRec.start(),
  locate: () => Geo.locate(),
  refresh: () => map.refresh(),
  shimBackend() {
    /* the idle recorder mounted at load is in scripted-demo mode (the
     * backend was off then) and would auto-play itself to a demo save in
     * the background — freeze it; openOtto remounts fresh, live */
    try { voice.stop(); } catch (e) {}
    const ANSWER = ${JSON.stringify(ANSWER)};
    Backend.enabled = true;
    Backend.tts = () => Promise.reject(new Error('demo: elevenlabs off'));
    Backend.geocode = () => Promise.reject(new Error('demo: geocode off'));
    Backend.search = () => Promise.resolve([]);
    Backend.scenarioAI = () => Promise.reject(new Error('demo: ai off'));
    Backend.structureText = () => Promise.reject(new Error('demo: ai off'));
    Backend.transcribe = () => new Promise(r => setTimeout(() => r({
      transcript: ANSWER.transcript,
      note: { title: ANSWER.title, category: ANSWER.category },
      reply: ANSWER.reply,
    }), 1500));
    Backend.saveNote = row => Promise.resolve([{ ...row,
      id: 'demo-msg-' + Date.now().toString(36),
      created_at: new Date().toISOString() }]);
    Backend.insertRun = () => Promise.resolve([{ id: 'demo-run' }]);
    Backend.updateRun = () => Promise.resolve([]);
    Backend.listDestinations = () => Promise.resolve([]);
    Backend.listMessages = () => Promise.resolve([]);
    Backend.listScenarios = () => Promise.resolve([]);
  },
  /* the map only re-renders on the app's own 2 s throttle; while the
   * harness drives, repaint at the feed rate so the dot glides. Gated
   * to the drive so taps never race a mid-repaint pin rebuild. */
  smooth() { setInterval(() => { try { if (window.__driving) map.refresh(); } catch (e) {} }, 66); },
  drive(fixes) {
    window.__driving = (window.__driving || 0) + 1;
    return new Promise(done => {
      let i = 0;
      window.__vclock.now = Math.max(window.__vclock.now, Date.now());
      const step = () => {
        if (i >= fixes.length) { window.__driving--; done(); return; }
        const f = fixes[i++];
        window.__vclock.now += f.vdt;
        window.__geo.lat = f.lat; window.__geo.lng = f.lng;
        try { ActivityRec.feed({ lat: f.lat, lng: f.lng, speed: f.sp, acc: 8, t: window.__vclock.now }); }
        catch (e) { console.error('feed', e); }
        setTimeout(step, f.wdt);
      };
      step();
    });
  },
  state() {
    const q = s => document.querySelector(s);
    return {
      passes: typeof tracking !== 'undefined' && tracking ? tracking.passes : -1,
      stopped: !!(tracking && tracking.stopped),
      fired: !!(tracking && tracking.fired),
      dwellS: tracking ? Math.round(tracking.dwellMs / 1000) : 0,
      tracking: !!tracking,
      otto: !q('#otto-screen').hidden,
      notesBanner: !q('#notes-banner').hidden,
      verdict: !q('#verdict-banner').hidden,
      card: !q('#card').hidden,
      pin: !!q('.fm-pin'),
      rec: !!q('#otto .vn-mic-rec'),
      micVisible: !!(q('#otto .vn-mic') && !q('#otto .vn-mic').hidden),
      bubbleMe: !!q('#otto .vn-bubble-me'),
      chip: (q('#otto .vn-chip') || {}).textContent || '',
      gpsChip: q('#gps').textContent,
      arChip: q('#ar').textContent,
      trackLine: q('#card-sc-track').textContent,
    };
  },
};`;

/* ---------- tiny runtime ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT],
    { stdio: 'ignore' });
  await sleep(700);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--font-render-hinting=none',
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    recordVideo: { dir: WORK, size: { width: 1080, height: 1920 } },
    colorScheme: 'dark',
    permissions: ['microphone', 'geolocation'],
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(INIT_SCRIPT);

  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('console.error:', msg.text());
  });

  /* dark lead-in so the video never opens on a white frame */
  await page.goto('data:text/html,<body style="background:%2305080e"></body>');
  await sleep(400);

  log('opening the app');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.addScriptTag({ content: BRIDGE_SCRIPT });
  const app = {
    state: () => page.evaluate(() => window.__app.state()),
    drive: fixes => page.evaluate(fx => window.__app.drive(fx), fixes),
    driveBg: fixes => page.evaluate(fx => { window.__app.drive(fx); }, fixes),
    narr: (text, ms) => page.evaluate(([t, m]) => window.__cap.narr(t, m), [text, ms]),
    driver: (text, ms) => page.evaluate(([t, m]) => window.__cap.driver(t, m), [text, ms]),
    shot: name => page.screenshot({ path: path.join(FRAMES, name + '.png') }).catch(() => {}),
  };
  await page.evaluate(() => { window.__app.shimBackend(); window.__app.smooth(); });

  async function waitState(label, pred, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await app.state();
      if (pred(s)) return s;
      if (Date.now() > until) {
        await app.shot('FAIL-' + label.replace(/\W+/g, '-'));
        throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`);
      }
      await sleep(140);
    }
  }
  async function tap(selector) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    const b = await loc.boundingBox();
    if (b) {
      await page.evaluate(([x, y]) => window.__ripple(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
      await sleep(320);
    }
    /* pins bobble forever (fm-bobble), so Playwright's stability check
     * never settles — force the click, retrying across pin re-renders */
    for (let i = 0; ; i++) {
      try { await loc.click({ force: true, timeout: 2500 }); return; }
      catch (e) { if (i >= 4) throw e; await sleep(250); }
    }
  }

  /* ================= the film ================= */

  /* — title card over the veiled map; the first fix lands at ~2.6 s — */
  await sleep(2900);
  await page.evaluate(() => window.__title.hide());
  log('title down, map up');

  /* Otto's pre-arrival reading fires by itself the moment the fix lands
   * inside the 350 m ring (the fake TTS mirrors it into the captions).
   * Give it a beat, then open the stop's card while he talks. */
  await waitState('notes banner', s => s.notesBanner, 12000);
  log('pre-arrival briefing is being read');
  await app.shot('01-briefing');
  await sleep(5200);

  await waitState('pin', s => s.pin, 5000);
  await tap('.fm-pin .fm-icon');
  await waitState('card', s => s.card, 5000);
  log('destination card open');
  await app.shot('02-card');
  await sleep(4200);
  await app.narr('One row of the dispatcher’s trigger sheet — a live detector armed for this address: slow loops past the door, then a stop.', 5200);
  await sleep(4600);

  await tap('#card-sc-start');
  await waitState('tracking', s => s.tracking, 5000);
  log('test tracking armed');
  await app.shot('03-tracking');
  await sleep(1600);
  await tap('#card-x');
  await sleep(500);

  /* — the drive: join the block, two slow loops, the stop — */
  await app.narr('The driver just drives. Otto watches the pattern — nothing to tap, nothing to read.', 4600);
  log('driving: joining the block');
  await app.drive(DRIVE.join);

  const loop1 = app.drive(DRIVE.loop1);
  await waitState('pass 1', s => s.passes >= 1, 25000);
  log('pass 1 counted');
  await app.narr('First slow pass — nothing free at the door.', 3800);
  await app.shot('04-pass1');
  await loop1;

  const loop2 = app.drive(DRIVE.loop2);
  await waitState('pass 2', s => s.passes >= 2, 25000);
  log('pass 2 counted');
  await app.narr('Second loop. The trigger is armed — now Otto waits for the stop.', 4600);
  await app.shot('05-pass2');
  await loop2;

  log('parking');
  await app.drive(DRIVE.toPark);
  const dwell = app.drive(DRIVE.dwell);
  await waitState('stop seen', s => s.stopped, 20000);
  log('stop seen');
  await app.narr('Parked two corners on — parcel to the door. The moment the wheels turn again…', 5400);
  await app.shot('06-stop');
  await dwell;

  /* — the fire: Otto opens by himself, asks, and listens — */
  await app.drive(DRIVE.driveOff);
  await waitState('trigger fired', s => s.fired && s.otto, 12000);
  log('TRIGGER FIRED — Otto screen open, question being spoken');
  await app.shot('07-otto-question');

  await waitState('mic recording', s => s.rec, 20000);
  log('mic open, driver answering');
  await app.driver(ANSWER.transcript, 8600);
  await app.shot('08-recording');
  await sleep(8300);

  await tap('#otto .vn-mic');
  await waitState('transcript', s => s.bubbleMe, 12000);
  log('transcript back');
  await app.shot('09-transcript');
  await waitState('note chip', s => /NOTE SAVED/.test(s.chip), 10000);
  log(`filed: ${(await app.state()).chip}`);

  /* Otto's spoken confirmation captions itself; let it land */
  await sleep(9200);
  await app.narr('Transcribed, structured, filed — an ACCESS tip against this address.', 4600);
  await app.shot('10-saved');
  await sleep(4400);

  /* park the blue dot at the kerb before the map comes back */
  await page.evaluate(p => { window.__geo.lat = p.lat; window.__geo.lng = p.lng; window.__app.locate(); }, PARK);
  await sleep(600);
  await tap('#otto-back');
  await waitState('card back', s => s.card && s.verdict, 8000);
  log('back on the map — card shows the filed tip');
  await app.narr('The tip is on the record for this address — and the pin flips green: debriefed.', 5200);
  await app.shot('11-card-filed');
  await sleep(5000);
  /* the tall card sits over the verdict bar — close it to answer */
  await tap('#card-x');
  await sleep(900);
  await app.shot('12-verdict');
  await app.narr('One tap of ground truth closes the run — that’s what tunes the trigger.', 4800);
  await sleep(4400);
  await tap('#vb-right');
  await sleep(1200);

  /* — the payoff: the next driver hears what this one learned — */
  await app.narr('Next tour. A different driver, the same address —', 4200);
  await page.evaluate(([g]) => { window.__geo.lat = g.lat; window.__geo.lng = g.lng; window.__app.locate(); },
    [at(560, 640)]);
  await sleep(1500);
  await tap('#ar');
  await sleep(900);
  const coda = app.drive(DRIVE.coda);
  await waitState('coda briefing', s => s.notesBanner, 20000);
  log('coda briefing — the new tip is read out');
  await app.shot('13-coda');
  await coda;
  await sleep(11500);
  await app.narr('What one driver learns, every driver hears.', 4200);
  await sleep(4400);

  await page.evaluate(() => window.__title.show(
    'What one driver learns, every driver hears.',
    'github.com/zappa36/otto-trigger-scenarios'));
  await sleep(4600);

  /* ================= wrap ================= */
  const video = page.video();
  await ctx.close();
  const raw = await video.path();
  await browser.close();
  server.kill();

  const webm = path.join(OUT_DIR, 'otto-driver-demo.webm');
  fs.copyFileSync(raw, webm);
  log(`webm: ${webm} (${(fs.statSync(webm).size / 1e6).toFixed(1)} MB)`);

  /* mp4 for players that don't do VP8 — best effort */
  const ffmpegs = [
    process.env.FFMPEG,
    '/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2',
    'ffmpeg',
  ].filter(Boolean);
  for (const ff of ffmpegs) {
    try {
      const mp4 = path.join(OUT_DIR, 'otto-driver-demo.mp4');
      execFileSync(ff, ['-y', '-i', webm, '-c:v', 'libx264', '-crf', '22', '-preset', 'medium',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', mp4], { stdio: 'ignore' });
      log(`mp4:  ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB)`);
      break;
    } catch (e) { /* try the next candidate */ }
  }
  log(`frames for review: ${FRAMES}`);
}

main().catch(e => { console.error(e); process.exit(1); });
