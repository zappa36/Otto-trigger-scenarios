import type { OttoAnswer } from '../data/chat';
import {
  activeRoute,
  callFn,
  callTtsStream,
  storeMode,
  visitState,
  type DepotRoute,
  type DepotStop,
  type DepotVisit,
} from './depot';
import { doorLabel, routeName } from './doors';
import { searchIndex, type DoorEntry } from './search';
import { playStream } from './stream';

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
const fmtClock = (iso?: string) => {
  const t = new Date(iso || 0);
  return isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const KIND_WORD: Record<string, string> = { bulky: 'a bulky item', food: 'fresh food' };
const kindWord = (s: DepotStop) => KIND_WORD[String(s.kind || '').toLowerCase()] || '';
/** "floor 3" for a number, "Apt 4B" as written — the phone's own rule. */
const floorWord = (f: string) => (/^\d+$/.test(f) ? `floor ${f}` : f);
const floorWords = (rows: DepotStop[]) =>
  rows.map((r) => String(r.floor || '').trim()).filter(Boolean).map(floorWord);
/** "Delivered 10:42" / "Not delivered 10:50" — the driver's tap on one stop, '' while open. */
const tapWord = (s: DepotStop, visits: Record<string, DepotVisit>) => {
  const v = visits[s.id];
  if (!v) return '';
  const at = fmtClock(v.delivered_at || v.created_at);
  return (v.outcome === 'failed' ? 'Not delivered' : 'Delivered') + (at ? ' ' + at : '');
};

/** The day's count on the route the phones show — the active row, else (nothing
 * marked yet) the last route on file, which is the phone's own fallback. */
function progress(stops: DepotStop[], routes: DepotRoute[], visits: Record<string, DepotVisit>) {
  const act = activeRoute(routes);
  const ids = [...routes.map((r) => r.id), ...stops.map((s) => s.route)].filter((id): id is string => !!id);
  const id = act ? act.id : [...new Set(ids)].pop() || null;
  const onRoute = id ? stops.filter((s) => s.route === id) : [];
  const delivered = onRoute.filter((s) => visitState(s, visits) === 'done').length;
  const failed = onRoute.filter((s) => visitState(s, visits) === 'failed').length;
  const n = onRoute.length;
  return {
    act,
    name: id ? routeName(id, routes) : '',
    onRoute,
    stopsWord: `${n} stop${n === 1 ? '' : 's'}`,
    delivered,
    failed,
    open: n - delivered - failed,
  };
}

/* ---------- STOP DATA for the model ---------- */

export function buildContext(
  entries: DoorEntry[],
  stops: DepotStop[],
  routes: DepotRoute[] = [],
  visits: Record<string, DepotVisit> = {},
): string {
  const withNotes = entries.filter((e) => e.notes.length > 0).length;
  const debriefed = entries.filter((e) => e.filed.length > 0).length;
  const routeIds = [...new Set(stops.map((s) => s.route).filter((r): r is string => !!r))];
  const p = progress(stops, routes, visits);
  const routeWords = routeIds.map(
    (id) => routeName(id, routes) + (p.act && p.act.id === id ? " (ON THE PHONES — the driver's screen opens on it)" : ''),
  );
  const head =
    `${stops.length} stops · ${entries.length} addresses on file · ${withNotes} with notes · ` +
    `${debriefed} debriefed` +
    (routeIds.length ? ` · route${routeIds.length === 1 ? '' : 's'} ${routeWords.join(', ')} (stop numbers are driving order)` : '') +
    (p.delivered || p.failed
      ? ` · today ${p.delivered} of ${p.stopsWord} delivered${p.failed ? `, ${p.failed} not delivered` : ''}, ${p.open} still open`
      : '');

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
    if (e.entrances.length) parts.push(`entrance: ${e.entrances.join(', ')}`);
    const floors = floorWords(e.door.rows);
    if (floors.length) parts.push(floors.join(', '));
    const kinds = e.door.rows.map(kindWord).filter(Boolean);
    if (kinds.length) parts.push(kinds.join(', '));
    const taps = e.door.rows.map((r) => tapWord(r, visits)).filter(Boolean);
    if (taps.length) parts.push(taps.map((t) => t.toUpperCase()).join(', '));
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
  'How far is the route?',
  'Which stops have notes?',
  'Latest driver debriefs',
];

/** "“Schöneberg 01” is on the phones — 7 of 20 stops delivered, 1 not delivered, 12 still open." */
function routeSentence(stops: DepotStop[], routes: DepotRoute[], visits: Record<string, DepotVisit>): string {
  const p = progress(stops, routes, visits);
  if (!p.onRoute.length) return '';
  const who = p.act
    ? `“${p.act.name}” is on the phones`
    : `“${p.name}” is what the phones open on while no route is marked for them`;
  if (!p.delivered && !p.failed) return ` ${who} — ${p.stopsWord}, none delivered yet.`;
  return (
    ` ${who} — ${p.delivered} of ${p.stopsWord} delivered` +
    (p.failed ? `, ${p.failed} not delivered` : '') +
    (p.open ? `, ${p.open} still open.` : ', the route is done.')
  );
}

function summaryAnswer(
  entries: DoorEntry[],
  stops: DepotStop[],
  routes: DepotRoute[],
  visits: Record<string, DepotVisit>,
): OttoAnswer {
  const noted = entries.filter((e) => e.notes.length > 0);
  const debriefed = entries.filter((e) => e.filed.length > 0);
  const routeIds = [...new Set(stops.map((s) => s.route).filter((r): r is string => !!r))];
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
      (routeIds.length
        ? `, route${routeIds.length === 1 ? '' : 's'} ${routeIds.map((id) => routeName(id, routes)).join(', ')} in driving order`
        : '') +
      `. ${noted.length} address${noted.length === 1 ? ' carries' : 'es carry'} notes Otto reads on approach; ` +
      `${debriefed.length} ${debriefed.length === 1 ? 'has' : 'have'} a driver debrief on file.` +
      routeSentence(stops, routes, visits),
    bullets: fresh.length ? fresh : undefined,
    tail: fresh.length ? 'Those are the freshest notes on file.' : undefined,
    sources: [FALLBACK_SOURCE],
    actions: ['How far is the route?', 'Which stops have notes?', 'Latest driver debriefs'],
  };
}

