import { useState } from 'react';
import type { QueueEntry } from '../state/useCurationQueue';
import shared from '../styles/shared.module.css';
import styles from './QueueView.module.css';

interface QueueViewProps {
  entries: QueueEntry[];
  pendingCount: number;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (id: string, headline: string) => void;
  onUndo: (id: string) => void;
}

export function QueueView({
  entries,
  pendingCount,
  onApprove,
  onReject,
  onEdit,
  onUndo,
}: QueueViewProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  function startEdit(entry: QueueEntry) {
    setEditing(entry.tip.id);
    setDraft(entry.tip.headline);
  }

  function saveEdit(id: string) {
    onEdit(id, draft.trim() || draft);
    setEditing(null);
  }

  return (
    <div className={shared.page} style={{ maxWidth: 860 }}>
      <h1 className={shared.h1}>Curation queue</h1>
      <p className={shared.lede} style={{ marginBottom: 22 }}>
        {pendingCount > 0
          ? `${pendingCount} ${pendingCount === 1 ? 'tip' : 'tips'} from Otto debriefs waiting for review. Approved tips go live for every driver on the route.`
          : 'Nothing is waiting for review. Approved tips are live for every driver on the route.'}
      </p>

      {pendingCount === 0 && (
        <div className={shared.note} style={{ marginBottom: 18 }}>
          The queue is clear. New tips arrive after each Otto debrief.
        </div>
      )}

      <div className={styles.list}>
        {entries.map((entry) => {
          const { tip, status } = entry;

          if (status !== 'pending') {
            return (
              <div key={tip.id} className={shared.card}>
                <div className={styles.resolved}>
                  <span
                    className={`${styles.resolvedMark} ${
                      status === 'approved' ? styles.markApproved : styles.markRejected
                    }`}
                  />
                  <span>
                    <strong>{tip.stop}</strong> · {tip.route} —{' '}
                    {status === 'approved'
                      ? 'approved, live for the route'
                      : 'rejected, not published'}
                  </span>
                  <button type="button" className={styles.undo} onClick={() => onUndo(tip.id)}>
                    Undo
                  </button>
                </div>
              </div>
            );
          }

          const isEditing = editing === tip.id;

          return (
            <div key={tip.id} className={`${shared.card} ${shared.cardPad}`}>
              <div className={styles.cardHead}>
                <span className={styles.category}>{tip.category}</span>
                <span className={styles.stop}>
                  {tip.stop} · {tip.route}
                </span>
                {tip.replacesStale && <span className={styles.replaces}>Replaces a stale tip</span>}
                <span className={styles.received}>{tip.received}</span>
              </div>

              {isEditing ? (
                <textarea
                  className={styles.editField}
                  value={draft}
                  rows={2}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label={`Tip for ${tip.stop}`}
                  autoFocus
                />
              ) : (
                <p className={styles.headline}>{tip.headline}</p>
              )}

              <p className={styles.quote}>{tip.quote}</p>

              <div className={styles.foot}>
                <span className={styles.source}>Otto debrief · {tip.driver}</span>
                <div className={styles.actions}>
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className={shared.btnQuiet}
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={shared.btnPrimary}
                        onClick={() => saveEdit(tip.id)}
                      >
                        Save tip
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={shared.btnQuiet}
                        onClick={() => onReject(tip.id)}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className={shared.btnSecondary}
                        onClick={() => startEdit(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={shared.btnPrimary}
                        onClick={() => onApprove(tip.id)}
                      >
                        Approve
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
