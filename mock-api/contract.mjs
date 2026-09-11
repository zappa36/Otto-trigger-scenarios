/*
 * The conventions of the Parcelvox Analytics API mock contract — enums,
 * ids, time, the query envelope, errors and keyset pagination. Everything
 * here is the contract's wording turned into code; the data lives in
 * source.mjs and invent.mjs, the routes in server.mjs.
 */
import { createHash } from 'node:crypto';

export const CATEGORIES = ['access', 'parking', 'gate_code', 'recipient', 'address', 'hazard', 'other'];
export const LOCATION_SOURCES = ['manifest', 'scan', 'spoken', 'trace_correlation', 'teleport', 'none'];
export const LOCATION_STATUSES = ['resolved', 'pending', 'ambiguous'];
export const CHANNELS = ['voice', 'sms', 'mms', 'sdk'];
export const TOUR_STATUSES = ['planned', 'active', 'closed', 'abandoned'];
export const OUTREACH_TRIGGERS = ['pre_stop', 'post_stop', 'hotspot_sweep', 'manual', 'shift_start'];
export const OUTREACH_STATES = ['pending', 'sent', 'answered', 'skipped', 'failed'];
export const SKIP_REASONS = ['budget_exceeded', 'low_confidence', 'driver_unreachable', 'tour_closed', 'consent_missing'];
export const GUIDANCE_KINDS = ['warn', 'instruct', 'ask'];
export const GUIDANCE_STATUSES = ['draft', 'approved', 'active', 'retired'];
export const BUCKETS = ['none', 'few', 'some', 'many'];
export const INTERVALS = ['day', 'week', 'month'];
export const EXPORT_RESOURCES = ['tours', 'reports', 'places', 'outreach'];
export const EXPORT_FORMATS = ['csv', 'jsonl'];

export const MAX_RANGE_DAYS = 400;
export const MAX_RADIUS_M = 5000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const DAY_MS = 86400000;

/** The error envelope: { error: { code, message, field } } with its HTTP status. */
export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
  toJSON() {
    const error = { code: this.code, message: this.message };
    if (this.field) error.field = this.field;
    return { error };
  }
}

/** A stable RFC-4122-shaped id from a name: the same input always yields the same id,
 *  so places, tours and drivers keep their ids across restarts and re-imports. */
