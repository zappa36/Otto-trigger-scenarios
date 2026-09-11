/*
 * Invented history — what the phone cannot have produced yet.
 *
 * One tester walking one route makes a handful of tours; the analytics
 * contract has trend charts, hotspot rankings and a 90-day series. So the
 * mock invents the rest: a small crew of drivers who have been working the
 * routes on file for the last N days, with the stops they completed, how
 * long each door took, what they reported and when Otto reached out.
 *
 * Deterministic: the same seed and the same routes give the same history
 * on every start, so ids and numbers are stable across restarts. Real rows
 * from the store are layered on top by source.mjs, never mixed in here.
 * Every row carries invented: true, so the two are always tellable apart.
 */
import { CATEGORIES, SKIP_REASONS, berlinInstant, isoInstant, serviceDateOf, uuidFrom, DAY_MS } from './contract.mjs';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** What drivers say, per category — the mock's report summaries. */
export const SUMMARIES = {
  access: [
    'Main door is keypad-only after 18:00 — the bell panel is inside the courtyard.',
    'Intercom dead — ring the ground-floor flat on the left, they buzz you in.',
    'Front door locked, the practice opens the courtyard door on the right.',
    'Stairwell light on a short timer — you climb the last floor in the dark.',
    'Lift out of order, fourth floor on foot.',
  ],
  parking: [
    'No loading bay — nearest legal stop is 80 m north outside the bakery.',
    'Loading zone full after 10:00, the side street is the only option.',
    'Begegnungszone — no through traffic, come in from the other end.',
    'Hazards-on stop tolerated for two minutes, not more — the warden walks this block.',
  ],
  gate_code: [
    'Gate code changed — ask dispatch for the new one before the next tour.',
    'Gate code on file still works but the gate sticks, push hard.',
    'Courtyard gate needs the code twice — once outside, once at the inner door.',
  ],
  recipient: [
    'Nobody home before 16:00 — neighbour in 2B takes parcels.',
    'Reception only signs between 09:00 and 12:00.',
    'Consignee moved out — the name on the bell is different now.',
    'Rang twice, waited, bounced — the customer is hard of hearing, give it a minute.',
  ],
  address: [
    'Pin sits on the wrong building — the number is in the courtyard behind.',
    'Two entrances with the same number, the parcels go to the one on the corner.',
    'House number is not on the street front, look for the archway.',
  ],
  hazard: [
    'Scaffolding across the pavement — step into the road at the corner.',
    'Street closed for works — detour via the next side street.',
    'Ice on the courtyard ramp in the morning, no grit.',
    'Dog loose in the courtyard, wait for the owner.',
  ],
  other: [
    'Long queue at reception around noon.',
    'Customer asks for the parcel to be left with the kiosk next door.',
    'Building has a second lift at the back, faster for the upper floors.',
  ],
};

/** A contract category for free text — driver-left notes and old rows that carry none. */
export function classifyText(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(code|keypad|pin)\b/.test(t) && /gate|door|tor|courtyard/.test(t)) return 'gate_code';
  if (/park|loading|ladezone|halten|no stopping|hazards-on|loading bay|begegnungszone/.test(t)) return 'parking';
  if (/nobody|no one|answer|neighbo|reception|consignee|takes parcels|not home|moved out|signs for/.test(t)) return 'recipient';
  if (/wrong (pin|building)|pin sits|house number|archway|courtyard behind|number is not|set back in the courtyard/.test(t)) return 'address';
  if (/closed|blocked|works|scaffold|construction|detour|ice |dog |hazard|danger|through traffic/.test(t)) return 'hazard';
  if (/door|entrance|intercom|bell|buzz|lift|stairs|way in|gate|locked|key|floor/.test(t)) return 'access';
  return 'other';
}

const QUESTION_PROMPTS = {
  access: 'Is the way in still the same as the notes say?',
  parking: 'Where did you manage to stop this time?',
  gate_code: 'Did the gate code on file still work?',
  recipient: 'Who took the parcel, and when do they answer?',
  address: 'Is the pin on the right building?',
  hazard: 'Is the approach still blocked?',
  other: 'Anything the next driver should know here?',
};

