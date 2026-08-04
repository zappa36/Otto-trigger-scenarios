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
  async function fn(name, body) {
    const r = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
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
    deleteDestination: id => rest('/rest/v1/destinations?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }),
    listMessages: limit => rest(`/rest/v1/${table}?select=*&order=created_at.desc&limit=${limit || 500}`),
  };
})();
