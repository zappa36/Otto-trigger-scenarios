export interface Driver {
  name: string;
  /** Routes the driver covers, as shown in the UI. */
  routesCovered: string;
  tipsShared: number;
  tipsAccepted: number;
  /** Share of shared tips that were approved, in percent. */
  acceptance: number;
  lastDebrief: string;
}

/**
 * Contribution only. ParcelVox keeps no records of pace, speed, or stops per
 * hour — this is knowledge capture, not surveillance.
 */
export const DRIVERS: Driver[] = [
  { name: 'Jonas B.', routesCovered: 'Rte 14 · 18', tipsShared: 38, tipsAccepted: 34, acceptance: 89, lastDebrief: 'Yesterday' },
  { name: 'Ayla T.', routesCovered: 'Rte 17 · 12', tipsShared: 31, tipsAccepted: 27, acceptance: 87, lastDebrief: 'Today' },
  { name: 'Ruth H.', routesCovered: 'Rte 18', tipsShared: 26, tipsAccepted: 24, acceptance: 92, lastDebrief: 'Today' },
  { name: 'Deniz K.', routesCovered: 'Rte 14 · 22', tipsShared: 22, tipsAccepted: 18, acceptance: 82, lastDebrief: 'Yesterday' },
  { name: 'Petra L.', routesCovered: 'Rte 21', tipsShared: 19, tipsAccepted: 17, acceptance: 89, lastDebrief: 'Mon' },
  { name: 'Ines F.', routesCovered: 'Rte 15', tipsShared: 17, tipsAccepted: 16, acceptance: 94, lastDebrief: 'Mon' },
  { name: 'Samuel W.', routesCovered: 'Rte 22', tipsShared: 12, tipsAccepted: 9, acceptance: 75, lastDebrief: 'Mon' },
  { name: 'Marek S.', routesCovered: 'Rte 11 · 12', tipsShared: 9, tipsAccepted: 7, acceptance: 78, lastDebrief: 'Aug 12' },
];
