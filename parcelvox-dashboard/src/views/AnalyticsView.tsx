import { EtaTrendChart } from '../components/EtaTrendChart';
import {
  CAPTURE_BY_ROUTE,
  FAILED_BY_CAUSE,
  FAILED_BY_CAUSE_NOTE,
  KPIS,
  TIP_FRESHNESS,
} from '../data/analytics';
import shared from '../styles/shared.module.css';
import styles from './AnalyticsView.module.css';

const DELTA_CLASS = {
  good: styles.deltaGood,
  warn: styles.deltaWarn,
  neutral: styles.deltaNeutral,
} as const;

export function AnalyticsView() {
  return (
    <div className={shared.page} style={{ maxWidth: 1120 }}>
      <div style={{ marginBottom: 22 }}>
        <h1 className={shared.h1}>Analytics</h1>
        <p className={shared.lede}>
          Delivery outcomes and knowledge health, Nordhaven depot · last 8 weeks
        </p>
      </div>

      <div className={styles.kpis}>
        {KPIS.map((kpi) => (
          <div key={kpi.label} className={`${shared.card} ${shared.cardPad}`}>
            <div className={styles.kpiLabel}>{kpi.label}</div>
            <div className={styles.kpiValue}>{kpi.value}</div>
            <div className={`${styles.kpiDelta} ${DELTA_CLASS[kpi.deltaTone]}`}>
              {kpi.delta}
              {kpi.deltaAccent && <span className={styles.deltaAccent}>{kpi.deltaAccent}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.split}>
        <div className={`${shared.card} ${shared.cardPadLg}`}>
          <div className={shared.cardTitle}>ETA accuracy, 8 weeks</div>
          <EtaTrendChart className={styles.chart} />
        </div>

        <div className={`${shared.card} ${shared.cardPadLg}`}>
          <div className={shared.cardTitle}>Failed stops by cause, this week</div>
          <div className={styles.bars}>
            {FAILED_BY_CAUSE.map((cause) => (
              <div key={cause.label} className={styles.barRow}>
                <span className={styles.barLabel}>{cause.label}</span>
                <span className={styles.barTrack}>
                  <span
                    className={`${styles.barFill} ${
                      cause.tone === 'strong' ? styles.fillStrong : styles.fillSoft
                    }`}
                    style={{ width: `${cause.width}%` }}
                  />
                </span>
                <span className={styles.barValue}>{cause.count}</span>
              </div>
            ))}
          </div>
          <p className={shared.cardNote}>{FAILED_BY_CAUSE_NOTE}</p>
        </div>
      </div>

      <div className={styles.split}>
        <div className={`${shared.card} ${shared.cardPadLg}`}>
          <div className={shared.cardTitle}>Capture rate by route</div>
          <div className={shared.cardSub}>Tips per 100 stops, last 4 weeks</div>
          <div className={styles.captureBars}>
            {CAPTURE_BY_ROUTE.map((route) => (
              <div key={route.label} className={styles.captureRow}>
                <span className={styles.captureLabel}>{route.label}</span>
                <span className={styles.captureTrack}>
                  <span
                    className={`${styles.barFill} ${
                      route.lagging ? styles.fillStrong : styles.fillGreen
                    }`}
                    style={{ width: `${route.width}%` }}
                  />
                </span>
                <span className={styles.captureValue}>{route.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={`${shared.card} ${shared.cardPadLg}`}>
          <div className={shared.cardTitle}>Tip freshness</div>
          <div className={shared.cardSub}>All {TIP_FRESHNESS.total} approved tips</div>
          <div className={styles.stack}>
            {TIP_FRESHNESS.bands.map((band) => (
              <span
                key={band.label}
                style={{ width: `${band.share}%`, background: band.colorVar }}
                title={`${band.label} — ${band.share}%`}
              />
            ))}
          </div>
          <div className={styles.freshnessKey}>
            {TIP_FRESHNESS.bands.map((band) => (
              <div key={band.label} className={styles.keyRow}>
                <span className={styles.keyDot} style={{ background: band.colorVar }} />
                <span>{band.label}</span>
                <span className={styles.keyValue}>{band.share}%</span>
              </div>
            ))}
          </div>
          <p className={shared.cardNote}>{TIP_FRESHNESS.note}</p>
        </div>
      </div>
    </div>
  );
}
