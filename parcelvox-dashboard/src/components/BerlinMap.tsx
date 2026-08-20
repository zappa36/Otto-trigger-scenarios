import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { geoArea, geoMercator, geoPath } from 'd3-geo';
import { line as d3line } from 'd3-shape';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  DEPOT,
  DEPOT_LABEL,
  DISTRICT_LABEL_OFFSETS,
  KRANWEG,
  MAP_ROUTES,
  type LngLat,
  type MapPin,
} from '../data/map';
import type { TipCategory } from '../data/queue';
import { doorLabel, type DepotDoor, type DepotRouteLine } from '../otto/doors';
import { OttoOrb } from './OttoOrb';
import styles from './BerlinMap.module.css';

const GEOJSON_URL = '/data/berliner-bezirke.geojson';

/**
 * Single-file builds (see `scripts/bundle-standalone.mjs`) inline the district
 * geometry here so the page needs no server at all.
 */
declare global {
  interface Window {
    __PARCELVOX_BERLIN_GEO__?: FeatureCollection;
  }
}

/**
 * d3 fits the *outside* of a polygon whose rings wind the wrong way, which
 * collapses the whole city to a dot. Anything covering more than a hemisphere
 * is inside out — reverse its rings.
 */
function rewind(collection: FeatureCollection): FeatureCollection {
  const reverse = <T,>(ring: T[]) => ring.slice().reverse();
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry || geoArea(feature) <= Math.PI) continue;
    if (geometry.type === 'Polygon') {
      geometry.coordinates = geometry.coordinates.map(reverse);
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates = geometry.coordinates.map((polygon) => polygon.map(reverse));
    }
  }
  return collection;
}

