/* The reading voice's stream player (otto-stream.js), checked against a
 * stand-in MediaSource. No browser here, so the fakes below enforce the
 * same rules a real one enforces — one append at a time, no endOfStream
 * while a buffer is updating, nothing into a source that is not open —
 * and the tests watch the order things happen in.
 *
 *   node --test test/otto-stream.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------- the stand-ins ---------- */

const urls = new Map(); // object URL -> what it points at
let urlN = 0;
URL.createObjectURL = obj => { const u = 'blob:fake/' + (++urlN); urls.set(u, obj); return u; };
URL.revokeObjectURL = () => {};

class FakeSourceBuffer extends EventTarget {
  constructor(ms) { super(); this.ms = ms; this.updating = false; this.appended = []; this.delayMs = 3; }
  appendBuffer(chunk) {
    if (this.ms.readyState !== 'open') throw new DOMException('appendBuffer: source not open', 'InvalidStateError');
    if (this.updating) throw new DOMException('appendBuffer while updating', 'InvalidStateError');
    this.updating = true;
    this.appended.push(Uint8Array.from(chunk));
    setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); }, this.delayMs);
  }
}
class FakeMediaSource extends EventTarget {
  static isTypeSupported(type) { return type === 'audio/mpeg'; }
  constructor() { super(); this.readyState = 'closed'; this.buffers = []; this.endOfStreamCalls = 0; FakeMediaSource.last = this; }
  addSourceBuffer() {
    if (this.readyState !== 'open') throw new DOMException('addSourceBuffer: source not open', 'InvalidStateError');
    const sb = new FakeSourceBuffer(this);
    this.buffers.push(sb);
    return sb;
  }
  endOfStream() {
    if (this.readyState !== 'open') throw new DOMException('endOfStream: source not open', 'InvalidStateError');
    if (this.buffers.some(b => b.updating)) throw new DOMException('endOfStream while updating', 'InvalidStateError');
    this.readyState = 'ended';
    this.endOfStreamCalls++;
  }
}
/* playMode: 'ok' — play() resolves shortly; 'blocked' — rejects like a
 * page that never had a gesture; 'never' — stays pending, like an
 * element that never gets enough data */
class FakeAudio extends EventTarget {
  constructor(playMode = 'ok') { super(); this._src = ''; this.playMode = playMode; this.playCalls = 0; }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    const ms = urls.get(v);
    if (ms instanceof FakeMediaSource) {
      setTimeout(() => { if (this._src === v) { ms.readyState = 'open'; ms.dispatchEvent(new Event('sourceopen')); } }, 1);
    }
  }
  removeAttribute(name) {
    if (name !== 'src') return;
    const ms = urls.get(this._src);
    if (ms instanceof FakeMediaSource) ms.readyState = 'closed';
    this._src = '';
  }
  pause() {}
  play() {
    this.playCalls++;
    if (this.playMode === 'blocked') return Promise.reject(new DOMException('play() needs a gesture', 'NotAllowedError'));
    if (this.playMode === 'never') return new Promise(() => {});
    return new Promise(r => setTimeout(r, 4));
  }
}

/* a Response-like whose body emits `chunks` one every gapMs, then ends —
 * or errors (fail), or goes quiet for good (hang) */
function responseOf(chunks, { gapMs = 2, fail = false, hang = false } = {}) {
  const state = { sent: 0, cancelled: false };
  const body = new ReadableStream({
    start(c) {
      let i = 0;
      const tick = () => {
        if (state.cancelled) return;
        if (i < chunks.length) { c.enqueue(chunks[i++]); state.sent = i; setTimeout(tick, gapMs); return; }
        if (hang) return;
        if (fail) c.error(new TypeError('network error')); else c.close();
      };
      setTimeout(tick, gapMs);
    },
    cancel() { state.cancelled = true; },
  });
  return { response: { body }, state };
}
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
const many = (n, size = 4) => Array.from({ length: n }, (_, i) => bytes(size, i));
const concat = arrs => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

globalThis.MediaSource = FakeMediaSource;
await import('../otto-stream.js');
const { OttoStream } = globalThis;

