'use strict';

/* ============================================================
 * Destination debrief — the app glue.
 *
 * Composes the two extracted kits WITHOUT modifying them:
 *   geolocate.js + field-map.js  (field-map-kit)   position + live map
 *   voice-note.js                (voice-notes-kit) the Otto debrief
 *   otto-agent.js                                  the same debrief as a
 *     live ElevenLabs conversation when an agent is configured; it wears
 *     the kit's mount seams, so openOtto picks one or the other and
 *     nothing else here has to know which.
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
const LS_RUNS = 'od_runs';

let destinations = [];
const messagesByDest = {};
const reportedIds = new Set();
let current = null; // destination in the open card / Otto session

/* Trigger scenarios (defined on dashboard.html) — read-only here. A
 * destination that belongs to a scenario carries the test steps on its
 * card, and Otto opens the debrief with the scenario's own question. */
let scenarios = [];
let scenarioByDest = {};
let routeScenario = null; // the route's own scenario (pinned at one stop by the loader)
const rebuildScenarioIndex = () => {
  scenarioByDest = {};
  scenarios.forEach(s => { if (s.destination_id) scenarioByDest[s.destination_id] = s; });
  /* its reading-ring params (notes_radius / notes_rearm) drive EVERY
   * stop of the route, not just the stop it happens to be pinned at */
  routeScenario = scenarios.find(s => {
    const d = s.destination_id && destinations.find(x => x.id === s.destination_id);
    return d && d.route;
  }) || null;
};
const scenarioOf = d => (d && scenarioByDest[d.id]) || null;
const stripQuotes = s => String(s || '').trim().replace(/^[“”"']+/, '').replace(/[“”"']+$/, '');
const scenarioShort = sc => String(sc.title || '').split(/\s+—\s+|\s+-\s+/)[0].trim();
/* "#3 · " — the sheet row's number. The dashboard leads with it on its
 * pins and list rows; pin labels and card titles here lead with the
 * same one, so "test #3" is findable on the phone without opening
 * every card. */
const scenarioNumPrefix = d => {
  const sc = scenarioOf(d);
  return sc && sc.num != null && sc.num !== '' ? '#' + sc.num + ' · ' : '';
};
/* sheet cells and notes rarely end in a full stop; text that gets
 * spoken or stitched into a briefing needs one, or two sentences read
 * as one confused one */
const sentence = s => { const t = String(s || '').trim(); return /[.!?…]$/.test(t) ? t : t + '.'; };

/* ---------- debrief language (🇬🇧 EN / 🇮🇹 IT) ----------
 * Picked on the scenario card before a run, sticky per phone. It steers
 * the whole debrief: the ElevenLabs conversation gets a language
 * override (Otto listens AND answers in Italian — the language must be
 * enabled on the agent and its security settings must allow the
 * override), the scenario's "Otto says" line is translated once via
 * scenario-ai and cached, and the keyless fallback speaks the question
 * with a matching voice. English is the untouched original behavior:
 * no override sent, the agent in its own default language. */
const LS_LANG = 'od_lang';
const LS_SAYS_IT = 'od_says_it';
let testLang = 'en';
try { if (localStorage.getItem(LS_LANG) === 'it') testLang = 'it'; } catch { /* private mode */ }
/* the app's own spoken lines, in both languages — scenario text comes
 * from the sheet and goes through the translator instead */
const LANG_TEXT = {
  en: {
    ask: 'What did you find?',
    plain: 'Tap the mic and tell me what you found.',
    at: d => `This is ${d.title}${d.addr ? ' — ' + d.addr : ''}. What's the situation there? Tap the mic and describe what you see.`,
  },
  it: {
    ask: 'Cosa hai trovato?',
    plain: 'Tocca il microfono e dimmi cosa hai trovato.',
    at: d => `Questa è ${d.title}${d.addr ? ' — ' + d.addr : ''}. Com'è la situazione lì? Tocca il microfono e descrivi cosa vedi.`,
  },
};
/* "Otto says" in Italian, one scenario-ai call per line, cached forever
 * (keyed by the English text, so an edited question re-translates). */
let saysItCache = {};
try { saysItCache = JSON.parse(localStorage.getItem(LS_SAYS_IT)) || {}; } catch { saysItCache = {}; }
let translateDown = false; // one failed call = the function is missing/old; stop asking this session
function prefetchSaysIt(sc) {
  if (testLang !== 'it' || !sc || !sc.otto_says || !Backend.enabled || translateDown) return;
  const src = stripQuotes(sc.otto_says);
  if (!src || saysItCache[src]) return;
  Backend.scenarioAI({ op: 'translate', text: src, to: 'it' }).then(d => {
    const t = d && String(d.text || '').trim();
    if (!t) return;
    saysItCache[src] = t;
    try { localStorage.setItem(LS_SAYS_IT, JSON.stringify(saysItCache)); } catch { /* full */ }
  }).catch(e => {
    translateDown = true;
    console.warn('scenario-ai translate unavailable — the opening question stays English:', e.message || e);
  });
}
/* The question as it should be SPOKEN right now, with the voice that
 * matches it: the cached Italian when the tester picked 🇮🇹 and the
 * translation has landed, the English original otherwise — an English
 * line read by an Italian voice helps nobody. */
function questionFor(sc) {
  if (sc && sc.otto_says) {
    const src = stripQuotes(sc.otto_says);
    const it = testLang === 'it' ? saysItCache[src] : null;
    return { text: resolveSays(it || src), lang: it ? 'it-IT' : 'en-US' };
  }
  return { text: LANG_TEXT[testLang].ask, lang: testLang === 'it' ? 'it-IT' : 'en-US' };
}

/* A scenario rule can carry its tunable numbers as {key} placeholders;
 * the dashboard's sliders edit them (sc.params). Resolve them for
 * display here — and feed the same numbers into the trigger detector
 * (trigOf below), so a slider moved on the dashboard retunes the very
 * next test run on this phone. */
const fmtParamVal = v => String(Math.abs(+v) >= 100 ? Math.round(+v) : Math.round(+v * 100) / 100);
const fillParams = (text, params) =>
  String(text == null ? '' : text).replace(/\{([a-z][a-z0-9_]*)\}/gi, (m, k) => {
    const p = Array.isArray(params) ? params.find(x => x && x.key === k) : null;
    return p && isFinite(+p.value) ? fmtParamVal(p.value) : m;
  });

/* ---------- test tracking: activity recognition + the trigger ----------
 * "Start test tracking" on a scenario card arms ActivityRec (states in
 * Google AR vocabulary — see activity-rec.js for what feeds them) and a
 * detector for the deck's sample rule: slow passes near the pin without
 * stopping, then the stop, then back in the vehicle -> Otto speaks up.
 * The numbers mirror the sheet ("radius and count are drafts to tune")
 * — and tune them the dashboard does: a scenario's params override any
 * of these per test run (trigOf below), so the sliders there are live
 * detector knobs here. */
const TRIG = {
  radius: 150,        // m — a pass is being inside this circle around the pin
  exitRadius: 190,    // m — hysteresis: the pass counts once you are back out
  passSpeedMax: 9,    // m/s — faster than this inside is through-traffic, not a loop
  passStillMax: 25e3, // ms — standing longer than this inside makes it a stop, not a pass
  passesNeeded: 2,    // deck says 2–3 slow loops
  stopSpeed: 0.6,     // m/s — below this you are standing
  stopDwellMs: 45e3,  // ms — CUMULATIVE standing time near the pin that makes THE stop
  stillGraceMs: 30e3, // ms — a shorter interruption pauses the dwell clock, a longer one resets it
  stopRadius: 250,    // m — where that stop may happen
  resumeSpeed: 3,     // m/s — moving again afterwards = back in the car -> fire
  /* park-and-walk shape (selected by an arrival_radius param): park the
   * vehicle near the pin, walk the rest, fire on arrival — measuring
   * parking position vs walking distance */
  parkRadiusMax: 400, // m — a vehicle stop this close to the pin counts as parking for it
  parkStopMs: 30e3,   // ms — vehicle standing this long = parked (fallback when the AR flip lags)
  arrivalRadius: 25,  // m — on foot this close to the pin = arrived
  minWalkM: 50,       // m — a shorter walk is not worth a question
};
/* dashboard param key -> [TRIG field, factor] (dashboard stores seconds,
 * the detector runs on milliseconds) */
const TRIG_PARAM_KEYS = {
  radius: ['radius', 1],
  exit_radius: ['exitRadius', 1],
  pass_speed_max: ['passSpeedMax', 1],
  pass_still_max_s: ['passStillMax', 1000],
  passes_needed: ['passesNeeded', 1],
  stop_speed: ['stopSpeed', 1],
  stop_dwell_s: ['stopDwellMs', 1000],
  still_grace_s: ['stillGraceMs', 1000],
  stop_radius: ['stopRadius', 1],
  resume_speed: ['resumeSpeed', 1],
  park_radius_max: ['parkRadiusMax', 1],
  park_stop_s: ['parkStopMs', 1000],
  arrival_radius: ['arrivalRadius', 1],
  min_walk_m: ['minWalkM', 1],
};
/* Which detector shape a scenario runs: an arrival_radius param selects
 * park-and-walk; everything else keeps the pass→stop→resume pipeline. */
const scenarioShape = sc =>
  ((sc && Array.isArray(sc.params) && sc.params.some(p => p && p.key === 'arrival_radius')) ? 'parkwalk' : 'passstop');
function trigOf(sc) {
  const t = { ...TRIG };
  (sc && Array.isArray(sc.params) ? sc.params : []).forEach(p => {
    const spec = p && TRIG_PARAM_KEYS[p.key];
    const v = p && parseFloat(p.value);
    if (spec && isFinite(v)) t[spec[0]] = p.key === 'passes_needed' ? Math.max(0, Math.round(v)) : v * spec[1];
  });
  if (t.exitRadius <= t.radius) t.exitRadius = Math.round(t.radius * 1.25); // hysteresis must stay outside the pass circle
  return t;
}
let tracking = null;  // { sc, d, trig, startedAt, passes, ... } while a test runs
let lastRun = null;   // the just-logged run, awaiting the tester's verdict (askRunVerdict)
let wakeLock = null;

/* ---------- the raw fix stream ----------
 * The run log's ar_trace says what the detector CONCLUDED; replaying a
 * run offline (scripts/tune_triggers.py) needs what it SAW. Sample the
 * per-fix signal at 1 Hz into a packed array; when the buffer fills,
 * drop every other sample and halve the rate — a long run keeps full
 * coverage at coarser resolution, and the row stays small enough for
 * the keepalive fetch that flushes abandoned runs (~64 KB budget). */
const FIX_CAP = 900;
const FIX_STATES = ['UNKNOWN', 'STILL', 'ON_FOOT', 'IN_VEHICLE'];
function recordFix(tr, snap) {
  const t = snap.t || Date.now();
  if (t - (tr.lastSampleAt || 0) < tr.fixEveryMs) return;
  tr.lastSampleAt = t;
  tr.fixes.push([
    Math.round((t - tr.startedAt) / 100) / 10,   // seconds since the run started
    Math.round(snap.position.lat * 1e5) / 1e5,   // ~1 m
    Math.round(snap.position.lng * 1e5) / 1e5,
    Math.round(snap.speed * 10) / 10,            // m/s
    Math.max(0, FIX_STATES.indexOf(snap.state)),
    snap.cadence ? 1 : 0,
  ]);
  if (tr.fixes.length >= FIX_CAP) {
    tr.fixes = tr.fixes.filter((_, i) => i % 2 === 0);
    tr.fixEveryMs *= 2;
  }
}

async function acquireWakeLock() {
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (tracking && document.visibilityState === 'visible') acquireWakeLock();
});

function startTracking(sc, d) {
  ActivityRec.requestMotionPermission(); // needs the tap gesture on iOS
  /* prime browser TTS inside this tap — Chrome refuses speak() from a
   * page that never spoke during a user gesture, and the trigger fires
   * minutes after the last tap (the wrapper's OttoTTS needs no priming) */
  try {
    if (!window.OttoTTS && 'speechSynthesis' in window) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }
  } catch { /* optional */ }
  /* same problem, louder, for the ElevenLabs agent: it needs an audio
   * context that was born in a gesture AND a microphone that was already
   * said yes to. Ask now, on the pavement, not when the trigger fires in
   * traffic — a permission dialog nobody sees is a debrief lost. */
  OttoAgent.prime();
  /* same idea for a 🇮🇹 run: fetch the translated question NOW, on the
   * pavement — by the time the trigger fires it reads from the cache */
  prefetchSaysIt(sc);
  ActivityRec.start();
  lastRun = null; // a new run makes the old verdict question stale
  el('verdict-banner').hidden = true;
  tracking = {
    sc, d, trig: trigOf(sc), shape: scenarioShape(sc), startedAt: Date.now(),
    passes: 0, inside: false, insideMaxStill: 0, insideSpeedSum: 0, insideN: 0,
    dwellMs: 0, contStillStart: null, stillBreakStart: null, prevT: null,
    stopped: false, resumeN: 0, fired: false, firedAt: null,
    /* park-and-walk shape */
    sawVehicle: false, lastVehicleFix: null, vehicleStillSince: null,
    parkedAt: null, walkM: 0, lastWalkFix: null,
    /* raw fix stream (recordFix) */
    fixes: [], fixEveryMs: 1000, lastSampleAt: 0,
  };
  acquireWakeLock();
  updateArChip(ActivityRec.snapshot);
  updateCardTrack();
}

