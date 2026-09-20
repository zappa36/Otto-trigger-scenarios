'use strict';

/* ============================================================
 * Minimal Supabase client (REST only, no SDK, no build step).
 *
 * The union of the two kits' backends — both widget files are
 * used VERBATIM, and each expects a global `Backend` with its
 * own methods, so this file provides both surfaces plus the
 * destinations/messages tables this app adds:
 *
 *   geolocate.js needs   geocode({lat,lng})
 *   voice-note.js needs  transcribe(blob, ctx), saveNote(row)
 *   app.js needs         search(q), destinations, messages
 *   dashboard.js needs   the scenarios table on top of all that
 *
 * When config.js is empty, enabled is false: the map falls back
 * to OpenStreetMap geocoding, Otto to the scripted demo, and
 * storage to localStorage.
 * ============================================================ */

const Backend = (() => {
  const url = (window.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = window.SUPABASE_ANON_KEY || '';
  const geocodeFn = window.GEOCODE_FN || 'geocode';
  const voiceFn = window.VOICE_FN || 'voice-note';
  const table = window.VOICE_TABLE || 'messages';
  const enabled = !!(url && key);

  async function rest(path, opts = {}) {
    const r = await fetch(url + path, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return r.status === 204 ? null : r.json();
  }

  /* AbortSignal.timeout is Chromium 103+ — on a WebView still short of
   * it, building the signal throws BEFORE the fetch runs, and every
   * time-boxed call here dies on the spot. No box then beats no call. */
  const timeoutSignal = ms =>
    (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  /* Time-boxed: geocoding is a lookup, and a lookup that hangs is worse
   * than one that fails — the callers all have a fallback ready. (The
   * voice upload below is NOT boxed; a long clip legitimately takes a
   * while to transcribe.) */
  async function fn(name, body, timeoutMs) {
    const r = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs || 8000),
    });
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return r.json();
  }

  /* A box a caller can also open from outside: the timer and the
   * caller's own signal abort the same fetch. AbortController is years
   * older than AbortSignal.timeout; a WebView without even that gets no
   * box, as above. clear() stops the timer once the answer is in; the
   * caller's signal stays wired to the connection for the body. */
  function boxed(ms, outer) {
    if (typeof AbortController === 'undefined') return { signal: outer, clear() {} };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    return { signal: ctl.signal, clear: () => clearTimeout(timer) };
  }

  /* The reading voice, as a STREAM: text in, and the moment the function
   * answers — status checked, nothing downloaded yet — the Response comes
   * back with its body still arriving: ElevenLabs is speaking the end of
   * the briefing while the phone plays the start (otto-stream.js feeds
   * the chunks to the audio element). The 12 s box covers the function's
   * answer, not the whole clip any more; the player watches the chunks
   * after that. The caller's signal drops the line at any point, so a
   * reading dismissed while the function is still answering stays
   * dismissed. */
  async function ttsStream(text, signal) {
    const box = boxed(12000, signal);
    let r;
    try {
      r = await fetch(`${url}/functions/v1/${window.ELEVENLABS_TTS_FN || 'elevenlabs-tts'}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: box.signal,
      });
    } finally { box.clear(); }
    if (!r.ok) {
      try { if (r.body) r.body.cancel().catch(() => {}); } catch { /* an error page is not worth downloading */ }
      throw new Error('elevenlabs-tts ' + r.status);
    }
    return r;
  }

  return {
    enabled,

    /* ---------- geolocate.js surface ---------- */
    geocode: body => fn(geocodeFn, body),
    /* forward search for the add-destination sheet */
    search: q => fn(geocodeFn, { q }).then(d => (d && d.results) || []),

    /* ---------- voice-note.js surface ---------- */
    async transcribe(blob, context) {
      const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, 'clip.' + ext);
      fd.append('context', context || '');
      const r = await fetch(`${url}/functions/v1/${voiceFn}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key }, // browser sets the multipart boundary
        body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${voiceFn} ${r.status}`);
      return d;
    },
    /* ---------- otto-agent.js surface ----------
     * The ElevenLabs conversation is spoken and transcribed at the other
     * end of the wire, so only the structuring leg of the voice function
     * is wanted: the same title + category the dashboard compares
     * against the scenario's expected tip type. */
    async structureText({ transcript, context }) {
      const r = await fetch(`${url}/functions/v1/${voiceFn}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, context: context || '' }),
        signal: timeoutSignal(20000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${voiceFn} ${r.status}`);
      return d;
    },
    /* A signed URL for a PRIVATE agent — the ElevenLabs key lives in the
     * function's secrets, never here. A public agent never calls this. */
    agentToken: agentId => fn(window.ELEVENLABS_TOKEN_FN || 'elevenlabs-token', { agent_id: agentId }, 10000),
    /* The reading voice (the pre-arrival notes in Otto's real voice), as
     * the stream above: the Response the moment the function answers,
     * its mp3 still arriving. Time-boxed hard — a reading that arrives
     * after the driver parked is a reading missed, and the caller has the
     * browser's own voice ready in its place. */
    ttsStream,
    /* The whole clip at once, boxed end to end: the darts count decodes
     * its one-word clips whole, the self-test measures one. */
    async tts(text) {
      const box = boxed(12000);
      try {
        const r = await ttsStream(text, box.signal);
        return await r.blob();
      } finally { box.clear(); }
    },
    /* Boot the reading function's isolate while the reading is still a
     * ring away: OPTIONS runs no TTS and spends no key, but the first
     * real clip of the session then skips the cold start — which was
     * eating into the same 12 s box every clip gets. */
    warmTts() {
      fetch(`${url}/functions/v1/${window.ELEVENLABS_TTS_FN || 'elevenlabs-tts'}`, { method: 'OPTIONS' })
        .catch(() => { /* a warm-up that failed changed nothing */ });
    },

    saveNote: row => rest(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    }),

    /* ---------- destinations & messages ---------- */
    listDestinations: () => rest('/rest/v1/destinations?select=*&order=created_at.asc'),
    insertDestination: row => rest('/rest/v1/destinations', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    }),
    /* the demo route lands as ONE insert — a hundred stops one request
     * at a time is a hundred chances to half-load a route */
    insertDestinations: rows => rest('/rest/v1/destinations', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    }),
    /* and leaves the same way (messages filed against the stops cascade) */
    deleteDestinationsByRoute: route => rest('/rest/v1/destinations?route=eq.' + encodeURIComponent(route), { method: 'DELETE' }),
    updateDestination: (id, patch) => rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    deleteDestination: id => rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),
    listMessages: limit => rest(`/rest/v1/${table}?select=*&order=created_at.desc&limit=${limit || 500}`),
    /* return=representation on both: RLS without the update/delete
     * policies (a schema.sql behind this build) silently matches zero
     * rows instead of erroring — the empty array IS the error signal */
    updateMessage: (id, patch) => rest(`/rest/v1/${table}?id=eq.` + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    deleteMessage: id => rest(`/rest/v1/${table}?id=eq.` + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    }),

    /* ---------- trigger scenarios (dashboard.js) ---------- */
    /* draft/revise round-trips are an LLM call each — a far longer box
     * than the geocode lookups, but still one, so a hung function shows
     * an error instead of a spinner that never ends */
    scenarioAI: body => fn(window.SCENARIO_AI_FN || 'scenario-ai', body, 30000),
    listScenarios: () => rest('/rest/v1/scenarios?select=*&order=num.asc.nullslast,created_at.asc'),
    insertScenarios: rows => rest('/rest/v1/scenarios', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    }),
    updateScenario: (id, patch) => rest('/rest/v1/scenarios?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    deleteScenario: id => rest('/rest/v1/scenarios?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),

    /* ---------- situations (dashboard.js) ----------
     * The other sheet: not WHEN Otto speaks but what happens after the
     * driver presses REPORT and says what they found. One row is one
     * thing a driver might say first, plus what a fitting follow-up
     * asks about — the unit the agent suite tests during the pilot,
     * where there are no triggers yet. No pin and no destination: a
     * situation is acted out in a conversation, not at an address. */
    listSituations: () => rest('/rest/v1/situations?select=*&order=num.asc.nullslast,created_at.asc'),
    /* the starter sheet lands as ONE insert, like the demo route */
    insertSituations: rows => rest('/rest/v1/situations', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    }),
    updateSituation: (id, patch) => rest('/rest/v1/situations?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    deleteSituation: id => rest('/rest/v1/situations?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),

    /* ---------- test-run log ----------
     * Every tracked run, fired or not (app.js saves, dashboard.js reads).
     * The runs where nothing happened are the ones debugging needs. */
    /* keepalive: the app flushes an abandoned run as the page dies, and
     * a normal fetch dies with it (the row is tiny, well under the
     * keepalive body cap) */
    insertRun: row => rest('/rest/v1/runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
      keepalive: true,
    }),
    /* the tester's one-tap verdict at run end ("should Otto have
     * spoken?") lands on the row after the fact */
    updateRun: (id, patch) => rest('/rest/v1/runs?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    listRuns: limit => rest(`/rest/v1/runs?select=*&order=created_at.desc&limit=${limit || 300}`),

    /* ---------- the agent suite's published runs ----------
     * One row per suite run the agent loop (elevenlabs/) publishes from
     * GitHub Actions — the simulated testers' half of the evidence,
     * read by dashboard.js to sit next to the field debriefs. Newest
     * first by when the suite RAN, not by when the row landed: a run
     * published late must not pose as the latest baseline. The table
     * is the newest in schema.sql, so a 404 here is "not created yet"
     * and the dashboard says so instead of failing the page. */
    listAgentRuns: limit => rest(`/rest/v1/agent_runs?select=*&order=ran_at.desc&limit=${limit || 50}`),

    /* ---------- the designer's "not a problem" list ----------
     * A finding on the RUNS tab (a pattern in the failed calls, or a
     * suggested prompt change) the designer has ruled fine by design.
     * Saved here so no run report and no proposal brings it up again;
     * one row per finding key, and saving a key twice only updates
     * the note (an upsert). UNDO deletes the row. The table is the
     * newest in schema.sql — a 404 means "not created yet". */
    listAccepted: () => rest('/rest/v1/accepted_findings?select=*&order=decided_at.desc'),
    acceptFinding: row => rest('/rest/v1/accepted_findings?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify([row]),
    }),
    unacceptFinding: key => rest('/rest/v1/accepted_findings?key=eq.' + encodeURIComponent(key), { method: 'DELETE' }),

    /* ---------- visits ----------
     * The Delivered / Not delivered tap on a route stop (app.js) — the
     * stand-in for a courier's parcel scan, and the row a tour is built
     * from: which stops were done, when, and how long the door took. */
    insertVisit: row => rest('/rest/v1/visits', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    }),
    deleteVisit: id => rest('/rest/v1/visits?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),
    listVisits: limit => rest(`/rest/v1/visits?select=*&order=created_at.desc&limit=${limit || 1000}`),

    /* ---------- the dart game (darts.js) ----------
     * One row per dart thrown after a report: the stop, the visit the
     * throw is tied to, who threw (a first name from settings, else
     * "someone") and the score. Nothing updates or deletes a throw.
     * The two reads are the card's two questions — has this stop had
     * its throw today, and what is the depot's best today — boxed, so
     * a slow network delays the card by seconds at most. A 404 means
     * the table is not created yet: paste its block of schema.sql
     * into the SQL editor. */
    insertDartThrow: row => rest('/rest/v1/dart_throws', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    }),
    dartThrowsFor: (destId, sinceISO) => rest('/rest/v1/dart_throws?select=id,visit_id,destination_id,thrown_at'
      + '&destination_id=eq.' + encodeURIComponent(destId)
      + '&thrown_at=gte.' + encodeURIComponent(sinceISO) + '&limit=20', { signal: timeoutSignal(3000) }),
    bestDartToday: sinceISO => rest('/rest/v1/dart_throws?select=player,score,thrown_at'
      + '&thrown_at=gte.' + encodeURIComponent(sinceISO)
      + '&order=score.desc,thrown_at.asc&limit=1', { signal: timeoutSignal(3000) }),
    /* the day's throws, best first — the board shown after a throw keeps
     * one row per driver out of these */
    dartLeadersToday: sinceISO => rest('/rest/v1/dart_throws?select=player,score,thrown_at'
      + '&thrown_at=gte.' + encodeURIComponent(sinceISO)
      + '&order=score.desc,thrown_at.asc&limit=100', { signal: timeoutSignal(3000) }),
  };
})();
