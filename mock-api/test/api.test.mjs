/*
 * The mock against the contract, end to end over HTTP: auth, the query
 * envelope, errors, cursors that paginate, and every endpoint's shape — on
 * the fixture (a snapshot of the real store plus one hand-made walk and two
 * runs), with the invented history on top and no artificial latency.
 *
 *   node --test test/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, makeSource, BASE_PATH } from '../server.mjs';
import { uuidFrom } from '../contract.mjs';
import { readFileSync } from 'node:fs';

const KEY = 'pvx_dev_analytics_read';
const RANGE = 'from=2026-06-01T00:00:00Z&to=2026-12-31T00:00:00Z';
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

let server, base;
before(async () => {
  const source = makeSource({ fixture: new URL('./fixture.json', import.meta.url).pathname, refreshMs: 1e9 });
  await source.load();
  server = createServer(source, { latency: [0, 0] });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}${BASE_PATH}`;
});
after(() => server.close());

const call = async (path, { key = KEY, method = 'GET', body } = {}) => {
  const r = await fetch(base + path, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw download */ }
  return { status: r.status, json, text, headers: r.headers };
};
const ok = async (path) => { const r = await call(path); assert.equal(r.status, 200, `${path} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; };

test('auth: no key 401, demo key 403 scope_denied, the dev key 200', async () => {
  assert.equal((await call(`/places?${RANGE}`, { key: null })).json.error.code, 'unauthenticated');
  const demo = await call(`/places?${RANGE}`, { key: 'demo_1234' });
  assert.equal(demo.status, 403);
  assert.equal(demo.json.error.code, 'scope_denied');
  assert.equal((await call(`/places?${RANGE}`)).status, 200);
});

test('query envelope: from/to required, ordered, ≤ 400 days; radius capped', async () => {
  let r = await call('/places');
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'invalid_parameter'); assert.equal(r.json.error.field, 'from');
  r = await call('/places?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z');
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'invalid_range');
  r = await call('/places?from=2025-01-01T00:00:00Z&to=2026-12-31T00:00:00Z');
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'range_too_large');
  r = await call(`/places?${RANGE}&lat=52.53&lng=13.41&radius_m=6000`);
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'radius_too_large');
  r = await call(`/places?${RANGE}&limit=900`);
  assert.equal(r.status, 400); assert.equal(r.json.error.field, 'limit');
  r = await call('/nothing-here');
  assert.equal(r.status, 404); assert.equal(r.json.error.code, 'not_found');
});

test('places: bbox around Kollwitzplatz lists every door once, with the contract shape', async () => {
  const res = await ok(`/places?${RANGE}&bbox=13.40,52.52,13.43,52.55`);
  assert.ok(res.meta.as_of && /Z$/.test(res.meta.as_of));
  assert.equal(res.meta.next_cursor, null);
  assert.equal(res.data.length, 11);
  for (const p of res.data) {
    for (const k of ['place_id', 'label', 'address', 'location', 'report_count', 'distinct_drivers', 'pooled_reports', 'top_categories', 'first_report_at', 'last_report_at', 'has_active_guidance', 'media_count']) assert.ok(k in p, `place lacks ${k}`);
    assert.ok(['none', 'few', 'some', 'many'].includes(p.pooled_reports));
    assert.ok(typeof p.report_count === 'number');
  }
  assert.ok(res.data.some((p) => p.has_active_guidance), 'dispatch notes on file show as active guidance');
  const k64 = res.data.find((p) => p.label === 'Kollwitzstraße 64');
  assert.ok(k64, 'the door with the real report is a place, named by its route stop');
  assert.ok(k64.report_count >= 1);
  const radius = await ok(`/places?${RANGE}&lat=52.536&lng=13.418&radius_m=120`);
  assert.ok(radius.data.length >= 1 && radius.data.length < 11, 'a tight radius keeps only the nearest doors');
});

test('places: keyset pagination walks the whole set once; a bad cursor is 400 invalid_cursor', async () => {
  const seen = new Set();
  let cursor = null, pages = 0;
  do {
    const res = await ok(`/places?${RANGE}&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
    assert.ok(res.data.length <= 4);
    for (const p of res.data) { assert.ok(!seen.has(p.place_id), 'no place repeats across pages'); seen.add(p.place_id); }
    cursor = res.meta.next_cursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 11);
  assert.equal(pages, 3);
  const bad = await call(`/places?${RANGE}&cursor=not-a-cursor`);
  assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'invalid_cursor');
});