/** "Friedrichshain-Kreuzberg" → "FRIEDRICHSHAIN". */
function districtLabel(feature: Feature<Geometry>): string {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const raw =
    properties.spatial_alias ??
    properties.name ??
    Object.values(properties).find((v) => typeof v === 'string' && /[a-z]/i.test(v)) ??
    '';
  return String(raw).split(/[-\s]/)[0].toUpperCase();
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

/** The real app's stops, when the shared store has any — replaces the sample. */
export interface LiveScene {
  doors: DepotDoor[];
  routes: DepotRouteLine[];
  /**
   * Every in-frame door, unfiltered — what the projection is fitted to. A real
   * route is one neighbourhood, unreadable at the citywide fit; and framing on
   * the unfiltered set keeps the camera still while filters come and go.
   */
  frame: LngLat[];
  selectedKey: string | null;
  onSelectDoor: (key: string) => void;
}

interface BerlinMapProps {
  /** Null shows every stale-tip pin; otherwise only pins with that tip type. Sample mode only. */
  filter: TipCategory | null;
  /** When set, the map draws the depot's real stops instead of the fictional sample. */
  live?: LiveScene | null;
}

export function BerlinMap({ filter, live }: BerlinMapProps) {
  const [tiltRef, { width, height }] = useElementSize<HTMLDivElement>();
  const [geo, setGeo] = useState<FeatureCollection | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const inlined = window.__PARCELVOX_BERLIN_GEO__;
    if (inlined) {
      setGeo(rewind(inlined));
      return;
    }
    fetch(GEOJSON_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.json() as Promise<FeatureCollection>;
      })
      .then((collection) => {
        if (!cancelled) setGeo(rewind(collection));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const liveDoors = live ? live.doors : null;
  const liveRoutes = live ? live.routes : null;
  const liveFrame = live ? live.frame : null;

  /* Selection is deliberately NOT a dependency — picking a door restyles
   * pins without re-projecting a hundred of them. */
  const scene = useMemo(() => {
    if (!geo || width === 0 || height === 0) return null;

    const projection = geoMercator();
    if (liveFrame && liveFrame.length > 0) {
      /* Fit the stops, not the city: a real route is one neighbourhood.
       * A padded bbox with a minimum span keeps a single pin from zooming
       * to a degenerate scale; the Bezirk plane just extends past the card. */
      const lngs = liveFrame.map((p) => p[0]);
      const lats = liveFrame.map((p) => p[1]);
      const padLng = Math.max((Math.max(...lngs) - Math.min(...lngs)) * 0.18, 0.012);
      const padLat = Math.max((Math.max(...lats) - Math.min(...lats)) * 0.18, 0.008);
      projection.fitExtent(
        [
          [width * 0.04, height * 0.07],
          [width * 0.96, height * 0.96],
        ],
        {
          type: 'MultiPoint',
          coordinates: [
            [Math.min(...lngs) - padLng, Math.min(...lats) - padLat],
            [Math.max(...lngs) + padLng, Math.max(...lats) + padLat],
          ],
        },
      );
    } else {
      projection.fitExtent(
        [
          [-width * 0.04, -height * 0.05],
          [width * 1.04, height * 1.05],
        ],
        geo,
      );
    }
    const path = geoPath(projection);
    const project = (at: LngLat) => projection(at) ?? [0, 0];
    const routeLine = d3line<LngLat>()
      .x((d) => project(d)[0])
      .y((d) => project(d)[1]);

    const districts = geo.features.flatMap((feature) => {
      const d = path(feature);
      const centroid = path.centroid(feature);
      if (!d || !Number.isFinite(centroid[0])) return [];
      const name = districtLabel(feature);
      const [dx, dy] = DISTRICT_LABEL_OFFSETS[name] ?? [0, 0];
      return [{ name, d, x: centroid[0] + dx, y: centroid[1] + dy }];
    });

    if (liveDoors && liveRoutes) {
      return {
        districts,
        live: {
          routes: liveRoutes.map((route) => {
            const [sx, sy] = project(route.points[0]);
            return { id: route.id, d: routeLine(route.points) ?? '', labelX: sx + 9, labelY: sy - 9 };
          }),
          doors: liveDoors.map((door) => {
            const [x, y] = project(door.at);
            return { door, x, y };
          }),
        },
        sample: null,
      };
    }

    const routes = MAP_ROUTES.map((route) => {
      const last = route.stops[route.stops.length - 1];
      const [lx, ly] = project(last);
      return {
        id: route.id,
        highlighted: route.highlighted ?? false,
        d: routeLine([DEPOT, ...route.stops]) ?? '',
        labelX: lx + (route.highlighted ? 18 : 9),
        labelY: ly + (route.highlighted ? 2 : -9),
      };
    });

    const placePin = (pin: MapPin) => {
      const [x, y] = project(pin.at);
      return { ...pin, x, y };
    };

    return {
      districts,
      live: null,
      sample: {
        routes,
        depot: project(DEPOT),
        pins: MAP_ROUTES.flatMap((route) => route.pins).map(placePin),
        otto: placePin(KRANWEG),
      },
    };
  }, [geo, width, height, liveDoors, liveRoutes, liveFrame]);

  const visible = (pin: MapPin) => filter === null || pin.categories.includes(filter);

  const selectDoor = (key: string) => live && live.onSelectDoor(key);
  const doorKeyDown = (key: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    selectDoor(key);
  };

  return (
    <div className={styles.stage}>
      <div className={styles.tilt} ref={tiltRef}>
        {scene && (
          <>
            <svg
              className={styles.svg}
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={
                scene.live
                  ? `Berlin, with the depot's ${scene.live.doors.length} stops from the dispatch board`
                  : 'Berlin, with all eight routes fanning out from the Nordhaven depot and Rte 14 highlighted'
              }
            >
              <g>
                {scene.districts.map((district) => (
                  <path
                    key={`fill-${district.name}-${district.x}`}
                    d={district.d}
                    fill="var(--pv-map-land)"
                    stroke="var(--pv-map-land-edge)"
                    strokeWidth={3}
                    strokeLinejoin="round"
                  />
                ))}
              </g>
              <g>
                {scene.districts.map((district) => (
                  <path
                    key={`edge-${district.name}-${district.x}`}
                    d={district.d}
                    fill="none"
                    stroke="var(--pv-map-outline)"
                    strokeWidth={1}
                  />
                ))}
              </g>
              <g>
                {scene.districts.map((district) => (
                  <text
                    key={`label-${district.name}-${district.x}`}
                    x={district.x}
                    y={district.y}
                    textAnchor="middle"
                    fontFamily="Inter, sans-serif"
                    fontSize={9}
                    fontWeight={600}
                    letterSpacing={1.2}
                    fill="var(--pv-map-label)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--pv-map-land)', strokeWidth: 3 }}
                  >
                    {district.name}
                  </text>
                ))}
              </g>

              {scene.sample && (
                <>
                  {scene.sample.routes.map((route) => (
                    <path
                      key={route.id}
                      d={route.d}
                      fill="none"
                      stroke={route.highlighted ? 'var(--pv-green)' : 'var(--pv-route-grey)'}
                      strokeWidth={route.highlighted ? 3.5 : 2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={route.highlighted ? 1 : 0.65}
                    />
                  ))}
                  {scene.sample.routes.map((route) => (
                    <text
                      key={`${route.id}-label`}
                      x={route.labelX}
                      y={route.labelY}
                      fontFamily="Inter, sans-serif"
                      fontSize={route.highlighted ? 11.5 : 11}
                      fontWeight={route.highlighted ? 700 : 600}
                      fill={route.highlighted ? 'var(--pv-green-dark)' : 'var(--pv-muted-2)'}
                      style={{ paintOrder: 'stroke', stroke: 'var(--pv-map-land)', strokeWidth: 4 }}
                    >
                      {route.id}
                    </text>
                  ))}

                  <rect
                    x={scene.sample.depot[0] - 4.5}
                    y={scene.sample.depot[1] - 4.5}
                    width={9}
                    height={9}
                    rx={3}
                    fill="var(--pv-ink)"
                    stroke="#FFFFFF"
                    strokeWidth={2}
                  />
                  <text
                    x={scene.sample.depot[0] - 9}
                    y={scene.sample.depot[1] + 16}
                    textAnchor="end"
                    fontFamily="Inter, sans-serif"
                    fontSize={10.5}
                    fontWeight={600}
                    fill="var(--pv-ink-2)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--pv-map-land)', strokeWidth: 4 }}
                  >
                    {DEPOT_LABEL}
                  </text>
                </>
              )}

              {scene.live && (
                <>
                  {scene.live.routes.map((route) => (
                    <path
                      key={route.id}
                      d={route.d}
                      fill="none"
                      stroke="var(--pv-green)"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.9}
                    />
                  ))}
                  {scene.live.routes.map((route) => (
                    <text
                      key={`${route.id}-label`}
                      x={route.labelX}
                      y={route.labelY}
                      fontFamily="Inter, sans-serif"
                      fontSize={11.5}
                      fontWeight={700}
                      fill="var(--pv-green-dark)"
                      style={{ paintOrder: 'stroke', stroke: 'var(--pv-map-land)', strokeWidth: 4 }}
                    >
                      {route.id}
                    </text>
                  ))}

                  {/* Doors without notes lie flat on the plane; a click stands them up. */}
                  {scene.live.doors
                    .filter(({ door }) => !door.hasNotes && door.key !== live?.selectedKey)
                    .map(({ door, x, y }) => (
                      <g
                        key={door.key}
                        className={styles.doorDot}
                        role="button"
                        tabIndex={0}
                        aria-label={doorLabel(door)}
                        onClick={() => selectDoor(door.key)}
                        onKeyDown={doorKeyDown(door.key)}
                      >
                        <title>{doorLabel(door)}</title>
                        <circle
                          cx={x}
                          cy={y}
                          r={4.5}
                          fill={door.debriefed ? 'var(--pv-green)' : '#fff'}
                          stroke={door.debriefed ? '#fff' : 'var(--pv-route-grey)'}
                          strokeWidth={1.6}
                        />
                      </g>
                    ))}
                </>
              )}
            </svg>

            {scene.sample && visible(scene.sample.otto) && (
              <div
                className={`${styles.pin} ${styles.ottoPin}`}
                style={{ left: scene.sample.otto.x, top: scene.sample.otto.y }}
              >
                <div className={styles.pinShadow} />
                <div className={styles.pinUp}>
                  <div className={styles.chip}>{scene.sample.otto.stop}</div>
                  <OttoOrb variant="pin" />
                  <div className={styles.pinStem} />
                </div>
              </div>
            )}

            {scene.sample &&
              scene.sample.pins.filter(visible).map((pin) => (
                <div
                  key={pin.stop}
                  className={styles.pin}
                  style={{ left: pin.x, top: pin.y }}
                  title={`${pin.stop} — tips going stale`}
                >
                  <div className={styles.pinShadow} />
                  <div className={styles.pinUp}>
                    <div className={styles.pinHead} />
                    <div className={styles.pinStem} />
                  </div>
                </div>
              ))}

            {/* Standing pins: amber where notes are on file, and whichever door is open. */}
            {scene.live &&
              scene.live.doors
                .filter(({ door }) => door.hasNotes || door.key === live?.selectedKey)
                .map(({ door, x, y }) => {
                  const selected = door.key === live?.selectedKey;
                  return (
                    <div
                      key={door.key}
                      className={`${styles.pin} ${styles.livePin} ${selected ? styles.pinSelected : ''}`}
                      style={{ left: x, top: y }}
                      role="button"
                      tabIndex={0}
                      aria-label={doorLabel(door)}
                      title={door.hasNotes ? `${doorLabel(door)} — notes on file` : doorLabel(door)}
                      onClick={() => selectDoor(door.key)}
                      onKeyDown={doorKeyDown(door.key)}
                    >
                      <div className={styles.pinShadow} />
                      <div className={styles.pinUp}>
                        {selected && <div className={styles.chip}>{doorLabel(door)}</div>}
                        <div
                          className={`${styles.pinHead} ${door.hasNotes ? '' : styles.pinHeadPlain}`}
                        />
                        <div className={styles.pinStem} />
                      </div>
                    </div>
                  );
                })}
          </>
        )}
      </div>
      {failed && <div className={styles.message}>Map data unavailable</div>}
    </div>
  );
}
