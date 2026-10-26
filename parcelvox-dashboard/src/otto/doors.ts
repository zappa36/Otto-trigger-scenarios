import type { LngLat } from '../data/map';
import type { ApiHotspot, ApiPlace } from './analytics';
import {
  activeRoute,
  notesOf,
  visitState,
  type DepotDebrief,
  type DepotRoute,
  type DepotStop,
  type DepotVisit,
} from './depot';

/*
 * Grouping the flat destinations list into what the map draws.
 *
 * A door is every stop at one exact position — stacked same-address rows
 * are one building, several parcels, exactly the grouping the trigger
 * dashboard's stop sheet uses. A route line is a route's rows in driving
 * order (the stop column), consecutive duplicates collapsed where several
 * parcels share a door; it knows its name from the routes table and
 * whether it is the route on the phones. The driver's Delivered / Not
 * delivered taps (visits) give every door its state, by the phone's own
 * rule: the newest tap per stop.
 */

export interface DepotDoor {
  /** `${lat},${lng}` — stable across reloads, the selection handle. */
  key: string;
  at: LngLat;
  title: string;
  /** Every destinations row behind this door, stop order first. */
  rows: DepotStop[];
  /** Route stop numbers here, driving order — [] for scenario pins. */
  stopNos: number[];
  hasNotes: boolean;
  /** A real (non-demo) Otto debrief is on file for at least one row. */
  debriefed: boolean;
  /** Stops behind this door the driver tapped Delivered on, and Not delivered on. */
  delivered: number;
  failed: number;
  /** 'open' while any stop here still waits; then 'done', or 'failed' when one was not delivered. */
  state: 'open' | 'done' | 'failed';
  /** What the analytics API knows about this door, when one is configured. */
  analytics?: DoorAnalytics;
}

export interface DoorAnalytics {
  placeId: string;
  /** Reports at this door in the API's range — the tester's and the invented history's. */
  reports: number;
  /** Position in the hotspot ranking (reports per 100 deliveries), 1 = worst; null when unranked. */
  hotspotRank: number | null;
  reportsPer100: number | null;
  topCategory: string | null;
}

/** Nearest API place within 30 m of a door — the contract links places to stops
 *  only through tours and reports, so position is the honest join for a map. */
const MATCH_M = 30;
const distM = (a: LngLat, b: { lat: number; lng: number }) => {
  const R = 6371000, toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a[1]), dLng = toR(b.lng - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

export function attachAnalytics(doors: DepotDoor[], places: ApiPlace[], hotspots: ApiHotspot[]): DepotDoor[] {
  const rank = new Map(hotspots.map((h, i) => [h.place_id, { rank: i + 1, per100: h.reports_per_100_deliveries }]));
  return doors.map((door) => {
    let best: ApiPlace | null = null;
    let bestD = MATCH_M;
    for (const p of places) {
      const d = distM(door.at, p.location);
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) return door;
    const hot = rank.get(best.place_id);
    return {
      ...door,
      analytics: {
        placeId: best.place_id,
        reports: best.report_count,
        hotspotRank: hot ? hot.rank : null,
        reportsPer100: hot ? hot.per100 : null,
        topCategory: best.top_categories[0] ? best.top_categories[0].category : null,
      },
    };
  });
}

export interface DepotRouteLine {
  id: string;
  /** The routes table's name — else the id made readable, as the trigger dashboard does. */
  name: string;
  /** The route the ROUTE door put on the phones: the driver's screen opens on it. */
  active: boolean;
  points: LngLat[];
}

/** 'schoeneberg-01' → 'Schoeneberg 01' — for a route the table does not know (a store from before it). */
export const prettyRouteId = (id: string): string =>
  String(id)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const routeName = (id: string, routes: DepotRoute[]): string => {
  const row = routes.find((r) => r.id === id);
  return (row && row.name) || prettyRouteId(id);
};

const stopOrder = (a: DepotStop, b: DepotStop) =>
  ((a.stop == null ? 1e9 : a.stop) - (b.stop == null ? 1e9 : b.stop)) ||
  String(a.created_at || '').localeCompare(String(b.created_at || ''));

export function groupDoors(
  stops: DepotStop[],
  debriefs: Record<string, DepotDebrief[]>,
  visits: Record<string, DepotVisit> = {},
): DepotDoor[] {
  const byKey = new Map<string, DepotStop[]>();
  for (const s of stops) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const k = s.lat + ',' + s.lng;
    const rows = byKey.get(k);
    if (rows) rows.push(s);
    else byKey.set(k, [s]);
  }
  return [...byKey.entries()].map(([key, rows]) => {
    rows.sort(stopOrder);
    const first = rows[0];
    const states = rows.map((r) => visitState(r, visits));
    const delivered = states.filter((s) => s === 'done').length;
    const failed = states.filter((s) => s === 'failed').length;
    return {
      key,
      at: [first.lng, first.lat] as LngLat,
      title: String(first.title || first.addr || 'Stop'),
      rows,
      stopNos: rows.map((r) => r.stop).filter((n): n is number => n != null),
      hasNotes: rows.some((r) => notesOf(r).length > 0),
      debriefed: rows.some((r) => (debriefs[r.id] || []).length > 0),
      delivered,
      failed,
      state: states.some((s) => s === 'open') ? 'open' : failed ? 'failed' : 'done',
    };
  });
}

/** "Stop 7 · Goltzstraße 13" / "Stops 4 + 5 · …" — how the phone names a door. */
export const doorLabel = (door: DepotDoor): string =>
  door.stopNos.length > 1
    ? `Stops ${door.stopNos.join(' + ')} · ${door.title}`
    : door.stopNos.length === 1
      ? `Stop ${door.stopNos[0]} · ${door.title}`
      : door.title;

export function routeLines(stops: DepotStop[], routes: DepotRoute[] = []): DepotRouteLine[] {
  const act = activeRoute(routes);
  const byRoute = new Map<string, DepotStop[]>();
  for (const s of stops) {
    if (!s.route || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const rows = byRoute.get(s.route);
    if (rows) rows.push(s);
    else byRoute.set(s.route, [s]);
  }
  return [...byRoute.entries()]
    .map(([id, rows]) => {
      rows.sort(stopOrder);
      const points: LngLat[] = [];
      for (const r of rows) {
        const last = points[points.length - 1];
        if (!last || last[0] !== r.lng || last[1] !== r.lat) points.push([r.lng, r.lat]);
      }
      return { id, name: routeName(id, routes), active: !!act && act.id === id, points };
    })
    .filter((line) => line.points.length > 1);
}
