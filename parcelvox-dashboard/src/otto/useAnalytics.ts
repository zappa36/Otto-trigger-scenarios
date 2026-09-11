import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyticsMode,
  fetchHotspots,
  fetchPlace,
  fetchPlaceReports,
  fetchPlaces,
  lastDays,
  type AnalyticsError,
  type ApiHotspot,
  type ApiPlace,
  type ApiPlaceDetail,
  type ApiReport,
  type Bbox,
  type Range,
} from './analytics';

/*
 * Hooks over the analytics API. Fetched when a view needs them, never on the
 * store's 30 s poll: analytics lags behind writes by design (meta.as_of says
 * how far) and the API rate-limits, so a quiet 5-minute refresh is plenty.
 */

export type AnalyticsStatus = 'off' | 'loading' | 'ready' | 'error';

export interface PlacesAnalytics {
  status: AnalyticsStatus;
  places: ApiPlace[];
  hotspots: ApiHotspot[];
  range: Range;
  asOf: string | null;
  error: string | null;
  refresh: () => void;
}

const REFRESH_MS = 5 * 60000;
const describe = (e: unknown): string => {
  const err = e as AnalyticsError;
  if (err && err.code === 'unreachable') return 'analytics API unreachable — is the mock running?';
  if (err && err.code === 'unauthenticated') return 'analytics API rejected the key';
  if (err && err.code === 'scope_denied') return 'analytics API: this key lacks analytics:read';
  return err && err.message ? `analytics API: ${err.message}` : 'analytics API error';
};

/** Every place inside the bbox (padded a little) plus the top hotspots, over the last 90 days. */
export function usePlacesAnalytics(bbox: Bbox | null, enabled: boolean): PlacesAnalytics {
  const on = analyticsMode === 'live' && enabled && !!bbox;
  const [state, setState] = useState<Omit<PlacesAnalytics, 'refresh' | 'range'>>({
    status: on ? 'loading' : 'off', places: [], hotspots: [], asOf: null, error: null,
  });
  const [tick, setTick] = useState(0);
  const rangeRef = useRef<Range>(lastDays(90));
  const bboxKey = bbox ? bbox.map((n) => n.toFixed(3)).join(',') : '';

  useEffect(() => {
    if (!on) {
      setState({ status: 'off', places: [], hotspots: [], asOf: null, error: null });
      return;
    }
    let cancelled = false;
    const range = lastDays(90);
    rangeRef.current = range;
    const [w, s, e, n] = bbox as Bbox;
    const pad = 0.003;
    setState((cur) => ({ ...cur, status: cur.places.length ? cur.status : 'loading', error: null }));
    Promise.all([
      fetchPlaces(range, { bbox: [w - pad, s - pad, e + pad, n + pad] }),
      fetchHotspots(range, { limit: 10 }),
    ])
      .then(([places, hot]) => {
        if (cancelled) return;
        setState({ status: 'ready', places: places.rows, hotspots: hot.data, asOf: hot.meta.as_of || places.asOf, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState((cur) => ({ ...cur, status: 'error', error: describe(err) }));
      });
    const timer = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // bboxKey stands in for bbox: a fresh array every render must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, bboxKey, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, range: rangeRef.current, refresh };
}

export interface PlaceAnalytics {
  status: AnalyticsStatus;
  detail: ApiPlaceDetail | null;
  reports: ApiReport[];
  asOf: string | null;
  error: string | null;
}

/** One place's numbers and its latest reports — fetched when its panel opens. */
export function usePlaceAnalytics(placeId: string | null, range: Range): PlaceAnalytics {
  const on = analyticsMode === 'live' && !!placeId;
  const [state, setState] = useState<PlaceAnalytics>({ status: on ? 'loading' : 'off', detail: null, reports: [], asOf: null, error: null });
  const rangeKey = `${range.from}|${range.to}`;

  useEffect(() => {
    if (!on) {
      setState({ status: 'off', detail: null, reports: [], asOf: null, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', detail: null, reports: [], asOf: null, error: null });
    Promise.all([fetchPlace(placeId as string, range), fetchPlaceReports(placeId as string, range, 8)])
      .then(([detail, reports]) => {
        if (cancelled) return;
        setState({ status: 'ready', detail: detail.data, reports: reports.data, asOf: detail.meta.as_of, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: 'error', detail: null, reports: [], asOf: null, error: describe(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, placeId, rangeKey]);

  return state;
}
