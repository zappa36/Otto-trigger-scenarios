/*
 * The wire to the real app around this dashboard — the destination pins
 * and pre-arrival notes that the phone (index.html) and the
 * trigger-scenarios dashboard (dashboard.html) already share.
 *
 * Same storage philosophy as the rest of the kit, decided once at load
 * (mirroring backend.js):
 *
 *  - Supabase, when the page carries real values in window.SUPABASE_URL /
 *    window.SUPABASE_ANON_KEY. The deployed standalone bundle loads
 *    config.js from its own origin and deploy-time injection fills it in;
 *    reads poll every 30 s (REST only — no realtime channel in this kit,
 *    same as dashboard.js) and writes PATCH the destinations row.
 *
 *  - localStorage otherwise, under the same keys the other two pages use
 *    (od_destinations / od_messages). Same origin means same store: a note
 *    added here is read aloud by the phone on its next approach, and the
 *    storage event keeps every open tab fresh both ways.
 *
 * An empty store is not an error — the map falls back to the fictional
 * Nordhaven sample, labelled as such: the kit's usual honest degrade.
 */

declare global {
  interface Window {
    /** Injected at deploy time via config.js; absent in dev and in the artifact build. */
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    VOICE_TABLE?: string;
  }
}

export interface DepotNote {
  id?: string;
  text: string;
  at?: string;
  /** Who left it — 'dispatch' or 'driver'; Otto names the voice when reading. */
  by?: string;
}

/** One destinations row — a route stop (route + stop set) or a scenario pin. */
export interface DepotStop {
  id: string;
  title?: string;
  addr?: string;
  lat: number;
  lng: number;
  consignee?: string | null;
  floor?: string | null;
  /** jsonb from Supabase, plain array from localStorage, string if hand-fed. */
  notes?: DepotNote[] | string | null;
  route?: string | null;
  stop?: number | null;
  created_at?: string;
}

/** An Otto debrief filed against a stop — only real ones (demo rows are filtered out). */
export interface DepotDebrief {
  id?: string;
  destination_id?: string;
  title?: string;
  transcript?: string;
  category?: string;
  demo?: boolean;
  created_at?: string;
}

export interface DepotSnapshot {
  mode: 'supabase' | 'local';
  /** First load finished. localStorage is synchronous, so local mode is ready at once. */
  ready: boolean;
  /** The last Supabase read failed; the previous data stays on screen meanwhile. */
  offline: boolean;
  stops: DepotStop[];
  /** Real debriefs by destination id, newest first. */
  debriefs: Record<string, DepotDebrief[]>;
}

const LS_DEST = 'od_destinations';
const LS_MSGS = 'od_messages';

const url = String(window.SUPABASE_URL || '').replace(/\/+$/, '');
const key = String(window.SUPABASE_ANON_KEY || '');
const msgTable = String(window.VOICE_TABLE || 'messages');
const mode: DepotSnapshot['mode'] = url && key ? 'supabase' : 'local';

const localId = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const warn = (e: unknown) => console.warn('depot:', e instanceof Error ? e.message : e);

/** The dispatch notes on a stop, tolerant of every storage shape — mirrors dashboard.js. */
export function notesOf(stop: DepotStop | null | undefined): DepotNote[] {
  let n: unknown = stop && stop.notes;
  if (typeof n === 'string') {
    try {
      n = JSON.parse(n);
    } catch {
      n = null;
    }
  }
  if (!Array.isArray(n)) return [];
  return (n as DepotNote[]).filter((x) => x && String(x.text || '').trim());
}

/* ---------- Supabase REST (the slice of backend.js this page needs) ---------- */

async function rest(path: string, opts: RequestInit = {}): Promise<unknown> {
  const r = await fetch(url + path, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.status === 204 ? null : r.json();
}

const listDestinations = () => rest('/rest/v1/destinations?select=*&order=created_at.asc');
const listMessages = () => rest(`/rest/v1/${msgTable}?select=*&order=created_at.desc&limit=500`);
const patchDestination = (id: string, patch: Partial<DepotStop>) =>
  rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });

/* ---------- the store ---------- */

let snapshot: DepotSnapshot = { mode, ready: mode === 'local', offline: false, stops: [], debriefs: {} };
/** Cheap change guard so a quiet 30 s poll does not repaint the map. */
let dataStamp = '';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function setData(stops: DepotStop[], debriefs: Record<string, DepotDebrief[]>, offline: boolean) {
  const stamp = JSON.stringify([stops, debriefs, offline]);
  if (snapshot.ready && stamp === dataStamp) return;
  dataStamp = stamp;
  snapshot = { mode, ready: true, offline, stops, debriefs };
  notify();
}

function groupDebriefs(rows: DepotDebrief[]): Record<string, DepotDebrief[]> {
  const by: Record<string, DepotDebrief[]> = {};
  for (const m of rows) {
    if (!m || !m.destination_id || m.demo || !(m.title || m.transcript)) continue;
    (by[m.destination_id] = by[m.destination_id] || []).push(m);
  }
  Object.values(by).forEach((list) =>
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
  );
  return by;
}

