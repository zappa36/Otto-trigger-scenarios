/* The radio (radio.js), checked without a browser: the directory is a
 * fake fetch that answers from fixtures and can refuse a mirror, the
 * audio element a stand-in that records what it was asked to play and
 * can refuse a stream. What is tested is what a driver would notice —
 * which stations Otto is told about, which stream plays, that the
 * radio is silent while a call is open and back afterwards, quieter
 * under a voice, and what each of Otto's three tools answers.
 *
 *   node --test test/radio.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------- the stand-ins ---------- */
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = ''; this.volume = 1; this.paused = true; this.preload = '';
    this.plays = []; this.loads = 0;
    FakeAudio.last = this;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; }
  removeAttribute(n) { if (n === 'src') this._src = ''; }
  load() { this.loads++; }
  pause() { this.paused = true; }
  play() {
    this.plays.push(this._src);
    if (FakeAudio.refuse.has(this._src)) return Promise.reject(new Error('unsupported source'));
    this.paused = false;
    return Promise.resolve();
  }
}
FakeAudio.refuse = new Set();
FakeAudio.last = null;
globalThis.Audio = FakeAudio;

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

/* the directory: `answer` maps a query to rows; `down` names mirrors that refuse */
const calls = [];
let answer = () => [];
const down = new Set();
globalThis.fetch = async url => {
  calls.push(url);
  const u = new URL(url);
  if (down.has(u.host)) throw new TypeError('failed to fetch');
  if (u.pathname.startsWith('/json/url/')) return { ok: true, json: async () => ({ ok: true }) };
  const rows = answer(u.searchParams);
  return { ok: true, json: async () => rows };
};
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

await import('../radio.js');
const { Radio } = globalThis;
const P = Radio._pure;

/* ---------- fixtures: what the directory says ---------- */
const row = (name, over = {}) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    name, url: 'https://streams.example/' + slug, url_resolved: 'https://streams.example/' + slug,
    codec: 'MP3', bitrate: 128, votes: 100, hls: 0, ssl_error: 0,
    country: 'Germany', countrycode: 'DE', tags: 'pop,rock,news', stationuuid: 'uuid-' + slug,
    ...over,
  };
};
const SWR = () => [
  row('SWR3', { votes: 19129 }),
  row('SWR3 - 96K AAC', { codec: 'AAC', bitrate: 96, votes: 853 }),
  row('SWR3 | 32k aac', { codec: 'AAC', bitrate: 32, votes: 40 }),
  row('SWR1', { votes: 5000, tags: 'pop,oldies' }),
  row('SWR4 BW', { votes: 900, tags: 'schlager' }),
  row('SWR Insecure', { votes: 8000, url: 'http://streams.example/swr-insecure', url_resolved: 'http://streams.example/swr-insecure' }),
];
/* between tests: nothing playing, nothing held, no choices on the table
 * (a call opening clears them), the one audio element's log emptied,
 * and the directory answering by name the way the real one does */
const byName = q => SWR().filter(r => {
  const name = q.get('name');
  const tag = q.get('tag');
  if (name && !r.name.toLowerCase().includes(name.toLowerCase())) return false;
  if (tag && !r.tags.split(',').includes(tag.toLowerCase())) return false;
  return true;
});
const reset = () => {
  calls.length = 0; down.clear(); FakeAudio.refuse.clear(); store.clear();
  Radio.stop(); Radio.hold('call'); Radio.release('call'); Radio.unduck('voice');
  if (FakeAudio.last) { FakeAudio.last.plays = []; FakeAudio.last.loads = 0; }
  answer = byName;
};

/* ---------- the rows, made playable ---------- */

test('a station\'s quality tags fold away, other names stay whole', () => {
  assert.equal(P.cleanName('SWR3 - 96K AAC'), 'swr3');
  assert.equal(P.cleanName('SWR3 | 48k aac'), 'swr3');
  assert.equal(P.cleanName('Radio X (128 kbps)'), 'radio x');
  assert.equal(P.cleanName('Deutschlandfunk | DLF | MP3 128k'), 'deutschlandfunk | dlf');
  assert.equal(P.cleanName('Absolut HOT'), 'absolut hot');
  assert.equal(P.cleanName('Radio 1 - Berlin'), 'radio 1 - berlin');
});