/** How the day is going: the driver's taps on the route the phones show. */
function progressAnswer(
  entries: DoorEntry[],
  stops: DepotStop[],
  routes: DepotRoute[],
  visits: Record<string, DepotVisit>,
): OttoAnswer {
  const p = progress(stops, routes, visits);
  if (!p.onRoute.length) {
    return {
      lead: p.act
        ? `“${p.act.name}” is on the phones but has no stops yet — add them on the trigger dashboard, behind the ROUTE door.`
        : 'No route is on the phones yet — load one on the trigger dashboard, behind the ROUTE door.',
      sources: [FALLBACK_SOURCE],
    };
  }
  const entryOf = (s: DepotStop) => entries.find((e) => e.door.rows.some((r) => r.id === s.id));
  const label = (s: DepotStop) => {
    const e = entryOf(s);
    return e ? doorLabel(e.door) : `Stop ${s.stop ?? ''} · ${s.title || s.addr || ''}`.trim();
  };
  const byStop = (a: DepotStop, b: DepotStop) => (a.stop ?? 1e9) - (b.stop ?? 1e9);
  const failed = p.onRoute.filter((s) => visitState(s, visits) === 'failed').sort(byStop);
  const next = p.onRoute.filter((s) => visitState(s, visits) === 'open').sort(byStop)[0];
  const bullets: OttoAnswer['bullets'] = [
    ...failed.map((s) => ({ tone: 'honey' as const, text: `**${label(s)}** — ${tapWord(s, visits)}` })),
    ...(next ? [{ tone: 'green' as const, text: `Next open stop: **${label(next)}**` }] : []),
  ];
  return {
    lead: routeSentence(stops, routes, visits).trim(),
    bullets: bullets.length ? bullets : undefined,
    tail: p.delivered || p.failed ? 'Counted from the Delivered and Not delivered taps on the driver\'s screen.' : undefined,
    sources: [FALLBACK_SOURCE],
    actions: failed.length ? ['Which stops have notes?'] : undefined,
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

function stopAnswer(e: DoorEntry, visits: Record<string, DepotVisit>): OttoAnswer {
  const first = e.door.rows[0];
  const where = [...e.entrances, ...floorWords(e.door.rows)].join(', ');
  const kinds = [...new Set(e.door.rows.map(kindWord).filter(Boolean))];
  const bullets: OttoAnswer['bullets'] = [
    ...e.door.rows
      .filter((r) => visits[r.id])
      .map((r) => ({
        tone: visits[r.id].outcome === 'failed' ? ('honey' as const) : ('green' as const),
        text: `${visits[r.id].outcome === 'failed' ? '✕' : '✓'} ${tapWord(r, visits)}${e.door.rows.length > 1 && r.stop != null ? ` (stop ${r.stop})` : ''}`,
      })),
    ...e.notes.map((n) => ({
      tone: 'honey' as const,
      text: `${n.call ? 'Agreed with the customer' : n.by === 'driver' ? 'A driver reported' : 'From dispatch'}: ${n.text}`,
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
        ? ` Delivery for ${e.consignees.join(' and ')}` + (where ? ` (${where})` : '') + (kinds.length ? ` — ${kinds.join(', ')}` : '') + '.'
        : where || kinds.length
          ? ` Delivery${where ? ` to ${where}` : ''}${kinds.length ? ` — ${kinds.join(', ')}` : ''}.`
          : ''),
    bullets: bullets.length ? bullets : undefined,
    tail: e.notes.length || e.filed.length
      ? 'The notes and debriefs are exactly what Otto reads aloud on approach.'
      : 'Nothing on file here yet — Otto would read only the consignee, the entrance and the floor.',
    sources: [FALLBACK_SOURCE],
  };
}

/* Question filler that must not gate a stop lookup ("what do we know about…"). */
const FILLER = new Set([
  'what', 'who', 'when', 'where', 'how', 'which', 'tell', 'know', 'about', 'the', 'and',
  'for', 'are', 'is', 'any', 'anything', 'there', 'does', 'do', 'we', 'you', 'me', 'my',
  'stop', 'stops', 'note', 'notes', 'file', 'have', 'has', 'with', 'info', 'on', 'at',
]);

/** True when the question names a stop: a word of four letters or more that
 * sits in the title or address of a few doors (not of all of them, like
 * "Berlin"), or "stop 7". */
function namesAStop(entries: DoorEntry[], q: string): boolean {
  if (!entries.length) return false;
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((t) => /^\p{L}{4,}$/u.test(t) && !FILLER.has(t));
  const few = Math.max(2, Math.ceil(entries.length / 3));
  const named = words.some((w) => {
    const hits = entries.filter((e) => e.hay.strong.includes(w)).length;
    return hits > 0 && hits <= few;
  });
  const stopNo = (q.match(/\bstop (\d+)\b/) || [])[1];
  return named || (!!stopNo && entries.some((e) => e.door.stopNos.includes(Number(stopNo))));
}

export function localAnswer(
  question: string,
  entries: DoorEntry[],
  stops: DepotStop[],
  routes: DepotRoute[] = [],
  visits: Record<string, DepotVisit> = {},
): OttoAnswer {
  const q = question.trim().toLowerCase();
  /* the day's progress — before the stop lookup, so "not delivered" is a
   * question about the route and not a search for a stop with those words;
   * a question that names a stop ("did we deliver to Maaßenstraße 8?") is
   * about that stop, whatever else it says, and goes on to the lookup */
  if (!namesAStop(entries, q) && /(how far|progress|deliver|still open|left to do|remaining|how many.*(done|left)|route going)/.test(q))
    return progressAnswer(entries, stops, routes, visits);
  if (/(summar|situation|overview|status|how.*(look|going|doing)|update)/.test(q))
    return summaryAnswer(entries, stops, routes, visits);
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
  if (best) return stopAnswer(best, visits);
  return {
    lead:
      'I could not match that to a stop on file. Ask me about a stop by street or consignee, ' +
      'for a summary of the situation, or how far the route is.',
    sources: [FALLBACK_SOURCE],
    actions: ASK_OTTO_SUGGESTIONS,
  };
}

/* ---------- the reply, spoken ---------- */

/* the clip under way: its element and the handle that drops it — the fetch
 * and the stream player share the one handle, so a stop mid-download is a
 * stop, not a reply that starts a second later */
let playing: { audio: HTMLAudioElement; stop: AbortController } | null = null;

export function stopSpeaking(): void {
  if (playing) {
    const { audio, stop } = playing;
    playing = null;
    stop.abort(); // first: the player lets go of the element before it is reset
    audio.pause();
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.removeAttribute('src');
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Reads a reply aloud: Otto's real ElevenLabs voice when the backend has
 * the tts function — playing from the first chunk while the rest of the
 * answer is still being spoken at the other end — the browser's own voice
 * otherwise. */
export async function speakReply(text: string): Promise<'elevenlabs' | 'browser' | null> {
  const spoken = text.replace(/\*\*/g, '').slice(0, 900);
  if (!spoken) return null;
  stopSpeaking();
  if (storeMode === 'supabase') {
    const audio = new Audio();
    audio.preload = 'auto';
    const mine = { audio, stop: new AbortController() };
    playing = mine;
    audio.onended = () => {
      if (playing === mine) playing = null;
      if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    };
    try {
      const r = await callTtsStream(spoken, mine.stop.signal);
      await playStream(audio, r, { signal: mine.stop.signal });
      return 'elevenlabs';
    } catch {
      /* stopped on purpose while the clip was on its way: nothing speaks
       * in its place */
      if (mine.stop.signal.aborted) return null;
      /* function missing or slow — the browser voice takes over, and any
       * fragment the element holds goes with the clip */
      if (playing === mine) playing = null;
      audio.pause();
      audio.removeAttribute('src');
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
