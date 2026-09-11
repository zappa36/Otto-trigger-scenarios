/*
 * The data behind the mock.
 *
 * Two layers, always tellable apart:
 *
 *   real      — the rows the Otto phone and the trigger dashboard write to the
 *               shared Supabase store (destinations, messages, visits,
 *               scenarios, runs), reshaped into the contract's places,
 *               reports, guidance, tours, outreach and gap alerts. One real
 *               driver: the tester.
 *   invented  — the history the phone cannot have produced yet (invent.mjs):
 *               a crew of drivers working the same routes for the last N
 *               days. Every invented row carries invented: true.
 *
 * buildModel() is pure — rows in, model out — so the tests feed it fixtures
 * and the server feeds it the live store, refreshed every minute.
 */
import { readFileSync } from 'node:fs';
import { CATEGORIES, GUIDANCE_KINDS, isUuid, isoInstant, serviceDateOf, uuidFrom } from './contract.mjs';
import { classifyText, invent } from './invent.mjs';

export { classifyText };

const OLD_LABELS = {
  ACCESS: 'access', ENTRANCE: 'access', CLOSURE: 'hazard', HAZARD: 'hazard',
  HOURS: 'recipient', INFO: 'other', PARKING: 'parking',
};

/** The contract's category for whatever the row carries — today's labels, the old ones, or free text. */
export function normCategory(raw, text) {
  const s = String(raw || '').trim();
  if (CATEGORIES.includes(s)) return s;
  if (OLD_LABELS[s.toUpperCase()]) return OLD_LABELS[s.toUpperCase()];
  if (CATEGORIES.includes(s.toLowerCase())) return s.toLowerCase();
  return classifyText(text || '');
}

/** One door = one place. Same street + number (+ postcode) is one place however
 *  the geocoder spelled the rest, so a scenario pin and a route stop at the same
 *  address land on the same place. No address at all → the rounded position. */
export function placeKey(d) {
  const addr = String(d.addr || '').trim();
  if (addr) {
    const s = addr.toLowerCase()
      .replace(/germany|deutschland/g, '')
      .replace(/berlin-bezirk [a-zäöüß-]+/g, '')
      .replace(/bezirk [a-zäöüß-]+/g, '');
    const pc = (s.match(/\b\d{5}\b/) || [])[0] || '';
    const streetNum = (s.match(/^\s*([^,\d]*?\d+\s?[a-z]?)\b/) || [])[1] || s.split(',')[0];
    return `${streetNum.replace(/\s+/g, ' ').trim()}|${pc}`;
  }
  return `${Number(d.lat).toFixed(4)},${Number(d.lng).toFixed(4)}`;
}

export function notesOf(row) {
  let n = row && row.notes;
  if (typeof n === 'string') { try { n = JSON.parse(n); } catch { n = null; } }
  return Array.isArray(n) ? n.filter((x) => x && String(x.text || '').trim()) : [];
}

const TRIGGER_FOR_SCENARIO = (title) =>
  /approach|blocked|crawl|street/i.test(String(title || '')) ? 'pre_stop' : 'post_stop';

const guidanceKind = (text) =>
  /\?\s*$/.test(text) ? 'ask' : /closed|blocked|danger|hazard|caution|works|construction|scaffold|ice|dog/i.test(text) ? 'warn' : 'instruct';

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const shortest = (titles) => titles.filter(Boolean).sort((a, b) => a.length - b.length)[0] || 'Stop';

/**
 * @param rows  { destinations, messages, visits, scenarios, runs } — the store's tables
 * @param opts  { realDriverName, invented, driverNames, historyDays, seed, routes, now }
 */
