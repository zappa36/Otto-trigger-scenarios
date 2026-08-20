import { FEATURED_ROUTE_ID, ROUTES } from '../data/routes';
import shared from '../styles/shared.module.css';

const COLUMNS = '1.5fr .55fr 1.5fr .9fr 1.1fr .25fr';

interface RoutesViewProps {
  onOpenRoute: () => void;
}

export function RoutesView({ onOpenRoute }: RoutesViewProps) {
  return (
    <div className={shared.page} style={{ maxWidth: 1080 }}>
      <h1 className={shared.h1}>Routes</h1>
      <p className={shared.lede} style={{ marginBottom: 22 }}>
        Tip coverage is the share of stops with at least one current tip. ETA accuracy is the share
        of stops delivered inside their promised window, last 7 days.
      </p>

      <div className={shared.table}>
        <div className={shared.thead} style={{ gridTemplateColumns: COLUMNS }}>
          <span>Route</span>
          <span>Stops</span>
          <span>Tip coverage</span>
          <span>Failed stops</span>
          <span>ETA accuracy</span>
          <span />
        </div>

        {ROUTES.map((route) => {
          // Routes with a note carry the honey figures; the route the demo
          // drills into also carries the highlighted row.
          const flagged = Boolean(route.note);
          const featured = route.id === FEATURED_ROUTE_ID;
          return (
            <button
              key={route.id}
              type="button"
              className={`${shared.row} ${shared.rowLink} ${featured ? shared.rowFlagged : ''}`}
              style={{ gridTemplateColumns: COLUMNS }}
              onClick={onOpenRoute}
            >
              <span className={shared.cellStrong}>
                {route.id} · {route.area}
              </span>
              <span>{route.stops}</span>
              <span className={shared.meter}>
                <span className={shared.meterTrack}>
                  <span className={shared.meterFill} style={{ width: `${route.coverage}%` }} />
                </span>
                <span className={shared.meterValue}>{route.coverage}%</span>
              </span>
              <span className={flagged ? shared.flag : undefined}>{route.failedStops}</span>
              <span>
                <span className={flagged ? shared.flag : undefined}>{route.etaAccuracy}%</span>
                {route.note && <span className={shared.rowNote}>{route.note}</span>}
              </span>
              <span className={shared.chevron}>›</span>
            </button>
          );
        })}
      </div>

      <p className={shared.footnote}>Route pages open on Rte 14 in this demo.</p>
    </div>
  );
}
