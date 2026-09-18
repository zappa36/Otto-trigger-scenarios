'use strict';

/* ============================================================
 * The dart game — a three-second reward after a report.
 *
 * A report is a chore: the driver pressed REPORT, told Otto what
 * they found, and got the route back. Now they get a dart first.
 * A full-screen card slides up with a board. The dart rides under
 * the thumb — it follows the drag, tilting into its direction — and
 * when the thumb lets go while it is moving, it flies on from there:
 * the speed and the direction at that moment decide where it lands.
 * Let go standing still and it drifts back to the hand instead.
 * Rings score, the bullseye most, a miss nothing. The score
 * shows for a second, then the card slides away by itself. Before
 * the throw the × in the corner closes it (a tap elsewhere does
 * nothing — it may be a flick that never got going), and a card
 * nobody plays leaves on its own after a while.
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
 *   - the × closes it; nothing plays a sound.
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

  /* Until the depot fills today's board, these regulars keep it
   * company: made up, first names only, the way the settings ask for.
   * The day's real throws outrank them on the same score, and a real
   * driver with the same first name takes the seat. Edit or empty the
   * list to change the flavour; the driver who just threw is always
   * slotted in among them. */
  const REGULARS = [
    { player: 'Mehmet', score: 25 },
    { player: 'Kasia', score: 10 },
    { player: 'Jonas', score: 10 },
    { player: 'Aylin', score: 5 },
    { player: 'Tomasz', score: 1 },
  ];
  const BOARD_ROWS = 5; // rows on today's board

  const T = {
    wait: 20e3,   // ms — no flick by then and the card leaves on its own (the × is the way out before that)
    flight: 380,  // ms — launch to landing
    score: 3600,  // ms — the score and today's board stay up this long
    slide: 280,   // ms — the card's slide in and out (darts.css agrees)
    still: 40e3,  // ms — how long to wait for the phone to stand still
    box: 3000,    // ms — a network answer later than this is not waited for
  };
  /* A throw is a drag that is still moving when the thumb lets go:
   * the dart's speed at that moment (CSS px per ms — a straight line
   * fitted through the last `window` ms of the drag, which shrugs off
   * the jitter a two-point difference would amplify) and its
   * direction. Slower than `minSpeed`, or a drag shorter than
   * `minTravel`, and the dart was set down, not thrown: it drifts back
   * to the hand. The speed decides how far the dart travels IN ALL,
   * hand to landing, and the stretch it was carried under the thumb
   * counts towards that — so a normal flick lands the same whether it
   * was let go early or late, and carrying the dart onto the board
   * and dropping it there earns nothing (it still flies `minFlight`
   * on). `sweet` is the speed whose distance is exactly hand to
   * centre — faster overshoots, slower falls short — but only the
   * default: after a few throws the phone's own usual release speed
   * (the median of the last ten, LS_FLICKS) becomes the sweet spot, so
   * a normal flick for THIS thumb on THIS screen lands near the
   * middle, whatever its pixel speed. `curve` keeps it forgiving
   * (twice the speed is 32 % more distance), `reach` keeps any speed
   * at all on the card, and `aim` softens the sideways part of a
   * throw — thumbs arc, and a dart a few degrees off should still
   * make the board. */
  const FLICK = { minTravel: 20, minSpeed: 0.2, minFlight: 24, sweet: 2, window: 100, hold: 80, curve: 0.4, reach: [0.35, 1.7], aim: 0.75 };
  const HINTS = { idle: 'flick the dart up', still: 'let go while the dart is still moving' };
  const LS_FLICKS = 'od_dart_flicks';
  const flicks = () => { try { return (JSON.parse(localStorage.getItem(LS_FLICKS)) || []).filter(v => v > 0); } catch { return []; } };
  const rememberFlick = v => { try { localStorage.setItem(LS_FLICKS, JSON.stringify([...flicks(), v].slice(-10))); } catch { /* private mode */ } };
  const sweetSpeed = () => {
    const f = flicks().sort((a, b) => a - b);
    return f.length >= 3 ? f[Math.floor(f.length / 2)] : FLICK.sweet;
  };
  let lastFlick = null; // { speed, pts } — the mic self-test reads it
  /* the clock for the swipe: one source for every event, whatever a
   * WebView puts in event.timeStamp */
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
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

  /* ---------- today's board ----------
   * The day's throws: the depot's (dart_throws) when there is a
   * backend, this phone's own otherwise. */
  const localToday = () => loadThrows().filter(r => String(r.thrown_at || '') >= dayStart());
  async function leadersToday() {
    const be = backend();
    if (be && be.dartLeadersToday) {
      try {
        const rows = await be.dartLeadersToday(dayStart());
        if (Array.isArray(rows)) return rows;
      } catch (e) { console.warn('darts: no board today —', e.message); }
    }
    return localToday();
  }
  /* one row per driver — their best of the day — the real rows first,
   * then the regulars in the seats nobody has taken; `me` is the driver
   * who just threw, slotted in above anyone on the same score, because
   * it is their moment (their best of the day if that was better). */
  function boardOf(rows, me) {
    const seats = new Map();
    (rows || []).forEach(r => {
      const k = nameOf(r.player).toLowerCase();
      if (!seats.has(k) || seats.get(k).score < r.score) seats.set(k, { player: nameOf(r.player), score: +r.score || 0, real: true });
    });
    REGULARS.forEach(r => { const k = r.player.toLowerCase(); if (!seats.has(k)) seats.set(k, { ...r, real: false }); });
    if (me) {
      const k = nameOf(me.player).toLowerCase();
      const had = seats.get(k);
      seats.set(k, { player: nameOf(me.player), score: Math.max(me.score, had ? had.score : 0), real: true, me: true });
    }
    return [...seats.values()].sort((a, b) => b.score - a.score
      || (b.me ? 1 : 0) - (a.me ? 1 : 0)
      || (b.real ? 1 : 0) - (a.real ? 1 : 0)
      || a.player.localeCompare(b.player));
  }
  const bestLine = board => (board[0] && board[0].score > 0
    ? `BEST TODAY: ${board[0].player.toUpperCase()} ${board[0].score}`
    : 'BEST TODAY: NOBODY YET — BE THE FIRST');
  /* the top rows, and the driver's own wherever it fell — a driver
   * outside the top is shown below a gap, with their rank */
  function renderBoard(board, named) {
    const rank = board.findIndex(r => r.me) + 1;
    const shown = rank && rank > BOARD_ROWS
      ? board.slice(0, BOARD_ROWS - 1).concat([{ gap: true }, board[rank - 1]])
      : board.slice(0, BOARD_ROWS);
    ui.lbRows.innerHTML = '';
    shown.forEach(r => {
      const li = document.createElement('li');
      if (r.gap) { li.className = 'dt-lb-gap'; li.textContent = '···'; ui.lbRows.appendChild(li); return; }
      if (r.me) li.className = 'dt-lb-me';
      const rankEl = document.createElement('span');
      rankEl.className = 'dt-lb-rank';
      rankEl.textContent = String(board.indexOf(r) + 1);
      const name = document.createElement('span');
      name.className = 'dt-lb-name';
      name.textContent = r.me && !named ? 'YOU' : r.player.toUpperCase();
      li.append(rankEl, name);
      if (r.me && named) {
        const you = document.createElement('span');
        you.className = 'dt-lb-you';
        you.textContent = 'YOU';
        li.appendChild(you);
      }
      const pts = document.createElement('span');
      pts.className = 'dt-lb-pts';
      pts.textContent = String(r.score);
      li.appendChild(pts);
      ui.lbRows.appendChild(li);
    });
  }

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
  let samples = null;   // the drag, sample by sample
  let drag = null;      // while the thumb holds the dart: { fx, fy, angle, raf }

  function build() {
    const r = root();
    if (!r || ui) return !!ui;
    r.innerHTML = `
      <div class="dt-card">
        <div class="dt-top">
          <div class="dt-tip dt-tip-empty"><b>FOR THE NEXT DRIVER</b><span class="dt-tip-text">…</span></div>
          <button class="dt-x" type="button" aria-label="Close">×</button>
        </div>
        <div class="dt-stage">${boardSvg()}</div>
        <div class="dt-best"></div>
        <div class="dt-hand"><span class="dt-hint">${HINTS.idle}</span></div>
        <div class="dt-dart">${DART_SVG}</div>
        <div class="dt-score" hidden>
          <div class="dt-score-head"><b class="dt-score-num"></b><span class="dt-score-word"></span></div>
          <div class="dt-lb"><span class="dt-lb-title">TODAY'S BOARD</span><ol class="dt-lb-rows"></ol></div>
        </div>
      </div>`;
    const q = sel => r.querySelector(sel);
    ui = {
      card: q('.dt-card'), tip: q('.dt-tip'), tipText: q('.dt-tip-text'), board: q('.dt-board'),
      score: q('.dt-score'), num: q('.dt-score-num'), word: q('.dt-score-word'), lbRows: q('.dt-lb-rows'),
      best: q('.dt-best'), hint: q('.dt-hint'), dart: q('.dt-dart'), x: q('.dt-x'),
    };
    ui.x.addEventListener('click', () => hide());
    /* a touch that begins on the × is the button's, not a swipe's */
    const onX = t => !!(t && t.closest && t.closest('.dt-x'));
    const start = (x, y) => {
      if (!state) return;
      if (state.thrown) { hide(); return; } // the score is up — any touch moves on
      down = { t: now(), x, y };
      samples = [down];
      drag = { fx: x, fy: y, angle: -9, raf: 0 };
      /* the thumb has the dart: the bob stops, and from here on the
       * transform is written by hand, without transitions */
      ui.dart.classList.add('dt-held');
      ui.dart.style.transition = 'none';
      ui.dart.style.transform = 'translate(0px, 0px) rotate(-9deg)';
      ui.hint.hidden = true;
    };
    const move = (x, y) => {
      if (!samples || !drag) return;
      samples.push({ t: now(), x, y });
      if (samples.length > 60) samples.splice(0, samples.length - 60);
      drag.fx = x;
      drag.fy = y;
      if (!drag.raf) drag.raf = requestAnimationFrame(follow);
    };
    const end = (x, y, cancelled) => {
      const s = samples, d = drag;
      samples = null;
      drag = null;
      if (d && d.raf) cancelAnimationFrame(d.raf);
      if (!s || !d || !state) return;
      /* the lift adds a sample only if the thumb moved since the last
       * one: a lift at the same spot a few ms later says nothing about
       * speed and would only flatten it. A thumb that PAUSED before
       * lifting sends no moves at all while it rests — the gap between
       * the last move and the lift is what says it stood still. */
      const prev = s[s.length - 1], t = now();
      if (x !== prev.x || y !== prev.y) s.push({ t, x, y });
      release(s, cancelled, t - s[s.length - 1].t > FLICK.hold);
    };
    if (typeof PointerEvent !== 'undefined') {
      r.addEventListener('pointerdown', e => {
        if (!state || onX(e.target)) return;
        e.preventDefault();
        try { r.setPointerCapture(e.pointerId); } catch { /* optional */ }
        start(e.clientX, e.clientY);
      });
      r.addEventListener('pointermove', e => move(e.clientX, e.clientY));
      r.addEventListener('pointerup', e => end(e.clientX, e.clientY, false));
      /* the browser took the gesture for itself (a scroll it decided
       * on, mid-swipe): what was seen may already be a flick — throw it
       * rather than lose it, and never mistake the cancel for a tap */
      r.addEventListener('pointercancel', e => end(e.clientX, e.clientY, true));
    } else {
      /* a WebView old enough to have no pointer events at all */
      const at = e => (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || e;
      r.addEventListener('touchstart', e => { if (onX(e.target)) return; const t = at(e); start(t.clientX, t.clientY); }, { passive: true });
      r.addEventListener('touchmove', e => { const t = at(e); move(t.clientX, t.clientY); }, { passive: true });
      r.addEventListener('touchend', e => { const t = at(e); end(t.clientX, t.clientY, false); });
      r.addEventListener('touchcancel', e => { const t = at(e); end(t.clientX, t.clientY, true); });
    }
    /* belt to touch-action's braces: while the card is up, a swipe on
     * it scrolls nothing and rubber-bands nothing, in every browser */
    r.addEventListener('touchmove', e => { if (state && e.cancelable && !onX(e.target)) e.preventDefault(); }, { passive: false });
    return true;
  }

  /* The dart under the thumb: it moves exactly as the thumb moves —
   * from wherever it rests, so the thumb need not cover it — and tilts
   * into the direction it is heading, eased so a jittery thumb does
   * not make it twitch. One update per frame, however many events. */
  function follow() {
    if (!drag) return;
    drag.raf = 0;
    const dx = drag.fx - down.x, dy = drag.fy - down.y;
    const v = velocity(samples, 60);
    if (Math.hypot(v.vx, v.vy) > 0.15) {
      const target = Math.atan2(v.vx, -v.vy) * 180 / Math.PI;
      const turn = ((target - drag.angle + 540) % 360) - 180; // the short way round
      drag.angle += turn * 0.35;
    }
    ui.dart.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${drag.angle.toFixed(1)}deg)`;
  }

  /* the dart's velocity (px per ms) over the last `win` ms of the drag:
   * a straight line fitted through the samples in that window */
  function velocity(s, win) {
    const last = s[s.length - 1];
    let pts = s.filter(p => last.t - p.t <= win);
    if (pts.length < 2) pts = s.slice(-2);
    if (pts.length < 2) return { vx: 0, vy: 0 };
    const t0 = pts[0].t;
    let n = 0, st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    pts.forEach(p => { const t = p.t - t0; n++; st += t; sx += p.x; sy += p.y; stt += t * t; stx += t * p.x; sty += t * p.y; });
    const den = n * stt - st * st;
    if (den < 1e-6) {
      const a = pts[0], dt = Math.max(1, last.t - a.t);
      return { vx: (last.x - a.x) / dt, vy: (last.y - a.y) / dt };
    }
    return { vx: (n * stx - st * sx) / den, vy: (n * sty - st * sy) / den };
  }

  const later = (ms, fn) => { if (state) state.timers.push(setTimeout(fn, ms)); };

  function reset() {
    ui.dart.className = 'dt-dart';
    ui.dart.style.transition = 'none';
    ui.dart.style.transform = '';
    void ui.dart.offsetWidth; // apply the reset before the transition comes back
    ui.dart.style.transition = '';
    ui.score.hidden = true;
    ui.best.hidden = false;
    ui.score.classList.remove('dt-miss');
    ui.board.classList.remove('dt-hit');
    ui.hint.textContent = HINTS.idle;
    ui.hint.hidden = false;
    if (drag && drag.raf) cancelAnimationFrame(drag.raf);
    drag = null;
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
    ui.best.textContent = bestLine(boardOf(ctx.rows));
    state = { ...ctx, thrown: false, timers: [] };
    r.hidden = false;
    void r.offsetHeight; // the slide needs a frame in the hidden position first
    r.classList.add('dt-in');
    const leaveIfIdle = () => {
      if (!state || state.thrown) return;
      if (drag) { later(5000, leaveIfIdle); return; } // never yank a dart out of a hand
      hide();
    };
    later(T.wait, leaveIfIdle);
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

  /* ---------- the thumb lets go: a throw, or a dart set down ---------- */
  function release(s, cancelled, paused) {
    if (state.thrown) return;
    const first = s[0], last = s[s.length - 1];
    const off = { x: last.x - first.x, y: last.y - first.y }; // where the thumb carried the dart
    const v = velocity(s, FLICK.window);
    const speed = Math.hypot(v.vx, v.vy);
    if (paused || Math.hypot(off.x, off.y) < FLICK.minTravel || speed < FLICK.minSpeed) { settle(cancelled); return; }
    throwDart(v.vx / speed, v.vy / speed, speed, off);
  }

  /* set down rather than thrown, or the browser cut the touch short:
   * the dart drifts back to the hand, the hint says what a throw needs,
   * and nothing is spent */
  function settle(cancelled) {
    ui.dart.style.transition = 'transform 320ms cubic-bezier(.2, .8, .3, 1)';
    ui.dart.style.transform = 'translate(0px, 0px) rotate(-9deg)';
    ui.hint.textContent = cancelled ? HINTS.idle : HINTS.still;
    ui.hint.hidden = false;
    later(340, () => {
      if (!state || state.thrown || drag) return;
      /* back in the hand: the bob resumes from its first frame, which
       * is the very pose the dart settled into */
      ui.dart.style.transition = 'none';
      ui.dart.style.transform = '';
      ui.dart.classList.remove('dt-held');
      void ui.dart.offsetWidth;
      ui.dart.style.transition = '';
    });
  }

  function throwDart(ux, uy, speed, off) {
    state.thrown = true;
    state.timers.forEach(clearTimeout);
    state.timers = [];
    ui.hint.hidden = true;
    const card = ui.card.getBoundingClientRect();
    const board = ui.board.getBoundingClientRect();
    /* the dart's point at rest in the hand (its transform origin, so a
     * rotation keeps the point where it is), and where the thumb has
     * carried it — which is where the flight begins */
    const L = { x: ui.dart.offsetLeft + ui.dart.offsetWidth / 2, y: ui.dart.offsetTop };
    const from = { x: L.x + off.x, y: L.y + off.y };
    const C = { x: board.left + board.width / 2 - card.left, y: board.top + board.height / 2 - card.top };
    const R = board.width / 2 * (100 / 110); // the SVG keeps a 10-unit margin round the rim
    /* hand to centre is the yardstick: the sweet speed travels exactly
     * that far in all, the carried stretch included */
    const D = Math.hypot(C.x - L.x, C.y - L.y);
    const total = D * clamp(Math.pow(speed / sweetSpeed(), FLICK.curve), FLICK.reach[0], FLICK.reach[1]);
    const flight = Math.max(FLICK.minFlight, total - Math.hypot(off.x, off.y));
    rememberFlick(speed); // this thumb's usual release becomes the sweet spot
    const P = { x: from.x + ux * FLICK.aim * flight, y: from.y + uy * flight };
    const bx = (P.x - C.x) / R * 100, by = (P.y - C.y) / R * 100;
    const ring = RINGS.find(g => Math.hypot(bx, by) <= g.r) || MISS;
    /* a miss still lands somewhere on the card, not off the screen */
    const to = { x: clamp(P.x, 12, card.width - 12), y: clamp(P.y, 12, card.height - 24) };
    const angle = Math.atan2(ux, -uy) * 180 / Math.PI; // 0 = straight up
    state.speed = Math.round(speed * 100) / 100;
    /* the flight carries on from under the thumb: the same transform
     * shape the drag wrote, so the transition runs on from there */
    ui.dart.classList.add('dt-flying');
    ui.dart.style.transition = `transform ${T.flight}ms cubic-bezier(.1, .7, .3, 1)`;
    ui.dart.style.transform = `translate(${(to.x - L.x).toFixed(1)}px, ${(to.y - L.y).toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`;
    later(T.flight, () => land(ring, bx, by));
  }

  function land(ring, bx, by) {
    const hit = ring.pts > 0;
    lastFlick = { speed: state.speed, pts: ring.pts };
    ui.dart.classList.remove('dt-flying');
    ui.dart.classList.add(hit ? 'dt-stuck' : 'dt-missed');
    if (hit) {
      ui.board.classList.add('dt-hit');
      try { if (navigator.vibrate) navigator.vibrate(ring.pts >= 25 ? [30, 40, 30] : 20); } catch { /* optional */ }
    }
    ui.num.textContent = hit ? String(ring.pts) : 'MISS';
    ui.word.textContent = ring.word + (state.counted ? '' : ' (practice)');
    ui.score.classList.toggle('dt-miss', !hit);
    const player = nameOf(state.player);
    /* today's board, with this throw on it — a driver without a name in
     * settings (app.js hands over "someone" then) is simply YOU on it */
    renderBoard(boardOf(state.rows, { player, score: ring.pts }), player !== 'someone');
    ui.best.hidden = true; // the board says it now, in full
    ui.score.hidden = false;
    if (state.counted) save(ring, bx, by, player);
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
      const [rows, leaders] = await Promise.all([
        be && be.dartThrowsFor
          ? boxed(be.dartThrowsFor(stop.id, dayStart()).catch(e => { console.warn('darts: could not ask the depot —', e.message); return null; }))
          : null,
        boxed(leadersToday()),
      ]);
      if (Array.isArray(rows) && rows.some(r => sameStop(r, stop, visit))) return false; // the depot says so too
      if (g !== gen) return false; // dismissed, or superseded, while the depot was answering
      whenStill(() => { if (g === gen) show({ stop, visit, player, rows: leaders || [], counted: true }); });
      return true;
    },
    /* a throw that is neither saved nor remembered — the settings sheet's
     * "try it", so a driver sees the game before a report earns one */
    async practice({ player } = {}) {
      if (!root()) return false;
      cancelPending();
      const g = ++gen;
      const leaders = await boxed(leadersToday());
      if (g !== gen) return false;
      return show({ stop: null, visit: null, player, rows: leaders || [], counted: false });
    },
    dismiss() { gen++; cancelPending(); hide(); },
    setTip(text) {
      tip = String(text || '').trim();
      if (ui) { ui.tipText.textContent = tip || '…'; ui.tip.classList.toggle('dt-tip-empty', !tip); }
    },
    get showing() { return !!state; },
    /* what the phone has learned about its thumb — the mic self-test
     * prints it, so a "the flick does nothing" report comes with numbers */
    stats() {
      const f = flicks();
      return { flicks: f.length, sweet: Math.round(sweetSpeed() * 100) / 100, last: lastFlick };
    },
  };
})();
