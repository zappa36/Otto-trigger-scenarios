import { analyticsIsMock, analyticsMode, categoryLabel, type Range } from '../otto/analytics';
import { usePlaceAnalytics } from '../otto/useAnalytics';
import styles from './PlaceAnalytics.module.css';

/*
 * What the analytics API knows about one door — the section at the top of
 * the stop panel once an API is configured: four headline numbers, the
 * reported problem types, the cross-carrier bucket, and the latest reports.
 * The numbers are the API's, over its range; the notes below them are the
 * store's. The two are never mixed.
 */

const fmtTime = (iso?: string | null) => {
  const t = new Date(iso || 0);
  return isNaN(t.getTime())
    ? ''
    : t.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const fmtDwell = (s: number | null) =>
  s == null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

interface PlaceAnalyticsProps {
  /** The API place matched to this door; null when the API knows no place here. */
  placeId: string | null;
  range: Range;
}

export function PlaceAnalytics({ placeId, range }: PlaceAnalyticsProps) {
  const a = usePlaceAnalytics(placeId, range);
  if (analyticsMode !== 'live') return null;
  const d = a.detail;
  const per100 = d && d.delivery_count > 0 ? ((d.report_count / d.delivery_count) * 100).toFixed(1) : '—';
  const maxCat = d ? Math.max(1, ...d.top_categories.map((c) => c.count)) : 1;

  return (
    <section className={styles.section} aria-label="Analytics for this place">
      <div className={styles.tag}>
        Analytics · last 90 days{analyticsIsMock ? ' · mock API' : ''}
      </div>

      {!placeId && <p className={styles.empty}>The API has no place at this door yet.</p>}
      {placeId && a.status === 'loading' && <p className={styles.empty}>Loading the API's numbers…</p>}
      {a.status === 'error' && <p className={styles.empty}>{a.error}</p>}

      {d && (
        <>
          <div className={styles.stats}>
            <Stat value={d.report_count} label="reports" />
            <Stat value={d.delivery_count} label="deliveries" />
            <Stat value={fmtDwell(d.median_dwell_seconds)} label="median dwell" />
            <Stat value={per100} label="per 100 deliveries" />
          </div>

          {d.top_categories.length > 0 && (
            <div className={styles.bars} role="list" aria-label="Reported problem types">
              {d.top_categories.map((c) => (
                <div key={c.category} className={styles.barRow} role="listitem">
                  <span className={styles.barLabel}>{categoryLabel(c.category)}</span>
                  <span className={styles.barTrack}>
                    <span className={styles.barFill} style={{ width: `${(c.count / maxCat) * 100}%` }} />
                  </span>
                  <span className={styles.barValue}>{c.count}</span>
                </div>
              ))}
            </div>
          )}

          <div className={styles.pooled}>
            Other carriers here: <b>{d.pooled_reports}</b> reports · {d.distinct_drivers} of ours reported ·{' '}
            {d.active_guidance.length} active guidance
          </div>

          {a.reports.length > 0 && (
            <div className={styles.reports}>
              {a.reports.map((r) => (
                <div key={r.report_id} className={`${styles.report} ${r.invented ? styles.reportInvented : ''}`}>
                  <span className={styles.cat}>{categoryLabel(r.category)}</span>
                  <span className={styles.reportText}>{r.summary}</span>
                  <span className={styles.reportMeta}>
                    {r.driver.name}
                    {r.invented ? ' · invented history' : ' · real'} · {fmtTime(r.occurred_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className={styles.asOf}>API data as of {fmtTime(a.asOf)}</div>
        </>
      )}
    </section>
  );
}
