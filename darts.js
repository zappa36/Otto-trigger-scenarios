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
 * That is the thumb version. The voice version, on by default, needs
 * neither thumb nor eyes: Otto says "start" and counts one to five,
 * and the driver says "stop" on the number they want — for the side
 * (one left, five right), the height (one top, five bottom) and the
 * strength (four is the sweet spot); a count nobody stops ends on
 * five. Otto announces the throw. On screen there is only Otto then,
 * as on the report call: his face and the words, his lines and each
 * stop as the driver's line — never the numbers. Rings score, the
 * bullseye most, a miss nothing. The score
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

  /* ---------- the voice throw ----------
   * Otto counts, the driver says stop — blind. "Side, left to right.
   * Start. One, two, three, four, five." A stop on the number they
   * want is the side; no stop, and five is the side: a count that
   * reaches its end stops there. Then "Height, top to bottom. Start."
   * and the count again; then "Strength. Start." — four is the sweet
   * spot (its band lands the dart where it was aimed, weaker falls
   * short, five flies high). "Three, three, four" is the perfect
   * throw, if the timing is right: the count moves on every beat, and
   * a stop belongs to the number heard a moment before. The numbers
   * are clips of Otto's own voice from the reading function, decoded
   * once and played through the audio engine, which keeps time;
   * without them the phone's own voice counts. Nothing of the count
   * is shown: on screen there is only Otto and the words — his lines,
   * each stop as the driver's line — as on the report call. The
   * phone does not have to understand "stop": the microphone is a
   * level meter and any sharp jump above what was there a moment ago
   * is a stop — instant, records nothing, and it works in the Android
   * app, where browsers cannot recognise speech. A tap is a stop too,
   * for a loud street or a phone that refuses the microphone. The ear
   * is shut while Otto speaks a sentence and takes each number's level
   * at once as he says it. A throw nobody stopped at all — every
   * count ran to its end — is no throw, and nothing is spent. */
  const VOICE = {
    beat: 1100,      // ms — one number of the count, unless the settings say a pace (app.js hands it over)
    lead: 500,       // ms — a breath after "Start" before "one"
    span: 105,       // board units — one and five sit this far each side of the centre
    countLag: 500,   // ms — hearing a number, deciding, saying stop: a stop belongs to the number this long before it was heard
    dodge: 180,      // ms — the ear takes a number's level at once as Otto says it, and looks for no stop meanwhile
    debounce: 650,   // ms — one stop at a time
    sweet: [0.6, 0.8],  // the strength band that lands the dart where it was aimed — four of five is in it
    drift: 130,      // board units — a strength fully short or fully over lands this far low or high
    gain: 0.7,       // the count's volume, under Otto's sentences
    settle: 1500,    // ms — the card stays this long after Otto has announced the throw
    cap: 22e3,       // ms — and leaves by then whatever the voice did
  };
  /* What Otto says. The first few throws a phone plays get the rules
   * in full — the driver cannot see them anywhere — and after that the
   * short lines: the driver knows the game. */
  const RULES = 'Here is the game. I count one to five, three times, and you say stop on the number you want. '
    + 'First the side: one is far left, three is the middle, five is far right. '
    + 'Then the height: one is the top, three is the middle, five is the bottom. '
    + 'Then the strength: four is just right; less falls short, five flies over. '
    + 'Say nothing and I stop at five. Three, three, four is a bullseye.';
  const CUES = {
    x: 'Dart! Say stop while I count. Side, left to right. Start.',
    y: 'Height, top to bottom. Start.',
    p: 'Strength. Start.',
    none: 'No stop, no throw. Next time.',
    practice: ' Just practice.',
  };
  const LONG = {
    x: RULES + ' Side, left to right. Start.',
    y: 'Now the height. One is the top, three the middle, five the bottom. Start.',
    p: 'Now the strength. Four is just right. Start.',
  };
  const LS_PLAYS = 'od_dart_voice_plays';
  const EXPLAIN = 3; // throws with the rules in full before the short lines
  const plays = () => { try { return +localStorage.getItem(LS_PLAYS) || 0; } catch { return 0; } };
  const cue = k => (state && state.longCues ? LONG[k] : CUES[k]);
  const COUNT = ['one', 'two', 'three', 'four', 'five'];
  const STEP = { x: 'SIDE', y: 'HEIGHT', p: 'STRENGTH' };
  /* what a number means: the side's one is the left, the height's one
   * is the top, the strength's five notches run one to five */
  const stepValue = (phase, i) => (phase === 'p' ? 0.1 + i * 0.2 : i / 4);
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
        <div class="dt-otto vn">
          <div class="vn-stage">
            <div class="vn-orb">
              <span class="vn-glow"></span><span class="vn-ring vn-ring1" hidden></span><span class="vn-ring vn-ring2" hidden></span>
              <span class="vn-blob"></span><span class="vn-sheen"></span>
              <div class="vn-face"><span class="vn-eyes"><span class="vn-eye"><i></i></span><span class="vn-eye"><i></i></span></span></div>
            </div>
            <div class="dt-chat"></div>
          </div>
          <div class="vn-bar"><div class="vn-labels"><div class="vn-caption"></div><div class="vn-sub"></div></div></div>
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
      chat: q('.dt-chat'), caption: q('.dt-otto .vn-caption'), sub: q('.dt-otto .vn-sub'), rings: [...r.querySelectorAll('.dt-otto .vn-ring')],
    };
    ui.x.addEventListener('click', () => hide());
    /* a touch that begins on the × is the button's, not a swipe's */
    const onX = t => !!(t && t.closest && t.closest('.dt-x'));
    const start = (x, y) => {
      if (!state) return;
      if (state.thrown) { hide(); return; } // the score is up — any touch moves on
      if (state.voice) { voiceStop(now(), 'tap'); return; } // a tap is a stop too
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

  /* ---------- the ear ----------
   * The microphone as a level meter, nothing more: no words, no
   * recording, nothing leaves the phone. A burst well above the room's
   * level is a stop. */
  const ear = { ctx: null, stream: null, src: null, an: null, buf: null, timer: 0, base: 0, own: 0, dodgeMax: 0, hot: false, lastStop: 0, born: 0, dodge: 0, on: null, ok: null, mute: false };
  /* an AudioContext born outside a tap may never run — make it in one */
  function primeEar() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ear.ctx) ear.ctx = new AC();
      if (ear.ctx.state === 'suspended') ear.ctx.resume().catch(() => {});
    } catch { /* no web audio */ }
  }
  document.addEventListener('pointerdown', primeEar, { capture: true, passive: true });
  async function openEar(onStop) {
    closeEar();
    ear.on = onStop;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { ear.ok = false; return false; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { console.warn('darts: no microphone —', e.message); ear.ok = false; return false; }
    if (!ear.on) { stream.getTracks().forEach(tr => tr.stop()); return false; } // closed while asking
    try {
      primeEar();
      ear.stream = stream;
      ear.src = ear.ctx.createMediaStreamSource(stream);
      ear.an = ear.ctx.createAnalyser();
      ear.an.fftSize = 512;
      ear.src.connect(ear.an);
      ear.buf = new Uint8Array(ear.an.fftSize);
    } catch (e) { console.warn('darts: no level meter —', e.message); closeEar(); ear.ok = false; return false; }
    ear.base = 0;
    ear.own = 0;
    ear.dodgeMax = 0;
    ear.hot = false;
    ear.dodge = 0;
    ear.born = now();
    ear.timer = setInterval(listen, 20);
    ear.ok = true;
    return true;
  }
  function listen() {
    if (!ear.an) return;
    ear.an.getByteTimeDomainData(ear.buf);
    let sum = 0;
    for (let i = 0; i < ear.buf.length; i++) { const v = (ear.buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / ear.buf.length);
    const t = now();
    if (ear.mute) { ear.base = ear.base * 0.8 + rms * 0.2; ear.hot = false; return; } // Otto is talking: his sentence is not a stop
    /* The floor: what was there a moment ago. It follows a level that
     * falls at once and a level that rises only slowly — so a bus
     * building up is absorbed, and a stop has to jump clear of it.
     * When one of the phone's own sounds starts (the dodge), the floor
     * takes its level at once, and that level at the microphone is
     * remembered: in the dodge, only a voice clearly louder than the
     * phone's own sound counts. */
    const inDodge = t < ear.dodge;
    const thr = Math.max(0.04, ear.base * 2.2, inDodge ? (ear.own || 1) * 2.5 : 0);
    ear.level = rms; // for the self-test and the field: what the ear hears right now
    ear.thr = thr;
    if (!ear.hot && rms > thr && t - ear.born > 300) {
      ear.hot = true;
      if (t - ear.lastStop > VOICE.debounce) { ear.lastStop = t; if (ear.on) ear.on(t); }
    } else if (ear.hot && rms < thr * 0.6) {
      ear.hot = false;
    }
    if (inDodge) {
      ear.base = Math.max(ear.base, rms);
      ear.dodgeMax = Math.max(ear.dodgeMax, rms);
    } else {
      if (ear.dodgeMax > 0) { ear.own = Math.max(ear.dodgeMax, ear.own * 0.9); ear.dodgeMax = 0; }
      ear.base = rms > ear.base ? ear.base + (rms - ear.base) * 0.03 : ear.base * 0.8 + rms * 0.2;
    }
  }

  /* ---------- Otto counting ----------
   * The five numbers as clips of his own voice from the reading
   * function, decoded once per session and played through the audio
   * engine, which keeps the count in time. Missing — keyless, a slow
   * function — the phone's own voice counts (speakThen, app.js). */
  const clips = { buf: new Map(), busy: new Map(), gain: null, src: null };
  function prefetchCounts() {
    const be = backend();
    if (!be || !be.tts || !ear.ctx) return;
    COUNT.forEach(w => {
      if (clips.buf.has(w) || clips.busy.has(w)) return;
      clips.busy.set(w, true);
      be.tts(w).then(b => b.arrayBuffer()).then(ab => ear.ctx.decodeAudioData(ab))
        .then(buf => clips.buf.set(w, buf))
        .catch(e => console.warn('darts: no clip for "' + w + '" —', e.message))
        .finally(() => clips.busy.delete(w));
    });
  }
  function stopCount() {
    if (clips.src) { try { clips.src.stop(); } catch { /* done already */ } clips.src = null; }
  }
  function playCount(i) {
    const w = COUNT[i];
    ear.dodge = now() + VOICE.dodge;
    const buf = clips.buf.get(w);
    if (buf && ear.ctx) {
      try {
        stopCount();
        if (!clips.gain) {
          clips.gain = ear.ctx.createGain();
          clips.gain.gain.value = VOICE.gain;
          clips.gain.connect(ear.ctx.destination);
        }
        const src = ear.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(clips.gain);
        src.start();
        clips.src = src;
        return;
      } catch { /* the phone's own voice, below */ }
    }
    if (typeof speakThen === 'function') { try { speakThen(w, () => {}, 'en-US'); } catch { /* silent count */ } }
  }
  function closeEar() {
    clearInterval(ear.timer);
    ear.timer = 0;
    ear.on = null;
    try { if (ear.src) ear.src.disconnect(); } catch { /* gone */ }
    ear.src = ear.an = ear.buf = null;
    if (ear.stream) { ear.stream.getTracks().forEach(tr => tr.stop()); ear.stream = null; }
  }

  /* Otto's voice, when app.js is there to lend it; a silent beat with
   * the callback otherwise, so the game runs the same. The ear is shut
   * while he talks. */
  function say(text, done) {
    let called = false;
    const cb = () => {
      if (called) return;
      called = true;
      setTimeout(() => { ear.mute = false; }, 150);
      if (done) done();
    };
    ear.mute = true;
    if (typeof speakOtto === 'function') {
      try { speakOtto(text, cb, null, 'en-US'); setTimeout(cb, 12000); return; } catch { /* fall through */ }
    }
    setTimeout(cb, 600);
  }

  const hintFor = g => (g.mic === false ? 'TAP TO STOP · ' : 'SAY STOP · ') + STEP[g.phase];
  const listeningSub = g => (g.mic === false ? 'tap to stop' : 'say stop');

  /* ---------- Otto on the screen ----------
   * The voice throw shows nothing but Otto — his face, as on the report
   * call — and the words: his lines, each stop as the driver's line.
   * Never the numbers: the driver is not looking. The last few lines
   * stay up. */
  function bubble(who, text) {
    const b = document.createElement('div');
    b.className = 'vn-bubble vn-bubble-' + who;
    const w = document.createElement('span');
    w.className = 'vn-who';
    w.textContent = who === 'ai' ? 'OTTO' : 'YOU';
    const t = document.createElement('div');
    t.className = 'vn-text';
    t.textContent = text;
    b.append(w, t);
    ui.chat.appendChild(b);
    while (ui.chat.children.length > 4) ui.chat.removeChild(ui.chat.firstChild);
    ui.chat.scrollTop = ui.chat.scrollHeight;
    return t;
  }
  function caption(cap, sub, listening) {
    ui.caption.textContent = cap;
    ui.sub.textContent = sub || '';
    ui.rings.forEach(ring => { ring.hidden = !listening; }); // the rings say "the line is open", as on the call
  }

  function voiceThrow() {
    if (!state || state.thrown || state.voice) return;
    state.longCues = plays() < EXPLAIN;
    try { localStorage.setItem(LS_PLAYS, String(plays() + 1)); } catch { /* private mode */ }
    const g = { phase: 'x', counting: false, step: 0, stepAt: 0, trail: [], raf: 0, mic: null, stops: 0, x: 0, y: 0 };
    state.voice = g;
    ui.hint.textContent = hintFor(g);
    ui.hint.hidden = false;
    prefetchCounts();
    openEar(t => voiceStop(t, 'voice')).then(ok => {
      if (!state || state.voice !== g) return;
      g.mic = ok;
      if (g.phase !== 'done') ui.hint.textContent = hintFor(g);
      if (g.counting) caption('Listening…', listeningSub(g), true);
    });
    bubble('ai', cue('x'));
    caption('Otto is talking', '', false);
    say(cue('x'), () => startCount(g));
    g.raf = requestAnimationFrame(voiceFrame);
  }
  /* a phase's count: one to five, every beat, once — a stop takes the
   * number heard, the end of the count takes five */
  function startCount(g) {
    if (!state || state.voice !== g || g.phase === 'done' || g.counting) return;
    g.counting = true;
    g.started = false; // "one" comes after a breath
    g.step = 0;
    g.stepAt = now() + VOICE.lead;
    g.trail = [];
    caption('Listening…', listeningSub(g), true);
    ui.hint.textContent = hintFor(g);
  }
  function voiceFrame() {
    const g = state && state.voice;
    if (!g || g.phase === 'done') return;
    const t = now();
    const beat = state.pace || VOICE.beat;
    if (g.counting && !g.started && t >= g.stepAt) { g.started = true; playCount(0); }
    if (g.counting && g.started) {
      if (t - g.stepAt >= beat) {
        if (g.step >= COUNT.length - 1) {
          /* the end of the count: five it is — and the loop lives on,
           * the next count needs it */
          voiceStop(t + VOICE.countLag, 'auto');
          if (g.phase === 'done') return;
        } else {
          g.step++;
          g.stepAt += beat;
          playCount(g.step);
        }
      }
      if (g.counting) {
        g.trail.push({ t, v: stepValue(g.phase, g.step) });
        while (g.trail.length && t - g.trail[0].t > 1500) g.trail.shift();
      }
    }
    g.raf = requestAnimationFrame(voiceFrame);
  }
  const valueAt = (g, at) => {
    let hit = g.trail[0];
    for (const p of g.trail) { if (p.t <= at) hit = p; else break; }
    return hit ? hit.v : stepValue(g.phase, 0);
  };
  function voiceStop(t, how) {
    const g = state && state.voice;
    if (!g || g.phase === 'done' || !g.counting || !g.started) return; // no number yet: Otto is still saying what this step is
    const v = valueAt(g, t - VOICE.countLag);
    try { if (navigator.vibrate) navigator.vibrate(20); } catch { /* optional */ }
    g.counting = false;
    stopCount();
    if (how !== 'auto') { g.stops++; bubble('me', how === 'tap' ? '(tap)' : '\u201cstop\u201d'); }
    if (g.phase === 'x') {
      g.x = -VOICE.span + v * 2 * VOICE.span; // left … right
      g.phase = 'y';
      ui.hint.textContent = hintFor(g);
      bubble('ai', cue('y'));
      caption('Otto is talking', '', false);
      say(cue('y'), () => startCount(g));
    } else if (g.phase === 'y') {
      g.y = -VOICE.span + v * 2 * VOICE.span; // top … bottom
      g.phase = 'p';
      ui.hint.textContent = hintFor(g);
      bubble('ai', cue('p'));
      caption('Otto is talking', '', false);
      say(cue('p'), () => startCount(g));
    } else {
      g.phase = 'done';
      cancelAnimationFrame(g.raf);
      closeEar();
      if (!g.stops) {
        /* every count ran to its end: nobody was playing — no throw,
         * and nothing spent */
        bubble('ai', CUES.none);
        caption('No throw', '', false);
        say(CUES.none, () => later(VOICE.settle, hide));
        later(VOICE.cap, hide);
        return;
      }
      const [lo, hi] = VOICE.sweet;
      const short = v < lo ? (lo - v) / lo : v > hi ? -(v - hi) / (1 - hi) : 0;
      flyTo(g.x, g.y + short * VOICE.drift, v);
    }
  }
  /* the third stop: the dart leaves the hand for the aimed spot, high
   * or low by what the strength said */
  function flyTo(bx, by, strength) {
    state.thrown = true;
    state.timers.forEach(clearTimeout);
    state.timers = [];
    state.speed = strength == null ? null : Math.round(strength * 100) / 100;
    ui.hint.hidden = true;
    const card = ui.card.getBoundingClientRect();
    const board = ui.board.getBoundingClientRect();
    const L = { x: ui.dart.offsetLeft + ui.dart.offsetWidth / 2, y: ui.dart.offsetTop };
    const C = { x: board.left + board.width / 2 - card.left, y: board.top + board.height / 2 - card.top };
    const R = board.width / 2 * (100 / 110);
    const P = { x: C.x + bx / 100 * R, y: C.y + by / 100 * R };
    const ring = RINGS.find(g => Math.hypot(bx, by) <= g.r) || MISS;
    const to = { x: clamp(P.x, 12, card.width - 12), y: clamp(P.y, 12, card.height - 24) };
    const angle = Math.atan2(to.x - L.x, L.y - to.y) * 180 / Math.PI * 0.35; // a lean towards where it goes
    ui.dart.classList.add('dt-flying');
    ui.dart.style.transition = `transform ${T.flight}ms cubic-bezier(.1, .7, .3, 1)`;
    ui.dart.style.transform = `translate(${(to.x - L.x).toFixed(1)}px, ${(to.y - L.y).toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`;
    later(T.flight, () => land(ring, bx, by));
  }
  /* what Otto says once the dart is in: the score, its word, and the
   * driver's place on today's board */
  /* where the dart went, for a driver who cannot see it: high or low,
   * left or right of the middle — how the next throw gets closer */
  function whereTo(ring, bx, by) {
    const parts = [];
    if (by <= -15) parts.push('high'); else if (by >= 15) parts.push('low');
    if (bx <= -15) parts.push('to the left'); else if (bx >= 15) parts.push('to the right');
    if (!parts.length) return '';
    return (ring.pts ? ' A little ' : ' It went ') + parts.join(' and ') + '.';
  }
  function announce(ring, board, bx, by) {
    const rank = board.findIndex(r => r.me) + 1;
    const head = (ring.pts ? ring.pts + '. ' : 'Miss. ') + ring.word + whereTo(ring, bx, by);
    if (!state.counted) return head + CUES.practice;
    const place = rank === 1 ? ' Top of the board today!'
      : rank === 2 ? ` Second today, behind ${board[0].player}.`
      : rank === 3 ? ' Third today.'
      : ` Number ${rank} today.`;
    return head + place;
  }

  function reset() {
    closeEar();
    stopCount();
    ear.mute = false;
    if (state && state.voice) { cancelAnimationFrame(state.voice.raf); state.voice.phase = 'done'; }
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
    /* by voice there is only Otto on the screen; by thumb, the board */
    r.classList.toggle('dt-by-voice', !!ctx.byVoice);
    ui.chat.innerHTML = '';
    caption('', '', false);
    state = { ...ctx, thrown: false, timers: [] };
    r.hidden = false;
    void r.offsetHeight; // the slide needs a frame in the hidden position first
    r.classList.add('dt-in');
    const leaveIfIdle = () => {
      if (!state || state.thrown) return;
      /* never yank a dart out of a hand, nor a count past its first step */
      if (drag || (state.voice && state.voice.phase !== 'y')) { later(5000, leaveIfIdle); return; }
      hide();
    };
    later(T.wait, leaveIfIdle);
    if (ctx.byVoice) later(T.slide + 60, voiceThrow);
    return true;
  }

  function hide() {
    const r = root();
    const s = state;
    if (!s || s.hiding) return;
    s.hiding = true;
    s.timers.forEach(clearTimeout);
    s.timers = [];
    closeEar();
    stopCount();
    if (s.voice) { cancelAnimationFrame(s.voice.raf); s.voice.phase = 'done'; }
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
    lastFlick = { speed: state.speed, pts: ring.pts, voice: !!state.voice };
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
    const board = boardOf(state.rows, { player, score: ring.pts });
    renderBoard(board, player !== 'someone');
    ui.best.hidden = true; // the board says it now, in full
    ui.score.hidden = false;
    if (state.counted) save(ring, bx, by, player);
    if (state.voice) {
      /* Otto announces it — on the screen too — and the card leaves once he is done */
      const line = announce(ring, board, bx, by);
      bubble('ai', line);
      caption('Thrown', ring.word, false);
      say(line, () => later(VOICE.settle, hide));
      later(VOICE.cap, hide);
    } else {
      later(T.score, hide);
    }
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
    async offer({ stop, visit, player, voice, pace }) {
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
      whenStill(() => { if (g === gen) show({ stop, visit, player, rows: leaders || [], counted: true, byVoice: !!voice, pace: +pace || 0 }); });
      return true;
    },
    /* a throw that is neither saved nor remembered — the settings sheet's
     * "try it", so a driver sees the game before a report earns one */
    async practice({ player, voice, pace } = {}) {
      if (!root()) return false;
      cancelPending();
      const g = ++gen;
      const leaders = await boxed(leadersToday());
      if (g !== gen) return false;
      return show({ stop: null, visit: null, player, rows: leaders || [], counted: false, byVoice: !!voice, pace: +pace || 0 });
    },
    dismiss() { gen++; cancelPending(); hide(); },
    /* a stop from outside — a hardware button, a wrapper, a test */
    stop() { if (state && state.voice) voiceStop(now(), 'voice'); },
    /* the rules, in Otto's voice — the settings sheet's "hear the rules" */
    explain() { say(RULES); },
    get rules() { return RULES; },
    setTip(text) {
      tip = String(text || '').trim();
      if (ui) { ui.tipText.textContent = tip || '…'; ui.tip.classList.toggle('dt-tip-empty', !tip); }
    },
    get showing() { return !!state; },
    /* what the phone has learned about its thumb — the mic self-test
     * prints it, so a "the flick does nothing" report comes with numbers */
    stats() {
      const f = flicks();
      return {
        flicks: f.length, sweet: Math.round(sweetSpeed() * 100) / 100, last: lastFlick,
        mic: ear.ok === null ? null : ear.ok ? 'ok' : 'refused',
        count: state && state.voice && state.voice.counting ? { phase: state.voice.phase, step: state.voice.step + 1 } : null, counts: clips.buf.size,
        level: ear.timer ? Math.round((ear.level || 0) * 1000) / 1000 : null, threshold: ear.timer ? Math.round((ear.thr || 0) * 1000) / 1000 : null,
      };
    },
  };
})();