/* Every tracked run goes on the record when it ends — FIRED OR NOT. A
 * silent run used to leave no data, and those are exactly the runs
 * debugging a trigger needs: which stage (pass / stop / resume) it died
 * at, under which knob values. Shown on the dashboard as the run log. */
function saveRunLog() {
  const tr = tracking;
  if (!tr) return;
  const now = Date.now();
  if (now - tr.startedAt < 20000 && !tr.passes && !tr.fired) return; // an accidental tap is not a test run
  /* This may now be called more than once per run (mid-run flush on
   * pagehide, then the proper stop) — log only when the picture changed,
   * so a flush-then-stop doesn't count one walk as two runs. */
  const sig = [tr.fixN || 0, tr.passes, !!tr.stopped, !!tr.fired].join('|');
  if (tr.loggedSig === sig) return;
  tr.loggedSig = sig;
  lastRun = { fired: !!tr.fired, id: null, saved: null, local: !Backend.enabled, answered: false };
  const row = {
    scenario_id: tr.sc.id,
    scenario_version: tr.sc.version || 1,
    destination_id: tr.d.id,
    started_at: new Date(tr.startedAt).toISOString(),
    ended_at: new Date(now).toISOString(),
    fired: !!tr.fired,
    fired_at: tr.firedAt ? new Date(tr.firedAt).toISOString() : null,
    passes: tr.passes,
    stop_seen: !!tr.stopped,
    ar_summary: ActivityRec.summary(tr.startedAt) || null,
    ar_trace: {
      source: ActivityRec.snapshot.source,
      segments: ActivityRec.segments(tr.startedAt),
      /* was the raw signal even there? 0 fixes = GPS never delivered
       * speed (permissions / screen off), not a detector failure */
      gps: { fixes: tr.fixN || 0, max_speed_mps: Math.round((tr.maxSp || 0) * 10) / 10 },
      ...(tr.shape === 'parkwalk' ? {
        parkwalk: {
          parked_at: tr.parkedAt ? { lat: tr.parkedAt.lat, lng: tr.parkedAt.lng } : null,
          park_distance_m: tr.parkedAt ? Math.round(distM(tr.parkedAt, tr.d)) : null,
          walk_m: Math.round(tr.walkM),
        },
      } : {}),
    },
    tuning: {
      shape: tr.shape,
      radius: tr.trig.radius,
      exit_radius: tr.trig.exitRadius,
      pass_speed_max: tr.trig.passSpeedMax,
      pass_still_max_s: tr.trig.passStillMax / 1000,
      passes_needed: tr.trig.passesNeeded,
      stop_speed: tr.trig.stopSpeed,
      stop_dwell_s: tr.trig.stopDwellMs / 1000,
      still_grace_s: tr.trig.stillGraceMs / 1000,
      stop_radius: tr.trig.stopRadius,
      resume_speed: tr.trig.resumeSpeed,
      /* the park-and-walk knobs were missing here — a parkwalk run whose
       * tuning only listed the pass/stop values could not be replayed */
      ...(tr.shape === 'parkwalk' ? {
        park_radius_max: tr.trig.parkRadiusMax,
        park_stop_s: tr.trig.parkStopMs / 1000,
        arrival_radius: tr.trig.arrivalRadius,
        min_walk_m: tr.trig.minWalkM,
      } : {}),
    },
    fixes: tr.fixes && tr.fixes.length ? {
      v: 1,
      cols: ['t_s', 'lat', 'lng', 'speed_mps', 'state', 'stepping'],
      states: FIX_STATES,
      sample_s: tr.fixEveryMs / 1000,
      rows: tr.fixes,
    } : null,
  };
  if (Backend.enabled) {
    const lr = lastRun;
    lr.saved = Backend.insertRun(row)
      .then(rows => { lr.id = rows && rows[0] && rows[0].id; })
      .catch(e => console.warn('run log not saved — re-run schema.sql?', e.message));
  } else {
    try {
      const runs = JSON.parse(localStorage.getItem(LS_RUNS) || '[]');
      lastRun.id = 'r' + Date.now().toString(36);
      runs.unshift({ ...row, id: lastRun.id, created_at: row.ended_at });
      const keep = runs.slice(0, 50); // enough history, bounded storage
      try {
        localStorage.setItem(LS_RUNS, JSON.stringify(keep));
      } catch {
        /* quota: the fix streams are the bulk — keep them on recent runs only */
        localStorage.setItem(LS_RUNS, JSON.stringify(keep.map((r, i) => i < 10 ? r : { ...r, fixes: null })));
      }
    } catch { /* private mode */ }
  }
}

