'use strict';

/* ============================================================
 * Live radio — a station by asking Otto.
 *
 * The phone is a web page, and a live station is an audio stream
 * with an address. The directory is Radio Browser
 * (api.radio-browser.info): community-run, free, no key, about
 * sixty thousand stations searchable by name, style, country,
 * place and language — and it answers a browser page directly.
 *
 * How a station gets picked: the driver asks Otto during a REPORT
 * call ("some jazz from Germany"). Otto's agent carries three CLIENT
 * TOOLS, built in ElevenLabs and answered here — otto-agent.js hands
 * every client_tool_call to `tools` below, by name:
 *
 *   find_radio_station({ name, style, country, place, language })
 *       -> the top three playable matches, as a line Otto reads out
 *   play_radio_station({ choice })      the number or the name
 *       -> "Now playing …" / "… starts when the call ends"
 *   stop_radio()
 *
 * The ⚙ sheet has a plain search box for the same thing (app.js).
 *
 * What was decided, and lives here:
 *   - SECURE STREAMS ONLY. The page is https, and a secure page
 *     refuses an insecure stream, so the search asks the directory
 *     for https stations and checks each one again: no certificate
 *     trouble, no HLS, a codec the audio element plays (mp3, aac).
 *     About one in three popular stations qualifies. Otto is never
 *     told about one the phone cannot play.
 *   - THE RADIO GETS OUT OF OTTO'S WAY. hold('call') while a line to
 *     Otto is open — the microphone streams everything it hears, and
 *     a station would end up in the transcript. The stream is
 *     dropped, not merely paused: a live stream paused for two
 *     minutes is stale and usually gone; release() reconnects it.
 *     duck() while Otto reads a pre-arrival note: quieter, not off.
 *   - A station chosen DURING a call starts when the call ends: the
 *     tool says so, and Otto tells the driver.
 *   - ONE ENTRY PER STATION. The directory lists "SWR3", "SWR3 - 96K
 *     AAC" and "SWR3 | 48k aac" as three rows; they fold into one,
 *     the top-voted row keeps the name, and the lower-data stream of
 *     the same station is the one played (never below MIN_KBPS) — a
 *     shift on a phone plan is long. The others stay as alternatives
 *     for when the chosen one will not play.
 *   - The last station is remembered: "play the radio" with no name
 *     brings it back.
 *   - FAVOURITES, kept on this phone like the other settings: ☆ on a
 *     found station or the one playing keeps it (up to MAX_FAVS), the ⚙
 *     sheet lists them one tap each. Otto knows them too: a favourite
 *     plays by name with no search, find_radio_station lists the ones
 *     that fit first (all of them when nothing was asked for), and the
 *     briefing names them.
 *
 * DOM-free on purpose: app.js draws the now-playing line and the
 * settings box from onChange(); the node tests (test/radio.test.mjs)
 * run the search, the folding and the tools with stand-ins for the
 * directory and the audio element.
 *
 *   Radio.find({ name, style, country, place, language }) -> stations
 *   Radio.play(station | nothing)   nothing = the last station
 *   Radio.stop()
 *   Radio.hold('call') / Radio.release('call')     silent, then back
 *   Radio.duck('voice') / Radio.unduck('voice')    quieter, then back
 *   Radio.status(), Radio.describe(), Radio.hint(), Radio.last()
 *   Radio.favourites(), Radio.isFavourite(st), Radio.addFavourite(st),
 *   Radio.removeFavourite(st), Radio.favouritesLine()
 *   Radio.onChange(fn)                             the status, on every change
 *   Radio.tools                                    the three tools, by name
 * ============================================================ */

