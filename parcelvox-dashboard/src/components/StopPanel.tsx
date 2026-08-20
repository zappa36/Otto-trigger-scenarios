import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  addNote,
  deleteNote,
  notesOf,
  setStopField,
  type DepotDebrief,
  type DepotStop,
} from '../otto/depot';
import { doorLabel, type DepotDoor } from '../otto/doors';
import styles from './StopPanel.module.css';

/*
 * What is on file behind one door — the dispatcher's side of the
 * pre-arrival loop, the same view the trigger dashboard's stop sheet
 * gives: every stop at this address (stacked pins are one building,
 * several parcels), its consignee, the notes Otto reads aloud on
 * approach — added and removed right here — and the latest real driver
 * debriefs, read-only.
 */

const fmtTime = (iso?: string) => {
  const t = new Date(iso || 0);
  return isNaN(t.getTime())
    ? ''
    : t.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/* Keyless Google Maps URLs — same links as the trigger dashboard. */
const gmapUrl = (d: DepotStop) => `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`;
const panoUrl = (d: DepotStop) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}`;

const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur();
};

function StopSection({ row, filed }: { row: DepotStop; filed: DepotDebrief[] }) {
  const [draft, setDraft] = useState('');
  const notes = notesOf(row);

  const submit = () => {
    if (!draft.trim()) return;
    addNote(row, draft);
    setDraft('');
  };

  return (
    <section className={styles.section}>
      <div className={styles.stopTag}>{row.stop != null ? `Stop ${row.stop}` : 'Scenario pin'}</div>

      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Consignee</span>
          <input
            key={`c:${row.consignee ?? ''}`}
            defaultValue={row.consignee ?? ''}
            placeholder="Who it's for — “Maria Weber”"
            onBlur={(e) => setStopField(row, 'consignee', e.currentTarget.value)}
            onKeyDown={blurOnEnter}
          />
        </label>
        <label className={styles.field}>
          <span>Floor / unit</span>
          <input
            key={`f:${row.floor ?? ''}`}
            defaultValue={row.floor ?? ''}
            placeholder="“4th floor”, “Apt 12B”"
            onBlur={(e) => setStopField(row, 'floor', e.currentTarget.value)}
            onKeyDown={blurOnEnter}
          />
        </label>
      </div>

      {notes.map((note, i) => (
        <div key={note.id || `${i}:${note.text}`} className={styles.note}>
          <div className={styles.noteText}>{note.text}</div>
          <div className={styles.noteMeta}>
            {String(note.by || 'dispatch').toUpperCase()}
            {note.at ? ` · ${fmtTime(note.at)}` : ''}
          </div>
          <button
            type="button"
            className={styles.noteDel}
            title="Remove this note"
            aria-label={`Remove note: ${note.text}`}
            onClick={() => deleteNote(row, i)}
          >
            ×
          </button>
        </div>
      ))}

      {filed.slice(0, 2).map((m, i) => (
        <div key={m.id || `d${i}`} className={`${styles.note} ${styles.debrief}`}>
          <div className={styles.noteText}>{m.title || m.transcript}</div>
          <div className={`${styles.noteMeta} ${styles.debriefMeta}`}>
            DRIVER DEBRIEF{m.created_at ? ` · ${fmtTime(m.created_at)}` : ''}
          </div>
        </div>
      ))}

      {!notes.length && !filed.length && (
        <p className={styles.empty}>Nothing on file yet — Otto reads only the consignee here.</p>
      )}

      <div className={styles.add}>
        <input
          value={draft}
          placeholder="Note for the next driver — read aloud on approach"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" onClick={submit}>
          + Add note
        </button>
      </div>
    </section>
  );
}

interface StopPanelProps {
  door: DepotDoor;
  debriefs: Record<string, DepotDebrief[]>;
  onClose: () => void;
}

export function StopPanel({ door, debriefs, onClose }: StopPanelProps) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const first = door.rows[0];

  return (
    <aside className={styles.panel} role="dialog" aria-label={doorLabel(door)}>
      <div className={styles.head}>
        <div className={styles.title}>{doorLabel(door)}</div>
        <div className={styles.addr}>
          {first.addr || `${first.lat}, ${first.lng}`}
          {door.rows.length > 1 ? ` — ${door.rows.length} parcels behind one door` : ''}
        </div>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className={styles.links}>
        <a className={`${styles.link} ${styles.linkAccent}`} href={gmapUrl(first)} target="_blank" rel="noopener noreferrer">
          Open in Google Maps ↗
        </a>
        <a className={styles.link} href={panoUrl(first)} target="_blank" rel="noopener noreferrer">
          Street View ↗
        </a>
      </div>

      <div className={styles.body}>
        {door.rows.map((row) => (
          <StopSection key={row.id} row={row} filed={debriefs[row.id] || []} />
        ))}
      </div>

      <p className={styles.hint}>
        Otto reads these aloud on the driver's phone on approach — consignee and floor first, then
        the notes, newest first, then the latest driver debriefs.
      </p>
    </aside>
  );
}
