import type { TipCategory } from './queue';

/** Longitude, latitude — WGS84. */
export type LngLat = [number, number];

export interface MapPin {
  stop: string;
  at: LngLat;
  /** Tip types on file at this stop; drives the filter chips above the map. */
  categories: TipCategory[];
}

export interface MapRoute {
  id: string;
  /** Every route leaves the Nordhaven depot. */
  stops: LngLat[];
  /** Stops whose tips are going stale — the only pins drawn on the map. */
  pins: MapPin[];
  highlighted?: boolean;
}

export const DEPOT: LngLat = [13.327, 52.537];
export const DEPOT_LABEL = 'Nordhaven depot';

/** The stop the Ask panel is grounded on — carries Otto's orb on the map. */
export const KRANWEG: MapPin = {
  stop: 'Kranweg 12',
  at: [13.583, 52.442],
  categories: ['Door code', 'Parking', 'Elevator'],
};

export const MAP_ROUTES: MapRoute[] = [
  {
    id: 'Rte 11',
    stops: [
      [13.362, 52.531],
      [13.377, 52.524],
      [13.392, 52.519],
      [13.408, 52.526],
    ],
    pins: [],
  },
  {
    id: 'Rte 12',
    stops: [
      [13.276, 52.532],
      [13.241, 52.539],
      [13.206, 52.535],
      [13.185, 52.522],
    ],
    pins: [{ stop: 'Hafenstraße 14', at: [13.241, 52.539], categories: ['Parking'] }],
  },
  {
    id: 'Rte 15',
    stops: [
      [13.395, 52.556],
      [13.409, 52.575],
      [13.428, 52.596],
      [13.446, 52.615],
    ],
    pins: [{ stop: 'Nordpark-Terrassen 6', at: [13.428, 52.596], categories: ['Access'] }],
  },
  {
    id: 'Rte 17',
    stops: [
      [13.318, 52.562],
      [13.298, 52.58],
      [13.268, 52.592],
      [13.232, 52.603],
    ],
    pins: [
      { stop: 'Möwenkai 21', at: [13.318, 52.562], categories: ['Parking'] },
      { stop: 'Fährweg 3', at: [13.232, 52.603], categories: ['Elevator'] },
    ],
  },
  {
    id: 'Rte 18',
    stops: [
      [13.436, 52.516],
      [13.47, 52.51],
      [13.499, 52.517],
      [13.525, 52.531],
    ],
    pins: [{ stop: 'Speicherweg 5', at: [13.499, 52.517], categories: ['Door code'] }],
  },
  {
    id: 'Rte 21',
    stops: [
      [13.317, 52.512],
      [13.291, 52.505],
      [13.271, 52.493],
      [13.288, 52.477],
    ],
    pins: [{ stop: 'Universitätsallee 9', at: [13.291, 52.505], categories: ['Door code'] }],
  },
  {
    id: 'Rte 22',
    stops: [
      [13.383, 52.489],
      [13.402, 52.47],
      [13.424, 52.455],
      [13.448, 52.443],
    ],
    pins: [
      { stop: 'Gewerbehof süd 2', at: [13.383, 52.489], categories: ['Parking'] },
      { stop: 'Hallenring 8', at: [13.448, 52.443], categories: ['Access'] },
    ],
  },
  {
    id: 'Rte 14',
    highlighted: true,
    stops: [
      [13.427, 52.503],
      [13.462, 52.482],
      [13.512, 52.462],
      [13.548, 52.451],
      KRANWEG.at,
    ],
    pins: [
      { stop: 'Alte Werft 3', at: [13.427, 52.503], categories: ['Parking', 'Access'] },
      { stop: 'Werftstraße 40', at: [13.548, 52.451], categories: ['Door code'] },
    ],
  },
];

/** Nudges that keep district labels from colliding once the plane is tilted. */
export const DISTRICT_LABEL_OFFSETS: Record<string, [number, number]> = {
  NEUKÖLLN: [26, 14],
  TEMPELHOF: [-20, 6],
  MITTE: [-26, -20],
  FRIEDRICHSHAIN: [0, 26],
  LICHTENBERG: [-14, -16],
  SPANDAU: [-6, 18],
  CHARLOTTENBURG: [0, 18],
};

export const MAP_FILTERS = ['All types', 'Door codes', 'Parking', 'Elevator', 'Access'] as const;
export type MapFilter = (typeof MAP_FILTERS)[number];

/** Maps a filter chip to the tip category it selects. */
export const FILTER_CATEGORY: Record<Exclude<MapFilter, 'All types'>, TipCategory> = {
  'Door codes': 'Door code',
  Parking: 'Parking',
  Elevator: 'Elevator',
  Access: 'Access',
};

/** Stale tips across the whole depot — the legend count. */
export const STALE_TIP_COUNT = 63;