export function buildModel(rows, opts) {
  const now = opts.now ?? Date.now();
  const destinations = rows.destinations || [], messages = rows.messages || [], visits = rows.visits || [];
  const scenarios = rows.scenarios || [], runs = rows.runs || [];
  const routeMeta = opts.routes || {};
  const realDriver = { driver_id: uuidFrom('driver:real:' + opts.realDriverName), name: opts.realDriverName };

  /* ---------- places: one per door ---------- */
  const placeByKey = new Map();
  const placeOfDest = new Map();
  for (const d of destinations) {
    const lat = num(d.lat), lng = num(d.lng);
    if (lat == null || lng == null) continue;
    const key = placeKey(d);
    let p = placeByKey.get(key);
    if (!p) {
      p = { place_id: uuidFrom('place:' + key), key, rows: [] };
      placeByKey.set(key, p);
    }
    p.rows.push(d);
    placeOfDest.set(d.id, p);
  }
  const places = [...placeByKey.values()].map((p) => {
    /* a route stop is titled by its address; a scenario pin by its story — the address names the place */
    const routeTitles = p.rows.filter((r) => r.route).map((r) => r.title);
    p.label = shortest(routeTitles.length ? routeTitles : p.rows.map((r) => r.title));
    p.address = p.rows.map((r) => r.addr).filter(Boolean).sort((a, b) => a.length - b.length)[0] || null;
    p.location = { lat: round5(avg(p.rows.map((r) => num(r.lat)))), lng: round5(avg(p.rows.map((r) => num(r.lng)))) };
    return p;
  }).sort((a, b) => (a.place_id < b.place_id ? -1 : 1));

  /* ---------- routes on file: the stop lists tours are built from ---------- */
  const routeRows = new Map();
  for (const d of destinations) {
    if (!d.route || !placeOfDest.has(d.id)) continue;
    (routeRows.get(d.route) || routeRows.set(d.route, []).get(d.route)).push(d);
  }
  const routes = [...routeRows.entries()].map(([id, ds]) => {
    ds.sort((a, b) => (num(a.stop) ?? 1e9) - (num(b.stop) ?? 1e9) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const meta = routeMeta[id] || {};
    return {
      id, name: meta.name || id, walking: meta.walking ?? ds.length <= 20,
      stops: ds.map((d, i) => {
        const p = placeOfDest.get(d.id);
        return { stop_id: d.id, sequence: num(d.stop) ?? i + 1, place_id: p.place_id, address: d.addr || p.address, label: p.label, lat: num(d.lat), lng: num(d.lng) };
      }),
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const routeById = new Map(routes.map((r) => [r.id, r]));

  /* ---------- guidance: what dispatch put on file ---------- */
  const guidance = [];
  for (const d of destinations) {
    const p = placeOfDest.get(d.id);
    if (!p) continue;
    for (const n of notesOf(d)) {
      if (n.by === 'driver') continue;
      const body = String(n.text).trim();
      guidance.push({
        guidance_id: uuidFrom(`guidance:${n.id || ''}:${p.place_id}:${body}`), place_id: p.place_id,
        kind: guidanceKind(body), body, status: 'active', valid_from: n.at ? isoInstant(Date.parse(n.at)) : null, valid_until: null, invented: false,
      });
    }
  }

  /* ---------- tours: the tester's walks, from the Delivered taps ---------- */
  const messagesByDest = new Map();
  for (const m of messages) {
    if (!m || m.demo || !m.destination_id || !(m.title || m.transcript)) continue;
    (messagesByDest.get(m.destination_id) || messagesByDest.set(m.destination_id, []).get(m.destination_id)).push(m);
  }
  const firedRuns = runs.filter((r) => r && r.fired && (r.fired_at || r.started_at || r.created_at));
  const runDay = (r) => serviceDateOf(Date.parse(r.fired_at || r.started_at || r.created_at));

  const visitGroups = new Map();
  for (const v of visits) {
    const d = placeOfDest.get(v.destination_id);
    const route = v.route || (d && d.rows.find((r) => r.id === v.destination_id) || {}).route;
    if (!route || !routeById.has(route) || !v.delivered_at) continue;
    const key = `${route}|${serviceDateOf(Date.parse(v.delivered_at))}`;
    (visitGroups.get(key) || visitGroups.set(key, []).get(key)).push(v);
  }
  const tours = [];
  const tourByRouteDay = new Map();
  for (const [key, vs] of visitGroups) {
    const [routeId, date] = key.split('|');
    const route = routeById.get(routeId);
    const latest = new Map();
    for (const v of vs) {
      const had = latest.get(v.destination_id);
      if (!had || String(v.created_at || v.delivered_at) > String(had.created_at || had.delivered_at)) latest.set(v.destination_id, v);
    }
    const stops = route.stops.map((s) => {
      const v = latest.get(s.stop_id);
      const delivered = v && v.outcome !== 'failed';
      const completedAt = delivered ? Date.parse(v.delivered_at) : null;
      const arrivedAt = v && v.arrived_at ? Date.parse(v.arrived_at) : null;
      const reportsHere = (messagesByDest.get(s.stop_id) || []).filter((m) => serviceDateOf(Date.parse(m.created_at)) === date).length;
      return {
        stop_id: s.stop_id, sequence: s.sequence, place_id: s.place_id, address: s.address,
        completed_at: completedAt ? isoInstant(completedAt) : null,
        dwell_seconds: completedAt && arrivedAt && completedAt > arrivedAt ? Math.round((completedAt - arrivedAt) / 1000) : null,
        parcel_count: 1, report_count: reportsHere,
        arrived_at: arrivedAt ? isoInstant(arrivedAt) : null, outcome: v ? (delivered ? 'delivered' : 'failed') : 'none',
      };
    });
    const scans = stops.filter((s) => s.completed_at).map((s) => Date.parse(s.completed_at));
    const lastTap = Math.max(...vs.map((v) => Date.parse(v.delivered_at)));
    const allVisited = stops.every((s) => s.outcome !== 'none');
    const status = allVisited ? 'closed' : now - lastTap < 3 * 3600000 ? 'active' : 'abandoned';
    const tourId = uuidFrom(`tour:real:${routeId}:${date}:${realDriver.driver_id}`);
    const stopIds = new Set(route.stops.map((s) => s.stop_id));
    const tour = {
      tour_id: tourId, service_date: date, status, driver: realDriver, route_id: routeId, route_name: route.name,
      stop_count: stops.length, completed_count: stops.filter((s) => s.completed_at).length,
      report_count: stops.reduce((n, s) => n + s.report_count, 0),
      first_scan_at: scans.length ? isoInstant(Math.min(...scans)) : null,
      last_scan_at: scans.length ? isoInstant(Math.max(...scans)) : null,
      active_minutes: scans.length ? Math.round((Math.max(...scans) - Math.min(...scans)) / 60000) : 0,
      gap_alerts: firedRuns.filter((r) => runDay(r) === date && stopIds.has(r.destination_id)).length,
      outreach_sent: firedRuns.filter((r) => runDay(r) === date).length,
      stops, invented: false,
    };
    tours.push(tour);
    tourByRouteDay.set(key, tour);
  }

  /* ---------- reports: what the tester told Otto ---------- */
  const reports = [];
  for (const m of messages) {
    if (!m || m.demo || !(m.title || m.transcript)) continue;
    const p = m.destination_id ? placeOfDest.get(m.destination_id) : null;
    const row = p && p.rows.find((r) => r.id === m.destination_id);
    const at = Date.parse(m.created_at);
    const tour = row && row.route ? tourByRouteDay.get(`${row.route}|${serviceDateOf(at)}`) : null;
    const lat = num(m.lat), lng = num(m.lng);
    reports.push({
      report_id: isUuid(m.id) ? m.id : uuidFrom('report:' + m.id),
      category: normCategory(m.category, m.title || m.transcript),
      summary: String(m.title || m.transcript).trim().slice(0, 140),
      occurred_at: isoInstant(at), created_at: isoInstant(at),
      place_id: p ? p.place_id : null, place_label: p ? p.label : null,
      driver: realDriver, tour_id: tour ? tour.tour_id : null, service_date: tour ? tour.service_date : null,
      stop_id: row ? row.id : null, parcel_id: null,
      channel: 'voice',
      location: lat != null && lng != null ? { lat: round5(lat), lng: round5(lng) } : null,
      location_source: lat != null && lng != null ? 'trace_correlation' : 'none',
      location_status: p ? 'resolved' : 'pending',
      media_count: 0, superseded: false, invented: false,
      transcript: m.transcript || null, scenario_id: null, ar_summary: m.ar_summary || null,
    });
  }

  /* ---------- outreach + gap alerts: every tracked run ---------- */
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const outreach = [], gapAlerts = [];
  for (const r of runs) {
    if (!r) continue;
    const sc = scenarioById.get(r.scenario_id);
    const p = r.destination_id ? placeOfDest.get(r.destination_id) : null;
    const row = p && p.rows.find((x) => x.id === r.destination_id);
    const at = Date.parse(r.fired_at || r.started_at || r.created_at);
    if (!Number.isFinite(at)) continue;
    const answer = r.fired && r.destination_id
      ? (messagesByDest.get(r.destination_id) || []).find((m) => { const t = Date.parse(m.created_at); return t >= at - 60000 && t <= at + 45 * 60000; })
      : null;
    const tour = row && row.route ? tourByRouteDay.get(`${row.route}|${serviceDateOf(at)}`) : null;
    outreach.push({
      outreach_id: isUuid(r.id) ? r.id : uuidFrom('outreach:' + r.id),
      trigger: TRIGGER_FOR_SCENARIO(sc && sc.title), channel: 'voice',
      state: r.fired ? (answer ? 'answered' : 'sent') : 'skipped',
      scheduled_for: isoInstant(at), sent_at: r.fired ? isoInstant(at) : null,
      answered_at: answer ? isoInstant(Date.parse(answer.created_at)) : null, duration_seconds: null,
      driver: realDriver, place_id: p ? p.place_id : null, tour_id: tour ? tour.tour_id : null,
      questions_asked: r.fired ? 1 : 0, questions_answered: answer ? 1 : 0, reports_created: answer ? 1 : 0,
      skip_reason: r.fired ? null : 'low_confidence', invented: false,
    });
    if (r.fired) {
      const v = String(r.verdict || '');
      gapAlerts.push({
        at: isoInstant(at), driver_id: realDriver.driver_id, tour_id: tour ? tour.tour_id : null,
        outcome: v === 'false_alarm' ? 'false_positive' : ['on_time', 'early', 'late'].includes(v) ? 'confirmed_issue' : 'no_answer', invented: false,
      });
    }
  }

  /* ---------- questions: the scenarios' own questions, asked on the runs ---------- */
  const realQuestionEvents = new Map();
  for (const r of runs) {
    if (!r || !r.fired || !r.scenario_id) continue;
    const at = Date.parse(r.fired_at || r.started_at || r.created_at);
    if (!Number.isFinite(at)) continue;
    const answered = !!(r.destination_id && (messagesByDest.get(r.destination_id) || []).some((m) => { const t = Date.parse(m.created_at); return t >= at - 60000 && t <= at + 45 * 60000; }));
    const key = `${r.scenario_id}|${r.scenario_version || (scenarioById.get(r.scenario_id) || {}).version || 1}`;
    (realQuestionEvents.get(key) || realQuestionEvents.set(key, []).get(key)).push({ at: isoInstant(at), answered, novel: answered, answer_seconds: answered ? 12 : null, invented: false });
  }

  /* ---------- the invented history on top ---------- */
  const scenariosWithPlace = scenarios.map((sc) => ({ ...sc, place_id: (sc.destination_id && placeOfDest.get(sc.destination_id) || {}).place_id || null }));
  const inv = opts.invented
    ? invent({ routes, places, scenarios: scenariosWithPlace, driverNames: opts.driverNames || [], historyDays: opts.historyDays || 90, seed: opts.seed || 'parcelvox', now })
    : { drivers: [], tours: [], reports: [], outreach: [], gapAlerts: [], questions: [], characterOf: () => ({ pooled: 'none' }) };

  /* driver-left notes on file read like debriefs from earlier tours — they
   * become reports by the invented crew (a real one already has a real row) */
  const noteReports = [];
  if (inv.drivers.length) {
    for (const d of destinations) {
      const p = placeOfDest.get(d.id);
      if (!p) continue;
      notesOf(d).filter((n) => n.by === 'driver').forEach((n, i) => {
        const driver = inv.drivers[(hashCode(n.text) + i) % inv.drivers.length];
        const at = n.at ? Date.parse(n.at) : now - 7 * 86400000;
        noteReports.push({
          report_id: uuidFrom(`report:note:${d.id}:${n.id || i}`), category: classifyText(n.text), summary: String(n.text).trim().slice(0, 140),
          occurred_at: isoInstant(at), created_at: isoInstant(at), place_id: p.place_id, place_label: p.label,
          driver: { driver_id: driver.driver_id, name: driver.name }, tour_id: null, service_date: null, stop_id: d.id, parcel_id: null,
          channel: 'voice', location: { lat: round5(num(d.lat)), lng: round5(num(d.lng)) }, location_source: 'scan', location_status: 'resolved',
          media_count: 0, superseded: false, invented: true,
        });
      });
    }
  }

  /* questions: real events merged onto the invented rows of the same version */
  const questions = inv.questions.map((q) => ({ ...q, events: [...q.events] }));
  for (const [key, events] of realQuestionEvents) {
    const [scenarioId, version] = key.split('|');
    const qid = uuidFrom('question:' + scenarioId);
    let q = questions.find((x) => x.question_id === qid && x.version === Number(version));
    if (!q) {
      const sc = scenariosWithPlace.find((s) => s.id === scenarioId) || {};
      q = { question_id: qid, version: Number(version), prompt: String(sc.otto_says || '').replace(/^[“”"']+|[“”"']+$/g, '').trim() || 'Question', place_id: sc.place_id || null, retired_at: null, events: [], invented: false };
      questions.push(q);
    }
    q.events.push(...events);
  }

  for (const p of places) p.pooled_reports = inv.characterOf(p.place_id).pooled || 'none';

  return {
    asOf: isoInstant(now), now, realDriver,
    drivers: [realDriver, ...inv.drivers],
    places, placeOfDest, routes, guidance,
    reports: [...reports, ...noteReports, ...inv.reports],
    tours: [...tours, ...inv.tours],
    outreach: [...outreach, ...inv.outreach],
    gapAlerts: [...gapAlerts, ...inv.gapAlerts],
    questions,
    scenarios: scenariosWithPlace,
    counts: {
      places: places.length, routes: routes.length,
      reports: { real: reports.length, invented: noteReports.length + inv.reports.length },
      tours: { real: tours.length, invented: inv.tours.length },
      outreach: { real: outreach.length, invented: inv.outreach.length },
      guidance: guidance.length,
    },
  };
}

const round5 = (x) => Number(Number(x).toFixed(5));
const hashCode = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/* ---------- loading the rows ---------- */

export async function fetchStoreRows({ supabaseUrl, supabaseKey }) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const headers = { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey };
  const get = async (table, optional = false) => {
    const r = await fetch(`${url}/rest/v1/${table}?select=*&limit=5000`, { headers });
    if (!r.ok) {
      if (optional) return [];
      throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    return r.json();
  };
  const [destinations, messages, scenarios, runs, visits] = await Promise.all([
    get('destinations'), get('messages'), get('scenarios'), get('runs', true), get('visits', true),
  ]);
  return { destinations, messages, scenarios, runs, visits };
}

export class Source {
  constructor(opts) {
    this.opts = opts;
    this.model = null;
    this.loadedAt = 0;
    this.kind = opts.fixture ? 'fixture' : 'supabase';
  }
  async load() {
    const rows = this.opts.fixture ? JSON.parse(readFileSync(this.opts.fixture, 'utf8')) : await fetchStoreRows(this.opts);
    this.model = buildModel(rows, { ...this.opts, now: Date.now() });
    this.loadedAt = Date.now();
    return this.model;
  }
  /** The model, reloaded when older than refreshMs; a failed refresh keeps the last good one. */
  async fresh() {
    if (!this.model || Date.now() - this.loadedAt > (this.opts.refreshMs ?? 60000)) {
      try {
        await this.load();
      } catch (e) {
        if (!this.model) throw e;
        console.warn('refresh failed, serving the previous snapshot:', e.message);
        this.loadedAt = Date.now();
      }
    }
    return this.model;
  }
}

export { GUIDANCE_KINDS };
