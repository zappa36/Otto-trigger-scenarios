'use strict';

/* ============================================================
 * The dart game — a three-second reward after a report.
 *
 * A report is a chore: the driver pressed REPORT, told Otto what
 * they found, and got the route back. Now they get a dart first.
 * The card slides up with a board; one flick of the thumb throws,
 * and the speed and the angle of the flick decide where it lands.
 * Rings score, the bullseye most, a miss nothing. The score shows
 * for a second, then the card slides away — on its own, or on any
 * tap. Back on the route in five seconds.
 *
 * app.js decides WHEN a throw is offered (the game is on in
 * settings, the report belonged to a stop); this file does the
 * rest:
 *   - one throw per STOP, not per call — the throw is tied to the
 *     stop's visit (the Delivered tap) when there is one, and to
 *     the stop and the day otherwise. Pressing REPORT ten times at
 *     one door earns one throw; the phone remembers, the depot's
 *     table is asked too,
 *   - only while the phone is STILL (activity-rec.js) — never on
 *     the move. It waits a while for the driver to stop; if they
 *     do not, there is no card and the throw is not spent,
 *   - any tap dismisses; nothing plays a sound.
 *
 * Scores land in the dart_throws table with the driver's first
 * name from settings ("someone" otherwise), and the line under the
 * board shows the depot's best today. Keyless, throws stay in
 * localStorage and the best is this phone's.
 *
 *   Darts.offer({ stop, visit, player })  // after a report call
 *   Darts.practice({ player })            // settings: a throw that is not counted
 *   Darts.dismiss()                       // Otto takes the screen, say
 *   Darts.setTip('use the side door')     // the one-line slot at the top of
 *                                         // the card — the tip Otto filed
 *                                         // for the next driver (not wired yet)
 * ============================================================ */