/**
 * @param {object} p
 * @param {Array} p.routes    [{ id, name, walking, stops: [{ stop_id, sequence, place_id, address, lat, lng }] }]
 * @param {Array} p.places    [{ place_id, label, address, location }]
 * @param {Array} p.scenarios the real scenarios on file (questions are drawn from them)
 * @param {string[]} p.driverNames
 * @param {number} p.historyDays
 * @param {string|number} p.seed
 * @param {number} p.now
 */
export function invent({ routes, places, scenarios = [], driverNames, historyDays, seed, now }) {
  const rand = mulberry32(hash32(seed));
  const chance = (p) => rand() < p;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + rand() * (b - a);
  const lognormal = (lo, hi) => Math.exp(between(Math.log(lo), Math.log(hi)));

  const drivers = driverNames.map((name) => ({ driver_id: uuidFrom('driver:' + name), name, invented: true }));

  /* A place's character: how often it causes trouble, and what kind. Hashed
   * from the id, so it stays put when the seed changes the day-to-day. */
  const character = new Map();
  for (const p of places) {
    const h = hash32('character:' + p.place_id);
    const r = (h % 1000) / 1000;
    const propensity = r < 0.08 ? 3 + (h % 300) / 100 : r < 0.3 ? 1.2 + (h % 130) / 100 : 0.2 + (h % 80) / 100;
    const category = CATEGORIES[(h >>> 8) % CATEGORIES.length];
    const pooled = ['none', 'few', 'some', 'many'][(h >>> 16) % 4];
    character.set(p.place_id, { propensity, category, pooled });
  }
  const characterOf = (placeId) => character.get(placeId) || { propensity: 0.5, category: 'other', pooled: 'few' };

  const tours = [], reports = [], outreach = [], gapAlerts = [];
  let seq = 0;
  const nextId = (kind) => uuidFrom(`${seed}:${kind}:${seq++}`);
  /* the same door does not say the same sentence three times in a row */
  const said = new Map();
  const summaryFor = (placeId, category) => {
    const k = placeId + ':' + category;
    const n = said.get(k) || 0;
    said.set(k, n + 1);
    const list = SUMMARIES[category];
    return list[(hash32(k) + n) % list.length];
  };

  const startDay = serviceDateOf(now - historyDays * DAY_MS);
  for (let dayOffset = historyDays; dayOffset >= 1; dayOffset--) {
    const dayT = now - dayOffset * DAY_MS;
    const date = serviceDateOf(dayT);
    const weekday = new Date(berlinInstant(date, 12)).getUTCDay();
    if (weekday === 0) continue; // no Sunday tours
    routes.forEach((route, ri) => {
      if (!chance(route.walking ? 0.55 : 0.72)) return;
      const driver = drivers[(dayOffset + ri * 2 + (chance(0.2) ? 1 : 0)) % drivers.length];
      const tourId = uuidFrom(`tour:${seed}:${route.id}:${date}:${driver.driver_id}`);
      let t = berlinInstant(date, 8) + between(0, 90) * 60000;
      const stops = [];
      let reportCount = 0, sentCount = 0;
      const shiftStart = chance(0.6);
      if (shiftStart) {
        const answered = chance(0.55);
        sentCount++;
        outreach.push(row('shift_start', 'voice', answered ? 'answered' : 'sent', t - 5 * 60000, t - 5 * 60000 + 12000, answered ? t - 5 * 60000 + 40000 : null, answered ? Math.round(between(30, 90)) : null, driver, null, tourId, 1, answered ? 1 : 0, 0, null));
      }
      for (const s of route.stops) {
        const ch = characterOf(s.place_id);
        t += (route.walking ? between(45, 180) : between(90, 360)) * 1000;
        const arrival = t;
        const dwell = Math.round(lognormal(45, 420) * (ch.propensity > 2 ? 1.5 : 1));
        const failed = chance(Math.min(0.25, 0.03 * ch.propensity));
        const completedAt = failed ? null : arrival + dwell * 1000;
        t = arrival + dwell * 1000;
        let stopReports = 0;
        if (chance(Math.min(0.6, 0.06 * ch.propensity))) {
          const category = chance(0.6) ? ch.category : pick(CATEGORIES);
          const at = (completedAt || arrival) + 30000;
          reports.push({
            report_id: nextId('report'), category, summary: summaryFor(s.place_id, category),
            occurred_at: isoInstant(at), created_at: isoInstant(at + between(20, 120) * 1000),
            place_id: s.place_id, place_label: s.label, driver: { driver_id: driver.driver_id, name: driver.name },
            tour_id: tourId, service_date: date, stop_id: s.stop_id, parcel_id: uuidFrom(`parcel:${tourId}:${s.stop_id}`),
            channel: chance(0.75) ? 'voice' : 'sms',
            location: { lat: round5(s.lat + between(-0.00015, 0.00015)), lng: round5(s.lng + between(-0.00025, 0.00025)) },
            location_source: chance(0.7) ? 'scan' : 'trace_correlation', location_status: 'resolved',
            media_count: chance(0.15) ? 1 : 0, superseded: false, invented: true,
          });
          stopReports++;
          reportCount++;
        }
        /* pre-stop outreach: Otto asks before the door, sometimes skipped */
        if (chance(0.12)) {
          const skipped = chance(0.22);
          const answered = !skipped && chance(0.72);
          if (!skipped) sentCount++;
          outreach.push(row('pre_stop', chance(0.55) ? 'voice' : 'sms', skipped ? 'skipped' : answered ? 'answered' : 'sent',
            arrival - 4 * 60000, skipped ? null : arrival - 4 * 60000 + 9000, answered ? arrival - 3 * 60000 : null,
            answered ? Math.round(between(20, 70)) : null, driver, s.place_id, tourId, skipped ? 0 : 1, answered ? 1 : 0, answered && chance(0.25) ? 1 : 0,
            skipped ? pick(['budget_exceeded', 'budget_exceeded', 'low_confidence', 'driver_unreachable', 'tour_closed']) : null));
        }
        /* post-stop outreach: after a long door or a report */
        if (stopReports || dwell > 300) {
          const answered = chance(0.8);
          sentCount++;
          outreach.push(row('post_stop', 'voice', answered ? 'answered' : chance(0.05) ? 'failed' : 'sent',
            t + 30000, t + 44000, answered ? t + 69000 : null, answered ? Math.round(between(40, 120)) : null,
            driver, s.place_id, tourId, 2, answered ? 2 : 0, stopReports, null));
        }
        stops.push({
          stop_id: s.stop_id, sequence: s.sequence, place_id: s.place_id, address: s.address,
          completed_at: completedAt ? isoInstant(completedAt) : null,
          dwell_seconds: completedAt ? dwell : null, parcel_count: 1, report_count: stopReports,
          arrived_at: isoInstant(arrival), outcome: failed ? 'failed' : 'delivered',
        });
      }
      if (chance(0.15)) {
        const answered = chance(0.5);
        sentCount++;
        outreach.push(row('hotspot_sweep', 'voice', answered ? 'answered' : 'sent', t + 600000, t + 600000 + 15000,
          answered ? t + 600000 + 60000 : null, answered ? Math.round(between(60, 180)) : null, driver, pick(route.stops).place_id, tourId,
          3, answered ? 3 : 0, answered ? 1 + (chance(0.4) ? 1 : 0) : 0, null));
      }
      const alerts = chance(0.5) ? 1 : chance(0.3) ? 2 : 0;
      for (let i = 0; i < alerts; i++) {
        const answered = chance(0.65);
        gapAlerts.push({
          at: isoInstant(berlinInstant(date, 8) + between(60, 420) * 60000), driver_id: driver.driver_id, tour_id: tourId,
          outcome: !answered ? 'no_answer' : chance(0.43) ? 'confirmed_issue' : 'false_positive', invented: true,
        });
      }
      const done = stops.filter((s) => s.completed_at);
      const scans = done.map((s) => Date.parse(s.completed_at));
      const abandoned = chance(0.03);
      const kept = abandoned ? stops.slice(0, Math.max(1, Math.floor(stops.length * between(0.3, 0.7)))) : stops;
      const keptDone = kept.filter((s) => s.completed_at);
      const keptScans = keptDone.map((s) => Date.parse(s.completed_at));
      if (abandoned) for (const s of stops.slice(kept.length)) { s.completed_at = null; s.dwell_seconds = null; s.outcome = 'skipped'; }
      tours.push({
        tour_id: tourId, service_date: date, status: abandoned ? 'abandoned' : 'closed',
        driver: { driver_id: driver.driver_id, name: driver.name }, route_id: route.id,
        stop_count: stops.length, completed_count: keptDone.length, report_count: reportCount,
        first_scan_at: keptScans.length ? isoInstant(Math.min(...keptScans)) : null,
        last_scan_at: keptScans.length ? isoInstant(Math.max(...keptScans)) : null,
        active_minutes: keptScans.length ? Math.round((Math.max(...keptScans) - Math.min(...keptScans)) / 60000) : 0,
        gap_alerts: alerts, outreach_sent: sentCount, stops, invented: true,
      });
      void scans;
    });
  }

  /* Questions: one per real scenario that asks something, versioned like the
   * scenario, asked at the scenario's own pin over the history window. */
  const questions = [];
  for (const sc of scenarios) {
    const prompt = String(sc.otto_says || '').replace(/^[“”"']+|[“”"']+$/g, '').trim();
    if (!prompt) continue;
    const qid = uuidFrom('question:' + sc.id);
    const version = Math.max(1, Number(sc.version) || 1);
    const placeId = sc.place_id || null;
    for (let v = 1; v <= version; v++) {
      const current = v === version;
      const older = version - v; // how many versions back
      const windowStart = now - historyDays * DAY_MS * (1 - (v - 1) / version);
      const windowEnd = current ? now : now - historyDays * DAY_MS * (1 - v / version);
      const retiredAt = current ? null : isoInstant(windowEnd);
      const asked = Math.round(between(current ? 25 : 8, current ? 70 : 30));
      const events = [];
      for (let i = 0; i < asked; i++) {
        const at = windowStart + rand() * Math.max(1, windowEnd - windowStart);
        const answered = chance(current ? 0.82 : 0.68);
        events.push({ at: isoInstant(at), answered, novel: answered && chance(current ? 0.24 : 0.16), answer_seconds: answered ? Math.round(between(5, 18)) : null });
      }
      const history = Array.isArray(sc.history) ? sc.history.find((h) => Number(h.version) === v) : null;
      const oldPrompt = history && history.fields && history.fields.otto_says ? String(history.fields.otto_says).replace(/^[“”"']+|[“”"']+$/g, '').trim() : null;
      questions.push({ question_id: qid, version: v, prompt: current ? prompt : oldPrompt || (older > 0 ? shorten(prompt) : prompt), place_id: placeId, retired_at: retiredAt, events, invented: true });
    }
  }
  /* a question per place character too, so /metrics/questions has more than one row */
  for (const cat of CATEGORIES) {
    const qid = uuidFrom('question:generic:' + cat);
    const events = [];
    const asked = Math.round(between(20, 60));
    for (let i = 0; i < asked; i++) {
      const at = now - rand() * historyDays * DAY_MS;
      const answered = chance(0.75);
      events.push({ at: isoInstant(at), answered, novel: answered && chance(0.2), answer_seconds: answered ? Math.round(between(6, 16)) : null });
    }
    questions.push({ question_id: qid, version: 1, prompt: QUESTION_PROMPTS[cat], place_id: null, retired_at: null, events, invented: true });
  }

  return { drivers, tours, reports, outreach, gapAlerts, questions, characterOf, startDay };

  function row(trigger, channel, state, scheduledFor, sentAt, answeredAt, duration, driver, placeId, tourId, asked, answered, created, skipReason) {
    return {
      outreach_id: nextId('outreach'), trigger, channel, state,
      scheduled_for: isoInstant(scheduledFor), sent_at: sentAt ? isoInstant(sentAt) : null,
      answered_at: answeredAt ? isoInstant(answeredAt) : null, duration_seconds: duration,
      driver: { driver_id: driver.driver_id, name: driver.name }, place_id: placeId, tour_id: tourId,
      questions_asked: asked, questions_answered: answered, reports_created: created,
      skip_reason: skipReason && SKIP_REASONS.includes(skipReason) ? skipReason : null, invented: true,
    };
  }
}

const round5 = (x) => Number(x.toFixed(5));
const shorten = (s) => s.split(/[,—-]/)[0].trim().replace(/\?*$/, '?');