test('only what a secure page can play passes: https, no certificate trouble, no HLS, mp3 or aac', () => {
  assert.equal(P.playable(row('ok')), true);
  assert.equal(P.playable(row('aac+', { codec: 'AAC+' })), true);
  assert.equal(P.playable(row('http', { url_resolved: 'http://streams.example/x' })), false);
  assert.equal(P.playable(row('ssl', { ssl_error: 1 })), false);
  assert.equal(P.playable(row('hls', { hls: 1 })), false);
  assert.equal(P.playable(row('ogg', { codec: 'OGG' })), false);
  assert.equal(P.playable(null), false);
});

test('one entry per station, by votes: the best-known name, the lower-data stream, the rest as fallbacks', () => {
  const out = P.dedupe(SWR());
  assert.deepEqual(out.map(s => s.name), ['SWR3', 'SWR1', 'SWR4 BW'], 'the insecure one is gone, the variants folded');
  const swr3 = out[0];
  assert.equal(swr3.bitrate, 96, 'the 96k AAC variant plays, not the 128 mp3');
  assert.equal(swr3.codec, 'AAC');
  assert.equal(swr3.url, 'https://streams.example/swr3-96k-aac');
  assert.equal(swr3.votes, 19129, 'the votes of the best-known row');
  assert.deepEqual(swr3.alts.map(a => a.bitrate), [128, 32], 'fallbacks by votes; the 32k one was too thin to prefer');
  assert.equal(swr3.country, 'Germany');
  assert.deepEqual(swr3.tags, ['pop', 'rock', 'news']);
});

test('long country names read short', () => {
  assert.equal(P.shortCountry('The United Kingdom Of Great Britain And Northern Ireland'), 'United Kingdom');
  assert.equal(P.shortCountry('The United States Of America'), 'United States');
  assert.equal(P.shortCountry('Germany'), 'Germany');
});

/* ---------- what Otto's words become ---------- */

test('a name with a country: the exact pair first, the name alone, then the name as a style', () => {
  assert.deepEqual(P.queriesFor({ name: 'swr3', country: 'de' }), [
    { name: 'swr3', countrycode: 'DE' }, { name: 'swr3' }, { tag: 'swr3', countrycode: 'DE' },
  ]);
});
test('a style with a country name, a place, a language — and nothing at all', () => {
  assert.deepEqual(P.queriesFor({ style: 'Jazz', country: 'Germany' }), [{ tag: 'jazz', country: 'Germany' }, { tag: 'jazz' }]);
  assert.deepEqual(P.queriesFor({ style: 'news', language: 'Italian', country: 'IT' }), [
    { tag: 'news', countrycode: 'IT', language: 'italian' }, { tag: 'news', countrycode: 'IT' }, { tag: 'news' },
  ]);
  assert.deepEqual(P.queriesFor({ place: 'Berlin' }), [{ state: 'Berlin' }]);
  assert.deepEqual(P.queriesFor({}), []);
  assert.deepEqual(P.queriesFor(null), []);
});

test('the search walks the queries until three choices are in hand, secure only, and reads them out', async () => {
  reset();
  answer = q => (q.get('countrycode') ? [] : SWR()); // the exact pair finds nothing; the name alone does
  const text = await Radio.tools.find_radio_station({ name: 'swr', country: 'DE' });
  assert.equal(calls.length, 2, 'the second query was enough');
  assert.match(calls[0], /countrycode=DE/);
  assert.match(calls[1], /name=swr/);
  assert.doesNotMatch(calls[1], /countrycode/);
  calls.forEach(u => { assert.match(u, /is_https=true/); assert.match(u, /hidebroken=true/); });
  assert.equal(text, 'Found 3 stations. 1: SWR3 from Germany (pop, rock). 2: SWR1 from Germany (pop, oldies). 3: SWR4 BW from Germany (schlager). Read them out, ask the driver which one, then call play_radio_station with the number or the name.');
  assert.deepEqual(Radio.choices().map(s => s.name), ['SWR3', 'SWR1', 'SWR4 BW']);
});