function readLocal(): { stops: DepotStop[]; debriefs: Record<string, DepotDebrief[]> } {
  let stops: DepotStop[] = [];
  let msgs: DepotDebrief[] = [];
  try {
    stops = JSON.parse(localStorage.getItem(LS_DEST) || '[]');
  } catch {
    /* private mode */
  }
  try {
    msgs = JSON.parse(localStorage.getItem(LS_MSGS) || '[]');
  } catch {
    /* private mode */
  }
  if (!Array.isArray(stops)) stops = [];
  if (!Array.isArray(msgs)) msgs = [];
  return { stops: stops.filter((s) => s && s.id != null), debriefs: groupDebriefs(msgs) };
}

async function refresh(): Promise<void> {
  if (mode === 'local') {
    const { stops, debriefs } = readLocal();
    setData(stops, debriefs, false);
    return;
  }
  try {
    const [stops, msgs] = await Promise.all([listDestinations(), listMessages()]);
    setData(
      (Array.isArray(stops) ? (stops as DepotStop[]) : []).filter((s) => s && s.id != null),
      groupDebriefs(Array.isArray(msgs) ? (msgs as DepotDebrief[]) : []),
      false,
    );
  } catch (e) {
    warn(e);
    setData(snapshot.stops, snapshot.debriefs, true);
  }
}

/* Poll / listen only while someone is looking (subscriber-refcounted). */
let timer: ReturnType<typeof setInterval> | null = null;
let onStorage: ((e: StorageEvent) => void) | null = null;

function start() {
  void refresh();
  if (mode === 'local') {
    onStorage = (e) => {
      if (e.key && ![LS_DEST, LS_MSGS].includes(e.key)) return;
      void refresh();
    };
    window.addEventListener('storage', onStorage);
  } else {
    timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (onStorage) window.removeEventListener('storage', onStorage);
  onStorage = null;
}

export function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export const getSnapshot = (): DepotSnapshot => snapshot;

/* ---------- writes ---------- */

function saveStopPatch(id: string, patch: Partial<DepotStop>): void {
  if (mode === 'local') {
    /* Read-modify-write the whole array against the freshest store, the
     * way dashboard.js persists — the storage event carries it to the
     * phone and the trigger dashboard in their own tabs. */
    try {
      const all: DepotStop[] = JSON.parse(localStorage.getItem(LS_DEST) || '[]');
      const row = Array.isArray(all) ? all.find((r) => r && r.id === id) : null;
      if (row) {
        Object.assign(row, patch);
        localStorage.setItem(LS_DEST, JSON.stringify(all));
      }
    } catch {
      /* private mode */
    }
    void refresh();
    return;
  }
  /* Optimistic locally, PATCH behind it; a failure flags offline and the
   * next poll restores the server's truth. */
  setData(
    snapshot.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    snapshot.debriefs,
    snapshot.offline,
  );
  patchDestination(id, patch).catch((e) => {
    warn(e);
    setData(snapshot.stops, snapshot.debriefs, true);
  });
}

const freshest = (stop: DepotStop) => snapshot.stops.find((s) => s.id === stop.id) || stop;

export function addNote(stop: DepotStop, text: string): void {
  const t = text.trim();
  if (!t) return;
  const cur = freshest(stop);
  const note: DepotNote = { id: localId('n'), text: t, at: new Date().toISOString(), by: 'dispatch' };
  saveStopPatch(cur.id, { notes: [note, ...notesOf(cur)] });
}

export function deleteNote(stop: DepotStop, idx: number): void {
  const cur = freshest(stop);
  const notes = notesOf(cur);
  if (!(idx >= 0 && idx < notes.length)) return;
  notes.splice(idx, 1);
  saveStopPatch(cur.id, { notes });
}

export function setStopField(stop: DepotStop, field: 'consignee' | 'floor', value: string): void {
  const cur = freshest(stop);
  const v = value.trim() || null;
  if ((cur[field] ?? null) === v) return;
  saveStopPatch(cur.id, { [field]: v });
}

/* ---------- Edge Functions (the slice this dashboard talks to) ---------- */

/** Which store this page runs against — 'local' means no functions exist. */
export const storeMode = mode;

/** POST a JSON Edge Function, time-boxed — mirrors backend.js's fn(). */
export async function callFn(name: string, body: unknown, timeoutMs = 30000): Promise<unknown> {
  if (mode !== 'supabase') throw new Error('keyless');
  const r = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((d as { error?: unknown }).error || `${name} ${r.status}`));
  return d;
}

/** The pre-arrival reading voice: text in, a short ElevenLabs mp3 out.
 * Time-boxed hard — the caller has the browser's own voice ready. */
export async function callTts(text: string): Promise<Blob> {
  if (mode !== 'supabase') throw new Error('keyless');
  const r = await fetch(`${url}/functions/v1/elevenlabs-tts`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('elevenlabs-tts ' + r.status);
  return r.blob();
}

/** A recorded question through the voice-note function (transcription leg
 * only — nothing is saved; saving debriefs is the phone's job). */
export async function transcribeClip(blob: Blob, context: string): Promise<string> {
  if (mode !== 'supabase') throw new Error('keyless');
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const fd = new FormData();
  fd.append('audio', blob, 'clip.' + ext);
  fd.append('context', context);
  const r = await fetch(`${url}/functions/v1/voice-note`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key }, // browser sets the multipart boundary
    body: fd,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((d as { error?: unknown }).error || `voice-note ${r.status}`));
  return String((d as { transcript?: unknown }).transcript || '');
}
