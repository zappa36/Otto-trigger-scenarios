export interface RouteSummary {
  /** Short identifier as it appears in the UI, e.g. "Rte 14". */
  id: string;
  /** Neighbourhood the route covers. */
  area: string;
  stops: number;
  /** Share of stops with at least one current tip, in percent. */
  coverage: number;
  failedStops: number;
  /** Share of stops delivered inside their promised window, last 7 days. */
  etaAccuracy: number;
  /** Why ETA accuracy is low. Present only on routes that need attention. */
  note?: string;
}

/** All sample data is fictional — Nordhaven depot does not exist. */
export const ROUTES: RouteSummary[] = [
  { id: 'Rte 11', area: 'Altstadt ring', stops: 42, coverage: 86, failedStops: 3, etaAccuracy: 92 },
  { id: 'Rte 12', area: 'Hafen west', stops: 38, coverage: 71, failedStops: 5, etaAccuracy: 89 },
  {
    id: 'Rte 14',
    area: 'Werftviertel',
    stops: 47,
    coverage: 64,
    failedStops: 9,
    etaAccuracy: 76,
    note: 'Gate waits at Alte Werft',
  },
  { id: 'Rte 15', area: 'Nordpark', stops: 35, coverage: 92, failedStops: 1, etaAccuracy: 95 },
  {
    id: 'Rte 17',
    area: 'Möwenkai',
    stops: 41,
    coverage: 58,
    failedStops: 7,
    etaAccuracy: 81,
    note: 'Bridge openings midday',
  },
  { id: 'Rte 18', area: 'Speicherstadt', stops: 44, coverage: 77, failedStops: 4, etaAccuracy: 93 },
  { id: 'Rte 21', area: 'Universität', stops: 33, coverage: 83, failedStops: 2, etaAccuracy: 94 },
  {
    id: 'Rte 22',
    area: 'Gewerbehof süd',
    stops: 29,
    coverage: 45,
    failedStops: 8,
    etaAccuracy: 71,
    note: 'Loading zones full after 10:00',
  },
];

/** The route the demo drills into. */
export const FEATURED_ROUTE_ID = 'Rte 14';