const Radio = (() => {
  const root = typeof window !== 'undefined' ? window : globalThis;
  const LS_STATION = 'od_radio_station';
  const LS_FAVS = 'od_radio_favs';
  const MAX_FAVS = 12;
  /* the directory's mirrors, tried in this order; the last is its
   * round-robin name */
  const MIRRORS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://all.api.radio-browser.info'];
  const T = { search: 6000, play: 15000 }; // ms
  const DUCK = 0.25;    // the volume while a voice of Otto's speaks
  const MIN_KBPS = 48;  // a lower-data variant below this is not worth the sound
  const CHOICES = 3;    // what Otto reads out

  const words = s => String(s == null ? '' : s).trim();
  const norm = s => words(s).toLowerCase().replace(/\s+/g, ' ');

  /* ---------- the directory's rows, made playable ----------
   * Pure functions, exported as Radio._pure for the tests. */

  /* "SWR3 - 96K AAC", "SWR3 | 48k aac", "Deutschlandfunk | DLF | MP3 128k"
   * -> the station's own name: a trailing quality tag behind a dash, a
   * bar or a bracket goes, as often as there is one */
  const QUALITY_TAIL = /\s*[-–—|(\[/]\s*(?:\d{2,3}\s?k(?:bps)?|aac\+?|mp3|ogg|opus|hd|hq|lo|low|hi|high|stereo|mono)\b[^)\]]*[)\]]?\s*$/i;
  function cleanName(name) {
    let s = words(name);
    for (let i = 0; i < 3; i++) {
      const t = s.replace(QUALITY_TAIL, '');
      if (t === s) break;
      s = t;
    }
    return norm(s) || norm(name);
  }
  const shortCountry = c => words(c).replace(/^The\s+/i, '').replace(/\s+Of\s+(Great Britain|America)\b.*$/i, '');
  const tagsOf = s => String(s || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3);

  /* a secure page plays only what this says yes to */
  function playable(st) {
    if (!st) return false;
    const url = String(st.url_resolved || st.url || '');
    if (!/^https:\/\//i.test(url)) return false;
    if (+st.ssl_error) return false;
    if (+st.hls) return false;
    return /^(mp3|aac)/i.test(String(st.codec || ''));
  }

  /* one entry per station: the variants of one name (bitrates, codecs)
   * fold into one; the top-voted row keeps the name, the lower-data
   * stream of the same station is the one played (not below MIN_KBPS),
   * the rest are the alternatives to fall back on. Sorted by votes. */
  function dedupe(rows) {
    const groups = new Map();
    for (const st of Array.isArray(rows) ? rows : []) {
      if (!playable(st)) continue;
      const key = cleanName(st.name);
      const votes = +st.votes || 0;
      const g = groups.get(key);
      if (!g) groups.set(key, { votes, best: st, variants: [st] });
      else { g.variants.push(st); if (votes > g.votes) { g.votes = votes; g.best = st; } }
    }
    return [...groups.values()].sort((a, b) => b.votes - a.votes).map(station);
  }
  function station(g) {
    const b = g.best;
    const kbps = v => +v.bitrate || 0;
    const lean = g.variants.filter(v => kbps(v) >= MIN_KBPS).sort((x, y) => kbps(x) - kbps(y))[0] || b;
    const pick = kbps(lean) && kbps(lean) < kbps(b) ? lean : b;
    const stream = v => ({ url: String(v.url_resolved || v.url || ''), uuid: String(v.stationuuid || ''), codec: words(v.codec), bitrate: kbps(v) });
    return {
      name: words(b.name),
      country: shortCountry(b.country),
      countrycode: words(b.countrycode),
      tags: tagsOf(b.tags),
      votes: g.votes,
      ...stream(pick),
      alts: g.variants.filter(v => v !== pick).sort((x, y) => (+y.votes || 0) - (+x.votes || 0)).map(stream),
    };
  }

  /* what Otto's tool hands over -> the directory's own fields, the most
   * specific query first; the first queries that fill three choices win */
  function queriesFor(p) {
    p = p || {};
    const name = words(p.name);
    const tag = norm(p.style).replace(/[^\p{L}\p{N} +&-]/gu, '').trim();
    const country = words(p.country);
    const place = words(p.place);
    const lang = norm(p.language);
    const geo = {};
    if (/^[a-z]{2}$/i.test(country)) geo.countrycode = country.toUpperCase();
    else if (country) geo.country = country;
    if (place) geo.state = place;
    if (lang) geo.language = lang;
    const where = geo.countrycode ? { countrycode: geo.countrycode } : geo.country ? { country: geo.country } : {};
    const out = [];
    const add = q => { const s = JSON.stringify(q); if (!out.some(x => JSON.stringify(x) === s)) out.push(q); };
    if (name) {
      add({ name, ...geo });
      add({ name });
      add({ tag: norm(name), ...where }); // "jazz" said as a name is a style
    }
    if (tag) {
      add({ tag, ...geo });
      add({ tag, ...where });
      add({ tag });
    }
    if (!name && !tag) {
      if (Object.keys(geo).length) add(geo);
      if (Object.keys(where).length) add(where);
    }
    return out;
  }

  /* the three choices, as the line Otto reads out — and what to do next */
  function spokenList(stations) {
    if (!stations.length) return 'No station found.';
    const parts = stations.map((s, i) => `${i + 1}: ${s.name}${s.fav ? ' (a favourite)' : ''}${s.country ? ' from ' + s.country : ''}${s.tags && s.tags.length ? ' (' + s.tags.slice(0, 2).join(', ') + ')' : ''}`);
    return `Found ${stations.length} station${stations.length === 1 ? '' : 's'}. ${parts.join('. ')}. Read them out, ask the driver which one, then call play_radio_station with the number or the name.`;
  }
  const describeQuery = p => {
    const bits = [];
    if (p && p.name) bits.push(`"${words(p.name)}"`);
    if (p && p.style) bits.push(words(p.style));
    if (p && p.place) bits.push(words(p.place));
    if (p && p.country) bits.push(words(p.country));
    if (p && p.language) bits.push(words(p.language));
    return bits.join(', ') || 'that';
  };

  /* the driver's pick — "2", "the second one", "SWR3", "the swr one",
   * "terzo" — against the choices read out */
  const ORDINALS = [
    ['1', 'first', 'primo', 'prima', 'erste', 'ersten', 'one', 'uno', 'eins'],
    ['2', 'second', 'secondo', 'seconda', 'zweite', 'zweiten', 'two', 'due', 'zwei'],
    ['3', 'third', 'terzo', 'terza', 'dritte', 'dritten', 'three', 'tre', 'drei'],
  ];
  const CARDINALS = new Set(['one', 'uno', 'eins', 'two', 'due', 'zwei', 'three', 'tre', 'drei']);
  const STOP = new Set(['the', 'one', 'radio', 'station', 'please', 'play', 'put', 'on', 'number', 'that', 'this', 'from', 'with',
    'il', 'la', 'lo', 'quello', 'quella', 'numero', 'stazione', 'metti', 'per', 'favore',
    'die', 'der', 'das', 'den', 'sender', 'nummer', 'bitte', 'mach', 'an', 'und', 'and', 'of']);
  function resolveChoice(text, stations, opts) {
    const byNumber = !opts || opts.byNumber !== false;
    const t = norm(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t || !Array.isArray(stations) || !stations.length) return null;
    const tw = t.split(' ');
    const has = w => tw.includes(w);
    /* a digit or an ordinal is a pick by position */
    if (byNumber) {
      for (let i = 0; i < ORDINALS.length; i++) {
        if (ORDINALS[i].some(w => !CARDINALS.has(w) && has(w))) return stations[i] || null;
      }
    }
    /* the name, whole or in part */
    const named = stations.find(s => norm(s.name) === t)
      || stations.find(s => t.includes(norm(s.name)))
      || stations.find(s => norm(s.name).includes(t));
    if (named) return named;
    const keys = tw.filter(w => w.length > 2 && !STOP.has(w));
    const byWord = stations.find(s => {
      const nw = norm(s.name).split(/[^\p{L}\p{N}]+/u);
      return keys.some(k => nw.some(w => w === k || (k.length >= 3 && w.startsWith(k))));
    });
    if (byWord) return byWord;
    /* a bare number word last — "one" is also a word in "the SWR one" */
    if (byNumber) {
      for (let i = 0; i < ORDINALS.length; i++) {
        if (ORDINALS[i].some(has)) return stations[i] || null;
      }
    }
    return null;
  }

  /* ---------- the directory ---------- */
  async function fetchJson(path, signal) {
    let err = null;
    for (const base of MIRRORS) {
      try {
        const r = await root.fetch(base + path, { signal });
        if (!r.ok) throw new Error('the directory answered ' + r.status);
        return await r.json();
      } catch (e) {
        err = e;
        if (signal && signal.aborted) break;
      }
    }
    throw err || new Error('the radio directory did not answer');
  }

  async function search(params) {
    const queries = queriesFor(params);
    if (!queries.length) return [];
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = ctl ? ctl.signal : undefined;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, T.search);
    const found = [];
    const seen = new Set();
    try {
      for (const q of queries) {
        const qs = new URLSearchParams({ ...q, hidebroken: 'true', is_https: 'true', order: 'votes', reverse: 'true', limit: '20' });
        let rows;
        try { rows = await fetchJson('/json/stations/search?' + qs.toString(), signal); } catch (e) {
          if (signal && signal.aborted) throw new Error('the radio directory took too long');
          if (found.length) break; // something is in hand — better it than nothing
          throw e;
        }
        for (const st of dedupe(rows)) {
          const key = cleanName(st.name);
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(st);
        }
        if (found.length >= CHOICES) break;
      }
    } finally {
      clearTimeout(timer);
    }
    return found.slice(0, CHOICES);
  }

  /* the directory counts a play when told; nothing waits for it */
  function click(st) {
    if (!st || !st.uuid || !root.fetch) return;
    try { root.fetch(MIRRORS[0] + '/json/url/' + encodeURIComponent(st.uuid)).catch(() => {}); } catch { /* optional */ }
  }

  /* ---------- the player ---------- */
  const state = {
    audio: null,
    station: null,     // what is chosen
    want: false,       // and meant to be playing
    live: false,       // and actually heard
    holds: new Set(),  // reasons it is silent (a call)
    ducks: new Set(),  // reasons it is quieter (a voice)
    results: [],       // the choices last read out
    error: '',
    listeners: [],
    gen: 0,
  };
  const storage = () => { try { return root.localStorage || null; } catch { return null; } };
  function remember(st) {
    const ls = storage();
    if (!ls) return;
    try { ls.setItem(LS_STATION, JSON.stringify(st)); } catch { /* private mode */ }
  }
  function lastStation() {
    const ls = storage();
    if (!ls) return null;
    try {
      const st = JSON.parse(ls.getItem(LS_STATION) || 'null');
      return st && st.url && st.name ? st : null;
    } catch { return null; }
  }

  /* ---------- favourites: the stations kept on this phone ---------- */
  function favourites() {
    const ls = storage();
    if (!ls) return [];
    try {
      const list = JSON.parse(ls.getItem(LS_FAVS) || '[]');
      return Array.isArray(list) ? list.filter(f => f && f.url && f.name) : [];
    } catch { return []; }
  }
  function saveFavourites(list) {
    const ls = storage();
    if (!ls) return;
    try { ls.setItem(LS_FAVS, JSON.stringify(list)); } catch { /* private mode */ }
  }
  const sameStation = (a, b) => !!a && !!b && ((!!a.uuid && a.uuid === b.uuid) || cleanName(a.name) === cleanName(b.name));
  const isFavourite = st => favourites().some(f => sameStation(f, st));
  /* the favourites that fit what was asked for — by name, style or
   * country — or all of them when nothing was ("one of my stations") */
  function matchFavourites(list, p) {
    p = p || {};
    const name = norm(p.name);
    const style = norm(p.style);
    const country = norm(p.country);
    if (!name && !style && !country) return (list || []).slice();
    return (list || []).filter(f => {
      const n = norm(f.name);
      if (name && (n.includes(name) || name.includes(n))) return true;
      if (style && (f.tags || []).some(t => norm(t).includes(style) || style.includes(norm(t)))) return true;
      if (country && (norm(f.countrycode) === country || (f.country && norm(f.country).includes(country)))) return true;
      return false;
    });
  }
  function status() {
    return {
      station: state.station,
      wanted: state.want,
      playing: state.want && state.live && !state.holds.size,
      held: [...state.holds],
      ducked: state.ducks.size > 0,
      error: state.error,
      choices: state.results,
    };
  }
  function emit() {
    const s = status();
    state.listeners.forEach(fn => { try { fn(s); } catch { /* a listener's problem */ } });
  }

  function audioEl() {
    if (state.audio) return state.audio;
    const A = root.Audio;
    if (!A) return null;
    const a = new A();
    a.preload = 'none';
    /* a stream that stops after it started: the next variant, or the bar says so */
    if (a.addEventListener) {
      a.addEventListener('error', () => { if (state.live && state.want && !state.holds.size) failover('the stream stopped'); });
      a.addEventListener('playing', () => { if (state.want) { state.live = true; emit(); } });
      a.addEventListener('waiting', emit);
    }
    state.audio = a;
    return a;
  }
  function drop() {
    state.gen++;
    state.live = false;
    const a = state.audio;
    if (!a) return;
    try { a.pause(); } catch { /* nothing playing */ }
    try { a.removeAttribute('src'); a.load(); } catch { /* not a full element */ }
  }
  /* the lock screen and the car's controls, where there are any */
  function mediaSession(st) {
    const ms = root.navigator && root.navigator.mediaSession;
    if (!ms) return;
    try {
      if (root.MediaMetadata) ms.metadata = new root.MediaMetadata({ title: st.name, artist: st.country ? 'Live radio · ' + st.country : 'Live radio' });
      ms.setActionHandler('pause', () => api.stop());
      ms.setActionHandler('stop', () => api.stop());
      ms.setActionHandler('play', () => api.play());
    } catch { /* optional */ }
  }

  async function startPlayback() {
    const a = audioEl();
    const st = state.station;
    if (!a || !st || !state.want || state.holds.size) return false;
    const gen = ++state.gen;
    state.error = '';
    state.live = false;
    try {
      a.src = st.url;
      a.volume = state.ducks.size ? DUCK : 1;
    } catch { /* not a full element */ }
    emit();
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve(a.play()),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('the stream did not start')), T.play); }),
      ]);
      if (gen !== state.gen) return false; // stopped or changed meanwhile
      state.live = true;
      mediaSession(st);
      click(st);
      emit();
      return true;
    } catch (e) {
      if (gen !== state.gen) return false;
      return failover((e && e.message) || 'the stream did not start');
    } finally {
      clearTimeout(timer);
    }
  }
  /* the chosen stream would not play: the next variant of the same
   * station, then give up — and say why */
  function failover(why) {
    const st = state.station;
    if (st && Array.isArray(st.alts) && st.alts.length) {
      const next = st.alts.shift();
      state.station = { ...st, url: next.url, uuid: next.uuid || st.uuid, codec: next.codec || st.codec, bitrate: next.bitrate || st.bitrate };
      remember(state.station);
      return startPlayback();
    }
    drop();
    state.want = false;
    state.error = `could not play ${st ? st.name : 'the station'} (${why})`;
    emit();
    return false;
  }

  const api = {
    find: search,
    choices: () => state.results,
    last: lastStation,
    favourites,
    isFavourite,
    /* keep a station — at most MAX_FAVS, a station kept twice stays once */
    addFavourite(st) {
      if (!st || !st.url || !st.name) return false;
      const list = favourites().filter(f => !sameStation(f, st));
      if (list.length >= MAX_FAVS) return false;
      const kept = { ...st, alts: Array.isArray(st.alts) ? st.alts : [] };
      delete kept.fav;
      list.push(kept);
      saveFavourites(list);
      emit();
      return true;
    },
    removeFavourite(st) {
      const list = favourites();
      const left = list.filter(f => !sameStation(f, st));
      if (left.length === list.length) return false;
      saveFavourites(left);
      emit();
      return true;
    },
    /* for the agent's briefing: the names, and that they need no search */
    favouritesLine() {
      const list = favourites();
      if (!list.length) return '';
      return `The driver keeps ${list.length} favourite station${list.length === 1 ? '' : 's'}: ${list.map(f => f.name).join(', ')}. Any of them plays by name with play_radio_station, no search needed.`;
    },
    /* a station from find(), or nothing for the last one played */
    async play(st) {
      if (st == null) st = lastStation();
      if (!st || !st.url) return false;
      state.station = { ...st, alts: Array.isArray(st.alts) ? st.alts.slice() : [] };
      state.want = true;
      state.error = '';
      remember(state.station);
      emit();
      return startPlayback();
    },
    stop() {
      state.want = false;
      state.error = '';
      drop();
      emit();
      return true;
    },
    hold(reason) {
      state.holds.add(reason || 'held');
      if (state.audio) drop();
      /* a new call starts with no choices on the table — "the second
       * one" must never pick from a list read out an hour ago */
      state.results = [];
      emit();
    },
    release(reason) {
      state.holds.delete(reason || 'held');
      if (!state.holds.size && state.want) startPlayback();
      else emit();
    },
    duck(reason) {
      state.ducks.add(reason || 'voice');
      if (state.audio) { try { state.audio.volume = DUCK; } catch { /* optional */ } }
    },
    unduck(reason) {
      state.ducks.delete(reason || 'voice');
      if (!state.ducks.size && state.audio) { try { state.audio.volume = 1; } catch { /* optional */ } }
    },
    status,
    /* for the agent's briefing: what is on */
    describe() {
      const st = state.station;
      if (!st || !state.want) return 'No radio is playing.';
      return `The radio is playing ${st.name}${state.holds.size ? ' (silent while this call lasts)' : ''}.`;
    },
    hint: () => 'If the driver asks for a radio station, call find_radio_station, read the choices out and ask which one, then call play_radio_station with their pick; stop_radio switches it off. A station chosen during a call starts when the call ends.',
    onChange(fn) { if (typeof fn === 'function') state.listeners.push(fn); },

    /* ---------- the tools, as the agent calls them ---------- */
    tools: {
      async find_radio_station(p) {
        /* the favourites that fit come first — all of them when nothing
         * was asked for — and the directory fills the choices up to three */
        const stations = matchFavourites(favourites(), p).slice(0, CHOICES).map(f => ({ ...f, fav: true }));
        if (stations.length < CHOICES && queriesFor(p).length) {
          let more = [];
          try { more = await search(p); } catch (e) { if (!stations.length) throw e; }
          for (const st of more) {
            if (stations.length >= CHOICES) break;
            if (!stations.some(f => sameStation(f, st))) stations.push(st);
          }
        }
        state.results = stations;
        emit();
        if (!stations.length) return `No playable station found for ${describeQuery(p)}. Tell the driver, and offer another name, style or country.`;
        return spokenList(stations);
      },
      async play_radio_station(p) {
        p = p || {};
        const choice = words(p.choice != null ? p.choice : p.station != null ? p.station : p.number != null ? p.number : p.name);
        let st = null;
        if (state.results.length) st = choice ? resolveChoice(choice, state.results) : (state.results.length === 1 ? state.results[0] : null);
        /* a favourite plays by name with no search — and by its number
         * when no choices were read out */
        if (!st && choice) st = resolveChoice(choice, favourites(), { byNumber: !state.results.length });
        if (!st && choice && !state.results.length) {
          /* a name straight to play — no choices read out first */
          const found = await search({ name: choice });
          if (found.length) st = found[0];
        }
        if (!st && !choice) st = lastStation();
        if (!st) {
          return state.results.length
            ? `Which one? The choices are ${state.results.map((s, i) => `${i + 1}: ${s.name}`).join(', ')}. Ask the driver, then call play_radio_station again.`
            : `No playable station found for "${choice}". Call find_radio_station first.`;
        }
        await api.play(st);
        if (state.error) return `${st.name} would not play (${state.error}). Offer another choice.`;
        return state.holds.size
          ? `${st.name} is set. It starts playing as soon as this call ends. Tell the driver so in one short line.`
          : `Now playing ${st.name}.`;
      },
      async stop_radio() {
        api.stop();
        return 'The radio is off.';
      },
    },

    _pure: { cleanName, playable, dedupe, queriesFor, spokenList, resolveChoice, shortCountry, matchFavourites, sameStation },
  };
  return api;
})();
/* the page sees the const above; the node tests need it on the global */
(typeof globalThis !== 'undefined' ? globalThis : window).Radio = Radio;