/* ---------- the incremental path ---------- */

test('appends the chunks one at a time, in order, and seals the stream after the last one', async () => {
  const chunks = [bytes(7, 1), bytes(3, 2), bytes(11, 3), bytes(5, 4), bytes(9, 5), bytes(2, 6)];
  /* chunks land faster than the buffer takes them (1 ms vs 3 ms), so
   * they queue — an append while updating would throw in the fake, and
   * the pump would report a cut instead of complete */
  const { response } = responseOf(chunks, { gapMs: 1 });
  const clip = await OttoStream.play(new FakeAudio(), response, {});
  assert.equal(clip.streamed, true);
  assert.equal(await clip.delivered, 'complete');
  const ms = FakeMediaSource.last;
  assert.equal(ms.buffers.length, 1);
  assert.deepEqual(concat(ms.buffers[0].appended), concat(chunks), 'every byte, in order, nothing re-cut');
  assert.equal(ms.endOfStreamCalls, 1);
  assert.equal(ms.readyState, 'ended');
});

test('playback starts while the clip is still arriving', async () => {
  const chunks = many(12, 50);
  const { response, state } = responseOf(chunks, { gapMs: 15 });
  const clip = await OttoStream.play(new FakeAudio(), response, {});
  assert.ok(state.sent < chunks.length, `started with ${state.sent} of ${chunks.length} chunks in`);
  assert.equal(await clip.delivered, 'complete');
  assert.equal(state.sent, chunks.length);
});

test('a line that drops after the voice started: what arrived plays out, delivered says cut', async () => {
  const { response } = responseOf(many(3), { gapMs: 10, fail: true });
  const clip = await OttoStream.play(new FakeAudio(), response, {});
  assert.equal(await clip.delivered, 'cut');
  const ms = FakeMediaSource.last;
  assert.equal(ms.buffers[0].appended.length, 3, 'the chunks that made it are in');
  assert.equal(ms.endOfStreamCalls, 1, 'sealed, so the element still reaches ended');
});

test('a line that drops before the voice started rejects, so the caller can fall back', async () => {
  const { response } = responseOf(many(2), { gapMs: 2, fail: true });
  await assert.rejects(OttoStream.play(new FakeAudio('never'), response, { startMs: 500 }), e => e.name === 'NetworkError');
  assert.equal(FakeMediaSource.last.endOfStreamCalls, 0, 'nothing sealed: the caller resets the element');
});

test('a line that goes quiet is a cut after stallMs, and the download is let go', async () => {
  const { response, state } = responseOf(many(2), { gapMs: 2, hang: true });
  const clip = await OttoStream.play(new FakeAudio(), response, { stallMs: 40 });
  assert.equal(await clip.delivered, 'cut');
  assert.equal(state.cancelled, true);
  assert.equal(FakeMediaSource.last.endOfStreamCalls, 1);
});

test('the signal stops the pump at once: no more appends, the download let go, delivered says stopped', async () => {
  const { response, state } = responseOf(many(20), { gapMs: 8 });
  const ctl = new AbortController();
  const clip = await OttoStream.play(new FakeAudio(), response, { signal: ctl.signal });
  await sleep(30);
  ctl.abort();
  const appended = FakeMediaSource.last.buffers[0].appended.length;
  assert.equal(await clip.delivered, 'stopped');
  await sleep(60);
  assert.equal(FakeMediaSource.last.buffers[0].appended.length, appended, 'nothing appended after the stop');
  assert.equal(state.cancelled, true);
  assert.equal(FakeMediaSource.last.endOfStreamCalls, 0);
});

test('stopped before the voice started rejects with AbortError', async () => {
  const { response, state } = responseOf(many(10), { gapMs: 5 });
  const ctl = new AbortController();
  const p = OttoStream.play(new FakeAudio('never'), response, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, e => e.name === 'AbortError');
  await sleep(10);
  assert.equal(state.cancelled, true);
});