test('a mirror that refuses is skipped for the next one', async () => {
  reset();
  down.add('de1.api.radio-browser.info');
  const found = await Radio.find({ name: 'swr' });
  assert.equal(found.length, 3);
  assert.ok(calls.some(u => u.startsWith('https://de2.api.radio-browser.info/')), 'the second mirror answered');
});

test('nothing found is said plainly, with what was looked for', async () => {
  reset();
  answer = () => [];
  const text = await Radio.tools.find_radio_station({ style: 'polka', country: 'Iceland' });
  assert.equal(text, 'No playable station found for polka, Iceland. Tell the driver, and offer another name, style or country.');
});

/* ---------- the driver's pick ---------- */

test('a number, an ordinal, a name, a word of the name — in three languages', () => {
  const st = P.dedupe(SWR());
  const pick = t => { const s = P.resolveChoice(t, st); return s && s.name; };
  assert.equal(pick('2'), 'SWR1');
  assert.equal(pick('the second one'), 'SWR1');
  assert.equal(pick('number 3'), 'SWR4 BW');
  assert.equal(pick('SWR3'), 'SWR3');
  assert.equal(pick('play swr1 please'), 'SWR1');
  assert.equal(pick('the swr one'), 'SWR3', 'a word of the name outranks a bare "one"');
  assert.equal(pick('one'), 'SWR3');
  assert.equal(pick('la terza'), 'SWR4 BW');
  assert.equal(pick('die zweite'), 'SWR1');
  assert.equal(pick('bbc'), null);
  assert.equal(pick('', st), null);
});

/* ---------- playing, and getting out of Otto's way ---------- */

test('a station chosen during a call is set, silent, and starts when the call ends', async () => {
  reset();
  Radio.hold('call'); // the call opens first, then the driver asks
  await Radio.tools.find_radio_station({ name: 'swr' });
  const text = await Radio.tools.play_radio_station({ choice: 'the second one' });
  assert.equal(text, 'SWR1 is set. It starts playing as soon as this call ends. Tell the driver so in one short line.');
  const a = FakeAudio.last;
  assert.ok(!a || a.plays.length === 0, 'nothing played into the open microphone');
  assert.deepEqual(Radio.status().held, ['call']);
  assert.equal(Radio.status().wanted, true);
  assert.equal(Radio.describe(), 'The radio is playing SWR1 (silent while this call lasts).');
  Radio.release('call');
  await tick();
  assert.deepEqual(FakeAudio.last.plays, ['https://streams.example/swr1']);
  assert.equal(Radio.status().playing, true);
  assert.equal(Radio.describe(), 'The radio is playing SWR1.');
  assert.ok(calls.some(u => u.includes('/json/url/uuid-swr1')), 'the directory was told about the play');
});

test('a call opening drops the stream; the call closing reconnects it; a voice only turns it down', async () => {
  reset();
  await Radio.tools.find_radio_station({ name: 'swr' });
  const text = await Radio.tools.play_radio_station({ choice: '1' });
  assert.equal(text, 'Now playing SWR3.');
  const a = FakeAudio.last;
  assert.equal(a.paused, false);
  assert.equal(a.src, 'https://streams.example/swr3-96k-aac', 'the lower-data stream of the same station');
  Radio.duck('voice');
  assert.equal(a.volume, 0.25);
  Radio.unduck('voice');
  assert.equal(a.volume, 1);
  const loads = a.loads;
  Radio.hold('call');
  assert.equal(a.paused, true);
  assert.equal(a.src, '', 'dropped, not paused — a live stream paused for a call is stale and gone');
  assert.ok(a.loads > loads);
  assert.equal(Radio.status().playing, false);
  assert.equal(Radio.status().wanted, true);
  Radio.release('call');
  await tick();
  assert.equal(a.paused, false);
  assert.equal(a.plays.length, 2, 'a fresh connection');
  assert.equal(Radio.status().playing, true);
});

