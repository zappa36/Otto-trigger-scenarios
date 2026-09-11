/*
 * The wire to the analytics API — the CTO's contract, or the mock of it in
 * mock-api/. Decided once at load, like depot.ts decides the store:
 *
 *  - window.ANALYTICS_URL / window.ANALYTICS_KEY from config.js (deploy-time
 *    injection, same as the Supabase pair),
 *  - VITE_ANALYTICS_URL / VITE_ANALYTICS_KEY in dev,
 *  - ?api=…&apikey=… on the page URL for a quick test against a laptop mock.
 *
 * Nothing configured → 'off', and the map shows the store alone. The
 * contract's conventions live here: bearer key, UTC instants, from/to on
 * every collection, the { data, meta } envelope, the error envelope, and
 * cursors followed until next_cursor is null.
 */

declare global {
  interface Window {
    ANALYTICS_URL?: string;
    ANALYTICS_KEY?: string;
  }
}

export type ReportCategory = 'access' | 'parking' | 'gate_code' | 'recipient' | 'address' | 'hazard' | 'other';
export const REPORT_CATEGORIES: ReportCategory[] = ['access', 'parking', 'gate_code', 'recipient', 'address', 'hazard', 'other'];

export interface ApiLocation {
  lat: number;
  lng: number;
}

export interface ApiPlace {
  place_id: string;
  label: string;
  address: string | null;
  location: ApiLocation;
  report_count: number;
  distinct_drivers: number;
  pooled_reports: 'none' | 'few' | 'some' | 'many';
  top_categories: { category: ReportCategory; count: number }[];
  first_report_at: string | null;
  last_report_at: string | null;
  has_active_guidance: boolean;
  media_count: number;
}

export interface ApiGuidance {
  guidance_id: string;
  kind: 'warn' | 'instruct' | 'ask';
  body: string;
  status: 'draft' | 'approved' | 'active' | 'retired';
  valid_from: string | null;
  valid_until: string | null;
}

export interface ApiPlaceDetail extends ApiPlace {
  delivery_count: number;
  median_dwell_seconds: number | null;
  timeline: { period_start: string; report_count: number; delivery_count: number }[];
  active_guidance: ApiGuidance[];
}

export interface ApiReport {
  report_id: string;
  category: ReportCategory;
  summary: string;
  occurred_at: string;
  created_at: string;
  place_id: string | null;
  place_label: string | null;
  driver: { driver_id: string; name: string };
  tour_id: string | null;
  service_date: string | null;
  stop_id: string | null;
  parcel_id: string | null;
  channel: 'voice' | 'sms' | 'mms' | 'sdk';
  location: ApiLocation | null;
  location_source: string;
  location_status: 'resolved' | 'pending' | 'ambiguous';
  media_count: number;
  superseded: boolean;
  /** Mock extension: rows the invented crew produced, as opposed to the tester's. */
  invented?: boolean;
}

export interface ApiHotspot {
  place_id: string;
  label: string;
  address: string | null;
  location: ApiLocation;
  report_count: number;
  delivery_count: number;
  reports_per_100_deliveries: number;
  median_dwell_seconds: number | null;
  dwell_index: number | null;
  distinct_drivers: number;
  top_category: ReportCategory | null;
  has_active_guidance: boolean;
  trend: 'improving' | 'stable' | 'worsening' | 'insufficient_data';
}

export interface Envelope<T> {
  data: T;
  meta: { as_of: string; next_cursor: string | null };
}