const Darts = (() => {
  const LS_THROWS = 'od_dart_throws';

  /* the rings, from the centre out: radius in board units (the rim is
   * 100 from the centre), the points, the word the score comes with */
  const RINGS = [
    { r: 12, pts: 50, name: 'bull', word: 'BULLSEYE!' },
    { r: 28, pts: 25, name: 'inner', word: 'So close!' },
    { r: 52, pts: 10, name: 'middle', word: 'Not bad.' },
    { r: 76, pts: 5, name: 'outer', word: 'Meh.' },
    { r: 100, pts: 1, name: 'rim', word: 'Barely on.' },
  ];
  const MISS = { r: Infinity, pts: 0, name: 'miss', word: 'The wall took it.' };

  const T = {
    show: 3500,   // ms — no flick by then and the card leaves on its own
    flight: 380,  // ms — launch to landing
    score: 1000,  // ms — the score stays up this long
    slide: 280,   // ms — the card's slide in and out (darts.css agrees)
    still: 40e3,  // ms — how long to wait for the phone to stand still
    box: 3000,    // ms — a network answer later than this is not waited for
  };
  /* A flick is a fast, short swipe: at least this far, at least this
   * fast (px per ms, measured over the last moments before the thumb
   * lifts). Slower is a tap, and a tap closes the card. `sweet` is the
   * flick speed that carries the dart exactly to the centre — faster
   * overshoots, slower falls short — and the square root keeps the
   * game forgiving: twice the speed is 41 % more distance, not double. */
  const FLICK = { minTravel: 24, minSpeed: 0.35, sweet: 1.6, window: 120 };
  /* activity states that are not "standing still" (UNKNOWN included —
   * an unknown phone is not known to be still; it settles in seconds) */
  const MOVING = ['IN_VEHICLE', 'ON_FOOT', 'WALKING', 'RUNNING', 'ON_BICYCLE', 'UNKNOWN'];

  const root = () => document.getElementById('darts');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  const nameOf = p => String(p || '').trim().slice(0, 24) || 'someone';
  /* local midnight, as the ISO stamp rows are compared against */
  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
  /* the app's modules are top-level consts, not window properties — a
   * typeof check is the only guard that works for a script loaded alone */
  const backend = () => (typeof Backend !== 'undefined' && Backend.enabled ? Backend : null);
  const activity = () => (typeof ActivityRec !== 'undefined' ? ActivityRec : null);

  /* ---------- this phone's memory of its throws ---------- */
  const loadThrows = () => {
    try { return JSON.parse(localStorage.getItem(LS_THROWS)) || []; } catch { return []; }
  };
  const remember = row => {
    try {
      const list = loadThrows();
      list.unshift(row);
      localStorage.setItem(LS_THROWS, JSON.stringify(list.slice(0, 300)));
    } catch { /* private mode */ }
  };
  /* the same stop: the same visit when the stop had one, or the same
   * stop on the same day — one throw either way */
  const sameStop = (row, stop, visit) =>
    (visit && visit.id && row.visit_id === visit.id)
    || (stop && row.destination_id === stop.id && String(row.thrown_at || '') >= dayStart());

  /* ---------- the depot's best today ---------- */
  const localBest = () => loadThrows()
    .filter(r => String(r.thrown_at || '') >= dayStart())
    .reduce((b, r) => (!b || r.score > b.score ? r : b), null);
  async function bestToday() {
    const be = backend();
    if (be && be.bestDartToday) {
      try {
        const rows = await be.bestDartToday(dayStart());
        if (Array.isArray(rows)) return rows[0] || null;
      } catch (e) { console.warn('darts: no best today —', e.message); }
    }
    return localBest();
  }
  const bestLine = b => (b && b.score > 0
    ? `BEST TODAY: ${nameOf(b.player).toUpperCase()} ${b.score}`
    : 'BEST TODAY: NOBODY YET — BE THE FIRST');

  /* ---------- the board ----------
   * Twenty sectors in the classic colours over three scoring rings, a
   * green ring and a red bull inside them. Scoring is by distance from
   * the centre alone, and each ring says what it is worth. */
  function boardSvg() {
    const N = 20;
    const P = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    const sector = (r0, r1, i, fill) => {
      const a0 = (i - 0.5) * 2 * Math.PI / N - Math.PI / 2;
      const a1 = a0 + 2 * Math.PI / N;
      return `<path d="M${P(r1, a0)} A${r1} ${r1} 0 0 1 ${P(r1, a1)} L${P(r0, a1)} A${r0} ${r0} 0 0 0 ${P(r0, a0)} Z" fill="${fill}"/>`;
    };
    let s = '<circle r="108" fill="#0b0e14"/>';
    [[76, 100], [52, 76], [28, 52]].forEach(([r0, r1], b) => {
      for (let i = 0; i < N; i++) s += sector(r0, r1, i, (i + b) % 2 ? '#f3e9d2' : '#1b1f27');
    });
    s += '<circle r="28" fill="#2f9e5f"/><circle r="12" fill="#e0413f"/>';
    /* the wires */
    for (let i = 0; i < N; i++) {
      const a = (i - 0.5) * 2 * Math.PI / N - Math.PI / 2;
      s += `<line x1="${P(28, a).replace(' ', '" y1="')}" x2="${P(100, a).replace(' ', '" y2="')}" stroke="#c9ced6" stroke-width=".7"/>`;
    }
    [28, 52, 76, 100].forEach(r => { s += `<circle r="${r}" fill="none" stroke="#c9ced6" stroke-width="1"/>`; });
    /* what each ring is worth, read from the rim in */
    [[88, '1'], [64, '5'], [40, '10'], [20, '25']].forEach(([y, t]) => {
      s += `<circle cx="0" cy="${-y}" r="7.5" fill="#0b0e14" stroke="#c9ced6" stroke-width=".6"/>`
        + `<text x="0" y="${-y + 3}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff" font-family="ui-monospace, Menlo, monospace">${t}</text>`;
    });
    s += '<text x="0" y="3.2" text-anchor="middle" font-size="8.5" font-weight="800" fill="#fff" font-family="ui-monospace, Menlo, monospace">50</text>';
    return `<svg class="dt-board" viewBox="-110 -110 220 220" aria-hidden="true">${s}</svg>`;
  }
  const DART_SVG = `<svg viewBox="0 0 18 52" width="22" height="64" aria-hidden="true">
    <path d="M9 0 L11.5 15 L6.5 15 Z" fill="#dfe6ee"/>
    <rect x="6" y="14" width="6" height="16" rx="3" fill="#ffd95e"/>
    <rect x="8" y="30" width="2" height="9" fill="#94a1b2"/>
    <path d="M9 36 L17 51 L9 46.5 L1 51 Z" fill="#ff6b6b"/>
  </svg>`;

  let ui = null;
  let state = null;     // while the card is up: { stop, visit, player, best, counted, thrown, timers }
  let pending = null;   // a throw waiting for the phone to stand still: { cancel }
  let gen = 0;          // bumped by every offer and dismiss — an offer still asking the
                        // depot when Otto takes the screen must not show up over him
  let tip = '';
  let down = null;      // where the thumb came down
  let samples = null;   // its last moments before lifting

  function build() {
    const r = root();
    if (!r || ui) return !!ui;
    r.innerHTML = `
      <div class="dt-card">
        <div class="dt-tip dt-tip-empty"><b>FOR THE NEXT DRIVER</b><span class="dt-tip-text">…</span></div>
        <div class="dt-stage">${boardSvg()}</div>
        <div class="dt-best"></div>
        <div class="dt-hand"><span class="dt-hint">flick up to throw · tap to skip</span></div>
        <div class="dt-dart">${DART_SVG}</div>
        <div class="dt-score" hidden><b class="dt-score-num"></b><span class="dt-score-word"></span></div>
      </div>`;
    const q = sel => r.querySelector(sel);
    ui = {
      card: q('.dt-card'), tip: q('.dt-tip'), tipText: q('.dt-tip-text'), board: q('.dt-board'),
      score: q('.dt-score'), num: q('.dt-score-num'), word: q('.dt-score-word'),
      best: q('.dt-best'), hint: q('.dt-hint'), dart: q('.dt-dart'),
    };
    r.addEventListener('pointerdown', e => {
      if (!state) return;
      e.preventDefault();
      try { r.setPointerCapture(e.pointerId); } catch { /* optional */ }
      down = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      samples = [down];
      ui.hint.hidden = true;
    });
    r.addEventListener('pointermove', e => {
      if (!samples) return;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      if (samples.length > 40) samples.splice(0, samples.length - 40);
    });
    r.addEventListener('pointerup', e => {
      const s = samples;
      samples = null;
      if (!s || !state) return;
      s.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      release(s);
    });
    r.addEventListener('pointercancel', () => { samples = null; });
    return true;
  }

  const later = (ms, fn) => { if (state) state.timers.push(setTimeout(fn, ms)); };

  function reset() {
    ui.dart.className = 'dt-dart';
    ui.dart.style.transition = 'none';
    ui.dart.style.transform = '';
    void ui.dart.offsetWidth; // apply the reset before the transition comes back
    ui.dart.style.transition = '';
    ui.score.hidden = true;
    ui.score.classList.remove('dt-miss');
    ui.board.classList.remove('dt-hit');
    ui.hint.hidden = false;
    samples = null;
    down = null;
  }

  function show(ctx) {
    if (!build()) return false;
    const r = root();
    if (state) state.timers.forEach(clearTimeout);
    r.classList.remove('dt-out');
    reset();
    ui.tipText.textContent = tip || '…';
    ui.tip.classList.toggle('dt-tip-empty', !tip);
    ui.best.textContent = bestLine(ctx.best);
    state = { ...ctx, thrown: false, timers: [] };
    r.hidden = false;
    void r.offsetHeight; // the slide needs a frame in the hidden position first
    r.classList.add('dt-in');
    later(T.show, () => { if (state && !state.thrown) hide(); });
    return true;
  }

  function hide() {
    const r = root();
    const s = state;
    if (!s || s.hiding) return;
    s.hiding = true;
    s.timers.forEach(clearTimeout);
    s.timers = [];
    r.classList.remove('dt-in');
    r.classList.add('dt-out');
    setTimeout(() => {
      if (state !== s) return; // a newer card took over
      r.hidden = true;
      r.classList.remove('dt-out');
      reset();
      state = null;
    }, T.slide + 40);
  }

  /* ---------- the thumb lifts: a tap, or a throw ---------- */
  function release(s) {
    if (state.thrown) { hide(); return; } // the score is up — any touch closes
    const first = s[0], last = s[s.length - 1];
    const travel = Math.hypot(last.x - first.x, last.y - first.y);
    /* the speed at release: the last moments of the swipe, not its
     * whole length — a thumb that slowed down before lifting flicked
     * slowly, however fast it started */
    const from = s.find(p => last.t - p.t <= FLICK.window) || first;
    const dt = Math.max(1, last.t - from.t);
    const vx = (last.x - from.x) / dt, vy = (last.y - from.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (travel < FLICK.minTravel || speed < FLICK.minSpeed) { hide(); return; } // a tap: the card leaves
    throwDart(vx / speed, vy / speed, speed);
  }

  function throwDart(ux, uy, speed) {
    state.thrown = true;
    state.timers.forEach(clearTimeout);
    state.timers = [];
    ui.hint.hidden = true;
    const card = ui.card.getBoundingClientRect();
    const board = ui.board.getBoundingClientRect();
    /* launch = the dart's point, where it rests in the hand (its
     * transform origin, so a rotation keeps the point where it landed) */
    const L = { x: ui.dart.offsetLeft + ui.dart.offsetWidth / 2, y: ui.dart.offsetTop };
    const C = { x: board.left + board.width / 2 - card.left, y: board.top + board.height / 2 - card.top };
    const R = board.width / 2 * (100 / 110); // the SVG keeps a 10-unit margin round the rim
    const D = Math.hypot(C.x - L.x, C.y - L.y);
    const dist = D * Math.sqrt(speed / FLICK.sweet);
    const P = { x: L.x + ux * dist, y: L.y + uy * dist };
    const bx = (P.x - C.x) / R * 100, by = (P.y - C.y) / R * 100;
    const ring = RINGS.find(g => Math.hypot(bx, by) <= g.r) || MISS;
    /* a miss still lands somewhere on the card, not off the screen */
    const to = { x: clamp(P.x, 12, card.width - 12), y: clamp(P.y, 12, card.height - 24) };
    const angle = Math.atan2(ux, -uy) * 180 / Math.PI; // 0 = straight up
    ui.dart.classList.add('dt-flying');
    ui.dart.style.transition = `transform ${T.flight}ms cubic-bezier(.15, .75, .35, 1)`;
    ui.dart.style.transform = `translate(${(to.x - L.x).toFixed(1)}px, ${(to.y - L.y).toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`;
    later(T.flight, () => land(ring, bx, by));
  }

  function land(ring, bx, by) {
    const hit = ring.pts > 0;
    ui.dart.classList.remove('dt-flying');
    ui.dart.classList.add(hit ? 'dt-stuck' : 'dt-missed');
    if (hit) {
      ui.board.classList.add('dt-hit');
      try { if (navigator.vibrate) navigator.vibrate(ring.pts >= 25 ? [30, 40, 30] : 20); } catch { /* optional */ }
    }
    ui.num.textContent = hit ? String(ring.pts) : 'MISS';
    ui.word.textContent = ring.word + (state.counted ? '' : ' (practice)');
    ui.score.classList.toggle('dt-miss', !hit);
    ui.score.hidden = false;
    const player = nameOf(state.player);
    if (state.counted) {
      if (hit && !(state.best && state.best.score >= ring.pts)) {
        ui.best.textContent = `BEST TODAY: ${player.toUpperCase()} ${ring.pts} — THAT'S YOU!`;
      }
      save(ring, bx, by, player);
    }
    later(T.score, hide);
  }

  function save(ring, bx, by, player) {
    const stop = state.stop, visit = state.visit;
    const row = {
      visit_id: visit && isUuid(visit.id) ? visit.id : null,
      destination_id: stop && isUuid(stop.id) ? stop.id : null,
      route: stop && stop.route ? stop.route : null,
      stop: stop && stop.stop != null ? stop.stop : null,
      player,
      score: ring.pts,
      ring: ring.name,
      hit_x: Math.round(clamp(bx, -999, 999)),
      hit_y: Math.round(clamp(by, -999, 999)),
    };
    /* the phone's own record keeps the local ids too — that is what the
     * one-throw-per-stop check reads first, backend or not */
    remember({ ...row, visit_id: visit ? visit.id : null, destination_id: stop ? stop.id : null, thrown_at: new Date().toISOString() });
    const be = backend();
    if (be && be.insertDartThrow) {
      be.insertDartThrow(row).catch(e =>
        console.warn('dart not saved — paste the dart_throws block of schema.sql into the SQL editor?', e.message));
    }
  }

  /* ---------- only while still ---------- */
  function cancelPending() { if (pending) pending.cancel(); }
  function whenStill(fn) {
    const AR = activity();
    /* no activity recognition at all, or switched off: nothing says
     * the phone is moving, so nothing holds the card back */
    const stillNow = snap => !AR || !AR.active || !MOVING.includes(snap ? snap.state : AR.state);
    if (stillNow()) { fn(); return; }
    let off = null, timer = null;
    const done = go => {
      clearTimeout(timer);
      if (off) off();
      off = null;
      pending = null;
      if (go) fn();
    };
    timer = setTimeout(() => done(false), T.still);
    off = AR.on(snap => { if (!snap.on || stillNow(snap)) done(true); });
    pending = { cancel: () => done(false) };
  }

  const boxed = p => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), T.box))]);

  return {
    /* after a report call: one throw for this stop, once the phone is
     * still. Resolves true when a card was (or will be) shown. */
    async offer({ stop, visit, player }) {
      if (!stop || !root()) return false;
      cancelPending();
      const g = ++gen;
      if (loadThrows().some(r => sameStop(r, stop, visit))) return false; // this stop had its throw
      const be = backend();
      const [rows, best] = await Promise.all([
        be && be.dartThrowsFor
          ? boxed(be.dartThrowsFor(stop.id, dayStart()).catch(e => { console.warn('darts: could not ask the depot —', e.message); return null; }))
          : null,
        boxed(bestToday()),
      ]);
      if (Array.isArray(rows) && rows.some(r => sameStop(r, stop, visit))) return false; // the depot says so too
      if (g !== gen) return false; // dismissed, or superseded, while the depot was answering
      whenStill(() => { if (g === gen) show({ stop, visit, player, best: best || null, counted: true }); });
      return true;
    },
    /* a throw that is neither saved nor remembered — the settings sheet's
     * "try it", so a driver sees the game before a report earns one */
    async practice({ player } = {}) {
      if (!root()) return false;
      cancelPending();
      const g = ++gen;
      const best = await boxed(bestToday());
      if (g !== gen) return false;
      return show({ stop: null, visit: null, player, best: best || null, counted: false });
    },
    dismiss() { gen++; cancelPending(); hide(); },
    setTip(text) {
      tip = String(text || '').trim();
      if (ui) { ui.tipText.textContent = tip || '…'; ui.tip.classList.toggle('dt-tip-empty', !tip); }
    },
    get showing() { return !!state; },
  };
})();
