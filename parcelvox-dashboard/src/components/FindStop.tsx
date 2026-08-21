import { useMemo, useState } from 'react';
import { notesOf, type DepotDebrief } from '../otto/depot';
import { doorLabel, type DepotDoor } from '../otto/doors';
import styles from './FindStop.module.css';

/*
 * The live replacement for the scripted Ask panel: a search over what is
 * actually on file. No theater — every result is a real stop from the
 * shared store, and clicking it centres the map and opens the stop panel
 * where the notes are read and edited.
 */

interface FindStopProps {
  doors: DepotDoor[];
  debriefs: Record<string, DepotDebrief[]>;
  /** Individual stops on file (doors can hold several parcels). */
  total: number;
  onOpen: (key: string) => void;
}

export function FindStop({ doors, debriefs, total, onOpen }: FindStopProps) {
  const [query, setQuery] = useState('');

  const indexed = useMemo(
    () =>
      doors.map((door) => {
        const rows = door.rows;
        const notes = rows.flatMap((r) => notesOf(r));
        const filed = rows.flatMap((r) => debriefs[r.id] || []);
        const consignees = rows.map((r) => String(r.consignee || '').trim()).filter(Boolean);
        return {
          door,
          consignees,
          notes,
          filed,
          hay: {
            strong: [door.title, rows[0].addr || '', door.stopNos.map((n) => `stop ${n}`).join(' ')]
              .join(' ')
              .toLowerCase(),
            mid: consignees.join(' ').toLowerCase(),
            weak: [
              rows.map((r) => r.floor || '').join(' '),
              rows.map((r) => r.route || '').join(' '),
              notes.map((n) => n.text).join(' '),
              filed.map((m) => m.title || m.transcript || '').join(' '),
            ]
              .join(' ')
              .toLowerCase(),
          },
          newestAt: (notes[0] && notes[0].at) || '',
        };
      }),
    [doors, debriefs],
  );

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) {
      /* nothing typed: the stops Otto currently has something to say about,
       * freshest note first */
      return indexed
        .filter((e) => e.notes.length > 0)
        .sort((a, b) => b.newestAt.localeCompare(a.newestAt))
        .slice(0, 8);
    }
    const tokens = q.split(/\s+/);
    return indexed
      .map((e) => {
        let score = 0;
        for (const t of tokens) {
          if (e.hay.strong.includes(t)) score += 3;
          else if (e.hay.mid.includes(t)) score += 2;
          else if (e.hay.weak.includes(t)) score += 1;
          else return { e, score: 0 }; // every word must match somewhere
        }
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.e.door.stopNos[0] ?? 1e9) - (b.e.door.stopNos[0] ?? 1e9) ||
          a.e.door.title.localeCompare(b.e.door.title),
      )
      .slice(0, 12)
      .map((x) => x.e);
  }, [indexed, q]);

  const withNotes = doors.filter((d) => d.hasNotes).length;

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>Find a stop</h2>
        <div className={styles.sub}>
          Search the {total} stops on file — street, consignee, note, stop number
        </div>
        <input
          className={styles.search}
          value={query}
          placeholder="Street, consignee, note, stop number…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search stops"
        />
      </div>

      <div className={styles.list}>
        {!q && results.length > 0 && <div className={styles.tag}>Latest notes on file</div>}
        {results.map((e) => (
          <button
            key={e.door.key}
            type="button"
            className={styles.row}
            onClick={() => onOpen(e.door.key)}
          >
            <span className={styles.rowTitle}>{doorLabel(e.door)}</span>
            {e.consignees.length > 0 && (
              <span className={styles.rowMeta}>{e.consignees.join(' · ')}</span>
            )}
            <span className={styles.chips}>
              {e.notes.length > 0 && (
                <span className={`${styles.chip} ${styles.chipNotes}`}>
                  {e.notes.length} note{e.notes.length === 1 ? '' : 's'}
                </span>
              )}
              {e.filed.length > 0 && (
                <span className={`${styles.chip} ${styles.chipDebriefs}`}>
                  {e.filed.length} debrief{e.filed.length === 1 ? '' : 's'}
                </span>
              )}
              {e.notes.length === 0 && e.filed.length === 0 && (
                <span className={styles.chip}>nothing on file yet</span>
              )}
            </span>
            {e.notes[0] && <span className={styles.preview}>{e.notes[0].text}</span>}
          </button>
        ))}
        {q && results.length === 0 && (
          <p className={styles.empty}>
            Nothing matches — try a street name, a consignee, or a word from a note.
          </p>
        )}
        {!q && results.length === 0 && (
          <p className={styles.empty}>No notes on file yet — search a stop to open it and add one.</p>
        )}
      </div>

      <p className={styles.hint}>
        {withNotes} of {doors.length} addresses carry notes · click a stop to open it on the map and
        edit what Otto reads on approach
      </p>
    </>
  );
}