test('place detail: deliveries, dwell, a timeline and the dispatch notes as guidance', async () => {
  const list = await ok(`/places?${RANGE}`);
  const k48 = list.data.find((p) => p.label === 'Kollwitzstraße 48');
  const res = await ok(`/places/${k48.place_id}?${RANGE}&interval=month`);
  const d = res.data;
  assert.equal(d.place_id, k48.place_id);
  assert.ok(d.delivery_count >= 1, 'the fixture walk delivered stop 1');
  assert.ok(Array.isArray(d.timeline) && d.timeline.length >= 6 && d.timeline[0].period_start);
  assert.equal(d.timeline.reduce((n, t) => n + t.delivery_count, 0), d.delivery_count, 'the timeline sums to the total');
  assert.ok(d.active_guidance.some((g) => /bell panel/i.test(g.body)));
  for (const g of d.active_guidance) { assert.ok(['warn', 'instruct', 'ask'].includes(g.kind)); assert.equal(g.status, 'active'); }
  const missing = await call(`/places/${uuidFrom('nope')}?${RANGE}`);
  assert.equal(missing.status, 404);
});

test('reports: the real debrief is there in the contract shape, next to invented rows marked as such', async () => {
  const res = await ok(`/reports?${RANGE}&location_status=resolved&limit=500`);
  const real = res.data.find((r) => r.report_id === fixture.messages[0].id);
  assert.ok(real, 'the tester’s report');
  assert.equal(real.category, 'access');
  assert.equal(real.channel, 'voice');
  assert.equal(real.driver.name, 'Otto tester');
  assert.equal(real.location_source, 'trace_correlation');
  assert.equal(real.tour_id, null);
  assert.equal(real.service_date, null);
  assert.ok(!('transcript' in real), 'the transcript is not part of the contract');
  for (const k of ['report_id', 'category', 'summary', 'occurred_at', 'created_at', 'place_id', 'place_label', 'driver', 'tour_id', 'service_date', 'stop_id', 'parcel_id', 'channel', 'location', 'location_source', 'location_status', 'media_count', 'superseded']) assert.ok(k in real, `report lacks ${k}`);
  assert.ok(res.data.some((r) => r.invented === true), 'invented rows say so');
  const byCat = await ok(`/reports?${RANGE}&category=access&category=parking&limit=500`);
  assert.ok(byCat.data.every((r) => ['access', 'parking'].includes(r.category)));
  const place = await ok(`/places/${real.place_id}/reports?${RANGE}`);
  assert.ok(place.data.some((r) => r.report_id === real.report_id));
  assert.ok(place.data.every((r, i, a) => i === 0 || a[i - 1].occurred_at >= r.occurred_at), 'newest first');
});

test('tours: the fixture walk is one tour with its stops, completion and dwell', async () => {
  const list = await ok(`/tours?${RANGE}&driver_id=${uuidFrom('driver:real:Otto tester')}`);
  assert.equal(list.data.length, 1);
  const t = list.data[0];
  assert.equal(t.service_date, '2026-09-10');
  assert.equal(t.stop_count, 12);
  assert.equal(t.completed_count, 10);
  assert.ok(['planned', 'active', 'closed', 'abandoned'].includes(t.status));
  assert.ok(t.first_scan_at < t.last_scan_at);
  assert.ok(!('stops' in t), 'the list has no stops');
  const detail = await ok(`/tours/${t.tour_id}`);
  assert.equal(detail.data.stops.length, 12);
  const s6 = detail.data.stops.find((s) => s.sequence === 6);
  assert.equal(s6.completed_at, null, 'the failed stop has no completion');
  const s1 = detail.data.stops.find((s) => s.sequence === 1);
  assert.ok(s1.completed_at && s1.dwell_seconds > 0 && s1.place_id);
  const byDate = await ok(`/tours?${RANGE}&service_date_from=2026-09-10&service_date_to=2026-09-10&status=closed&status=abandoned&status=active`);
  assert.ok(byDate.data.some((x) => x.tour_id === t.tour_id));
  const all = await ok(`/tours?${RANGE}&limit=500`);
  assert.ok(all.data.some((x) => x.invented) && all.data.some((x) => x.status === 'abandoned' || x.completed_count < x.stop_count), 'invented history includes unfinished tours');
});

test('drivers: the tester plus the invented crew, with recent tours on the detail', async () => {
  const res = await ok(`/drivers?${RANGE}`);
  const me = res.data.find((d) => d.name === 'Otto tester');
  assert.ok(me && me.tour_count >= 1 && me.report_count >= 1 && me.channels_used.includes('voice'));
  assert.ok(res.data.length >= 2);
  const detail = await ok(`/drivers/${me.driver_id}?${RANGE}`);
  assert.ok(Array.isArray(detail.data.recent_tours) && detail.data.recent_tours.length >= 1 && detail.data.recent_tours.length <= 20);
});

