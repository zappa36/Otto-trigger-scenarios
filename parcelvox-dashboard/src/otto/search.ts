import { notesOf, type DepotDebrief, type DepotNote, type DepotStop } from './depot';
import type { DepotDoor } from './doors';

/*
 * One search over the store, shared by the finder pane and Otto's
 * deterministic fallback answers: every word of the query must match
 * somewhere on a door; title and address hits rank above consignees,
 * which rank above notes and debriefs.
 */

export interface DoorEntry {
  door: DepotDoor;
  consignees: string[];
  notes: DepotNote[];
  filed: DepotDebrief[];
  hay: { strong: string; mid: string; weak: string };
  /** Timestamp of the freshest note behind this door ('' when none). */
  newestAt: string;
}

export function buildIndex(
  doors: DepotDoor[],
  debriefs: Record<string, DepotDebrief[]>,
): DoorEntry[] {
  return doors.map((door) => {
    const rows: DepotStop[] = door.rows;
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
  });
}

export function searchIndex(index: DoorEntry[], query: string): DoorEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  return index
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
    .map((x) => x.e);
}
