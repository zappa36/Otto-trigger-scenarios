import { useMemo, useState } from 'react';
import type { DepotDebrief } from '../otto/depot';
import { doorLabel, type DepotDoor } from '../otto/doors';
import { buildIndex, searchIndex } from '../otto/search';
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
  /** Jump to the Ask view — the conversation over the same store. */
  onAskOtto: () => void;
}

export function FindStop({ doors, debriefs, total, onOpen, onAskOtto }: FindStopProps) {
  const [query, setQuery] = useState('');

  const indexed = useMemo(() => buildIndex(doors, debriefs), [doors, debriefs]);

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
    return searchIndex(indexed, q).slice(0, 12);
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
        <button type="button" className={styles.askOtto} onClick={onAskOtto}>
          💬 Ask Otto about these stops
        </button>
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