test('outreach and gap alerts from the two runs; the metrics endpoints have their shapes', async () => {
  const out = await ok(`/outreach?${RANGE}&driver_id=${uuidFrom('driver:real:Otto tester')}`);
  assert.equal(out.data.length, 2);
  for (const o of out.data) { assert.equal(o.trigger, 'post_stop'); assert.ok(['sent', 'answered', 'skipped', 'failed', 'pending'].includes(o.state)); assert.equal(o.driver.name, 'Otto tester'); }
  const gaps = await ok(`/metrics/gap-alerts?${RANGE}&driver_id=${uuidFrom('driver:real:Otto tester')}&interval=week`);
  assert.deepEqual(gaps.data.totals, { fired: 2, answered: 2, confirmed_issue: 1, false_positive: 1, no_answer: 0, precision: 0.5 });
  assert.ok(gaps.data.series.length > 0 && gaps.data.series.every((s) => s.period_start && 'precision' in s));
  const allGaps = await ok(`/metrics/gap-alerts?${RANGE}`);
  assert.ok(allGaps.data.totals.fired > 2);
  const om = await ok(`/metrics/outreach?${RANGE}`);
  for (const k of ['scheduled', 'sent', 'answered', 'skipped', 'failed', 'answer_rate', 'reports_created', 'cost_per_useful_event_eur']) assert.ok(k in om.data.totals, `totals lack ${k}`);
  assert.ok(om.data.by_trigger.length >= 2 && om.data.by_channel.length >= 1 && Array.isArray(om.data.skips));
  assert.ok(om.data.skips.every((s) => ['budget_exceeded', 'low_confidence', 'driver_unreachable', 'tour_closed', 'consent_missing'].includes(s.reason)));
  const q = await ok(`/metrics/questions?${RANGE}`);
  assert.ok(q.data.length >= 2);
  const scen = fixture.scenarios.find((s) => s.num === 11) || fixture.scenarios[0];
  const mine = q.data.filter((x) => x.question_id === uuidFrom('question:' + scen.id));
  assert.ok(mine.length >= 1 && mine[0].asked >= 2, 'the scenario’s own question counts the two runs');
  for (const row of q.data) { assert.ok(row.version >= 1 && 'yield' in row && 'retired_at' in row); }
});

test('guidance effect: requires guidance_id, never a bare number, null with a reason when the holdout is thin', async () => {
  const bad = await call(`/metrics/guidance-effect?${RANGE}`);
  assert.equal(bad.status, 400); assert.equal(bad.json.error.field, 'guidance_id');
  const list = await ok(`/places?${RANGE}`);
  const withG = list.data.find((p) => p.has_active_guidance);
  const detail = await ok(`/places/${withG.place_id}?${RANGE}`);
  const g = detail.data.active_guidance[0];
  const res = await ok(`/metrics/guidance-effect?guidance_id=${g.guidance_id}&window_days=30`);
  const d = res.data;
  assert.equal(d.guidance_id, g.guidance_id);
  assert.ok(d.treated.place_count >= 1 && 'before' in d.treated && 'after' in d.treated && 'holdout' in d);
  if (d.effect === null) assert.ok(['holdout_too_small', 'insufficient_deliveries'].includes(d.effect_unavailable_reason));
  else assert.ok(['low', 'medium'].includes(d.effect.confidence) && typeof d.effect.note === 'string');
});

test('exports: accepted, then ready with a download that streams the rows', async () => {
  const created = await call('/exports', { method: 'POST', body: { resource: 'reports', format: 'csv', from: '2026-06-01T00:00:00Z', to: '2026-12-31T00:00:00Z', filters: { category: ['access', 'parking'] } } });
  assert.equal(created.status, 202);
  assert.equal(created.json.data.state, 'pending');
  const id = created.json.data.export_id;
  let view;
  for (let i = 0; i < 40; i++) {
    view = (await ok(`/exports/${id}`)).data;
    if (view.state === 'ready' || view.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(view.state, 'ready', JSON.stringify(view));
  assert.ok(view.row_count >= 1 && view.bytes > 0 && view.download_url && view.url_expires_at);
  const dl = await call(view.download_url.slice(base.length));
  assert.equal(dl.status, 200);
  assert.ok(dl.text.startsWith('report_id,'));
  assert.equal(dl.text.trim().split('\n').length, view.row_count + 1);
  const bad = await call('/exports', { method: 'POST', body: { resource: 'drivers', format: 'csv', from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error.field, 'resource');
  const jsonl = await call('/exports', { method: 'POST', body: { resource: 'tours', format: 'jsonl', from: '2026-06-01T00:00:00Z', to: '2026-12-31T00:00:00Z' } });
  assert.equal(jsonl.status, 202);
});
