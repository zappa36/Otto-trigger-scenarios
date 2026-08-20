import { RTE_14_DETAIL } from '../data/routeDetail';
import { ROUTES } from '../data/routes';
import shared from '../styles/shared.module.css';
import styles from './RouteDetailView.module.css';

const COLUMNS = '1.4fr 1.8fr 1fr .9fr';

/** "Gate waits at Alte Werft" → "gate waits at Alte Werft", for mid-sentence use. */
function sentenceTail(text: string | undefined) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

const TIP_CLASS = {
  current: shared.tipCurrent,
  stale: shared.tipStale,
  pending: shared.tipPending,
} as const;

interface RouteDetailViewProps {
  onBack: () => void;
  /** Sends the debrief request through to the Ask view. */
  onAskForDebrief: (question: string) => void;
}

export function RouteDetailView({ onBack, onAskForDebrief }: RouteDetailViewProps) {
  const detail = RTE_14_DETAIL;
  const route = ROUTES.find((r) => r.id === detail.routeId);
  if (!route) return null;

  return (
    <div className={shared.page} style={{ maxWidth: 1080 }}>
      <button type="button" className={styles.back} onClick={onBack}>
        ← All routes
      </button>
      <h1 className={shared.h1}>
        {route.id} · {route.area}
      </h1>

      <div className={`${shared.pills} ${styles.stats}`}>
        <span className={shared.pill}>{route.stops} stops</span>
        <span className={shared.pill}>Tip coverage {route.coverage}%</span>
        <span className={`${shared.pill} ${shared.pillAlert}`}>
          ETA accuracy {route.etaAccuracy}% · {sentenceTail(route.note)}
        </span>
        <span className={`${shared.pill} ${shared.pillAlert}`}>
          {route.failedStops} failed stops this week
        </span>
        <span className={shared.pill}>Rotation: {detail.rotation}</span>
      </div>

      <div className={styles.alert}>
        <div className={styles.alertBody}>
          <div className={styles.alertTitle}>{detail.alert.title}</div>
          <div className={styles.alertText}>{detail.alert.body}</div>
        </div>
        <button
          type="button"
          className={shared.btnPrimary}
          onClick={() => onAskForDebrief(`Why does route 14 fail on Mondays?`)}
        >
          {detail.alert.action}
        </button>
      </div>

      <div className={shared.table}>
        <div className={shared.thead} style={{ gridTemplateColumns: COLUMNS }}>
          <span>Stop</span>
          <span>Tips on file</span>
          <span>Last confirmed</span>
          <span>Last 4 Mondays</span>
        </div>

        {detail.stops.map((stop) => (
          <div key={stop.address} className={shared.row} style={{ gridTemplateColumns: COLUMNS }}>
            <span className={shared.cellStrong}>{stop.address}</span>
            {stop.tips.length > 0 ? (
              <span className={shared.tips}>
                {stop.tips.map((tip) => (
                  <span key={tip.label} className={`${shared.tip} ${TIP_CLASS[tip.state]}`}>
                    {tip.label}
                  </span>
                ))}
              </span>
            ) : (
              <span className={shared.cellEmpty}>No tips yet</span>
            )}
            {stop.lastConfirmed ? (
              <span className={shared.cellDate}>{stop.lastConfirmed}</span>
            ) : (
              <span className={shared.cellEmpty}>—</span>
            )}
            <span className={shared.dots}>
              {stop.mondays.map((outcome, i) => (
                <span
                  key={i}
                  className={`${shared.dot} ${outcome === 'failed' ? shared.dotFail : shared.dotOk}`}
                  title={outcome === 'failed' ? 'Failed' : 'Delivered'}
                />
              ))}
            </span>
          </div>
        ))}
      </div>

      <p className={shared.footnote}>{detail.footnote}</p>
    </div>
  );
}