test('a signal already pulled rejects at once, before a byte is read', async () => {
  const { response, state } = responseOf(many(3), { gapMs: 2 });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(OttoStream.play(new FakeAudio(), response, { signal: ctl.signal }), e => e.name === 'AbortError');
  assert.equal(state.sent, 0);
});

test('a play() the browser refuses rejects with its reason and stops the download', async () => {
  const { response, state } = responseOf(many(10), { gapMs: 5 });
  await assert.rejects(OttoStream.play(new FakeAudio('blocked'), response, {}), e => e.name === 'NotAllowedError');
  await sleep(10);
  assert.equal(state.cancelled, true);
});

test('playback that never starts times out and rejects', async () => {
  const { response } = responseOf([bytes(4, 1)], { gapMs: 1 });
  await assert.rejects(OttoStream.play(new FakeAudio('never'), response, { startMs: 40 }), e => e.name === 'TimeoutError');
});

test('a short clip that is complete before play() settles still resolves, with delivered already complete', async () => {
  const { response } = responseOf([bytes(4, 1)], { gapMs: 1 });
  const audio = new FakeAudio();
  audio.play = () => new Promise(r => setTimeout(r, 40)); // the browser takes its time
  const clip = await OttoStream.play(audio, response, {});
  assert.equal(await clip.delivered, 'complete');
  assert.equal(FakeMediaSource.last.endOfStreamCalls, 1);
});

/* ---------- the whole-clip path ---------- */

test('without a MediaSource for mp3 the clip is collected whole and played as before', async () => {
  const saved = globalThis.MediaSource;
  globalThis.MediaSource = undefined;
  try {
    assert.equal(OttoStream.supported(), false);
    const chunks = many(3);
    const { response, state } = responseOf(chunks, { gapMs: 3 });
    const audio = new FakeAudio();
    const clip = await OttoStream.play(audio, response, {});
    assert.equal(clip.streamed, false);
    assert.equal(state.sent, chunks.length, 'nothing played before the whole clip was in');
    assert.match(audio.src, /^blob:/);
    assert.equal(urls.get(audio.src).size, 12, 'one Blob of every chunk');
    assert.equal(await clip.delivered, 'complete');
  } finally { globalThis.MediaSource = saved; }
});

test('the whole-clip path honours the stall watchdog and the stop signal too', async () => {
  const saved = globalThis.MediaSource;
  globalThis.MediaSource = undefined;
  try {
    const quiet = responseOf([bytes(4, 1)], { gapMs: 2, hang: true });
    await assert.rejects(OttoStream.play(new FakeAudio(), quiet.response, { stallMs: 30 }), e => e.name === 'NetworkError');
    assert.equal(quiet.state.cancelled, true);
    const ctl = new AbortController();
    const long = responseOf(many(10), { gapMs: 5 });
    const p = OttoStream.play(new FakeAudio(), long.response, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 12);
    await assert.rejects(p, e => e.name === 'AbortError');
    await sleep(10);
    assert.equal(long.state.cancelled, true);
  } finally { globalThis.MediaSource = saved; }
});

test('playWhole plays a clip already on the phone and times out if it never starts', async () => {
  const blob = new Blob([bytes(4, 1), bytes(4, 2)], { type: 'audio/mpeg' });
  const audio = new FakeAudio();
  const clip = await OttoStream.playWhole(audio, blob);
  assert.equal(clip.streamed, false);
  assert.match(audio.src, /^blob:/);
  assert.equal(urls.get(audio.src), blob);
  assert.equal(await clip.delivered, 'complete');
  await assert.rejects(OttoStream.playWhole(new FakeAudio('never'), blob, { startMs: 30 }), e => e.name === 'TimeoutError');
  await assert.rejects(OttoStream.playWhole(new FakeAudio('blocked'), blob), e => e.name === 'NotAllowedError');
});

test('supported() follows what the browser says about mp3', () => {
  assert.equal(OttoStream.supported(), true);
  const saved = globalThis.MediaSource;
  globalThis.MediaSource = class { static isTypeSupported() { return false; } };
  try { assert.equal(OttoStream.supported(), false); } finally { globalThis.MediaSource = saved; }
});
