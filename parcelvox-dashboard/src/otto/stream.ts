/*
 * Plays an mp3 that is still arriving — the dashboard's copy of the phone's
 * otto-stream.js, typed; that file's comments carry the reasoning, and the
 * two are kept in step. In short: ElevenLabs sends the clip in pieces as it
 * is made, and with Media Source Extensions the element plays the first
 * piece while the last is still being synthesised, so a reply is heard a
 * moment after the function answers instead of after the whole answer has
 * been spoken at the other end and downloaded.
 *
 * The rules of the incremental path: one append at a time (the next chunk
 * on updateend, never while `updating`), endOfStream only once the last
 * append has settled, a chunk that ends mid-frame goes in as it is (the
 * browser's parser keeps the tail), the pump torn down before the element
 * is reset, and a watchdog on the chunks so a quiet line is given up on.
 *
 * playStream() resolves once the clip is actually playing; before that
 * every failure rejects, so the caller can fall back to another voice.
 * `delivered` settles when the download is over: 'complete', 'cut' (the
 * line dropped part-way; what arrived plays out and ended still fires) or
 * 'stopped' (the caller's signal). Where the browser has no MediaSource for
 * mp3 (Safari) the clip is collected whole and played as before.
 */

const MIME = 'audio/mpeg';

type Chunk = Uint8Array<ArrayBuffer>;
type Arrived = 'complete' | 'cut';
export type Delivered = Arrived | 'stopped';
export interface StreamedClip {
  /** played as it arrived (true) or whole, once it was all in (false) */
  streamed: boolean;
  delivered: Promise<Delivered>;
}
export interface StreamOptions {
  signal?: AbortSignal;
  /** give up on a line that sends nothing for this long (default 10 s) */
  stallMs?: number;
  /** give up if playback has not started this long after the answer (default 10 s) */
  startMs?: number;
}

type WindowWithMMS = typeof window & { ManagedMediaSource?: typeof MediaSource };

/* MediaSource where there is one; iOS Safari has only the managed flavour.
 * Neither Safari takes mp3 through it today — isTypeSupported says so. */
function sourceClass(): typeof MediaSource | null {
  const w = window as WindowWithMMS;
  const MS = w.ManagedMediaSource ?? w.MediaSource;
  try {
    return MS && typeof MS.isTypeSupported === 'function' && MS.isTypeSupported(MIME) ? MS : null;
  } catch {
    return null;
  }
}
export const canStream = (): boolean => !!sourceClass();

const fault = (name: string, message: string): DOMException => new DOMException(message, name);
const stopped = (): DOMException => fault('AbortError', 'the reading was stopped');

/* Reads a body chunk by chunk under a watchdog: onChunk for each piece,
 * then onEnd('complete' | 'cut') exactly once. cancel() stops the reading,
 * and with it the download, without a word. */
function drain(
  body: ReadableStream<Chunk>,
  stallMs: number,
  onChunk: (chunk: Chunk) => void,
  onEnd: (how: Arrived) => void,
): { cancel: () => void } {
  const reader = body.getReader();
  let timer = 0;
  let over = false;
  const end = (how: Arrived | null) => {
    if (over) return;
    over = true;
    window.clearTimeout(timer);
    if (how !== 'complete') void reader.cancel().catch(() => undefined);
    if (how) onEnd(how);
  };
  const next = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => end('cut'), stallMs);
    reader.read().then(
      ({ done, value }) => {
        if (over) return;
        if (done) {
          end('complete');
          return;
        }
        if (value?.length) onChunk(value);
        next();
      },
      () => end('cut'),
    );
  };
  next();
  return { cancel: () => end(null) };
}

/* The incremental path: the body goes into a SourceBuffer piece by piece
 * and the element plays from the first one. */
