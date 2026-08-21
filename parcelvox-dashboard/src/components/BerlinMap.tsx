import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { geoArea, geoMercator, geoPath, type GeoProjection } from 'd3-geo';
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
const EUROPE_URL = '/data/europe-countries.geojson';

/**
 * Single-file builds (see `scripts/bundle-standalone.mjs`) inline both
 * geometries here so the page needs no server at all.
 */
declare global {
  interface Window {
    __PARCELVOX_BERLIN_GEO__?: FeatureCollection;
    __PARCELVOX_EUROPE_GEO__?: FeatureCollection;
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

/* Keep in sync with --tilt and scale() in BerlinMap.module.css — pointer
 * deltas arrive in screen px, and the plane lives behind that transform. */
const TILT_SCALE = 1.18;
const TILT_COS = Math.cos((40 * Math.PI) / 180);

/* The zoom-out floor is dynamic: at least region scale, and always far
 * enough out to see every stop on file at once. */
const clampK = (k: number, min: number) => Math.min(60, Math.max(min, k));

/**
 * Fits `projection` to `pts` with padding and a minimum span (a single pin
 * must not zoom to a degenerate scale). With `trim`, the frame is clipped to
 * the 6th–94th percentile per axis — only when there are enough points to
 * trim — so a few far-out pins don't dictate the whole view; they stay
 * reachable by panning, zooming out, or the "show all" jump.
 */
function fitPoints(
  projection: GeoProjection,
  pts: LngLat[],
  width: number,
  height: number,
  trim: boolean,
) {
  const q = (sorted: number[], p: number) => sorted[Math.round(p * (sorted.length - 1))];
  const lngs = pts.map((p) => p[0]).sort((a, b) => a - b);
  const lats = pts.map((p) => p[1]).sort((a, b) => a - b);
  const [lo, hi] = trim && pts.length >= 20 ? [0.06, 0.94] : [0, 1];
  const minLng = q(lngs, lo);
  const maxLng = q(lngs, hi);
  const minLat = q(lats, lo);
  const maxLat = q(lats, hi);
  const padLng = Math.max((maxLng - minLng) * 0.18, 0.012);
  const padLat = Math.max((maxLat - minLat) * 0.18, 0.008);
  /* The extent stops well short of the plane's bottom: the CSS tilt brings
   * the lower edge toward the viewer and the card crops it, and the legend
   * sits in the lower-left corner — content there would be fitted "in" yet
   * invisible. */
  projection.fitExtent(
    [
      [width * 0.05, height * 0.09],
      [width * 0.95, height * 0.78],
    ],
    {
      type: 'MultiPoint',
      coordinates: [
        [minLng - padLng, minLat - padLat],
        [maxLng + padLng, maxLat + padLat],
      ],
    },
  );
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
   * Every door, unfiltered — what the projection is fitted to. A real route
   * is one neighbourhood, unreadable at the citywide fit; and framing on the
   * unfiltered set keeps the camera still while filters come and go.
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
  const [euGeo, setEuGeo] = useState<FeatureCollection | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const inlined = window.__PARCELVOX_BERLIN_GEO__;
    if (inlined) {
      setGeo(rewind(inlined));
    } else {
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
    }
    /* The countries backdrop is a nice-to-have — without it the map still
     * works, only the land beyond Berlin goes blank. */
    const euInlined = window.__PARCELVOX_EUROPE_GEO__;
    if (euInlined) {
      setEuGeo(rewind(euInlined));
    } else {
      fetch(EUROPE_URL)
        .then((response) => (response.ok ? (response.json() as Promise<FeatureCollection>) : null))
        .then((collection) => {
          if (!cancelled && collection) setEuGeo(rewind(collection));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const liveDoors = live ? live.doors : null;
  const liveRoutes = live ? live.routes : null;
  const liveFrame = live ? live.frame : null;

  /* Manual camera. null = the automatic fit; k is a multiple of the fitted
   * scale, so ⌖ and a fresh data set mean the same thing at k = 1. */
  const [camera, setCamera] = useState<{ center: LngLat; k: number } | null>(null);
  /* An in-flight drag is a pure CSS translate of the plane (in plane px) —
   * the projection is recomputed once, on release. */
  const [panPx, setPanPx] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const projectionRef = useRef<GeoProjection | null>(null);
  const baseScaleRef = useRef(1);
  /* The every-stop camera (the "show all" jump) and the matching zoom-out floor. */
  const fitAllRef = useRef<{ center: LngLat; k: number } | null>(null);
  const kMinRef = useRef(0.12);
  const sizeRef = useRef({ w: 0, h: 0 });
  sizeRef.current = { w: width, h: height };

  /* Switching between the sample and the live data is a different world —
   * a camera aimed at one makes no sense over the other. */
  const liveOn = !!(liveDoors && liveRoutes);
  useEffect(() => setCamera(null), [liveOn]);

  /* Selection is deliberately NOT a dependency — picking a door restyles
   * pins without re-projecting a hundred of them. */
  const scene = useMemo(() => {
    if (!geo || width === 0 || height === 0) return null;

    const projection = geoMercator();
    if (liveFrame && liveFrame.length > 0) {
      fitPoints(projection, liveFrame, width, height, true);
    } else {
      projection.fitExtent(
        [
          [-width * 0.04, -height * 0.05],
          [width * 1.04, height * 1.05],
        ],
        geo,
      );
    }
    baseScaleRef.current = projection.scale();

    /* The untrimmed fit is the "show all" camera, and sets how far out the
     * zoom may go — always far enough to see every stop on file at once. */
    if (liveFrame && liveFrame.length > 0) {
      const all = geoMercator();
      fitPoints(all, liveFrame, width, height, false);
      const center = all.invert ? all.invert([width / 2, height / 2]) : null;
      const kAll = all.scale() / baseScaleRef.current;
      fitAllRef.current = center ? { center: center as LngLat, k: kAll } : null;
      kMinRef.current = Math.min(0.12, kAll * 0.85);
    } else {
      fitAllRef.current = null;
      kMinRef.current = 0.12;
    }

    if (camera) {
      projection
        .center(camera.center)
        .translate([width / 2, height / 2])
        .scale(baseScaleRef.current * camera.k);
    }
    projectionRef.current = projection;
    const path = geoPath(projection);
    const project = (at: LngLat) => projection(at) ?? [0, 0];
    const routeLine = d3line<LngLat>()
      .x((d) => project(d)[0])
      .y((d) => project(d)[1]);

    /* Bezirk detail only near city scale — its strokes and labels are
     * constant-px and turn a fingernail-sized Berlin into a blot. Further
     * out, the countries backdrop carries the map. */
    const cityDetail = projection.scale() > 9000;

    const countries = euGeo
      ? euGeo.features.flatMap((feature) => {
          const d = path(feature);
          if (!d) return [];
          const centroid = path.centroid(feature);
          const props = (feature.properties ?? {}) as Record<string, unknown>;
          const name = String(props.name || '').toUpperCase();
          return [{ name, d, x: centroid[0], y: centroid[1] }];
        })
      : [];

    const districts = !cityDetail
      ? []
      : geo.features.flatMap((feature) => {
          const d = path(feature);
          const centroid = path.centroid(feature);
          if (!d || !Number.isFinite(centroid[0])) return [];
          const name = districtLabel(feature);
          const [dx, dy] = DISTRICT_LABEL_OFFSETS[name] ?? [0, 0];
          return [{ name, d, x: centroid[0] + dx, y: centroid[1] + dy }];
        });

    if (liveDoors && liveRoutes) {
      const doors = liveDoors.map((door) => {
        const [x, y] = project(door.at);
        return { door, x, y };
      });
      return {
        countries,
        districts,
        live: {
          routes: liveRoutes.map((route) => {
            const [sx, sy] = project(route.points[0]);
            return { id: route.id, d: routeLine(route.points) ?? '', labelX: sx + 9, labelY: sy - 9 };
          }),
          doors,
          /* stops currently outside the card — drives the "show all" pill */
          beyond: doors.filter(({ x, y }) => x < 0 || x > width || y < 0 || y > height).length,
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
      countries,
      districts,
      live: null,
      sample: {
        routes,
        depot: project(DEPOT),
        pins: MAP_ROUTES.flatMap((route) => route.pins).map(placePin),
        otto: placePin(KRANWEG),
      },
    };
  }, [geo, euGeo, width, height, liveDoors, liveRoutes, liveFrame, camera]);

  /* The camera as the projection currently sees it, so wheel, buttons and
   * drags compose with whatever the fit produced. Reads refs only. */
  const cameraNow = (): { center: LngLat; k: number } | null => {
    const proj = projectionRef.current;
    const { w, h } = sizeRef.current;
    if (!proj || !proj.invert || !w || !h) return null;
    const center = proj.invert([w / 2, h / 2]);
    return center ? { center: center as LngLat, k: proj.scale() / baseScaleRef.current } : null;
  };
  const cameraRef = useRef(cameraNow);
  cameraRef.current = cameraNow;

  const zoomBy = (factor: number) => {
    const cam = cameraNow();
    if (cam) setCamera({ center: cam.center, k: clampK(cam.k * factor, kMinRef.current) });
  };

  /* Jump to the untrimmed fit — every stop on file in one view. */
  const showAll = () => {
    const all = fitAllRef.current;
    if (all) setCamera({ center: all.center, k: clampK(all.k, kMinRef.current) });
  };

  /* Wheel needs a native non-passive listener — a synthetic onWheel can't
   * preventDefault the page scroll. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current();
      if (cam) setCamera({ center: cam.center, k: clampK(cam.k * Math.exp(-e.deltaY * 0.0016), kMinRef.current) });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  /* Screen-px pointer delta → plane px (the tilt scales x, foreshortens y). */
  const planeDelta = (
    e: { clientX: number; clientY: number },
    d: { sx: number; sy: number },
  ): [number, number] => [
    (e.clientX - d.sx) / TILT_SCALE,
    (e.clientY - d.sy) / (TILT_SCALE * TILT_COS),
  ];

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    /* A fresh press is a fresh intent — the previous drag's suppression must
     * not survive to eat this press's click (the browser doesn't always fire
     * a click at the end of a drag, so the flag can't count on being consumed). */
    suppressClick.current = false;
    dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    setPanPx(planeDelta(e, d));
  };
  const endPan = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true; // the release lands on a pin — that's not a pick
    const [pdx, pdy] = planeDelta(e, d);
    const proj = projectionRef.current;
    const { w, h } = sizeRef.current;
    const cam = cameraNow();
    const center = proj && proj.invert && w && h ? proj.invert([w / 2 - pdx, h / 2 - pdy]) : null;
    if (center && cam) setCamera({ center: center as LngLat, k: clampK(cam.k, kMinRef.current) });
    setPanPx(null); // batched with setCamera — the committed projection replaces the preview
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const visible = (pin: MapPin) => filter === null || pin.categories.includes(filter);

  const selectDoor = (key: string) => live && live.onSelectDoor(key);
  const doorKeyDown = (key: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    selectDoor(key);
  };

  return (
    <div
      className={`${styles.stage} ${panPx ? styles.dragging : ''}`}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onPointerLeave={endPan}
      onClickCapture={onClickCapture}
    >
      <div className={styles.tilt} ref={tiltRef}>
        <div
          className={styles.content}
          style={panPx ? { transform: `translate(${panPx[0]}px, ${panPx[1]}px)` } : undefined}
        >
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
                  ? `Map of the depot's ${scene.live.doors.length} stops from the dispatch board`
                  : 'Berlin, with all eight routes fanning out from the Nordhaven depot and Rte 14 highlighted'
              }
            >
              <g>
                {scene.countries.map((country) => (
                  <path
                    key={`country-${country.name}-${country.x}`}
                    d={country.d}
                    fill="var(--pv-map-land)"
                    stroke="var(--pv-map-outline)"
                    strokeWidth={1}
                    strokeLinejoin="round"
                  />
                ))}
              </g>
              <g>
                {scene.countries.map(
                  (country) =>
                    country.name && (
                      <text
                        key={`country-label-${country.name}-${country.x}`}
                        x={country.x}
                        y={country.y}
                        textAnchor="middle"
                        fontFamily="Inter, sans-serif"
                        fontSize={9.5}
                        fontWeight={600}
                        letterSpacing={1.2}
                        fill="var(--pv-map-label)"
                        style={{ paintOrder: 'stroke', stroke: 'var(--pv-map-land)', strokeWidth: 3 }}
                      >
                        {country.name}
                      </text>
                    ),
                )}
              </g>
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
      </div>
      <div className={styles.controls}>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.5)}>
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(1 / 1.5)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Fit the stops"
          title="Back to the fitted view"
          onClick={() => setCamera(null)}
        >
          ⌖
        </button>
      </div>
      {scene?.live && scene.live.beyond > 0 && (
        <button type="button" className={styles.beyond} onClick={showAll}>
          {scene.live.beyond} {scene.live.beyond === 1 ? 'stop' : 'stops'} beyond this view — show
          all
        </button>
      )}
      {failed && <div className={styles.message}>Map data unavailable</div>}
    </div>
  );
}
