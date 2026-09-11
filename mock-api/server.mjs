#!/usr/bin/env node
/*
 * Parcelvox Analytics API — the mock server.
 *
 * Serves the contract (base path /v1/analytics) from the model in
 * source.mjs: the Otto app's real rows from the shared store, with the
 * invented history from invent.mjs on top. Conventions the contract asks
 * for are all here — bearer keys with the analytics:read scope, UTC
 * instants, from/to on every collection, the { data, meta } envelope,
 * keyset cursors that actually paginate, the error envelope and codes,
 * 422s for oversized ranges and radii, and a few hundred milliseconds of
 * latency so loading states get exercised.
 *
 *   node server.mjs                # http://localhost:8787/v1/analytics
 *   PORT=9000 MOCK_LATENCY=0 node server.mjs
 *   MOCK_FIXTURE=test/fixture.json node server.mjs   # rows from a file, no store
 *
 * GET / (outside the base path) is a status page: what is loaded, real vs
 * invented counts, the key to use.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import * as C from './contract.mjs';
import { Source } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(path.join(HERE, 'seed.json'), 'utf8'));
const env = process.env;

export const BASE_PATH = '/v1/analytics';
const PORT = Number(env.PORT || 8787);
const KEYS = String(env.MOCK_API_KEYS || (seed.api_keys || []).join(',') || 'pvx_dev_analytics_read')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LATENCY = parseLatency(env.MOCK_LATENCY ?? seed.latency_ms ?? '200-800');

/* The kit's own project — the same pair config.js carries (publishable key, public by design). */
const SUPABASE_URL = env.MOCK_SUPABASE_URL || env.SUPABASE_URL || 'https://lgyycoxsqrnhawzlqxlq.supabase.co';
const SUPABASE_KEY = env.MOCK_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || 'sb_publishable_UhActVk58ukgC6On1z9yuw_IbsMeWJf';

export function makeSource(overrides = {}) {
  const fixture = overrides.fixture ?? env.MOCK_FIXTURE ?? null;
  return new Source({
    supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY,
    fixture: fixture ? path.resolve(fixture) : null,
    realDriverName: env.MOCK_REAL_DRIVER || (seed.real_driver && seed.real_driver.name) || 'Otto tester',
    invented: env.MOCK_INVENTED != null ? env.MOCK_INVENTED !== '0' : seed.invented !== false,
    driverNames: seed.invented_drivers || [],
    historyDays: Number(env.MOCK_HISTORY_DAYS || seed.history_days || 90),
    seed: env.MOCK_SEED || seed.seed || 'parcelvox',
    routes: seed.routes || {},
    refreshMs: Number(env.MOCK_REFRESH_S || seed.refresh_seconds || 60) * 1000,
    ...overrides,
  });
}