function playStreamed(
  MS: typeof MediaSource,
  audio: HTMLAudioElement,
  body: ReadableStream<Chunk>,
  opts: StreamOptions,
): Promise<StreamedClip> {
  return new Promise<StreamedClip>((resolve, reject) => {
    const signal = opts.signal ?? null;
    const stallMs = opts.stallMs ?? 10000;
    const startMs = opts.startMs ?? 10000;
    const ms = new MS();
    const w = window as WindowWithMMS;
    if (w.ManagedMediaSource && MS === w.ManagedMediaSource) audio.disableRemotePlayback = true;
    const url = URL.createObjectURL(ms);
    const pending: Chunk[] = []; // chunks waiting for the buffer, in arrival order
    let sb: SourceBuffer | null = null;
    let started = false; // play() settled: the voice is out
    let over = false; // the pump has nothing left to do
    let arrived: Arrived | null = null; // once the download is over
    let startTimer = 0;
    let feed: { cancel: () => void } | null = null;
    let settleDelivered: (how: Delivered) => void = () => undefined;
    const delivered = new Promise<Delivered>((r) => {
      settleDelivered = r;
    });

    /* the pump is done; the element is the caller's from here. The start
     * watchdog is not the pump's: a short clip can be sealed complete
     * before the browser has begun playing it. */
    const teardown = () => {
      over = true;
      signal?.removeEventListener('abort', onStop);
      feed?.cancel();
      pending.length = 0;
      URL.revokeObjectURL(url);
    };
    /* no reading from this clip: the caller falls back to another voice */
    const giveUp = (e: unknown) => {
      if (!over) teardown();
      window.clearTimeout(startTimer);
      reject(e);
    };
    /* the download is over and the buffer has taken every chunk: seal the
     * stream (the element then knows where the clip ends and fires ended
     * when it gets there) and say how it went */
    const seal = (how: Arrived) => {
      if (over) return;
      if (how === 'cut' && !started) {
        giveUp(fault('NetworkError', 'the clip stopped arriving before it started playing'));
        return;
      }
      teardown();
      try {
        if (ms.readyState === 'open') ms.endOfStream();
      } catch {
        /* the element moved on */
      }
      settleDelivered(how);
    };
    /* something broke on this side: after the voice started, what arrived
     * plays out and the download stops; before, the caller gets to fall back */
    const fail = (e: unknown) => {
      if (!started) {
        giveUp(e);
        return;
      }
      if (over) return;
      arrived = 'cut';
      pending.length = 0;
      feed?.cancel();
      pump();
    };
    /* the caller's signal: stop now, say nothing more */
    const onStop = () => {
      if (over) return;
      const was = started;
      teardown();
      if (was) settleDelivered('stopped');
      else giveUp(stopped());
    };
    const pump = () => {
      if (over || !sb || sb.updating) return;
      if (ms.readyState !== 'open') {
        /* the element was pointed elsewhere under us, or the decoder gave up */
        const was = started;
        const how: Delivered = arrived === 'cut' ? 'cut' : 'stopped';
        teardown();
        if (was) settleDelivered(how);
        else giveUp(fault('InvalidStateError', 'the audio source closed before the clip started'));
        return;
      }
      const chunk = pending.shift();
      if (chunk) {
        try {
          sb.appendBuffer(chunk);
        } catch (e) {
          fail(e);
        }
        return; // the next chunk goes in on updateend
      }
      if (arrived) seal(arrived);
    };
    const onOpen = () => {
      if (over) return;
      URL.revokeObjectURL(url);
      try {
        sb = ms.addSourceBuffer(MIME);
      } catch (e) {
        fail(e);
        return;
      }
      sb.addEventListener('updateend', pump);
      sb.addEventListener('error', () => fail(fault('EncodingError', 'the browser could not decode the clip')));
      /* play() now, with the source open and still empty: a locked element
       * rejects at once, and playback begins by itself the moment the first
       * appended chunk is decodable */
      let p: Promise<void>;
      try {
        p = audio.play();
      } catch (e) {
        fail(e);
        return;
      }
      p.then(() => {
        started = true;
        window.clearTimeout(startTimer);
        resolve({ streamed: true, delivered });
      }, fail);
      pump();
    };
    startTimer = window.setTimeout(() => {
      if (!started) giveUp(fault('TimeoutError', `the clip did not start playing within ${startMs} ms`));
    }, startMs);
    signal?.addEventListener('abort', onStop, { once: true });
    ms.addEventListener('sourceopen', onOpen, { once: true });
    feed = drain(
      body,
      stallMs,
      (chunk) => {
        pending.push(chunk);
        pump();
      },
      (how) => {
        arrived = how;
        pump();
      },
    );
    audio.src = url;
  });
}

/* Without a MediaSource for mp3: the whole clip first, then play — the
 * same watchdog on the way in, the same shape out. */
function playCollected(audio: HTMLAudioElement, body: ReadableStream<Chunk>, opts: StreamOptions): Promise<StreamedClip> {
  return new Promise<StreamedClip>((resolve, reject) => {
    const signal = opts.signal ?? null;
    const parts: Chunk[] = [];
    let over = false;
    let feed: { cancel: () => void } | null = null;
    const onStop = () => {
      if (over) return;
      over = true;
      feed?.cancel();
      reject(stopped());
    };
    signal?.addEventListener('abort', onStop, { once: true });
    feed = drain(
      body,
      opts.stallMs ?? 10000,
      (chunk) => parts.push(chunk),
      (how) => {
        if (over) return;
        over = true;
        signal?.removeEventListener('abort', onStop);
        if (how !== 'complete') {
          reject(fault('NetworkError', 'the clip stopped arriving'));
          return;
        }
        startWhole(audio, new Blob(parts, { type: MIME }), opts.startMs).then(resolve, reject);
      },
    );
  });
}

/* the whole clip on the element — with the same start watchdog as the
 * stream: a play() that never settles must not hang the caller */
function startWhole(audio: HTMLAudioElement, blob: Blob, startMs = 10000): Promise<StreamedClip> {
  audio.src = URL.createObjectURL(blob);
  let timer = 0;
  const late = new Promise<never>((_, rej) => {
    timer = window.setTimeout(() => rej(fault('TimeoutError', `the clip did not start playing within ${startMs} ms`)), startMs);
  });
  return Promise.race([audio.play(), late])
    .then((): StreamedClip => ({ streamed: false, delivered: Promise.resolve<Delivered>('complete') }))
    .finally(() => window.clearTimeout(timer));
}

/** Plays the mp3 of a fetch Response (status already checked) on `audio`,
 * from its first chunk where the browser can, whole otherwise. */
export function playStream(audio: HTMLAudioElement, response: Response, opts: StreamOptions = {}): Promise<StreamedClip> {
  if (opts.signal?.aborted) return Promise.reject(stopped());
  const body = response.body;
  if (!body) return response.blob().then((blob) => startWhole(audio, blob, opts.startMs));
  const MS = sourceClass();
  return MS ? playStreamed(MS, audio, body, opts) : playCollected(audio, body, opts);
}
