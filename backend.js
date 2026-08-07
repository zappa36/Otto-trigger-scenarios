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

  /* Time-boxed: geocoding is a lookup, and a lookup that hangs is worse
   * than one that fails — the callers all have a fallback ready. (The
   * voice upload below is NOT boxed; a long clip legitimately takes a
   * while to transcribe.) */
  async function fn(name, body, timeoutMs) {
    const r = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 8000),
    });
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return r.json();
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
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${voiceFn} ${r.status}`);
      return d;
    },
    /* A signed URL for a PRIVATE agent — the ElevenLabs key lives in the
     * function's secrets, never here. A public agent never calls this. */
    agentToken: agentId => fn(window.ELEVENLABS_TOKEN_FN || 'elevenlabs-token', { agent_id: agentId }, 10000),

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
    updateDestination: (id, patch) => rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
    deleteDestination: id => rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),
    listMessages: limit => rest(`/rest/v1/${table}?select=*&order=created_at.desc&limit=${limit || 500}`),

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

    /* ---------- test-run log ----------
     * Every tracked run, fired or not (app.js saves, dashboard.js reads).
     * The runs where nothing happened are the ones debugging needs. */
    insertRun: row => rest('/rest/v1/runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    }),
    listRuns: limit => rest(`/rest/v1/runs?select=*&order=created_at.desc&limit=${limit || 300}`),
  };
})();