/* A run that ended by the app being closed or the phone locking used to
 * evaporate — and an abandoned run is exactly the kind the log exists
 * for. Flush it while the page can still speak (the insert rides a
 * keepalive fetch, so the row outlives the tab); if the tester comes
 * back and finishes properly, the changed-picture guard in saveRunLog
 * keeps the walk from counting as two runs. */
window.addEventListener('pagehide', () => { if (tracking) saveRunLog(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && tracking) saveRunLog();
});

function stopTracking() {
  saveRunLog(); // before ActivityRec.stop() — the summary reads the live history
  ActivityRec.stop();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  tracking = null;
  el('trigger-banner').hidden = true;
  updateArChip(ActivityRec.snapshot);
  updateCardTrack();
  askRunVerdict();
}

/* ---------- the verdict bar ----------
 * "Should Otto have spoken — and WHEN?" is the ground truth every
 * knob-tuning and every learned trigger needs, and the only person who
 * knows is the tester, in the seconds after the run, before the memory
 * fades. So ask RIGHT THERE, one tap, the moment tracking stops. A run
 * where Otto spoke gets the full timing question (right timing / too
 * early / too late / false alarm); a silent run only gets right call /
 * should have spoken — timing without a fire is not a thing. The
 * verdict lands on the run row (runs.verdict + the derived
 * runs.should_fire) and the offline tuner reads both: should_fire as
 * its labels, early/late as which direction to move the fire. Skipping
 * is fine — an unanswered run is null, not a guess. */
function askRunVerdict() {
  if (!lastRun || lastRun.answered) return;
  const fired = lastRun.fired;
  el('vb-text').textContent = fired
    ? 'Otto spoke on this run — how was his timing?'
    : 'Otto stayed quiet the whole run. Right call?';
  el('vb-right').textContent = fired ? '✓ Right timing' : '✓ Right call';
  el('vb-wrong').textContent = fired ? '✗ False alarm' : '✗ Should have spoken';
  el('vb-early').hidden = !fired;
  el('vb-late').hidden = !fired;
  el('notes-banner').hidden = true; // same slot — the verdict question wins it
  el('verdict-banner').hidden = false;
}

function answerRunVerdict(kind) {
  const lr = lastRun;
  el('verdict-banner').hidden = true;
  if (!lr || lr.answered) return;
  lr.answered = true;
  /* early and late still mean "a debrief was warranted" — the fire was
   * right, the moment was wrong */
  const should = kind === 'on_time' || kind === 'early' || kind === 'late' || kind === 'missed';
  if (navigator.vibrate) navigator.vibrate(30); // "got it" — felt, not shown
  if (lr.local) {
    try {
      const runs = JSON.parse(localStorage.getItem(LS_RUNS) || '[]');
      const r = runs.find(x => x.id === lr.id);
      if (r) {
        r.should_fire = should;
        r.verdict = kind;
        localStorage.setItem(LS_RUNS, JSON.stringify(runs));
      }
    } catch { /* private mode */ }
  } else {
    /* the insert may still be in flight — chain, don't race it */
    Promise.resolve(lr.saved).then(() => {
      if (lr.id) Backend.updateRun(lr.id, { should_fire: should, verdict: kind })
        .catch(e => console.warn('verdict not saved — re-run schema.sql?', e.message));
    });
  }
}

/* ---------- park-and-walk detector ----------
 * Measures the relationship a single stop cannot: where the vehicle was
 * left vs how far the tester walked to the pin. The IN_VEHICLE→on-foot
 * flip (near-instant since the native AR engine) marks the parking
 * spot; a sustained vehicle standstill is the fallback for a lagging
 * flip. The on-foot leg accumulates until arrival at the pin — and only
 * then does Otto speak, because only then is the walking distance a
 * fact he can quote ({park_m}/{walk_m} in the scenario's question). */
function parkWalkStep(snap) {
  const tr = tracking;
  const cfg = tr.trig;
  const t = snap.t || Date.now();
  const sp = snap.speed;
  const pos = snap.position;
  const dPin = distM(pos, tr.d);
  const inVehicle = snap.state === 'IN_VEHICLE' || sp >= 4;

  if (inVehicle) {
    tr.sawVehicle = true;
    tr.lastVehicleFix = { lat: pos.lat, lng: pos.lng, t };
    /* rolling again after a "park" with no real walk = that was traffic
     * (a light, a queue), not parking */
    if (tr.parkedAt && !tr.fired && tr.walkM < 20) {
      tr.parkedAt = null;
      tr.walkM = 0;
      tr.lastWalkFix = null;
    }
    /* fallback park: the vehicle standing long enough inside the park
     * ring, even before any on-foot flip is seen */
    if (!tr.parkedAt && sp <= cfg.stopSpeed && dPin <= cfg.parkRadiusMax && dPin > cfg.arrivalRadius) {
      if (!tr.vehicleStillSince) tr.vehicleStillSince = t;
      if (t - tr.vehicleStillSince >= cfg.parkStopMs) {
        tr.parkedAt = { lat: pos.lat, lng: pos.lng, t };
        updateCardTrack();
      }
    } else if (sp > cfg.stopSpeed) {
      tr.vehicleStillSince = null;
    }
    updateCardTrack();
    return;
  }

  /* on foot (or at least: no longer a vehicle) */
  if (!tr.parkedAt && tr.sawVehicle) {
    const at = tr.lastVehicleFix || { lat: pos.lat, lng: pos.lng, t };
    const dPark = distM(at, tr.d);
    if (dPark <= cfg.parkRadiusMax && dPark > cfg.arrivalRadius) {
      tr.parkedAt = { lat: at.lat, lng: at.lng, t };
      tr.walkM = 0;
      tr.lastWalkFix = null;
      updateCardTrack();
    }
  }
  if (!tr.parkedAt || tr.fired) return;

  /* accumulate the walked path, GPS jumps filtered out */
  if (tr.lastWalkFix) {
    const seg = distM(tr.lastWalkFix, pos);
    if (seg > 1 && seg < 60) tr.walkM += seg;
  }
  tr.lastWalkFix = { lat: pos.lat, lng: pos.lng };
  updateCardTrack();

  /* arrival: at the pin, on foot, having genuinely walked */
  const walked = Math.max(tr.walkM, distM(tr.parkedAt, pos));
  if (dPin <= cfg.arrivalRadius && walked >= cfg.minWalkM) fireTrigger(t);
}