test('stop switches it off and says so; the last station is remembered and comes back unnamed', async () => {
  reset();
  await Radio.tools.find_radio_station({ name: 'swr' });
  await Radio.tools.play_radio_station({ choice: 'SWR4' });
  assert.equal(await Radio.tools.stop_radio(), 'The radio is off.');
  assert.equal(FakeAudio.last.paused, true);
  assert.equal(Radio.status().wanted, false);
  assert.equal(Radio.describe(), 'No radio is playing.');
  assert.equal(Radio.last().name, 'SWR4 BW');
  const ok = await Radio.play();
  assert.equal(ok, true);
  assert.equal(Radio.status().station.name, 'SWR4 BW');
});

test('a stream that will not play falls back to the station\'s other variant, then gives up out loud', async () => {
  reset();
  FakeAudio.refuse.add('https://streams.example/swr3-96k-aac');
  await Radio.tools.find_radio_station({ name: 'swr' });
  const text = await Radio.tools.play_radio_station({ choice: 'swr3' });
  assert.equal(text, 'Now playing SWR3.');
  assert.deepEqual(FakeAudio.last.plays, ['https://streams.example/swr3-96k-aac', 'https://streams.example/swr3']);
  assert.equal(Radio.status().station.bitrate, 128);
  /* now every variant refuses */
  FakeAudio.refuse.add('https://streams.example/swr3');
  FakeAudio.refuse.add('https://streams.example/swr3-32k-aac');
  const again = await Radio.tools.play_radio_station({ choice: 'swr3' });
  assert.match(again, /^SWR3 would not play \(could not play SWR3 \(unsupported source\)\)\. Offer another choice\.$/);
  assert.equal(Radio.status().wanted, false);
  assert.match(Radio.status().error, /could not play SWR3/);
});

test('a name straight to play, no choices read out first — and a pick nobody read out asks back', async () => {
  reset();
  const text = await Radio.tools.play_radio_station({ choice: 'swr1' });
  assert.equal(text, 'Now playing SWR1.');
  reset();
  await Radio.tools.find_radio_station({ name: 'swr' });
  answer = () => [];
  const ask = await Radio.tools.play_radio_station({ choice: 'bbc' });
  assert.equal(ask, 'Which one? The choices are 1: SWR3, 2: SWR1, 3: SWR4 BW. Ask the driver, then call play_radio_station again.');
  reset();
  answer = () => [];
  assert.equal(await Radio.tools.play_radio_station({ choice: 'bbc' }), 'No playable station found for "bbc". Call find_radio_station first.');
});

test('the hint and the description are one sentence each, for the briefing', () => {
  assert.match(Radio.hint(), /^If the driver asks for a radio station, call find_radio_station/);
  assert.match(Radio.hint(), /starts when the call ends\.$/);
});

/* ---------- favourites: the stations kept on this phone ---------- */

test('a station kept is listed once, up to twelve; a quality tag is the same station; ✕ lets it go', () => {
  reset();
  const [swr3, swr1] = P.dedupe(SWR());
  assert.equal(Radio.favourites().length, 0);
  assert.equal(Radio.addFavourite(swr3), true);
  assert.equal(Radio.addFavourite(swr3), true, 'kept twice stays once');
  assert.equal(Radio.addFavourite(swr1), true);
  assert.deepEqual(Radio.favourites().map(f => f.name), ['SWR3', 'SWR1']);
  assert.equal(Radio.isFavourite(swr1), true);
  assert.equal(Radio.isFavourite({ name: 'SWR3 - 96K AAC', url: 'https://streams.example/other' }), true, 'the same station under a quality tag');
  assert.equal(Radio.removeFavourite(swr3), true);
  assert.equal(Radio.removeFavourite(swr3), false);
  assert.deepEqual(Radio.favourites().map(f => f.name), ['SWR1']);
  for (let i = 0; i < 12; i++) Radio.addFavourite(row('Station ' + i));
  assert.equal(Radio.favourites().length, 12, 'twelve at most');
  assert.equal(Radio.addFavourite(row('One too many')), false);
  assert.equal(Radio.addFavourite(null), false);
});

