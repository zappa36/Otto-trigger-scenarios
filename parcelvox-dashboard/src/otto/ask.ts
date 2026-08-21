import type { OttoAnswer } from '../data/chat';
import { callFn, callTts, storeMode, type DepotStop } from './depot';
import { doorLabel } from './doors';
import { searchIndex, type DoorEntry } from './search';

/*
 * Otto's dispatcher conversation, grounded in the store.
 *
 * Live backend + the dispatch-ask function deployed → a real answer: the
 * dashboard serialises the stops, notes and debriefs into a compact STOP
 * DATA block and sends it with the conversation; the function's contract
 * is the same OttoAnswer shape the scripted demo bubbles render.
 *
 * Keyless, or the function not deployed → a deterministic answerer over
 * the same index the finder uses: situation summaries, noted-stop lists,
 * latest debriefs, and per-stop lookups. Honest about what it is — every
 * fallback answer says so in its source chips.
 */

const fmtDay = (iso?: string) => {
  const t = new Date(iso || 0);
  return isNaN(t.getTime()) ? '' : t.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

/* ---------- STOP DATA for the model ---------- */

export function buildContext(entries: DoorEntry[], stops: DepotStop[]): string {
  const withNotes = entries.filter((e) => e.notes.length > 0).length;
  const debriefed = entries.filter((e) => e.filed.length > 0).length;
  const routes = [...new Set(stops.map((s) => s.route).filter(Boolean))];
  const head =
    `${stops.length} stops · ${entries.length} addresses on file · ${withNotes} with notes · ` +
    `${debriefed} debriefed` +
    (routes.length ? ` · route ${routes.join(', ')} (stop numbers are driving order)` : '');

  /* noted and debriefed doors first — if the block must be cut, the quiet
   * stops go, and the tail says how many were dropped */
  const ranked = [...entries].sort(
    (a, b) => (b.notes.length + b.filed.length) - (a.notes.length + a.filed.length),
  );
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of ranked) {
    const first = e.door.rows[0];
    const parts = [
      `${doorLabel(e.door)}${first.addr ? ` (${first.addr})` : ''}` +
        (e.consignees.length ? ` — for ${e.consignees.join(', ')}` : ''),
    ];
    const floors = e.door.rows.map((r) => r.floor).filter(Boolean);
    if (floors.length) parts.push(`floor ${floors.join(', ')}`);
    if (e.notes.length) {
      parts.push(
        'NOTES: ' +
          e.notes
            .map((n) => `[${n.by || 'dispatch'}${n.at ? ' ' + fmtDay(n.at) : ''}] ${n.text}`)
            .join(' | '),
      );
    }
    if (e.filed.length) {
      parts.push(
        'DEBRIEFS: ' +
          e.filed
            .slice(0, 2)
            .map(
              (m) =>
                `${m.title || m.transcript}${m.category ? ` (${m.category})` : ''}` +
                (m.created_at ? ` ${fmtDay(m.created_at)}` : ''),
            )
            .join(' | '),
      );
    }
    const line = parts.join(' · ');
    if (used + line.length > 26000) {
      dropped++;
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  return (
    `DEPOT: ${head}\nSTOPS:\n` +
    lines.join('\n') +
    (dropped ? `\n(+ ${dropped} more stops with nothing notable on file)` : '')
  );
}

/* ---------- the real answer ---------- */

export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Flattens an answer back to plain text — for history and for speaking. */
export const answerText = (a: OttoAnswer): string =>
  [a.lead, ...(a.bullets || []).map((b) => b.text), a.tail || '']
    .join(' ')
    .replace(/\*\*/g, '')
    .trim();

function sanitizeAnswer(raw: unknown): OttoAnswer | null {
  const r = raw as { lead?: unknown; bullets?: unknown; tail?: unknown };
  const lead = String(r?.lead || '').trim();
  if (!lead) return null;
  const bullets = Array.isArray(r.bullets)
    ? r.bullets
        .map((b: { text?: unknown; tone?: unknown }) => ({
          tone: b?.tone === 'green' ? ('green' as const) : ('honey' as const),
          text: String(b?.text || '').trim(),
        }))
        .filter((b) => b.text)
        .slice(0, 8)
    : undefined;
  const tail = String(r?.tail || '').trim() || undefined;
  return { lead, bullets: bullets && bullets.length ? bullets : undefined, tail };
}

export async function askDispatch(history: AskTurn[], context: string): Promise<OttoAnswer> {
  const out = await callFn('dispatch-ask', { messages: history, context }, 30000);
  const answer = sanitizeAnswer(out);
  if (!answer) throw new Error('empty answer');
  answer.sources = ['Live answer · grounded in the store'];
  return answer;
}

/* ---------- the deterministic fallback ---------- */

const FALLBACK_SOURCE =
  storeMode === 'supabase'
    ? 'Deterministic lookup — deploy the dispatch-ask function for conversational answers'
    : 'Deterministic lookup — this browser, keyless';

export const ASK_OTTO_SUGGESTIONS = [
  'Summary of the situation',
  'Which stops have notes?',
  'Latest driver debriefs',
];

function summaryAnswer(entries: DoorEntry[], stops: DepotStop[]): OttoAnswer {
  const noted = entries.filter((e) => e.notes.length > 0);
  const debriefed = entries.filter((e) => e.filed.length > 0);
  const routes = [...new Set(stops.map((s) => s.route).filter(Boolean))];
  const fresh = [...noted]
    .sort((a, b) => b.newestAt.localeCompare(a.newestAt))
    .slice(0, 3)
    .map((e) => ({
      tone: 'honey' as const,
      text: `**${doorLabel(e.door)}** — ${e.notes[0].text}`,
    }));
  return {
    lead:
      `${stops.length} stops across ${entries.length} addresses on file` +
      (routes.length ? `, route ${routes.join(', ')} in driving order` : '') +
      `. ${noted.length} address${noted.length === 1 ? ' carries' : 'es carry'} notes Otto reads on approach; ` +
      `${debriefed.length} ${debriefed.length === 1 ? 'has' : 'have'} a driver debrief on file.`,
    bullets: fresh.length ? fresh : undefined,
    tail: fresh.length ? 'Those are the freshest notes on file.' : undefined,
    sources: [FALLBACK_SOURCE],
    actions: ['Which stops have notes?', 'Latest driver debriefs'],
  };
}

function notedAnswer(entries: DoorEntry[]): OttoAnswer {
  const noted = [...entries]
    .filter((e) => e.notes.length > 0)
    .sort((a, b) => b.newestAt.localeCompare(a.newestAt));
  if (!noted.length) {
    return {
      lead: 'No notes on file yet — open a stop on the map to add the first one.',
      sources: [FALLBACK_SOURCE],
    };
  }
  return {
    lead: `${noted.length} address${noted.length === 1 ? ' has' : 'es have'} notes on file — freshest first:`,
    bullets: noted.slice(0, 6).map((e) => ({
      tone: 'honey' as const,
      text: `**${doorLabel(e.door)}** — ${e.notes[0].text}${e.notes.length > 1 ? ` (+${e.notes.length - 1} more)` : ''}`,
    })),
    tail: noted.length > 6 ? `And ${noted.length - 6} more — ask about any stop by name.` : undefined,
    sources: [FALLBACK_SOURCE],
  };
}

function debriefsAnswer(entries: DoorEntry[]): OttoAnswer {
  const all = entries
    .flatMap((e) => e.filed.map((m) => ({ e, m })))
    .sort((a, b) => String(b.m.created_at || '').localeCompare(String(a.m.created_at || '')));
  if (!all.length) {
    return {
      lead: 'No driver debriefs on file yet — they arrive as drivers report to Otto at the stops.',
      sources: [FALLBACK_SOURCE],
    };
  }
  return {
    lead: `${all.length} driver debrief${all.length === 1 ? '' : 's'} on file — latest first:`,
    bullets: all.slice(0, 6).map(({ e, m }) => ({
      tone: 'green' as const,
      text:
        `**${doorLabel(e.door)}** — ${m.title || m.transcript}` +
        (m.created_at ? ` (${fmtDay(m.created_at)})` : ''),
    })),
    sources: [FALLBACK_SOURCE],
  };
}

function stopAnswer(e: DoorEntry): OttoAnswer {
  const first = e.door.rows[0];
  const bullets: OttoAnswer['bullets'] = [
    ...e.notes.map((n) => ({
      tone: 'honey' as const,
      text: `${n.by === 'driver' ? 'A driver reported' : 'From dispatch'}: ${n.text}`,
    })),
    ...e.filed.slice(0, 2).map((m) => ({
      tone: 'green' as const,
      text: `Debrief: ${m.title || m.transcript}${m.created_at ? ` (${fmtDay(m.created_at)})` : ''}`,
    })),
  ];
  return {
    lead:
      `**${doorLabel(e.door)}**${first.addr ? ` — ${first.addr}` : ''}.` +
      (e.consignees.length
        ? ` Delivery for ${e.consignees.join(' and ')}` +
          (e.door.rows.some((r) => r.floor) ? ` (floor ${e.door.rows.map((r) => r.floor).filter(Boolean).join(', ')})` : '') +
          '.'
        : ''),
    bullets: bullets.length ? bullets : undefined,
    tail: bullets.length
      ? 'That is exactly what Otto reads aloud on approach.'
      : 'Nothing on file here yet — Otto would read only the consignee.',
    sources: [FALLBACK_SOURCE],
  };
}

/* Question filler that must not gate a stop lookup ("what do we know about…"). */
const FILLER = new Set([
  'what', 'who', 'when', 'where', 'how', 'which', 'tell', 'know', 'about', 'the', 'and',
  'for', 'are', 'is', 'any', 'anything', 'there', 'does', 'do', 'we', 'you', 'me', 'my',
  'stop', 'stops', 'note', 'notes', 'file', 'have', 'has', 'with', 'info', 'on', 'at',
]);

export function localAnswer(question: string, entries: DoorEntry[], stops: DepotStop[]): OttoAnswer {
  const q = question.trim().toLowerCase();
  if (/(summar|situation|overview|status|how.*(look|going|doing)|update)/.test(q))
    return summaryAnswer(entries, stops);
  if (/debrief/.test(q)) return debriefsAnswer(entries);
  if (/(which|what|list|show).*(note|tip)|notes\?$|stops with notes/.test(q))
    return notedAnswer(entries);
  /* strict first (a search-box-style query), then content words only, best
   * single door by any-token score — a question, not a filter */
  let best: DoorEntry | undefined = searchIndex(entries, q)[0];
  if (!best) {
    const tokens = q
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => (t.length >= 3 || /^\d+$/.test(t)) && !FILLER.has(t));
    let top: { e: DoorEntry; score: number } | null = null;
    for (const e of entries) {
      let score = 0;
      for (const t of tokens) {
        if (e.hay.strong.includes(t)) score += 3;
        else if (e.hay.mid.includes(t)) score += 2;
        else if (e.hay.weak.includes(t)) score += 1;
      }
      if (score > 0 && (!top || score > top.score)) top = { e, score };
    }
    if (top) best = top.e;
  }
  if (best) return stopAnswer(best);
  return {
    lead:
      'I could not match that to a stop on file. Ask me about a stop by street or consignee, ' +
      'or for a summary of the situation.',
    sources: [FALLBACK_SOURCE],
    actions: ASK_OTTO_SUGGESTIONS,
  };
}

/* ---------- the reply, spoken ---------- */

let playing: HTMLAudioElement | null = null;

export function stopSpeaking(): void {
  if (playing) {
    playing.pause();
    playing = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Reads a reply aloud: Otto's real ElevenLabs voice when the backend has
 * the tts function, the browser's own voice otherwise. */
export async function speakReply(text: string): Promise<'elevenlabs' | 'browser' | null> {
  const spoken = text.replace(/\*\*/g, '').slice(0, 900);
  if (!spoken) return null;
  stopSpeaking();
  if (storeMode === 'supabase') {
    try {
      const blob = await callTts(spoken);
      const audio = new Audio(URL.createObjectURL(blob));
      playing = audio;
      audio.onended = () => {
        if (playing === audio) playing = null;
        URL.revokeObjectURL(audio.src);
      };
      await audio.play();
      return 'elevenlabs';
    } catch {
      /* function missing or slow — the browser voice takes over */
    }
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(spoken));
      return 'browser';
    } catch {
      return null;
    }
  }
  return null;
}