export function uuidFrom(name) {
  const h = createHash('sha1').update(String(name)).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

/** UTC, ISO-8601, Z-suffixed, whole seconds — the contract's instant. */
export const isoInstant = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The carrier's calendar date for an instant — Europe/Berlin here. */
const berlinDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const serviceDateOf = (t) => berlinDate.format(new Date(t));

/** An instant for a Berlin local date + time, DST approximated by month (a mock's precision). */
export function berlinInstant(date, hour = 0, minute = 0) {
  const month = Number(date.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? '+02:00' : '+01:00';
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`);
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(raw, field, { required = false } = {}) {
  if (raw == null || raw === '') {
    if (required) throw new ApiError(400, 'invalid_parameter', `${field} is required`, field);
    return null;
  }
  const s = String(raw);
  const t = Date.parse(s);
  if (!Number.isFinite(t) || !INSTANT_RE.test(s)) {
    throw new ApiError(400, 'invalid_parameter', `${field} must be an ISO-8601 instant such as 2026-09-09T14:22:31Z`, field);
  }
  return t;
}

export function parseDate(raw, field) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + 'T00:00:00Z'))) {
    throw new ApiError(400, 'invalid_parameter', `${field} must be a calendar date, YYYY-MM-DD`, field);
  }
  return s;
}

/** from / to — required on every collection and series endpoint, to exclusive, ≤ 400 days. */
export function parseRange(q) {
  const from = parseInstant(q.get('from'), 'from', { required: true });
  const to = parseInstant(q.get('to'), 'to', { required: true });
  if (from >= to) throw new ApiError(400, 'invalid_range', 'from must be before to', 'from');
  if (to - from > MAX_RANGE_DAYS * DAY_MS) {
    throw new ApiError(422, 'range_too_large', `from..to spans more than ${MAX_RANGE_DAYS} days`, 'to');
  }
  return { from, to };
}

export function parseLimit(q) {
  const raw = q.get('limit');
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new ApiError(400, 'invalid_parameter', `limit must be an integer between 1 and ${MAX_LIMIT}`, 'limit');
  }
  return n;
}

export function parseInt0(q, name, fallback) {
  const raw = q.get(name);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, 'invalid_parameter', `${name} must be a non-negative integer`, name);
  return n;
}

export function parseInterval(q) {
  const raw = q.get('interval') || 'week';
  if (!INTERVALS.includes(raw)) throw new ApiError(400, 'invalid_parameter', `interval must be one of ${INTERVALS.join(', ')}`, 'interval');
  return raw;
}

/** A repeatable enum filter: ?driver_id=a&driver_id=b — AND-combined with the other filters, OR within. */
export function parseEnumList(q, name, allowed) {
  const values = q.getAll(name).filter((v) => v !== '');
  for (const v of values) {
    if (allowed && !allowed.includes(v)) {
      throw new ApiError(400, 'invalid_parameter', `${name} must be one of ${allowed.join(', ')}`, name);
    }
  }
  return values;
}

/** Either a radius (lat, lng, radius_m ≤ 5000) or a bbox (west,south,east,north). */
export function parseGeo(q) {
  const lat = q.get('lat'), lng = q.get('lng'), radius = q.get('radius_m'), bbox = q.get('bbox');
  if (bbox != null && bbox !== '') {
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[0] >= parts[2] || parts[1] >= parts[3]) {
      throw new ApiError(400, 'invalid_parameter', 'bbox must be west,south,east,north', 'bbox');
    }
    const [west, south, east, north] = parts;
    return { kind: 'bbox', west, south, east, north };
  }
  if (lat != null || lng != null || radius != null) {
    const la = Number(lat), ln = Number(lng), r = Number(radius);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !Number.isFinite(r) || r <= 0) {
      throw new ApiError(400, 'invalid_parameter', 'a radius search needs lat, lng and radius_m', 'radius_m');
    }
    if (r > MAX_RADIUS_M) throw new ApiError(422, 'radius_too_large', `radius_m is capped at ${MAX_RADIUS_M}`, 'radius_m');
    return { kind: 'radius', lat: la, lng: ln, radius: r };
  }
  return null;
}

export function inGeo(geo, loc) {
  if (!geo) return true;
  if (!loc) return false;
  if (geo.kind === 'bbox') return loc.lng >= geo.west && loc.lng <= geo.east && loc.lat >= geo.south && loc.lat <= geo.north;
  return distanceM(geo, loc) <= geo.radius;
}

export function distanceM(a, b) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const bucket = (n) => (n <= 0 ? 'none' : n < 3 ? 'few' : n < 10 ? 'some' : 'many');

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

export const round = (x, digits = 1) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));

/** The start of the day / ISO week / month a UTC instant falls in — series buckets. */
export function periodStart(t, interval) {
  const d = new Date(t);
  if (interval === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (interval === 'day') return day;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * DAY_MS;
}

export function nextPeriod(t, interval) {
  const d = new Date(t);
  if (interval === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return t + (interval === 'day' ? 1 : 7) * DAY_MS;
}

/** Every period start covering [from, to). */
export function periods(from, to, interval) {
  const out = [];
  for (let t = periodStart(from, interval); t < to; t = nextPeriod(t, interval)) out.push(t);
  return out;
}

/* ---------- keyset pagination ---------- */

export const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function decodeCursor(raw) {
  try {
    const c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!c || typeof c.k !== 'string' || typeof c.id !== 'string') throw new Error('shape');
    return c;
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'cursor is not one this API issued', 'cursor');
  }
}

/**
 * Page through an already-sorted list. keyOf(item) -> [sortKey, id]; the cursor
 * names the last item of the previous page, so a page is everything after it —
 * stable as long as the ordering is, which the handlers guarantee by sorting on
 * (key, id).
 */
export function paginate(items, limit, cursorRaw, keyOf) {
  let start = 0;
  if (cursorRaw) {
    const c = decodeCursor(cursorRaw);
    const idx = items.findIndex((it) => {
      const [k, id] = keyOf(it);
      return k === c.k && id === c.id;
    });
    if (idx < 0) throw new ApiError(400, 'invalid_cursor', 'cursor points past the current ordering — start over without it', 'cursor');
    start = idx + 1;
  }
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + limit < items.length;
  const next = more && last ? encodeCursor({ k: keyOf(last)[0], id: keyOf(last)[1] }) : null;
  return { page, next };
}

/** Sort helper: descending on a string/number key, then id, for a stable order. */
export const byDesc = (keyOf) => (a, b) => {
  const [ka, ia] = keyOf(a), [kb, ib] = keyOf(b);
  if (ka < kb) return 1;
  if (ka > kb) return -1;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};