function detectorStep(snap) {
  /* evidence counters, before any shape logic: when a run comes back
   * with 0 fixes or a max speed of 0, the diagnosis is GPS, not the
   * detector — the distinction a stuck-on-UNKNOWN chip cannot make */
  tracking.fixN = (tracking.fixN || 0) + 1;
  tracking.maxSp = Math.max(tracking.maxSp || 0, snap.speed);
  recordFix(tracking, snap);
  if (tracking.shape === 'parkwalk') { parkWalkStep(snap); return; }
  const tr = tracking;
  const cfg = tr.trig; // the scenario's tuned values (TRIG defaults otherwise)
  const t = snap.t || Date.now();
  const sp = snap.speed;
  const dist = distM(snap.position, tr.d);

  /* the stop: CUMULATIVE stillness near the pin, after the loops.
   * Continuous dwell dies indoors: GPS noise breaks a standing streak
   * every couple of minutes, so a 5-minute rule could physically never
   * commit (run log 2026-08-17 — 50 min inside, longest unbroken STILL
   * ~2 min). Brief noise now PAUSES the dwell clock; only a sustained
   * interruption (stillGraceMs — genuine walking off, driving away)
   * starts the count over. The pass classifier below keeps judging by
   * the longest UNBROKEN still, so a stop-and-go queue still reads as
   * a pass, not a stop. */
  const still = sp <= cfg.stopSpeed && dist <= cfg.stopRadius;
  const dt = tr.prevT != null ? Math.max(0, Math.min(t - tr.prevT, 15000)) : 0;
  tr.prevT = t;
  if (still) {
    tr.dwellMs += dt;
    tr.stillBreakStart = null;
    if (!tr.contStillStart) tr.contStillStart = t;
    if (tr.inside) tr.insideMaxStill = Math.max(tr.insideMaxStill, t - tr.contStillStart);
    if (!tr.stopped && tr.passes >= cfg.passesNeeded && tr.dwellMs >= cfg.stopDwellMs) {
      tr.stopped = true;
      updateCardTrack();
      /* A resume gate at or below the standing gate is no gate at all —
       * fire AT the stop. Walking debriefs want this: the smoothed speed
       * of someone standing still never reaches even 0.5 m/s (run log
       * 2026-08-06 12:53 proved it), so "wait for movement" would hold
       * Otto silent forever. Driving scenarios keep resume_speed above
       * stop_speed and behave as before. */
      if (!tr.fired && cfg.resumeSpeed <= cfg.stopSpeed) fireTrigger(t);
    }
  } else {
    tr.contStillStart = null;
    if (tr.dwellMs > 0) {
      if (!tr.stillBreakStart) tr.stillBreakStart = t;
      if (t - tr.stillBreakStart >= cfg.stillGraceMs) { tr.dwellMs = 0; tr.stillBreakStart = null; }
    }
  }

  /* pass episodes: in through the pass circle and out again, slow, no stop */
  if (!tr.inside && dist <= cfg.radius) {
    tr.inside = true;
    tr.insideMaxStill = 0;
    tr.insideSpeedSum = 0;
    tr.insideN = 0;
  }
  if (tr.inside) { tr.insideSpeedSum += sp; tr.insideN++; }
  if (tr.inside && dist >= cfg.exitRadius) {
    tr.inside = false;
    const mean = tr.insideN ? tr.insideSpeedSum / tr.insideN : 0;
    if (mean > 0.3 && mean <= cfg.passSpeedMax && tr.insideMaxStill < cfg.passStillMax) {
      tr.passes++;
      updateCardTrack();
    }
  }

  /* back in the car after the stop — the deck's timing to talk */
  if (tr.stopped && !tr.fired) {
    if (sp >= cfg.resumeSpeed) { if (++tr.resumeN >= 2) fireTrigger(t); }
    else tr.resumeN = 0;
  }
}

/* ---------- hands-free debrief ----------
 * A fired trigger opens Otto by itself: buzz, the question spoken ALOUD
 * (speechSynthesis — built into the browser, keyless), and the mic
 * starts listening the moment the question ends. The tester's only tap
 * is the one that finishes their answer. No banner to notice, no
 * screen to find — the whole point of a trigger is that Otto comes to
 * you. */
function speakThen(text, done, lang) {
  stopOttoAudio(); // one voice at a time — a reading clip in flight yields
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    /* only clear the bridge callback if it is still OURS — a later
     * speakThen (a trigger question cutting off a pre-arrival reading)
     * may already have registered its own */
    if (window.__ottoTtsDone === finish) window.__ottoTtsDone = null;
    done();
  };
  const capMs = Math.min(20000, 2500 + String(text || '').length * 90);
  try {
    /* Android wrapper: the OttoTTS bridge — WebViews have no Web Speech
     * API at all, speechSynthesis.speak() there is a silent no-op */
    if (window.OttoTTS && window.OttoTTS.speak && text) {
      window.__ottoTtsDone = finish;
      OttoTTS.speak(text);
      setTimeout(finish, capMs);
      return;
    }
    if (!('speechSynthesis' in window) || !text) { setTimeout(finish, 1200); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    /* the caller says which language the TEXT is in — the browser then
     * picks a voice that can actually pronounce it */
    u.lang = lang || 'en-US';
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
    /* some browsers never fire onend — cap the wait by text length */
    setTimeout(finish, capMs);
  } catch { setTimeout(finish, 1200); }
}

/* ---------- the reading voice (ElevenLabs) ----------
 * With the backend live, pre-arrival notes are read in Otto's REAL
 * voice: the elevenlabs-tts function turns the briefing into a short
 * mp3 clip (the ElevenLabs key never reaches the phone — same rule as
 * the agent) and one shared audio element plays it. Everything
 * degrades in place, like the rest of the kit: function not deployed,
 * clip late, playback still locked, backend off — the reading falls
 * back to speakThen (the wrapper's TTS, then the browser's own voice)
 * and the banner is the record either way. */
let elevenDown = false; // one failed fetch = the function is missing; stop asking this session
let ottoAudio = null;   // one element, unlocked by the first gesture (see boot)
/* 10 ms of silence — played inside the first tap so a later
 * programmatic play() is allowed (autoplay rules want one gesture) */
const SILENCE_WAV = 'data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
function ottoAudioEl() {
  if (!ottoAudio) { ottoAudio = new Audio(); ottoAudio.preload = 'auto'; }
  return ottoAudio;
}
/* Stopping a clip also settles whoever was waiting for it to end —
 * a cut-off reading must not leave its "still speaking" flag stuck. */
function stopOttoAudio() {
  if (!ottoAudio) return;
  const pending = ottoAudio.__finish;
  ottoAudio.__finish = null;
  try {
    ottoAudio.onended = ottoAudio.onerror = null;
    ottoAudio.pause();
    if (ottoAudio.src && ottoAudio.src.slice(0, 5) === 'blob:') URL.revokeObjectURL(ottoAudio.src);
    ottoAudio.removeAttribute('src');
  } catch { /* optional */ }
  if (pending) pending();
}

/* Otto speaks: the ElevenLabs voice when it is reachable, speakThen
 * (wrapper TTS, then browser TTS) otherwise. onVoice fires only when
 * the real voice actually starts, so callers can label truthfully. */
async function speakOtto(text, done, onVoice) {
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    if (ottoAudio && ottoAudio.__finish === finish) ottoAudio.__finish = null;
    done();
  };
  if (Backend.enabled && !elevenDown && text) {
    try {
      const blob = await Backend.tts(String(text));
      const a = ottoAudioEl();
      stopOttoAudio();
      a.src = URL.createObjectURL(blob);
      a.__finish = finish;
      a.onended = finish;
      a.onerror = finish;
      await a.play(); // throws while autoplay is still locked — fall through
      if (onVoice) onVoice('elevenlabs');
      /* insurance for an onended that never fires */
      setTimeout(finish, Math.min(60000, 5000 + String(text).length * 100));
      return;
    } catch (e) {
      /* detach before falling back — speakThen stops the element, and a
       * still-registered finish would count the fallback as already done */
      if (ottoAudio) { ottoAudio.__finish = null; ottoAudio.onended = ottoAudio.onerror = null; }
      /* a failed FETCH means the function is missing or broken — stop
       * asking this session; a blocked play() is not the function's
       * fault, so it gets to try again next time */
      if (!(e && e.name === 'NotAllowedError')) {
        elevenDown = true;
        console.warn('elevenlabs-tts unavailable — falling back to the device voice:', e && e.message);
      }
    }
  }
  speakThen(text, finish);
}

/* {park_m} / {walk_m} in a scenario's "Otto says" become the actual
 * measured distances of THIS run — Otto quotes what he saw. */
function resolveSays(text) {
  const tr = tracking;
  return String(text)
    .replace(/\{park_m\}/g, tr && tr.parkedAt ? String(Math.round(distM(tr.parkedAt, tr.d))) : 'some')
    .replace(/\{walk_m\}/g, tr ? String(Math.round(tr.walkM)) : 'some');
}

function fireTrigger(t) {
  tracking.fired = true;
  tracking.firedAt = t;
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  el('notes-banner').hidden = true; // the question outranks the briefing
  updateCardTrack();
  openOtto(tracking.d);
  /* With the ElevenLabs agent on the line there is nothing to stage: it
   * opens with the scenario's question in its own voice and listens
   * straight through. The block below is the keyless path. */
  if (voice.agent) return;
  openingQuestion();
}

/* The keyless hands-free opener: the question spoken by the browser,
 * then the kit's own mic tapped for them. */
