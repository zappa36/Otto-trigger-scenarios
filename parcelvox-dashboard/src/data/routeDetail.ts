export type TipState = 'current' | 'stale' | 'pending';

export interface StopTip {
  label: string;
  state: TipState;
}

export interface RouteStop {
  address: string;
  tips: StopTip[];
  /** Date the newest tip was last confirmed; null when the stop has no tips. */
  lastConfirmed: string | null;
  /** Outcome of the last four Mondays, oldest first. */
  mondays: ('delivered' | 'failed')[];
}

export interface RouteDetail {
  routeId: string;
  rotation: string;
  alert: { title: string; body: string; action: string };
  stops: RouteStop[];
  footnote: string;
}

export const RTE_14_DETAIL: RouteDetail = {
  routeId: 'Rte 14',
  rotation: 'Jonas B. · Deniz K.',
  alert: {
    title: 'Möwensteig 8 fails on Mondays',
    body: 'Failed 3 of the last 4 Mondays and has no access tip on file. Two related tips are waiting in the curation queue.',
    action: 'Ask for a debrief',
  },
  stops: [
    {
      address: 'Möwensteig 8',
      tips: [],
      lastConfirmed: null,
      mondays: ['failed', 'delivered', 'failed', 'failed'],
    },
    {
      address: 'Alte Werft 3',
      tips: [
        { label: 'Parking · stale', state: 'stale' },
        { label: 'Access · pending', state: 'pending' },
      ],
      lastConfirmed: 'Jun 12',
      mondays: ['delivered', 'failed', 'delivered', 'failed'],
    },
    {
      address: 'Kranweg 12',
      tips: [
        { label: 'Door code', state: 'current' },
        { label: 'Parking', state: 'current' },
        { label: 'Elevator · stale', state: 'stale' },
      ],
      lastConfirmed: 'Aug 11',
      mondays: ['delivered', 'delivered', 'failed', 'delivered'],
    },
    {
      address: 'Werftstraße 40',
      tips: [{ label: 'Door code · stale', state: 'stale' }],
      lastConfirmed: 'May 30',
      mondays: ['delivered', 'delivered', 'delivered', 'failed'],
    },
    {
      address: 'Salzgasse 7',
      tips: [
        { label: 'Door code', state: 'current' },
        { label: 'Parking', state: 'current' },
      ],
      lastConfirmed: 'Jul 30',
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
    {
      address: 'Werftstraße 15',
      tips: [{ label: 'Door code', state: 'current' }],
      lastConfirmed: 'Aug 6',
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
    {
      address: 'Möwenkai 3',
      tips: [],
      lastConfirmed: null,
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
    {
      address: 'Kaimauer 22',
      tips: [{ label: 'Access', state: 'current' }],
      lastConfirmed: 'Jul 18',
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
    {
      address: 'Hellingweg 2',
      tips: [
        { label: 'Parking', state: 'current' },
        { label: 'Door code', state: 'current' },
      ],
      lastConfirmed: 'Aug 12',
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
    {
      address: 'Salzgasse 19',
      tips: [{ label: 'Elevator', state: 'current' }],
      lastConfirmed: 'Jul 25',
      mondays: ['delivered', 'delivered', 'delivered', 'delivered'],
    },
  ],
  footnote:
    'Stops with open questions shown first · 37 more delivered clean · mint = delivered, honey = failed',
};
