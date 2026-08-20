import type { LngLat } from '../data/map';
import { notesOf, type DepotDebrief, type DepotStop } from './depot';

/*
 * Grouping the flat destinations list into what the map draws.
 *
 * A door is every stop at one exact position — stacked same-address rows
 * are one building, several parcels, exactly the grouping the trigger
 * dashboard's stop sheet uses. A route line is a route's rows in driving
 * order (the stop column), consecutive duplicates collapsed where several
 * parcels share a door.
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
}

export interface DepotRouteLine {
  id: string;
  points: LngLat[];
}

const stopOrder = (a: DepotStop, b: DepotStop) =>
  ((a.stop == null ? 1e9 : a.stop) - (b.stop == null ? 1e9 : b.stop)) ||
  String(a.created_at || '').localeCompare(String(b.created_at || ''));

export function groupDoors(
  stops: DepotStop[],
  debriefs: Record<string, DepotDebrief[]>,
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
    return {
      key,
      at: [first.lng, first.lat] as LngLat,
      title: String(first.title || first.addr || 'Stop'),
      rows,
      stopNos: rows.map((r) => r.stop).filter((n): n is number => n != null),
      hasNotes: rows.some((r) => notesOf(r).length > 0),
      debriefed: rows.some((r) => (debriefs[r.id] || []).length > 0),
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

export function routeLines(stops: DepotStop[]): DepotRouteLine[] {
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
      return { id, points };
    })
    .filter((line) => line.points.length > 1);
}

/*
 * The map is a Berlin frame — the projection is fitted to the twelve
 * Bezirke, so a pin elsewhere would land far off the card. Scenario pins
 * can be anywhere in the world; those outside are counted, not drawn.
 * Bounds are the Bezirk geometry's bbox with a little slack.
 */
export const inBerlinFrame = (door: DepotDoor): boolean => {
  const [lng, lat] = door.at;
  return lng > 13.05 && lng < 13.8 && lat > 52.32 && lat < 52.7;
};