function openingQuestion() {
  const q = questionFor(tracking && tracking.sc);
  speakThen(q.text, () => {
    if (el('otto-screen').hidden) return; // they backed out while Otto was talking
    /* live mode only: auto-tap the widget's own mic. The scripted demo
     * paces itself, and a demo that pretends to listen teaches wrong. */
    if (!voice.live) return;
    const mic = document.querySelector('#otto .vn-mic');
    if (mic && !mic.hidden) {
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]); // "listening now" — felt, not just seen
      mic.click();
    }
  }, q.lang);
}

/* ---------- pre-arrival notes ----------
 * Otto reads what is on file for a destination BEFORE the driver gets
 * there: who the delivery is for (consignee + floor), the building
 * notes a dispatcher saved on the dashboard ("the elevator is broken"),
 * and what earlier drivers reported in their debriefs against the same
 * pin. Spoken aloud, hands-free, once per approach — a note that has to
 * be read off the screen at the door helps nobody in traffic. The
 * banner is the visual record of what was said; the card carries the
 * same notes for re-reading (and re-hearing) at the kerb. */
const NOTES = {
  approachRadius: 350, // m — entering this ring around a pin with notes starts the reading
  rearmRadius: 700,    // m — leaving this far out re-arms it (a new approach = a new reading)
  maxNotes: 3,         // newest notes on file read aloud (dispatch and driver-left alike)
  maxDriver: 2,        // newest driver debriefs read aloud
};
/* The rings are per destination when its scenario carries the keys —
 * notes_radius / notes_rearm are dashboard sliders exactly like the
 * trigger detector's knobs (the notes block offers to add the first
 * one); the NOTES defaults above are only the fallback. */
function notesRadiiOf(d) {
  /* a route stop without its own scenario reads the route scenario's
   * rings — one slider on the dashboard retunes the whole tour */
  const sc = scenarioOf(d) || (d.route ? routeScenario : null);
  const val = k => {
    const p = sc && Array.isArray(sc.params) ? sc.params.find(x => x && x.key === k) : null;
    const v = p && parseFloat(p.value);
    return isFinite(v) && v > 0 ? v : null;
  };
  const approach = val('notes_radius') || NOTES.approachRadius;
  let rearm = val('notes_rearm') || NOTES.rearmRadius;
  if (rearm <= approach) rearm = approach * 2; // hysteresis must stay outside the reading ring
  return { approach, rearm };
}
const notesRead = new Map(); // destination id -> 'done' until the rearm ring is left
let notesSpeaking = false;
let notesBannerDest = null;
let lastNotesScan = 0;

/* jsonb from Supabase, plain array from localStorage, string if hand-fed.
 * Each note says who left it (by: 'dispatch' | 'driver') — the dashboard
 * writes dispatch notes, the demo route also carries what drivers
 * reported on earlier tours. The reading names the voice either way. */
const notesOnFile = d => {
  let n = d && d.notes;
  if (typeof n === 'string') { try { n = JSON.parse(n); } catch { n = null; } }
  return Array.isArray(n) ? n.filter(x => x && String(x.text || '').trim()) : [];
};
/* what other drivers left behind: the debriefs already filed against
 * the pin — the structured title where Otto made one, the raw words
 * otherwise. Demo rows stay out: nothing counts them as real data.
 * Sorted here, not trusted from insertion order: boot unshifts a
 * newest-first backend page (reversing it), live reports unshift on
 * top — only an explicit sort keeps "newest" actually newest. */
const driverReportsOf = d => (messagesByDest[d.id] || [])
  .filter(m => m && !m.demo && (m.title || m.transcript))
  .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

/* a bare "3" in the floor field should not be read as "three" */
const speakFloor = f => (/^\d+$/.test(String(f).trim()) ? 'floor ' + String(f).trim() : String(f).trim());
/* "250 m" reads fine on a card; spoken it needs the unit spelled out */
const speakDist = m => (m < 1000 ? Math.round(m / 10) * 10 + ' meters' : (m / 1000).toFixed(1) + ' kilometers');

function briefingLines(d) {
  const lines = [];
  const name = String(d.consignee || '').trim();
  const floor = String(d.floor || '').trim();
  if (name) lines.push(`Delivery is for ${name}${floor ? ', ' + speakFloor(floor) : ''}.`);
  else if (floor) lines.push(`Delivery goes to ${speakFloor(floor)}.`);
  notesOnFile(d).slice(0, NOTES.maxNotes).forEach(n =>
    lines.push((n.by === 'driver' ? 'A driver reported: ' : 'From dispatch: ') + sentence(n.text)));
  driverReportsOf(d).slice(0, NOTES.maxDriver).forEach(m => lines.push('A driver reported: ' + sentence(m.title || m.transcript)));
  return lines;
}

/* Runs on every fresh fix (ActivityRec's continuous stream while armed,
 * the Geo kit's one-shot fixes otherwise). Cheap: a distance per pin. */
function checkApproach(pos) {
  const now = Date.now();
  if (now - lastNotesScan < 2000) return;
  lastNotesScan = now;
  /* stay armed through a busier moment: an open debrief, a reading
   * already under way, or the verdict bar waiting for its tap */
  const busy = notesSpeaking || !el('otto-screen').hidden || !el('verdict-banner').hidden;
  let next = null;
  for (const d of visibleDestinations()) {
    const dist = distM(pos, d);
    const rings = notesRadiiOf(d);
    if (dist > rings.rearm) { notesRead.delete(d.id); continue; }
    if (busy || dist > rings.approach || notesRead.get(d.id) === 'done') continue;
    if (!briefingLines(d).length) continue; // nothing on file — nothing to read
    /* on a dense route several stops arm at once — the nearest one is
     * the approach actually being made; the rest wait for their turn */
    if (!next || dist < next.dist) next = { d, dist };
  }
  if (next) speakPreArrival(next.d, next.dist);
}

/* "stop 12, Goltzstraße 13" when the pin is one stop of a route */
const spokenTitle = d => (d.stop != null ? `stop ${d.stop}, ` : '') + d.title;

function speakPreArrival(d, dist) {
  notesRead.set(d.id, 'done');
  notesSpeaking = true;
  const head = dist > 60
    ? `Heads up — ${spokenTitle(d)}, about ${speakDist(dist)} ahead.`
    : `You're at ${spokenTitle(d)}.`;
  const text = [head, ...briefingLines(d)].join(' ');
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]); // softer than the trigger's buzz
  notesBannerDest = d;
  el('nb-title').textContent = 'OTTO · PRE-ARRIVAL NOTES';
  el('nb-text').textContent = text;
  el('notes-banner').hidden = false;
  /* the ◆ label appears only once the ElevenLabs clip actually plays —
   * a silent fallback never masquerades as the real thing */
  speakOtto(text, () => { notesSpeaking = false; },
    () => { el('nb-title').textContent = 'OTTO · PRE-ARRIVAL NOTES · ◆ ELEVENLABS'; });
}

/* the card's notes box — exactly what an approach would read out */
function renderCardNotes(d) {
  const box = el('card-notes-body');
  box.innerHTML = '';
  const name = String(d.consignee || '').trim();
  const floor = String(d.floor || '').trim();
  const notes = notesOnFile(d);
  const reports = driverReportsOf(d).slice(0, NOTES.maxDriver).length;
  el('card-notes').hidden = !name && !floor && !notes.length && !reports;
  if (el('card-notes').hidden) return;
  if (name || floor) {
    const line = document.createElement('div');
    line.className = 'cn-line';
    line.textContent = name ? `Consignee: ${name}${floor ? ' · ' + floor : ''}` : `Floor: ${floor}`;
    box.appendChild(line);
  }
  notes.slice(0, NOTES.maxNotes).forEach(n => {
    const row = document.createElement('p');
    row.className = 'cn-note';
    const tag = document.createElement('b');
    tag.textContent = n.by === 'driver' ? 'DRIVER' : 'DISPATCH';
    row.append(tag, document.createTextNode(String(n.text)));
    box.appendChild(row);
  });
  if (reports) {
    const row = document.createElement('p');
    row.className = 'cn-note';
    const tag = document.createElement('b');
    tag.textContent = 'DRIVERS';
    row.append(tag, document.createTextNode(
      `the latest ${reports === 1 ? 'report' : reports + ' reports'} below ${reports === 1 ? 'is' : 'are'} read out too`));
    box.appendChild(row);
  }
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
  /* raw speed rides along — the instant signal, while the state label
   * carries deliberate smoothing */
  const kmh = typeof snap.speed === 'number' && snap.speed >= 0 ? ` · ${Math.round(snap.speed * 3.6)} KM/H` : '';
  chip.textContent = `AR · ${snap.state}${suffix}${test}${kmh}`;
}

