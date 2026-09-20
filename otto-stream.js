'use strict';

/* ============================================================
 * OttoStream — plays an mp3 that is still arriving.
 *
 * The reading voice used to wait for the whole clip before the first
 * word: ask the function, download the mp3, then play. ElevenLabs
 * makes a clip in pieces and sends each piece the moment it is ready;
 * a browser with Media Source Extensions can play the first piece
 * while the last is still being made. So the reading starts a few
 * hundred milliseconds after the function answers, instead of after
 * the whole briefing has been synthesised and downloaded — "heads up,
 * stop 12" at the corner rather than at the kerb. Nothing else
 * changes: the same audio element, the same onended, the same
 * fallbacks around it.
 *
 *   OttoStream.play(audio, response, { signal, stallMs, startMs })
 *
 * takes the page's audio element and a fetch Response (its status
 * already checked by the caller) and resolves once the clip is
 * actually playing — the moment to label the voice — with
 * { streamed, delivered }: `streamed` says whether it played as it
 * arrived or whole, `delivered` is a promise that settles when the
 * download is over: 'complete' (the whole clip arrived), 'cut' (the
 * line dropped or stalled part-way — what had arrived plays out, and
 * the element's ended still fires) or 'stopped' (the caller's
 * signal). Before playback has started every failure rejects
 * instead, so the caller can fall back to another voice with nothing
 * half-said.
 *
 * The rules of the incremental path, each of them a bug when broken:
 *   - a SourceBuffer takes one append at a time: the next chunk waits
 *     for updateend, and nothing is appended while `updating` is true
 *   - endOfStream() only once the last append has settled, never
 *     while a buffer is updating
 *   - a chunk from the network may end in the middle of an mp3 frame;
 *     the browser's parser keeps the tail for the next append, so
 *     chunks go in as they come and are never re-cut here
 *   - stopping tears the pump down BEFORE the element is reset, so a
 *     chunk that lands late never goes into a source the page has
 *     already moved on from
 *   - the network is watched chunk by chunk: a line that goes quiet
 *     for stallMs is given up on, instead of a reading that hangs
 *
 * Where the browser has no MediaSource for mp3 (Safari, and so every
 * iPhone), the clip is collected whole and played as before — no
 * worse than it was. OttoStream.supported() says which it will be.
 * Checked by test/otto-stream.test.mjs against a stand-in MediaSource.
 * ============================================================ */