test('a favourite that fits comes first when Otto searches, marked, and the directory fills the rest without doubling it', async () => {
  reset();
  answer = () => SWR(); // a directory with jazz on every SWR station, for the merge
  const [swr3] = P.dedupe(SWR());
  Radio.addFavourite({ ...swr3, tags: ['jazz', 'smooth'] });
  const text = await Radio.tools.find_radio_station({ style: 'jazz' });
  assert.match(text, /^Found 3 stations\. 1: SWR3 \(a favourite\) from Germany \(jazz, smooth\)\. 2: SWR1 from Germany \(pop, oldies\)\. 3: SWR4 BW/);
  assert.ok(calls.some(u => u.includes('tag=jazz')), 'the directory was asked too');
  assert.equal(Radio.choices().filter(s => s.name === 'SWR3').length, 1);
});

test('"one of my stations": nothing asked for, the favourites alone, no directory call', async () => {
  reset();
  const [swr3, swr1] = P.dedupe(SWR());
  Radio.addFavourite(swr3);
  Radio.addFavourite(swr1);
  const text = await Radio.tools.find_radio_station({});
  assert.equal(text, 'Found 2 stations. 1: SWR3 (a favourite) from Germany (pop, rock). 2: SWR1 (a favourite) from Germany (pop, oldies). Read them out, ask the driver which one, then call play_radio_station with the number or the name.');
  assert.equal(calls.length, 0);
});

test('a favourite plays by name with no search, by its number when nothing was read out, and still by name when choices are on the table', async () => {
  reset();
  const [swr3, swr1] = P.dedupe(SWR());
  Radio.addFavourite(swr3);
  Radio.addFavourite(swr1);
  assert.equal(await Radio.tools.play_radio_station({ choice: 'swr1' }), 'Now playing SWR1.');
  assert.equal(calls.filter(u => u.includes('/json/stations/')).length, 0, 'no search');
  assert.equal(await Radio.tools.play_radio_station({ choice: 'the first one' }), 'Now playing SWR3.');
  await Radio.tools.find_radio_station({ name: 'swr4' });
  assert.equal(await Radio.tools.play_radio_station({ choice: '1' }), 'Now playing SWR4 BW.', 'a number picks from the choices read out');
  assert.equal(await Radio.tools.play_radio_station({ choice: 'swr1' }), 'Now playing SWR1.', 'a favourite by name outranks "which one?"');
  assert.equal(await Radio.tools.play_radio_station({ choice: 'bbc' }), 'Which one? The choices are 1: SWR4 BW. Ask the driver, then call play_radio_station again.');
});

test('the briefing names the favourites, and says they need no search', () => {
  reset();
  assert.equal(Radio.favouritesLine(), '');
  const [swr3, swr1] = P.dedupe(SWR());
  Radio.addFavourite(swr3);
  Radio.addFavourite(swr1);
  assert.equal(Radio.favouritesLine(), 'The driver keeps 2 favourite stations: SWR3, SWR1. Any of them plays by name with play_radio_station, no search needed.');
});

test('which favourites fit: by name, style or country — all of them when nothing was asked for', () => {
  const favs = [
    { name: 'SWR3', url: 'u', tags: ['pop'], country: 'Germany', countrycode: 'DE' },
    { name: 'RAI Radio 1', url: 'u', tags: ['news'], country: 'Italy', countrycode: 'IT' },
  ];
  const names = p => P.matchFavourites(favs, p).map(f => f.name);
  assert.deepEqual(names({ name: 'rai' }), ['RAI Radio 1']);
  assert.deepEqual(names({ style: 'News' }), ['RAI Radio 1']);
  assert.deepEqual(names({ country: 'de' }), ['SWR3']);
  assert.deepEqual(names({ country: 'Italy' }), ['RAI Radio 1']);
  assert.deepEqual(names({}), ['SWR3', 'RAI Radio 1']);
  assert.deepEqual(names({ name: 'bbc' }), []);
});
