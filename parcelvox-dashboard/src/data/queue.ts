export type TipCategory = 'Door code' | 'Parking' | 'Elevator' | 'Access';

export interface QueuedTip {
  id: string;
  category: TipCategory;
  stop: string;
  route: string;
  /** Set when the tip would replace a tip already on file. */
  replacesStale?: boolean;
  received: string;
  headline: string;
  /** Excerpt of what the driver said during the Otto debrief. */
  quote: string;
  driver: string;
}

export const QUEUED_TIPS: QueuedTip[] = [
  {
    id: 'q-1',
    category: 'Door code',
    stop: 'Speicherweg 5',
    route: 'Rte 18',
    received: 'Today 07:42',
    headline: 'Front gate code changed to 2481#',
    quote: '…the old code stopped working, a neighbor let me in — the new one is 2481 hash…',
    driver: 'Ruth H.',
  },
  {
    id: 'q-2',
    category: 'Parking',
    stop: 'Möwenkai 21',
    route: 'Rte 17',
    received: 'Today 07:15',
    headline: 'Courtyard fits a van after 09:30 — before that, use the ferry lot',
    quote: '…gate stays shut for the fish market until half nine, ferry lot is two minutes on foot…',
    driver: 'Ayla T.',
  },
  {
    id: 'q-3',
    category: 'Elevator',
    stop: 'Kranweg 12',
    route: 'Rte 14',
    replacesStale: true,
    received: 'Yesterday 16:20',
    headline: 'Freight elevator is back in service',
    quote: '…they fixed the freight lift, no more stairwell B runs for the upper floors…',
    driver: 'Jonas B.',
  },
  {
    id: 'q-4',
    category: 'Access',
    stop: 'Alte Werft 3',
    route: 'Rte 14',
    received: 'Yesterday 11:05',
    headline: 'Ring unit 4b — the caretaker takes parcels until 14:00',
    quote:
      '…nobody answers the main bell, but 4b is the caretaker and he signs for the whole house before two…',
    driver: 'Deniz K.',
  },
  {
    id: 'q-5',
    category: 'Door code',
    stop: 'Universitätsallee 9',
    route: 'Rte 21',
    received: 'Mon 13:48',
    headline: 'Side entrance code 77A3 — main door stays locked during lectures',
    quote: '…main door locked again, porter says use the side entrance, seven seven A three…',
    driver: 'Petra L.',
  },
  {
    id: 'q-6',
    category: 'Parking',
    stop: 'Gewerbehof süd 2',
    route: 'Rte 22',
    received: 'Mon 09:12',
    headline: 'Ask at the gatehouse — the guard opens the yard for deliveries',
    quote: '…don’t queue at the barrier, walk to the gatehouse and they wave you through…',
    driver: 'Samuel W.',
  },
  {
    id: 'q-7',
    category: 'Access',
    stop: 'Nordpark-Terrassen 6',
    route: 'Rte 15',
    received: 'Mon 08:30',
    headline: 'Concierge is closed Mondays — the flower shop next door takes parcels',
    quote: '…concierge desk dark again, the florist said she’s happy to sign on Mondays…',
    driver: 'Ines F.',
  },
];