export class AnalyticsError extends Error {
  code: string;
  status: number;
  field?: string;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const pageParams = new URLSearchParams(window.location.search);
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
const base = String(pageParams.get('api') || window.ANALYTICS_URL || env.VITE_ANALYTICS_URL || '').replace(/\/+$/, '');
const key = String(pageParams.get('apikey') || window.ANALYTICS_KEY || env.VITE_ANALYTICS_KEY || '');

/** 'live' when a base URL and a key are configured; 'off' otherwise. */
export const analyticsMode: 'live' | 'off' = base && key ? 'live' : 'off';
export const analyticsBase = base;
/** True when the configured API is the repo's own mock (a localhost or an explicit ?api=). */
export const analyticsIsMock = /localhost|127\.0\.0\.1|mock/i.test(base) || pageParams.has('api');

export interface Range {
  from: string;
  to: string;
}

/** Whole seconds, Z-suffixed — the contract's instant. */
const instant = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The last N days up to the top of the next hour (to is exclusive). */
export function lastDays(days = 90): Range {
  const now = Date.now();
  const to = Math.ceil(now / 3600000) * 3600000;
  return { from: instant(to - days * 86400000), to: instant(to) };
}

type Query = Record<string, string | number | string[] | undefined | null>;

function buildQuery(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function get<T>(path: string, q: Query = {}, timeoutMs = 15000): Promise<Envelope<T>> {
  if (analyticsMode !== 'live') throw new AnalyticsError(0, 'not_configured', 'analytics API not configured');
  let r: Response;
  try {
    r = await fetch(`${base}${path}${buildQuery(q)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AnalyticsError(0, 'unreachable', e instanceof Error ? e.message : 'network error');
  }
  const body = (await r.json().catch(() => null)) as (Envelope<T> & { error?: { code: string; message: string; field?: string } }) | null;
  if (!r.ok) {
    const err = body && body.error;
    throw new AnalyticsError(r.status, err ? err.code : `http_${r.status}`, err ? err.message : `HTTP ${r.status}`, err ? err.field : undefined);
  }
  if (!body || !('data' in body) || !body.meta) throw new AnalyticsError(r.status, 'bad_envelope', 'response is not a { data, meta } envelope');
  return body;
}

/** A whole collection: pages of 500 until next_cursor is null (capped). */
export async function listAll<T>(path: string, q: Query = {}, cap = 5000): Promise<{ rows: T[]; asOf: string }> {
  const rows: T[] = [];
  let cursor: string | null = null;
  let asOf = '';
  do {
    const res: Envelope<T[]> = await get<T[]>(path, { ...q, limit: 500, cursor: cursor || undefined });
    rows.push(...res.data);
    asOf = res.meta.as_of;
    cursor = res.meta.next_cursor;
  } while (cursor && rows.length < cap);
  return { rows, asOf };
}

/** west, south, east, north — WGS84, the contract's bbox order. */
export type Bbox = [number, number, number, number];

export const fetchPlaces = (range: Range, opts: { bbox?: Bbox; category?: ReportCategory[]; minReports?: number } = {}) =>
  listAll<ApiPlace>('/places', {
    ...range,
    bbox: opts.bbox ? opts.bbox.map((n) => n.toFixed(5)).join(',') : undefined,
    category: opts.category,
    min_report_count: opts.minReports,
  });

export const fetchHotspots = (range: Range, opts: { minDeliveries?: number; limit?: number; category?: ReportCategory[] } = {}) =>
  get<ApiHotspot[]>('/metrics/hotspots', { ...range, min_deliveries: opts.minDeliveries, limit: opts.limit ?? 10, category: opts.category });

export const fetchPlace = (placeId: string, range: Range, interval: 'day' | 'week' | 'month' = 'month') =>
  get<ApiPlaceDetail>(`/places/${encodeURIComponent(placeId)}`, { ...range, interval });

export const fetchPlaceReports = (placeId: string, range: Range, limit = 8) =>
  get<ApiReport[]>(`/places/${encodeURIComponent(placeId)}/reports`, { ...range, limit });

/** Plain words for a category, for chips and legends. */
export const categoryLabel = (c: string): string =>
  ({ access: 'Access', parking: 'Parking', gate_code: 'Gate code', recipient: 'Recipient', address: 'Address', hazard: 'Hazard', other: 'Other' })[c] || c;
