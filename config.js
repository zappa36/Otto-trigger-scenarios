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

/* Google Maps Platform key — same mechanism as driversense_rewards:
 * injected at deploy time from the GMAPS_BROWSER_KEY env var (the build
 * command in vercel.json does the substitution), so no real key ever
 * lives in the repo and secret scanning stays quiet. On the deployed
 * site it is still a PUBLIC browser key (that is how Maps in the browser
 * works — anyone can read it with F12); protection comes from the
 * HTTP-referrer restriction and daily quota caps in the Google Cloud
 * console, never from secrecy.
 * Local clones keep the placeholder and simply run keyless: grid
 * backdrop instead of live Google tiles. Quick test without deploying:
 * open any page with ?gkey=YOUR_API_KEY. */
window.GMAPS_KEY = '__GMAPS_KEY__';
if (String(window.GMAPS_KEY).slice(0, 2) === '__') window.GMAPS_KEY = ''; /* placeholder -> keyless */
window.GMAPS_KEY = new URLSearchParams(location.search).get('gkey') || window.GMAPS_KEY;