function updateCardTrack() {
  const btn = el('card-sc-start');
  const line = el('card-sc-track');
  const sc = current && scenarioOf(current);
  const isThis = tracking && current && tracking.d.id === current.id;
  btn.textContent = isThis ? '■ Stop tracking' : '▶ Start test tracking';
  if (!sc || !isThis) { line.textContent = tracking || !sc ? '' : 'GPS + activity are recorded while tracking'; return; }
  const tr = tracking;
  if (tr.shape === 'parkwalk') {
    const bits = tr.fired ? ['TRIGGER FIRED']
      : tr.parkedAt ? [`PARKED ${fmtDist(distM(tr.parkedAt, tr.d))} FROM PIN`, `WALKED ${Math.round(tr.walkM)} M`]
      : tr.sawVehicle ? ['DRIVING — PARK TO CONTINUE']
      : ['WAITING FOR THE DRIVE'];
    line.textContent = 'TRACKING · ' + bits.join(' · ');
    return;
  }
  const bits = [`${tr.passes} SLOW PASS${tr.passes === 1 ? '' : 'ES'}`];
  if (tr.fired) bits.push('TRIGGER FIRED');
  else if (tr.stopped) bits.push('STOP SEEN — DRIVE ON TO FIRE');
  else if (tr.passes >= tr.trig.passesNeeded) bits.push('WAITING FOR YOUR STOP');
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
    checkApproach(snap.position); // notes on file get read out on the way in
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
          /* which definition and which knob values this run actually used —
           * the dashboard's version/feedback loop compares against these */
          scenario_version: tracking.sc.version || 1,
          passes: tracking.passes,
          stopped: !!tracking.stopped,
          ...(tracking.shape === 'parkwalk' && tracking.parkedAt ? {
            park_distance_m: Math.round(distM(tracking.parkedAt, tracking.d)),
            walk_m: Math.round(tracking.walkM),
          } : {}),
          fired_at: tracking.firedAt ? new Date(tracking.firedAt).toISOString() : null,
          tuning: {
            radius: tracking.trig.radius,
            exit_radius: tracking.trig.exitRadius,
            pass_speed_max: tracking.trig.passSpeedMax,
            pass_still_max_s: tracking.trig.passStillMax / 1000,
            passes_needed: tracking.trig.passesNeeded,
            stop_speed: tracking.trig.stopSpeed,
            stop_dwell_s: tracking.trig.stopDwellMs / 1000,
            stop_radius: tracking.trig.stopRadius,
            resume_speed: tracking.trig.resumeSpeed,
          },
        },
      } : {}),
    },
  };
}

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

/* ---------- the route toggle ----------
 * One phone, two demos: the full delivery route, or a clean map for
 * scenario tests. The ROUTE chip hides the route's stops on THIS
 * device only — pins, approach readings and taps alike; scenario pins
 * stay, and the dashboard still says what is loaded. The choice
 * sticks per device, so a demo phone stays the demo phone. */
const LS_ROUTE_ON = 'od_route_on';
let routeOn = true;
try { routeOn = localStorage.getItem(LS_ROUTE_ON) !== '0'; } catch { /* private mode */ }
function visibleDestinations() {
  return routeOn ? destinations : destinations.filter(d => !d.route);
}
function renderRouteChip() {
  const chip = el('route');
  const n = destinations.filter(d => d.route).length;
  chip.hidden = !n;
  if (!n) return;
  chip.textContent = routeOn ? `ROUTE · ${n} STOPS` : 'ROUTE OFF';
  chip.classList.toggle('off', !routeOn);
}
el('route').onclick = () => {
  routeOn = !routeOn;
  try { localStorage.setItem(LS_ROUTE_ON, routeOn ? '1' : '0'); } catch { /* private mode */ }
  /* a card open on a stop that just went hidden closes with it — but
   * an open debrief is never yanked, the toggle can wait */
  if (!routeOn && current && current.route && el('otto-screen').hidden) {
    el('card').hidden = true;
    current = null;
  }
  renderRouteChip();
  renderEmpty();
  map.refresh();
};

