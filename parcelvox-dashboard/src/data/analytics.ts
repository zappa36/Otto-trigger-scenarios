export interface Kpi {
  label: string;
  value: string;
  /** Supporting line under the number. Tone drives its colour. */
  delta: string;
  deltaTone: 'good' | 'warn' | 'neutral';
  /** Optional trailing fragment rendered in green inside a neutral line. */
  deltaAccent?: string;
}

export const KPIS: Kpi[] = [
  {
    label: 'ETA accuracy',
    value: '84.6%',
    delta: '+2.1 pts vs 4 weeks ago',
    deltaTone: 'good',
  },
  {
    label: 'Failed stops this week',
    value: '39',
    delta: '12 fewer than last week',
    deltaTone: 'good',
  },
  {
    label: 'Capture rate',
    value: '3.1',
    delta: 'tips per 100 stops · ',
    deltaTone: 'neutral',
    deltaAccent: '+0.4',
  },
  {
    label: 'Tip freshness',
    value: '68%',
    delta: '−5 pts · 23 tips need a reconfirm',
    deltaTone: 'warn',
  },
];

/** ETA accuracy over the last eight weeks. */
export const ETA_TREND = {
  /** Gridline values, top to bottom. */
  axis: [86, 82, 78, 74],
  weeks: ['W26', 'W27', 'W28', 'W29', 'W30', 'W31', 'W32', 'W33'],
  values: [76.8, 78.2, 77.8, 80.0, 81.2, 82.4, 83.6, 84.4],
  /** Weeks that get an x-axis label. */
  labelledWeeks: ['W26', 'W28', 'W30', 'W32'],
  latestLabel: '84.6%',
  /** Plot x for each week inside the 520×200 viewBox, as drawn in the design. */
  x: [36, 103, 170, 237, 304, 371, 437, 504],
};

export interface CauseBar {
  label: string;
  count: number;
  /** Share of the widest bar, in percent. */
  width: number;
  tone: 'strong' | 'soft';
}

export const FAILED_BY_CAUSE: CauseBar[] = [
  { label: 'No access', count: 14, width: 100, tone: 'strong' },
  { label: 'No parking', count: 11, width: 79, tone: 'strong' },
  { label: 'Recipient absent', count: 8, width: 57, tone: 'soft' },
  { label: 'Wrong entrance', count: 6, width: 43, tone: 'soft' },
];

export const FAILED_BY_CAUSE_NOTE =
  '25 of 39 fails sit at stops with no current access or parking tip.';

export interface CaptureBar {
  label: string;
  value: string;
  width: number;
  /** Routes below the depot average are flagged in honey. */
  lagging?: boolean;
}

export const CAPTURE_BY_ROUTE: CaptureBar[] = [
  { label: 'Rte 15 · Nordpark', value: '4.6', width: 100 },
  { label: 'Rte 11 · Altstadt', value: '3.8', width: 83 },
  { label: 'Rte 14 · Werftviertel', value: '3.4', width: 74 },
  { label: 'Rte 18 · Speicherstadt', value: '3.0', width: 65 },
  { label: 'Rte 21 · Universität', value: '2.8', width: 61 },
  { label: 'Rte 12 · Hafen west', value: '2.4', width: 52 },
  { label: 'Rte 17 · Möwenkai', value: '2.1', width: 46 },
  { label: 'Rte 22 · Gewerbehof', value: '1.3', width: 28, lagging: true },
];

export interface FreshnessBand {
  label: string;
  share: number;
  colorVar: string;
}

export const TIP_FRESHNESS = {
  total: 486,
  bands: [
    { label: 'Confirmed in the last 30 days', share: 68, colorVar: 'var(--pv-green)' },
    { label: '31–90 days old', share: 21, colorVar: 'var(--pv-honey)' },
    { label: 'Older than 90 days', share: 11, colorVar: 'var(--pv-grey-dot)' },
  ] as FreshnessBand[],
  note: 'Reconfirms happen on the next run — a driver just says yes or no to Otto.',
};
