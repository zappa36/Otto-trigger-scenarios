'use strict';

/* ============================================================
 * Configuration.
 *
 * Everything is optional. With all of it empty the app still
 * runs the whole loop on-device: grid map backdrop, address
 * search via OpenStreetMap, destinations in localStorage, and
 * Otto as the scripted demo conversation.
 *
 * To go live you provide exactly three things:
 *   1. a Supabase project (URL + anon key below, schema.sql run
 *      once, both Edge Functions deployed),
 *   2. an OpenAI key — as the voice-note function's secret, so
 *      Otto really transcribes; it never reaches the browser,
 *   3. optionally a Google Maps browser key for the real map
 *      tiles (the grid works without it).
 * ============================================================ */

window.SUPABASE_URL = '';
window.SUPABASE_ANON_KEY = '';

/* Edge Function names (as deployed in Supabase). */
window.GEOCODE_FN = 'geocode';
window.VOICE_FN = 'voice-note';

/* Table Otto's structured messages are written to. */
window.VOICE_TABLE = 'messages';

/* Google Maps Platform browser key — client-side by design, restrict it
 * to this site's HTTP referrer. Enables the Maps JavaScript API (pan +
 * pinch) with the Static Maps image as fallback. Leave empty for the
 * grid backdrop. */
window.GMAPS_KEY = '';