/* ---------- map ---------- */
const map = FieldMap.mount({
  el: '#map',
  geo: LiveGeo, // Geo, plus ActivityRec's continuous fixes while tracking
  markers: () => {
    const list = visibleDestinations().map(d => {
      const done = reportedIds.has(d.id);
      return {
        id: d.id, lat: d.lat, lng: d.lng,
        label: (done ? '✓ ' : '') + (d.stop != null ? d.stop + ' · ' : '') + scenarioNumPrefix(d)
          + String(d.title || 'Destination').toUpperCase().slice(0, 22),
        color: done ? '70,211,154' : '255,107,107',
        labelColor: done ? '#7ce0b8' : '#ff9b9b',
        /* ✎ = notes on file — Otto will speak on the way in; the mark
         * yields to ✓ once the stop is debriefed */
        icon: done ? '✓' : notesOnFile(d).length ? '✎' : '▲',
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
    if (!d) return;
    /* route stops can share one address (several parcels, one door) and
     * their pins stack exactly — a tap serves the first stop still open
     * there, the way a courier works through parcels at a single bell */
    const here = visibleDestinations().filter(x => x.lat === d.lat && x.lng === d.lng);
    openCard(here.find(x => !reportedIds.has(x.id)) || d);
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
      /* the sheet's "Otto says" column IS the debrief opener — in the
       * card's chosen language once the translation has landed */
      if (s && s.otto_says) return questionFor(s).text;
      return current ? LANG_TEXT[testLang].at(current) : LANG_TEXT[testLang].plain;
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
      /* Otto's reply gets the same voice as his question — text-only
       * feedback goes unnoticed by someone watching the road. Scripted
       * demo replies stay silent: nothing was actually heard, and the
       * agent already said its piece in its own voice (res.spoken). */
      if (!res.demo && !res.spoken && res.reply) speakThen(String(res.reply), () => {});
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
      if (!el('card').hidden) openCard(current); // the debrief lands in the card's list
    },
  };
};

/* ---------- the scenario, as the agent hears it ----------
 * An ElevenLabs agent is told about the test in three ways, in
 * descending order of how much the agent's own prompt has to know:
 *
 *   1. dynamic variables — {{scenario_rule}}, {{park_distance_m}} …
 *      substituted into a prompt that names them,
 *   2. a contextual update — the same thing in plain sentences, for a
 *      prompt that names none of them,
 *   3. the first message — the sheet's "Otto says", verbatim.
 *
 * Everything measured is what THIS run measured: the agent asks about
 * the two loops it can see, not about loops in general. */
function agentVars() {
  const d = current;
  const sc = d && scenarioOf(d);
  const tr = tracking && d && tracking.d.id === d.id ? tracking : null;
  const p = sc && sc.params;
  const v = {
    destination_title: d ? d.title : '',
    destination_address: d ? (d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`) : '',
    destination_lat: d ? d.lat : '',
    destination_lng: d ? d.lng : '',
    /* the pre-arrival notes on file — the agent knows what Otto read
     * out on the way in, so it can follow up ("was the elevator really
     * out?") instead of hearing about it cold */
    destination_consignee: d ? String(d.consignee || '') : '',
    destination_floor: d ? String(d.floor || '') : '',
    destination_notes: d ? notesOnFile(d).slice(0, NOTES.maxNotes)
      .map(n => (n.by === 'driver' ? 'a driver reported: ' : '') + n.text).join('; ') : '',
    scenario_num: sc && sc.num != null ? sc.num : '',
    scenario_title: sc ? sc.title : '',
    scenario_version: sc ? (sc.version || 1) : '',
    scenario_question: sc && sc.otto_says ? questionFor(sc).text : '',
    /* the card's 🇬🇧/🇮🇹 pick, for prompts that want to name it */
    debrief_language: testLang === 'it' ? 'Italian' : 'English',
    scenario_rule: sc ? fillParams(sc.rule, p) : '',
    scenario_ar_states: sc ? sc.ar_states || '' : '',
    scenario_signals: sc ? sc.signals || '' : '',
    scenario_timing: sc ? fillParams(sc.timing, p) : '',
    scenario_test_steps: sc ? fillParams(sc.test_steps, p) : '',
    /* the "What Otto learns" column: the tip type this debrief is
     * supposed to come back with, so the agent can steer towards it */
    expected_tip_type: sc ? sc.learns || '' : '',
    trigger_fired: tr && tr.fired ? 'yes' : 'no',
    trigger_passes: tr ? tr.passes : '',
    trigger_stopped: tr ? (tr.stopped ? 'yes' : 'no') : '',
    /* only the park-and-walk shape measures these — on a pass/stop run
     * they are a constant zero, and "you walked 0 m" is the kind of
     * detail that makes an agent sound like it was not there */
    park_distance_m: tr && tr.shape === 'parkwalk' && tr.parkedAt ? Math.round(distM(tr.parkedAt, tr.d)) : '',
    walk_m: tr && tr.shape === 'parkwalk' ? Math.round(tr.walkM) : '',
    activity_state: ActivityRec.active ? ActivityRec.state : '',
    activity_summary: ActivityRec.active ? (ActivityRec.summary(tr ? tr.startedAt : Date.now() - 15 * 60e3) || '') : '',
  };
  const pos = LiveGeo.position;
  if (pos && d) v.distance_to_pin_m = Math.round(distM(pos, d));
  return v;
}

function agentBriefing() {
  const v = agentVars();
  const lines = [];
  lines.push(`You are Otto, debriefing a field tester who has just acted out a trigger scenario at ${v.destination_title || 'a destination'}${v.destination_address ? ` (${v.destination_address})` : ''}.`);
  if (v.scenario_title) lines.push(`Scenario${v.scenario_num !== '' ? ' #' + v.scenario_num : ''}: ${sentence(v.scenario_title + ' (v' + v.scenario_version + ')')}`);
  if (v.scenario_rule) lines.push(`The trigger rule under test: ${sentence(v.scenario_rule)}`);
  if (v.expected_tip_type) lines.push(`What this debrief should end up teaching us (tip type): ${v.expected_tip_type}.`);
  const onFile = [];
  if (v.destination_consignee) onFile.push(`the consignee is ${v.destination_consignee}${v.destination_floor ? ' (' + v.destination_floor + ')' : ''}`);
  else if (v.destination_floor) onFile.push(`the delivery goes to ${v.destination_floor}`);
  if (v.destination_notes) onFile.push(`notes on file: ${v.destination_notes}`);
  if (onFile.length) lines.push(sentence(`Pre-arrival notes on file, read to them on the way in: ${onFile.join('; ')}`));
  if (v.trigger_fired === 'yes') {
    const bits = [];
    if (v.trigger_passes !== '' && v.trigger_passes > 0) bits.push(`${v.trigger_passes} slow pass${v.trigger_passes === 1 ? '' : 'es'} near the pin`);
    if (v.trigger_stopped === 'yes') bits.push('a stop');
    if (v.park_distance_m !== '') bits.push(`parked ${v.park_distance_m} m from the pin`);
    if (v.walk_m !== '') bits.push(`walked ${v.walk_m} m`);
    lines.push(`The trigger fired on this run${bits.length ? ': the phone measured ' + bits.join(', ') + '.' : '.'}`);
  } else {
    lines.push('This debrief was opened by hand — the trigger did not fire on this run.');
  }
  if (v.activity_summary) lines.push(`Activity the phone observed: ${v.activity_summary}.`);
  lines.push('Ask about what they actually found on the ground, keep it to a couple of short questions, and let them go.');
  /* belt to the language override's braces: an agent whose prompt never
   * mentions language still gets told, in words, which one this run is */
  if (testLang === 'it') lines.push('This tester chose Italian: conduct the entire debrief in Italian — every question and reply.');
  return lines.join(' ');
}

/* Otto is the ElevenLabs agent when one is configured, and the recorded
 * debrief otherwise — same mount seams either way (see otto-agent.js),
 * so everything below this line is written once. A conversation that
 * cannot be opened falls back in place rather than dead-ending. */
function mountOtto(recorderOnly) {
  if (!recorderOnly && OttoAgent.available()) {
    return OttoAgent.mount({
      ...voiceOpts(),
      vars: agentVars,
      briefing: agentBriefing,
      language: () => testLang,
      onFallback() {
        voice = mountOtto(true);
        /* a trigger that fired still owes the tester its question */
        if (tracking && tracking.fired && current && tracking.d.id === current.id) openingQuestion();
      },
    });
  }
  return VoiceNote.mount(voiceOpts());
}

/* Mounted idle behind the hidden screen: the recorder, never the agent —
 * mounting the agent opens a live (metered) line, so that waits for the
 * screen it belongs to. */
let voice = VoiceNote.mount(voiceOpts());

function openOtto(d) {
  current = d;
  /* a pre-arrival reading must not talk over the debrief — the keyless
   * path cancels it itself (speakThen), the agent path would not */
  stopOttoAudio();
  try {
    if (window.OttoTTS && OttoTTS.stop) OttoTTS.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch { /* optional */ }
  el('card').hidden = true;
  /* the flag rides along so mid-debrief there is no doubt which
   * language this conversation was opened in */
  el('otto-dest').textContent = (testLang === 'it' ? '🇮🇹 ' : '🇬🇧 ')
    + (d.stop != null ? 'Stop ' + d.stop + ' · ' : '') + scenarioNumPrefix(d) + d.title;
  el('otto-screen').hidden = false;
  /* a manual "Report to Otto" tap never went through startTracking —
   * kick the translation off now; the connect handshake usually gives
   * it enough of a head start, and English is the harmless fallback */
  prefetchSaysIt(scenarioOf(d));
  voice.destroy();
  voice = mountOtto(false); // mount() starts it
}

function closeOtto() {
  /* Backing out of a conversation is not the same as throwing it away:
   * the tester answered the question, so the agent files what was said
   * before the line closes. */
  if (voice.agent) voice.end();
  else voice.stop();
  stopOttoAudio();
  try {
    if (window.OttoTTS && OttoTTS.stop) OttoTTS.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch { /* optional */ }
  el('otto-screen').hidden = true;
  if (current) openCard(current); // back to the card, now with the new message
}

/* ---------- destination card ---------- */
function openCard(d) {
  current = d;
  el('card-title').textContent = (d.stop != null ? 'Stop ' + d.stop + ' · ' : '') + scenarioNumPrefix(d) + d.title;
  el('card-addr').textContent = d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`;
  updateCardDistance();
  el('card-dir').href = dirUrl(d);
  el('card-sv').href = panoUrl(d);

  /* a scenario pin carries its instructions — and is managed from the
   * dashboard, so the card's remove link goes away */
  const sc = scenarioOf(d);
  el('card-scenario').hidden = !sc;
  if (sc) {
    el('card-sc-name').textContent = scenarioNumPrefix(d) + sc.title
      + ((sc.version || 1) > 1 ? ' · v' + sc.version : '');
    const steps = fillParams(sc.test_steps || sc.rule || '', sc.params);
    el('card-sc-steps').textContent = steps;
    el('card-sc-steps').hidden = !steps;
    updateCardTrack();
  }
  el('card-remove').hidden = !!sc;

  /* what an approach would read out — consignee, floor, dispatch notes;
   * the driver debriefs listed below are the rest of the briefing */
  renderCardNotes(d);

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

/* ---------- empty state ---------- */
function renderEmpty() { el('hint').hidden = visibleDestinations().length > 0; }

/* ---------- GPS chip ---------- */
Geo.on(snap => {
  const chip = el('gps');
  const street = snap.address && (snap.address.street || snap.address.area);
  chip.textContent = snap.state === 'fix' && street ? street.toUpperCase() : Geo.label;
  chip.classList.toggle('warn', snap.stale || snap.state === 'off');
  if (!el('card').hidden) updateCardDistance();
  /* the kit's one-shot fixes brief too, so notes still get read with
   * activity recognition toggled off — never off a cached position:
   * a stale fix could narrate an approach that happened an hour ago */
  if (snap.position && !snap.stale) checkApproach(snap.position);
});

/* ---------- version chip ----------
 * Web build is stamped at deploy time; the Android wrapper injects its
 * own version after the page loads, so the chip shows both channels:
 * "V 250806.1432-c05ebe0 · APP 1.7". */
const renderBuild = () => {
  el('build').textContent = 'V ' + window.BUILD
    + (window.WRAPPER_VERSION ? ' · APP ' + window.WRAPPER_VERSION : '');
};
window.__setWrapperVersion = v => { window.WRAPPER_VERSION = String(v); renderBuild(); };
renderBuild();

/* Tap the version chip → mic self-test. The voice widget degrades to
 * its scripted demo silently when any link in the recording chain is
 * missing; in the field that reads as "Otto recorded me" when nothing
 * was recorded. This names the broken link on the device itself. */
el('build').onclick = async () => {
  const out = [];
  out.push('backend: ' + (Backend.enabled ? 'ON' : 'OFF — demo mode'));
  out.push('secure context: ' + (window.isSecureContext ? 'yes' : 'NO'));
  /* which Otto this phone will actually open — the whole point of this
   * self-test is that a silent fallback never masquerades as the real
   * thing, and there are now two real things to tell apart */
  out.push('ElevenLabs agent: ' + (OttoAgent.agentId()
    ? (OttoAgent.available() ? 'ON — ' + OttoAgent.agentId() : 'configured but UNUSABLE here')
    : 'not configured — recorded debrief'));
  /* the card's 🇬🇧/🇮🇹 pick — an Italian debrief that comes out English
   * usually means the agent declined the language override */
  out.push('debrief language: ' + (testLang === 'it'
    ? 'ITALIAN — needs Italian + the "language" override enabled on the agent'
    : 'ENGLISH (agent default)'));
  /* the reading voice for pre-arrival notes — probed live, because a
   * silent fallback in the field reads as "ElevenLabs spoke" */
  if (Backend.enabled) {
    try {
      const clip = await Backend.tts('Ok.');
      elevenDown = false; // it works — forget any earlier failure
      out.push(`notes reading voice: ELEVENLABS — OK (${Math.round(clip.size / 102.4) / 10} KB test clip)`);
    } catch (e) {
      out.push('notes reading voice: device TTS — elevenlabs-tts unreachable (' + (e.message || e) + ')');
    }
  } else {
    out.push('notes reading voice: device TTS (backend OFF)');
  }
  out.push('wrapper TTS: ' + (window.OttoTTS ? 'yes' : 'no (browser)'));
  const md = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  out.push('mediaDevices.getUserMedia: ' + (md ? 'yes' : 'MISSING'));
  out.push('MediaRecorder: ' + (typeof MediaRecorder !== 'undefined' ? 'yes' : 'MISSING'));
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
    out.push('- audio/webm: ' + (MediaRecorder.isTypeSupported('audio/webm') ? 'yes' : 'no'));
    out.push('- audio/mp4: ' + (MediaRecorder.isTypeSupported('audio/mp4') ? 'yes' : 'no'));
  }
  if (md) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      out.push('mic open/close: OK');
    } catch (e) {
      out.push('mic open FAILED: ' + (e.name || '') + ' ' + (e.message || ''));
    }
  }
  alert('MIC SELF-TEST\n\n' + out.join('\n'));
};

/* ---------- boot ---------- */
el('gps').onclick = () => Geo.locate();
el('zoom-in').onclick = () => { const g = map.map; if (g) g.setZoom(Math.min(20, (g.getZoom() || 17) + 1)); };
el('zoom-out').onclick = () => { const g = map.map; if (g) g.setZoom(Math.max(3, (g.getZoom() || 17) - 1)); };
el('card-close').onclick = () => { el('card').hidden = true; };
el('card-otto').onclick = () => current && openOtto(current);
el('card-remove').onclick = removeCurrent;
el('otto-back').onclick = closeOtto;

/* ↻ — pull fresh scenarios, pins and debriefs without reloading the
 * page. The dashboard cuts new versions mid-session; testers were
 * walking stale definitions without knowing. */
el('reload').onclick = async () => {
  const chip = el('reload');
  if (chip.dataset.busy) return;
  chip.dataset.busy = '1';
  chip.textContent = '…';
  try {
    await boot();
    /* keep whatever is open pointing at the fresh objects */
    if (current && el('otto-screen').hidden) {
      const d = destinations.find(x => x.id === current.id);
      if (d) { current = d; if (!el('card').hidden) openCard(d); }
      else { el('card').hidden = true; current = null; } // deleted on the dashboard
    }
  } finally {
    delete chip.dataset.busy;
    chip.textContent = '↻';
  }
};

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
/* the debrief language, picked before the run and sticky until changed —
 * takes effect when the NEXT conversation opens, so flipping it after a
 * trigger fired still applies to the retry, not the line already open */
function renderLang() {
  el('lang-en').classList.toggle('on', testLang !== 'it');
  el('lang-it').classList.toggle('on', testLang === 'it');
}
function setLang(l) {
  testLang = l;
  try { localStorage.setItem(LS_LANG, l); } catch { /* private mode */ }
  renderLang();
  /* start translating the question(s) this pick will need */
  prefetchSaysIt(current ? scenarioOf(current) : null);
  if (tracking) prefetchSaysIt(tracking.sc);
}
el('lang-en').onclick = () => setLang('en');
el('lang-it').onclick = () => setLang('it');
renderLang();
el('trigger-banner').onclick = () => {
  el('trigger-banner').hidden = true;
  if (tracking) openOtto(tracking.d);
};
el('vb-right').onclick = () => answerRunVerdict(lastRun && lastRun.fired ? 'on_time' : 'quiet_right');
el('vb-early').onclick = () => answerRunVerdict('early');
el('vb-late').onclick = () => answerRunVerdict('late');
el('vb-wrong').onclick = () => answerRunVerdict(lastRun && lastRun.fired ? 'false_alarm' : 'missed');
el('vb-skip').onclick = () => { el('verdict-banner').hidden = true; };
el('tb-close').onclick = e => {
  e.stopPropagation();
  el('trigger-banner').hidden = true;
};
el('notes-banner').onclick = () => {
  el('notes-banner').hidden = true;
  if (notesBannerDest) openCard(notesBannerDest);
};
el('nb-close').onclick = e => {
  e.stopPropagation();
  el('notes-banner').hidden = true;
  /* dismissing mid-reading means "stop talking" — whichever voice */
  stopOttoAudio();
  try {
    if (window.OttoTTS && OttoTTS.stop) OttoTTS.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch { /* optional */ }
};
/* the card's replay — hear at the kerb what the approach said in traffic */
el('card-notes-play').onclick = () => {
  if (!current) return;
  const lines = briefingLines(current);
  if (lines.length) speakOtto(lines.join(' '), () => {});
};
/* A pre-arrival reading can be the first thing Otto ever says — no
 * tracking tap came before it — and browsers refuse both speak() and
 * play() from a page that never made a sound during a user gesture.
 * Prime both voices on the first tap anywhere: an empty utterance for
 * the browser TTS, 10 ms of silence through the shared audio element
 * for the ElevenLabs clips. (The wrapper's OttoTTS needs no priming,
 * and its WebView allows gesture-free playback.) */
document.addEventListener('pointerdown', () => {
  try {
    if (!window.OttoTTS && 'speechSynthesis' in window) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }
  } catch { /* optional */ }
  try {
    const a = ottoAudioEl();
    if (!a.src) { // never yank a briefing that is already playing
      a.src = SILENCE_WAV;
      a.play().then(() => { a.removeAttribute('src'); }).catch(() => { a.removeAttribute('src'); });
    }
  } catch { /* optional */ }
}, { once: true, capture: true });

async function boot() {
  /* boot doubles as reload (the ↻ chip) — start from a clean slate or
   * every re-run would stack the same messages onto the lists again */
  Object.keys(messagesByDest).forEach(k => delete messagesByDest[k]);
  reportedIds.clear();
  if (Backend.enabled) {
    try {
      destinations = (await Backend.listDestinations()) || [];
      /* a route loads as ONE bulk insert, so its rows share a created_at
       * — the stop number breaks the tie and keeps the tour in order */
      destinations.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))
        || ((a.stop == null ? 1e9 : a.stop) - (b.stop == null ? 1e9 : b.stop)));
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
  renderRouteChip();
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
    renderRouteChip();
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

/* GPS is the only position source — no simulated fallback. The map
 * starts on the last cached real fix (prime, flagged stale) and a fresh
 * fix is requested immediately; until one lands, the veil and the GPS
 * chip say exactly where things stand. Coming back to the foreground
 * retries automatically, so a denied-then-granted permission or a
 * missed cold start never leaves the app stuck unlocated. */
Geo.prime();
Geo.locate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !Geo.position && Geo.state !== 'locating') Geo.locate();
});

/* Activity recognition arms itself at app open — testers kept walking
 * with it off. The chip still toggles it, so switching it off is one
 * tap; continuous GPS is the accepted cost. (iOS motion permission
 * still needs a tap — until then, states run on GPS speed alone.) */
ActivityRec.start();
updateArChip(ActivityRec.snapshot);
