import { useCallback, useMemo, useState } from 'react';
import { QUEUED_TIPS, type QueuedTip } from '../data/queue';

export type QueueStatus = 'pending' | 'approved' | 'rejected';

export interface QueueEntry {
  tip: QueuedTip;
  status: QueueStatus;
}

/**
 * Review state for the curation queue. Reviewed tips stay in place with an
 * undo, so a demo can be walked backwards, and the pending count drives the
 * badge in the left nav.
 */
export function useCurationQueue() {
  const [entries, setEntries] = useState<QueueEntry[]>(() =>
    QUEUED_TIPS.map((tip) => ({ tip, status: 'pending' })),
  );

  const setStatus = useCallback((id: string, status: QueueStatus) => {
    setEntries((current) =>
      current.map((entry) => (entry.tip.id === id ? { ...entry, status } : entry)),
    );
  }, []);

  const approve = useCallback((id: string) => setStatus(id, 'approved'), [setStatus]);
  const reject = useCallback((id: string) => setStatus(id, 'rejected'), [setStatus]);
  const undo = useCallback((id: string) => setStatus(id, 'pending'), [setStatus]);

  const edit = useCallback((id: string, headline: string) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.tip.id === id ? { ...entry, tip: { ...entry.tip, headline } } : entry,
      ),
    );
  }, []);

  const pendingCount = useMemo(
    () => entries.filter((entry) => entry.status === 'pending').length,
    [entries],
  );

  return { entries, pendingCount, approve, reject, undo, edit };
}