function parseLatency(v) {
  const s = String(v).trim();
  if (!s || s === '0') return [0, 0];
  const [a, b] = s.split('-').map(Number);
  return [a || 0, b || a || 0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- reading the model ---------- */

const t = (iso) => Date.parse(iso);
const inRange = (iso, from, to) => { const x = t(iso); return x >= from && x < to; };
/* Internal fields never leave; `invented` does — the one documented extension that
 * tells the dashboard which rows are the tester's and which the invented crew's. */
const pub = (row, drop = ['rows', 'key', 'events', 'arrived_at', 'outcome', 'transcript', 'scenario_id', 'ar_summary']) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!drop.includes(k)) out[k] = v;
  return out;
};
const reportsAt = (model, placeId, from, to) => model.reports.filter((r) => r.place_id === placeId && inRange(r.occurred_at, from, to));
const deliveriesAt = (model, placeId, from, to) => {
  const out = [];
  for (const tour of model.tours) for (const s of tour.stops) if (s.place_id === placeId && s.completed_at && inRange(s.completed_at, from, to)) out.push({ ...s, driver_id: tour.driver.driver_id });
  return out;
};
const activeGuidanceAt = (model, placeId) => model.guidance.filter((g) => g.place_id === placeId && g.status === 'active' && (!g.valid_until || t(g.valid_until) > model.now));
function topCategories(reports) {
  const counts = new Map();
  for (const r of reports) counts.set(r.category, (counts.get(r.category) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([category, count]) => ({ category, count }));
}
function placeRow(model, p, from, to) {
  const reps = reportsAt(model, p.place_id, from, to);
  const times = reps.map((r) => t(r.occurred_at));
  return {
    place_id: p.place_id, label: p.label, address: p.address, location: p.location,
    report_count: reps.length,
    distinct_drivers: new Set(reps.map((r) => r.driver.driver_id)).size,
    pooled_reports: p.pooled_reports || 'none',
    top_categories: topCategories(reps).slice(0, 3),
    first_report_at: times.length ? C.isoInstant(Math.min(...times)) : null,
    last_report_at: times.length ? C.isoInstant(Math.max(...times)) : null,
    has_active_guidance: activeGuidanceAt(model, p.place_id).length > 0,
    media_count: reps.reduce((n, r) => n + (r.media_count || 0), 0),
  };
}
const networkMedianDwell = (model, from, to) => {
  const all = [];
  for (const tour of model.tours) for (const s of tour.stops) if (s.dwell_seconds != null && s.completed_at && inRange(s.completed_at, from, to)) all.push(s.dwell_seconds);
  return C.median(all);
};
const tourInRange = (tour, from, to) => tour.first_scan_at
  ? inRange(tour.first_scan_at, from, to)
  : C.berlinInstant(tour.service_date, 12) >= from && C.berlinInstant(tour.service_date, 12) < to;
const tourSummary = (tour) => pub(tour, ['stops']);
const tourDetail = (tour) => ({ ...pub(tour), stops: tour.stops.map((s) => pub(s)) });
const envelope = (model, data, next = null) => ({ data, meta: { as_of: model.asOf, next_cursor: next } });
const pad = (n) => String(Math.round(n)).padStart(8, '0');

/* ---------- handlers ---------- */

function listTours(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const drivers = C.parseEnumList(q, 'driver_id');
  const statuses = C.parseEnumList(q, 'status', C.TOUR_STATUSES);
  const sdFrom = C.parseDate(q.get('service_date_from'), 'service_date_from');
  const sdTo = C.parseDate(q.get('service_date_to'), 'service_date_to');
  const rows = model.tours
    .filter((x) => tourInRange(x, from, to))
    .filter((x) => !drivers.length || drivers.includes(x.driver.driver_id))
    .filter((x) => !statuses.length || statuses.includes(x.status))
    .filter((x) => (!sdFrom || x.service_date >= sdFrom) && (!sdTo || x.service_date <= sdTo))
    .sort(C.byDesc((x) => [x.service_date + (x.first_scan_at || ''), x.tour_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (x) => [x.service_date + (x.first_scan_at || ''), x.tour_id]);
  return envelope(model, page.map(tourSummary), next);
}

function getTour(model, q, [id]) {
  const tour = model.tours.find((x) => x.tour_id === id);
  if (!tour) throw new C.ApiError(404, 'not_found', `no tour ${id}`);
  return envelope(model, tourDetail(tour));
}

function driverRow(model, d, from, to) {
  const tours = model.tours.filter((x) => x.driver.driver_id === d.driver_id && tourInRange(x, from, to));
  const reports = model.reports.filter((r) => r.driver.driver_id === d.driver_id && inRange(r.occurred_at, from, to));
  const out = model.outreach.filter((o) => o.driver.driver_id === d.driver_id && inRange(o.scheduled_for, from, to));
  const alerts = model.gapAlerts.filter((g) => g.driver_id === d.driver_id && inRange(g.at, from, to));
  const stopCount = tours.reduce((n, x) => n + x.stop_count, 0);
  const lastTimes = [...tours.map((x) => x.last_scan_at), ...reports.map((r) => r.occurred_at), ...out.map((o) => o.answered_at || o.sent_at)].filter(Boolean).map(t);
  return {
    driver_id: d.driver_id, name: d.name,
    tour_count: tours.length, stop_count: stopCount, report_count: reports.length,
    reports_per_100_stops: stopCount ? C.round((reports.length / stopCount) * 100, 2) : null,
    outreach_sent: out.filter((o) => ['sent', 'answered', 'failed'].includes(o.state)).length,
    outreach_answered: out.filter((o) => o.state === 'answered').length,
    gap_alerts: alerts.length,
    channels_used: [...new Set([...reports.map((r) => r.channel), ...out.map((o) => o.channel)])].sort(),
    last_active_at: lastTimes.length ? C.isoInstant(Math.max(...lastTimes)) : null,
    _active: tours.length + reports.length + out.length > 0,
  };
}

function listDrivers(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const rows = model.drivers.map((d) => driverRow(model, d, from, to)).filter((r) => r._active)
    .sort(C.byDesc((r) => [pad(r.report_count) + r.name, r.driver_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [pad(r.report_count) + r.name, r.driver_id]);
  return envelope(model, page.map((r) => pub(r, ['_active'])), next);
}

function getDriver(model, q, [id]) {
  const d = model.drivers.find((x) => x.driver_id === id);
  if (!d) throw new C.ApiError(404, 'not_found', `no driver ${id}`);
  const { from, to } = C.parseRange(q);
  const row = pub(driverRow(model, d, from, to), ['_active']);
  const recent = model.tours.filter((x) => x.driver.driver_id === id && tourInRange(x, from, to))
    .sort(C.byDesc((x) => [x.service_date + (x.first_scan_at || ''), x.tour_id])).slice(0, 20).map(tourSummary);
  return envelope(model, { ...row, recent_tours: recent });
}

function listPlaces(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const geo = C.parseGeo(q);
  const cats = C.parseEnumList(q, 'category', C.CATEGORIES);
  const minReports = C.parseInt0(q, 'min_report_count', 0);
  const rows = model.places.map((p) => placeRow(model, p, from, to))
    .filter((r) => C.inGeo(geo, r.location))
    .filter((r) => r.report_count >= minReports)
    .filter((r) => !cats.length || reportsAt(model, r.place_id, from, to).some((x) => cats.includes(x.category)))
    .sort(C.byDesc((r) => [pad(r.report_count) + r.label, r.place_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [pad(r.report_count) + r.label, r.place_id]);
  return envelope(model, page, next);
}

function findPlace(model, id) {
  const p = model.places.find((x) => x.place_id === id);
  if (!p) throw new C.ApiError(404, 'not_found', `no place ${id}`);
  return p;
}

function getPlace(model, q, [id]) {
  const p = findPlace(model, id);
  const { from, to } = C.parseRange(q);
  const interval = q.get('interval') ? C.parseInterval(q) : 'month';
  const row = placeRow(model, p, from, to);
  const deliveries = deliveriesAt(model, id, from, to);
  const reps = reportsAt(model, id, from, to);
  const timeline = C.periods(from, to, interval).map((start) => {
    const end = C.nextPeriod(start, interval);
    return {
      period_start: C.isoInstant(start),
      report_count: reps.filter((r) => inRange(r.occurred_at, start, end)).length,
      delivery_count: deliveries.filter((d) => inRange(d.completed_at, start, end)).length,
    };
  });
  const data = {
    ...row,
    delivery_count: deliveries.length,
    median_dwell_seconds: C.median(deliveries.map((d) => d.dwell_seconds)),
    timeline,
    active_guidance: activeGuidanceAt(model, id).map((g) => pub(g, ['place_id'])),
  };
  delete data.media_count;
  data.media_count = row.media_count;
  return envelope(model, data);
}

function listPlaceReports(model, q, [id]) {
  findPlace(model, id);
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const rows = reportsAt(model, id, from, to).sort(C.byDesc((r) => [r.occurred_at, r.report_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [r.occurred_at, r.report_id]);
  return envelope(model, page.map((r) => pub(r)), next);
}

function listReports(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const cats = C.parseEnumList(q, 'category', C.CATEGORIES);
  const drivers = C.parseEnumList(q, 'driver_id');
  const tours = C.parseEnumList(q, 'tour_id');
  const places = C.parseEnumList(q, 'place_id');
  const statuses = C.parseEnumList(q, 'location_status', C.LOCATION_STATUSES);
  const channels = C.parseEnumList(q, 'channel', C.CHANNELS);
  const rows = model.reports
    .filter((r) => inRange(r.occurred_at, from, to))
    .filter((r) => !cats.length || cats.includes(r.category))
    .filter((r) => !drivers.length || drivers.includes(r.driver.driver_id))
    .filter((r) => !tours.length || tours.includes(r.tour_id))
    .filter((r) => !places.length || places.includes(r.place_id))
    .filter((r) => !statuses.length || statuses.includes(r.location_status))
    .filter((r) => !channels.length || channels.includes(r.channel))
    .sort(C.byDesc((r) => [r.occurred_at, r.report_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [r.occurred_at, r.report_id]);
  return envelope(model, page.map((r) => pub(r)), next);
}

function listOutreach(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const triggers = C.parseEnumList(q, 'trigger', C.OUTREACH_TRIGGERS);
  const states = C.parseEnumList(q, 'state', C.OUTREACH_STATES);
  const channels = C.parseEnumList(q, 'channel', C.CHANNELS);
  const drivers = C.parseEnumList(q, 'driver_id');
  const places = C.parseEnumList(q, 'place_id');
  const rows = model.outreach
    .filter((o) => inRange(o.scheduled_for, from, to))
    .filter((o) => !triggers.length || triggers.includes(o.trigger))
    .filter((o) => !states.length || states.includes(o.state))
    .filter((o) => !channels.length || channels.includes(o.channel))
    .filter((o) => !drivers.length || drivers.includes(o.driver.driver_id))
    .filter((o) => !places.length || places.includes(o.place_id))
    .sort(C.byDesc((o) => [o.scheduled_for, o.outreach_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (o) => [o.scheduled_for, o.outreach_id]);
  return envelope(model, page.map((o) => pub(o)), next);
}

function hotspots(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const cats = C.parseEnumList(q, 'category', C.CATEGORIES);
  const minDeliveries = C.parseInt0(q, 'min_deliveries', 5);
  const netMedian = networkMedianDwell(model, from, to);
  const mid = from + (to - from) / 2;
  const rows = [];
  for (const p of model.places) {
    const deliveries = deliveriesAt(model, p.place_id, from, to);
    if (deliveries.length < minDeliveries) continue;
    const reps = reportsAt(model, p.place_id, from, to).filter((r) => !cats.length || cats.includes(r.category));
    const per100 = C.round((reps.length / deliveries.length) * 100, 1);
    const med = C.median(deliveries.map((d) => d.dwell_seconds));
    const d1 = deliveries.filter((d) => t(d.completed_at) < mid).length, d2 = deliveries.length - d1;
    const r1 = reps.filter((r) => t(r.occurred_at) < mid).length, r2 = reps.length - r1;
    let trend = 'insufficient_data';
    if (d1 >= 5 && d2 >= 5) {
      const ratio = (r2 / d2 + 0.01) / (r1 / d1 + 0.01);
      trend = ratio > 1.25 ? 'worsening' : ratio < 0.8 ? 'improving' : 'stable';
    }
    rows.push({
      place_id: p.place_id, label: p.label, address: p.address, location: p.location,
      report_count: reps.length, delivery_count: deliveries.length, reports_per_100_deliveries: per100,
      median_dwell_seconds: med, dwell_index: med != null && netMedian ? C.round(med / netMedian, 2) : null,
      distinct_drivers: new Set(reps.map((r) => r.driver.driver_id)).size,
      top_category: (topCategories(reps)[0] || {}).category || null,
      has_active_guidance: activeGuidanceAt(model, p.place_id).length > 0, trend,
    });
  }
  rows.sort(C.byDesc((r) => [pad(r.reports_per_100_deliveries * 10) + pad(r.report_count), r.place_id]));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [pad(r.reports_per_100_deliveries * 10) + pad(r.report_count), r.place_id]);
  return envelope(model, page, next);
}

function gapAlertTotals(alerts) {
  const confirmed = alerts.filter((a) => a.outcome === 'confirmed_issue').length;
  const falsePos = alerts.filter((a) => a.outcome === 'false_positive').length;
  const answered = confirmed + falsePos;
  return { fired: alerts.length, answered, confirmed_issue: confirmed, false_positive: falsePos, no_answer: alerts.length - answered, precision: answered ? C.round(confirmed / answered, 3) : null };
}

function gapAlerts(model, q) {
  const { from, to } = C.parseRange(q);
  const interval = C.parseInterval(q);
  const drivers = C.parseEnumList(q, 'driver_id');
  const alerts = model.gapAlerts.filter((a) => inRange(a.at, from, to)).filter((a) => !drivers.length || drivers.includes(a.driver_id));
  const series = C.periods(from, to, interval).map((start) => {
    const end = C.nextPeriod(start, interval);
    const tot = gapAlertTotals(alerts.filter((a) => inRange(a.at, start, end)));
    return { period_start: C.isoInstant(start), fired: tot.fired, answered: tot.answered, confirmed_issue: tot.confirmed_issue, false_positive: tot.false_positive, precision: tot.precision };
  });
  return envelope(model, { totals: gapAlertTotals(alerts), series });
}

const COST_EUR = { voice: 0.19, sms: 0.06, mms: 0.09, sdk: 0.02 };

function outreachMetrics(model, q) {
  const { from, to } = C.parseRange(q);
  const triggers = C.parseEnumList(q, 'trigger', C.OUTREACH_TRIGGERS);
  const channels = C.parseEnumList(q, 'channel', C.CHANNELS);
  const rows = model.outreach.filter((o) => inRange(o.scheduled_for, from, to))
    .filter((o) => !triggers.length || triggers.includes(o.trigger))
    .filter((o) => !channels.length || channels.includes(o.channel));
  const sentRows = rows.filter((o) => ['sent', 'answered', 'failed'].includes(o.state));
  const answered = rows.filter((o) => o.state === 'answered').length;
  const created = rows.reduce((n, o) => n + (o.reports_created || 0), 0);
  const cost = sentRows.reduce((s, o) => s + (COST_EUR[o.channel] || 0.1), 0);
  const group = (key) => {
    const by = new Map();
    for (const o of rows) {
      const g = by.get(o[key]) || { [key]: o[key], sent: 0, answered: 0, reports_created: 0 };
      if (['sent', 'answered', 'failed'].includes(o.state)) g.sent++;
      if (o.state === 'answered') g.answered++;
      g.reports_created += o.reports_created || 0;
      by.set(o[key], g);
    }
    return [...by.values()].sort((a, b) => b.sent - a.sent);
  };
  const skips = new Map();
  for (const o of rows) if (o.state === 'skipped' && o.skip_reason) skips.set(o.skip_reason, (skips.get(o.skip_reason) || 0) + 1);
  return envelope(model, {
    totals: {
      scheduled: rows.length, sent: sentRows.length, answered, skipped: rows.filter((o) => o.state === 'skipped').length,
      failed: rows.filter((o) => o.state === 'failed').length, answer_rate: sentRows.length ? C.round(answered / sentRows.length, 3) : null,
      reports_created: created, cost_per_useful_event_eur: created ? C.round(cost / created, 2) : null,
    },
    by_trigger: group('trigger'), by_channel: group('channel'),
    skips: [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  });
}

function questionMetrics(model, q) {
  const { from, to } = C.parseRange(q);
  const limit = C.parseLimit(q);
  const ids = C.parseEnumList(q, 'question_id');
  const places = C.parseEnumList(q, 'place_id');
  const rows = model.questions
    .filter((x) => !ids.length || ids.includes(x.question_id))
    .filter((x) => !places.length || places.includes(x.place_id))
    .map((x) => {
      const ev = x.events.filter((e) => inRange(e.at, from, to));
      const answered = ev.filter((e) => e.answered);
      const novel = answered.filter((e) => e.novel).length;
      return {
        question_id: x.question_id, version: x.version, prompt: x.prompt,
        asked: ev.length, answered: answered.length, answer_rate: ev.length ? C.round(answered.length / ev.length, 3) : null,
        novel_answers: novel, confirming_answers: answered.length - novel, yield: answered.length ? C.round(novel / answered.length, 3) : null,
        median_answer_seconds: C.median(answered.map((e) => e.answer_seconds)), retired_at: x.retired_at,
      };
    })
    .filter((r) => r.asked > 0)
    .sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : b.version - a.version));
  const { page, next } = C.paginate(rows, limit, q.get('cursor'), (r) => [r.question_id, String(r.version)]);
  return envelope(model, page, next);
}

function armStats(model, placeIds, from, to) {
  let reports = 0;
  const deliveries = [];
  for (const id of placeIds) {
    reports += reportsAt(model, id, from, to).length;
    deliveries.push(...deliveriesAt(model, id, from, to));
  }
  return {
    deliveries: deliveries.length,
    reports_per_100_deliveries: deliveries.length ? C.round((reports / deliveries.length) * 100, 1) : null,
    median_dwell_seconds: C.median(deliveries.map((d) => d.dwell_seconds)),
  };
}

function guidanceEffect(model, q) {
  const id = q.get('guidance_id');
  if (!id) throw new C.ApiError(400, 'invalid_parameter', 'guidance_id is required', 'guidance_id');
  const g = model.guidance.find((x) => x.guidance_id === id);
  if (!g) throw new C.ApiError(404, 'not_found', `no guidance ${id}`);
  const windowDays = C.parseInt0(q, 'window_days', 30) || 30;
  if (windowDays > 180) throw new C.ApiError(400, 'invalid_parameter', 'window_days is capped at 180', 'window_days');
  const activated = g.valid_from ? t(g.valid_from) : model.now - windowDays * C.DAY_MS;
  const w = windowDays * C.DAY_MS;
  const treated = [...new Set(model.guidance.filter((x) => x.status === 'active').map((x) => x.place_id))];
  const holdout = model.places.map((p) => p.place_id).filter((pid) => !treated.includes(pid));
  const arm = (ids) => ({ place_count: ids.length, before: armStats(model, ids, activated - w, activated), after: armStats(model, ids, activated, activated + w) });
  const T = arm(treated), H = arm(holdout);
  const enough = [T.before, T.after, H.before, H.after].every((s) => s.deliveries >= 5);
  const strip = (a) => ({ place_count: a.place_count, before: pub(a.before, ['deliveries']), after: pub(a.after, ['deliveries']) });
  const data = { guidance_id: g.guidance_id, kind: g.kind, body: g.body, activated_at: g.valid_from, window_days: windowDays, treated: strip(T), holdout: strip(H) };
  if (H.place_count < 3 || !enough) {
    data.effect = null;
    data.effect_unavailable_reason = H.place_count < 3 ? 'holdout_too_small' : 'insufficient_deliveries';
  } else {
    const delta = (k) => C.round((T.after[k] - T.before[k]) - (H.after[k] - H.before[k]), k === 'median_dwell_seconds' ? 0 : 1);
    const low = H.place_count < 10;
    data.effect = {
      reports_per_100_deliveries: delta('reports_per_100_deliveries'), median_dwell_seconds: delta('median_dwell_seconds'),
      confidence: low ? 'low' : 'medium', note: low ? 'Holdout arm below 10 places. Treat as directional only.' : 'Treated delta minus holdout delta over matched windows.',
    };
  }
  return envelope(model, data);
}

/* ---------- exports: anything unbounded goes async ---------- */

const exportsById = new Map();

function collect(model, resource, from, to, filters) {
  const q = new URLSearchParams({ from: C.isoInstant(from), to: C.isoInstant(to), limit: String(C.MAX_LIMIT) });
  for (const [k, v] of Object.entries(filters || {})) for (const x of Array.isArray(v) ? v : [v]) q.append(k, String(x));
  const handler = { tours: listTours, reports: listReports, places: listPlaces, outreach: listOutreach }[resource];
  const rows = [];
  let cursor = null;
  do {
    if (cursor) q.set('cursor', cursor); else q.delete('cursor');
    const res = handler(model, q);
    rows.push(...res.data);
    cursor = res.meta.next_cursor;
  } while (cursor);
  return rows;
}

function createExport(model, q, params, body, origin) {
  const b = body && typeof body === 'object' ? body : {};
  if (!C.EXPORT_RESOURCES.includes(b.resource)) throw new C.ApiError(400, 'invalid_parameter', `resource must be one of ${C.EXPORT_RESOURCES.join(', ')}`, 'resource');
  if (!C.EXPORT_FORMATS.includes(b.format)) throw new C.ApiError(400, 'invalid_parameter', `format must be one of ${C.EXPORT_FORMATS.join(', ')}`, 'format');
  const range = C.parseRange(new URLSearchParams({ from: String(b.from || ''), to: String(b.to || '') }));
  if (b.filters != null && (typeof b.filters !== 'object' || Array.isArray(b.filters))) throw new C.ApiError(400, 'invalid_parameter', 'filters must be an object of filter → value(s)', 'filters');
  const id = C.uuidFrom(`export:${Date.now()}:${Math.random()}`);
  const job = { export_id: id, state: 'pending', resource: b.resource, format: b.format, from: range.from, to: range.to, filters: b.filters || {}, created_at: C.isoInstant(Date.now()), origin };
  exportsById.set(id, job);
  setTimeout(() => { if (job.state === 'pending') job.state = 'running'; }, 700);
  setTimeout(() => {
    try {
      const rows = collect(model, job.resource, job.from, job.to, job.filters);
      job.body = job.format === 'csv' ? toCsv(rows) : rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
      job.row_count = rows.length;
      job.bytes = Buffer.byteLength(job.body);
      job.state = 'ready';
      job.completed_at = C.isoInstant(Date.now());
      job.url_expires_at = C.isoInstant(Date.now() + 3600000);
    } catch (e) {
      job.state = 'failed'; job.error_code = 'export_failed'; job.error_message = e.message; job.completed_at = C.isoInstant(Date.now());
    }
  }, 2200);
  return { status: 202, body: { data: { export_id: id, state: 'pending', created_at: job.created_at } } };
}

function exportView(job) {
  const out = { export_id: job.export_id, state: job.state, resource: job.resource, format: job.format, created_at: job.created_at };
  if (job.state === 'ready' && t(job.url_expires_at) < Date.now()) out.state = 'expired';
  if (['ready', 'expired'].includes(out.state)) Object.assign(out, { row_count: job.row_count, bytes: job.bytes, completed_at: job.completed_at });
  if (out.state === 'ready') Object.assign(out, { download_url: `${job.origin}${BASE_PATH}/exports/${job.export_id}/download`, url_expires_at: job.url_expires_at });
  if (job.state === 'failed') Object.assign(out, { error_code: job.error_code, error_message: job.error_message, completed_at: job.completed_at });
  return out;
}

function getExport(model, q, [id]) {
  const job = exportsById.get(id);
  if (!job) throw new C.ApiError(404, 'not_found', `no export ${id}`);
  return { data: exportView(job) };
}

function downloadExport(model, q, [id]) {
  const job = exportsById.get(id);
  if (!job || job.state !== 'ready' || t(job.url_expires_at) < Date.now()) throw new C.ApiError(404, 'not_found', 'no downloadable export at this url');
  return { raw: job.body, type: job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8', name: `${job.resource}.${job.format}` };
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return [cols.join(','), ...flat.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + (rows.length ? '\n' : '');
}

/* ---------- routing ---------- */

const ROUTES = [
  ['GET', /^\/tours$/, listTours],
  ['GET', /^\/tours\/([^/]+)$/, getTour],
  ['GET', /^\/drivers$/, listDrivers],
  ['GET', /^\/drivers\/([^/]+)$/, getDriver],
  ['GET', /^\/places$/, listPlaces],
  ['GET', /^\/places\/([^/]+)$/, getPlace],
  ['GET', /^\/places\/([^/]+)\/reports$/, listPlaceReports],
  ['GET', /^\/reports$/, listReports],
  ['GET', /^\/outreach$/, listOutreach],
  ['GET', /^\/metrics\/hotspots$/, hotspots],
  ['GET', /^\/metrics\/gap-alerts$/, gapAlerts],
  ['GET', /^\/metrics\/outreach$/, outreachMetrics],
  ['GET', /^\/metrics\/questions$/, questionMetrics],
  ['GET', /^\/metrics\/guidance-effect$/, guidanceEffect],
  ['POST', /^\/exports$/, createExport],
  ['GET', /^\/exports\/([^/]+)$/, getExport],
  ['GET', /^\/exports\/([^/]+)\/download$/, downloadExport],
];

function checkAuth(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new C.ApiError(401, 'unauthenticated', 'send Authorization: Bearer <api_key>');
  const key = m[1];
  if (/^(demo|sdk)_/i.test(key)) throw new C.ApiError(403, 'scope_denied', 'this key lacks the analytics:read scope');
  if (!KEYS.includes(key)) throw new C.ApiError(401, 'unauthenticated', 'unknown api key');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '600',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new C.ApiError(400, 'invalid_parameter', 'body too large')); });
    req.on('end', () => { if (!raw) return resolve(null); try { resolve(JSON.parse(raw)); } catch { reject(new C.ApiError(400, 'invalid_parameter', 'body must be JSON')); } });
    req.on('error', reject);
  });
}

export function createServer(source, { latency = LATENCY } = {}) {
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      const origin = `http://${req.headers.host || `localhost:${PORT}`}`;
      if (url.pathname === '/' || url.pathname === '') {
        const model = await source.fresh();
        return send(200, {
          name: 'Parcelvox Analytics API — mock', base_url: origin + BASE_PATH, source: source.kind, as_of: model.asOf,
          api_key_hint: 'Authorization: Bearer ' + KEYS[0], counts: model.counts,
          drivers: model.drivers.map((d) => ({ driver_id: d.driver_id, name: d.name, real: d.driver_id === model.realDriver.driver_id })),
          routes: model.routes.map((r) => ({ id: r.id, name: r.name, stops: r.stops.length, walking: r.walking })),
        });
      }
      if (!url.pathname.startsWith(BASE_PATH + '/')) throw new C.ApiError(404, 'not_found', `nothing at ${url.pathname} — the API lives under ${BASE_PATH}`);
      checkAuth(req);
      const sub = url.pathname.slice(BASE_PATH.length).replace(/\/+$/, '') || '/';
      const route = ROUTES.find(([method, re]) => method === req.method && re.test(sub));
      if (!route) throw new C.ApiError(404, 'not_found', `no ${req.method} ${sub}`);
      const params = sub.match(route[1]).slice(1).map(decodeURIComponent);
      const body = req.method === 'POST' ? await readBody(req) : null;
      const model = await source.fresh();
      if (latency[1] > 0) await sleep(latency[0] + Math.random() * (latency[1] - latency[0]));
      const out = route[2](model, url.searchParams, params, body, origin);
      if (out && out.raw != null) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.name}"`, ...CORS });
        return res.end(out.raw);
      }
      if (out && out.status) return send(out.status, out.body);
      return send(200, out);
    } catch (e) {
      if (e instanceof C.ApiError) return send(e.status, e.toJSON(), e.status === 429 ? { 'Retry-After': '5' } : {});
      console.error(e);
      return send(500, { error: { code: 'internal', message: e.message } });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const source = makeSource();
  source.load().then((model) => {
    const server = createServer(source);
    server.listen(PORT, () => {
      const c = model.counts;
      console.log(`Parcelvox Analytics API mock — http://localhost:${PORT}${BASE_PATH}`);
      console.log(`  source: ${source.kind}${source.kind === 'supabase' ? ' ' + SUPABASE_URL : ' ' + source.opts.fixture}`);
      console.log(`  places ${c.places} · routes ${c.routes} · reports ${c.reports.real} real + ${c.reports.invented} invented · tours ${c.tours.real} real + ${c.tours.invented} invented`);
      console.log(`  key: ${KEYS[0]}   (Authorization: Bearer ${KEYS[0]})`);
      console.log(`  status page: http://localhost:${PORT}/`);
    });
  }).catch((e) => {
    console.error('could not load the store:', e.message);
    process.exit(1);
  });
}

export { existsSync };