const OttoStream = (() => {
  const MIME = 'audio/mpeg';
  const root = typeof window !== 'undefined' ? window : globalThis;

  /* MediaSource where there is one; iOS Safari (17.1+) has only the
   * managed flavour, which wants remote playback switched off on the
   * element. Neither Safari takes mp3 through it today — isTypeSupported
   * says so — and play() below then collects the clip whole. */
  function sourceClass() {
    const MS = root.ManagedMediaSource || root.MediaSource;
    try {
      return MS && typeof MS.isTypeSupported === 'function' && MS.isTypeSupported(MIME) ? MS : null;
    } catch { return null; }
  }
  const supported = () => !!sourceClass();

  const fault = (name, message) => {
    try { return new DOMException(message, name); } catch { return Object.assign(new Error(message), { name }); }
  };
  const stopped = () => fault('AbortError', 'the reading was stopped');

  /* Reads a body chunk by chunk under a watchdog: onChunk(bytes) for
   * each piece, then onEnd('complete' | 'cut') exactly once — 'cut' for
   * a network error or a silence longer than stallMs. cancel() stops
   * the reading, and with it the download, without a word. */
  function drain(body, stallMs, onChunk, onEnd) {
    const reader = body.getReader();
    let timer = 0;
    let over = false;
    const end = how => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (how !== 'complete') { try { reader.cancel().catch(() => {}); } catch { /* already released */ } }
      if (how) onEnd(how);
    };
    (function next() {
      clearTimeout(timer);
      timer = setTimeout(() => end('cut'), stallMs);
      reader.read().then(({ done, value }) => {
        if (over) return;
        if (done) { end('complete'); return; }
        if (value && value.length) onChunk(value);
        next();
      }, () => end('cut'));
    })();
    return { cancel: () => end(null) };
  }

  /* The incremental path: the body goes into a SourceBuffer piece by
   * piece and the element plays from the first one. */
  function playStreamed(MS, audio, body, opts) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal || null;
      const stallMs = opts.stallMs || 10000;
      const startMs = opts.startMs || 10000;
      const ms = new MS();
      if (root.ManagedMediaSource && MS === root.ManagedMediaSource) audio.disableRemotePlayback = true;
      const url = URL.createObjectURL(ms);
      const pending = [];     // chunks waiting for the buffer, in arrival order
      let sb = null;          // the SourceBuffer, once the source is open
      let started = false;    // play() settled: the voice is out
      let over = false;       // the pump has nothing left to do
      let arrived = null;     // 'complete' | 'cut' once the download is over
      let startTimer = 0;
      let feed = null;
      let settleDelivered = null;
      const delivered = new Promise(r => { settleDelivered = r; });

      /* the pump has nothing more to do — whatever the element does next
       * is the caller's business. (The start watchdog is not the pump's:
       * a short clip can be sealed complete before the browser has begun
       * playing it, and the caller is still owed an answer either way.) */
      const teardown = () => {
        over = true;
        if (signal) signal.removeEventListener('abort', onStop);
        if (feed) feed.cancel();
        pending.length = 0;
        try { URL.revokeObjectURL(url); } catch { /* twice is fine */ }
      };
      /* no reading from this clip: the caller falls back to another voice */
      const giveUp = e => {
        if (!over) teardown();
        clearTimeout(startTimer);
        reject(e);
      };
      /* the download is over and the buffer has taken every chunk: seal
       * the stream — the element now knows where the clip ends and fires
       * ended when it gets there — and say how it went */
      const seal = how => {
        if (over) return;
        if (how === 'cut' && !started) {
          /* dropped before a word of it was out: not a reading to start */
          giveUp(fault('NetworkError', 'the clip stopped arriving before it started playing'));
          return;
        }
        teardown();
        try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* the element moved on */ }
        settleDelivered(how);
      };
      /* something broke on this side — an append refused, the decoder,
       * play() itself: after the voice started, what arrived plays out
       * and the download stops; before, the caller gets to fall back */
      const fail = e => {
        if (over) { if (!started) giveUp(e); return; }
        if (!started) { giveUp(e); return; }
        arrived = 'cut';
        pending.length = 0;
        if (feed) feed.cancel();
        pump();
      };
      /* the caller's signal: stop now, say nothing more */
      const onStop = () => {
        if (over) return;
        const was = started;
        teardown();
        if (was) settleDelivered('stopped'); else giveUp(stopped());
      };
      function pump() {
        if (over || !sb || sb.updating) return;
        if (ms.readyState !== 'open') {
          /* the element was pointed elsewhere under us (a reset without
           * our signal) — or the decoder gave up and closed the source */
          const was = started;
          const how = arrived === 'cut' ? 'cut' : 'stopped';
          teardown();
          if (was) settleDelivered(how);
          else giveUp(fault('InvalidStateError', 'the audio source closed before the clip started'));
          return;
        }
        if (pending.length) {
          try { sb.appendBuffer(pending.shift()); } catch (e) { fail(e); }
          return; // the next chunk goes in on updateend
        }
        if (arrived) seal(arrived);
      }
      const onOpen = () => {
        if (over) return;
        try { URL.revokeObjectURL(url); } catch { /* optional */ }
        try { sb = ms.addSourceBuffer(MIME); } catch (e) { fail(e); return; }
        sb.addEventListener('updateend', pump);
        sb.addEventListener('error', () => fail(fault('EncodingError', 'the browser could not decode the clip')));
        /* play() now, with the source open and still empty: it settles
         * the autoplay question at once (a locked element rejects here,
         * before a chunk is spent) and playback begins by itself the
         * moment the first appended chunk is decodable */
        let p;
        try { p = audio.play(); } catch (e) { fail(e); return; }
        Promise.resolve(p).then(() => {
          started = true;
          clearTimeout(startTimer);
          resolve({ streamed: true, delivered });
        }, fail);
        pump();
      };
      startTimer = setTimeout(() => {
        if (!started) giveUp(fault('TimeoutError', 'the clip did not start playing within ' + startMs + ' ms'));
      }, startMs);
      if (signal) signal.addEventListener('abort', onStop, { once: true });
      ms.addEventListener('sourceopen', onOpen, { once: true });
      feed = drain(body, stallMs, chunk => { pending.push(chunk); pump(); }, how => { arrived = how; pump(); });
      audio.src = url;
    });
  }

  /* Without a MediaSource for mp3: the whole clip first, then play —
   * the same watchdog on the way in, the same shape out. */
  function playCollected(audio, body, opts) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal || null;
      const parts = [];
      let over = false;
      let feed = null;
      const onStop = () => {
        if (over) return;
        over = true;
        if (feed) feed.cancel();
        reject(stopped());
      };
      if (signal) signal.addEventListener('abort', onStop, { once: true });
      feed = drain(body, opts.stallMs || 10000, chunk => parts.push(chunk), how => {
        if (over) return;
        over = true;
        if (signal) signal.removeEventListener('abort', onStop);
        if (how !== 'complete') { reject(fault('NetworkError', 'the clip stopped arriving')); return; }
        startWhole(audio, new Blob(parts, { type: MIME }), opts.startMs).then(resolve, reject);
      });
    });
  }
  /* the whole clip on the element — and the same start watchdog as the
   * stream: a play() that never settles must not hang the caller */
  function startWhole(audio, blob, startMs) {
    audio.src = URL.createObjectURL(blob);
    let timer = 0;
    const late = new Promise((_, rej) => {
      timer = setTimeout(() => rej(fault('TimeoutError', 'the clip did not start playing within ' + (startMs || 10000) + ' ms')), startMs || 10000);
    });
    return Promise.race([Promise.resolve(audio.play()), late])
      .then(() => ({ streamed: false, delivered: Promise.resolve('complete') }))
      .finally(() => clearTimeout(timer));
  }

  function play(audio, response, opts) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) return Promise.reject(stopped());
    const body = response && response.body;
    if (!body || typeof body.getReader !== 'function') {
      /* no body stream at all (a very old WebView): the old way, whole */
      return Promise.resolve(response.blob()).then(blob => startWhole(audio, blob, opts.startMs));
    }
    const MS = sourceClass();
    return MS ? playStreamed(MS, audio, body, opts) : playCollected(audio, body, opts);
  }

  return { play, supported, MIME };
})();
/* the page sees the const above; the node tests need it on the global */
(typeof globalThis !== 'undefined' ? globalThis : window).OttoStream = OttoStream;
