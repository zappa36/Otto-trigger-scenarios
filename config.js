'use strict';

/* ============================================================
 * Configuration.
 *
 * Everything is optional. With all of it empty the app still
 * runs the whole loop on-device: grid map backdrop, address
 * search via OpenStreetMap, scenarios in localStorage (each
 * browser its own), and Otto as the scripted demo conversation.
 *
 * Nothing is edited here to go live — every value is injected at
 * deploy time from Vercel env vars by scripts/vercel-build.sh:
 *   1. SUPABASE_URL + SUPABASE_ANON_KEY — a Supabase project with
 *      schema.sql run once; scenarios, pins and debriefs are then
 *      shared between the dashboard and every phone,
 *   2. GMAPS_BROWSER_KEY — live Google map tiles + house-number
 *      address search,
 *   3. an OpenAI key — as the voice-note Edge Function's secret,
 *      so Otto really transcribes; it never reaches the browser,
 *   4. ELEVENLABS_AGENT_ID — Otto becomes a live conversation with
 *      your own ElevenLabs agent instead of one clip at a time.
 * (The anon key and the Maps key are public in the browser by
 * design — RLS and key restrictions are the protection. The
 * env-var path keeps them out of the git history.)
 * ============================================================ */

window.SUPABASE_URL = '__SUPABASE_URL__';
window.SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';
if (String(window.SUPABASE_URL).slice(0, 2) === '__') window.SUPABASE_URL = ''; /* placeholder -> local demo mode */
if (String(window.SUPABASE_ANON_KEY).slice(0, 2) === '__') window.SUPABASE_ANON_KEY = '';

/* Edge Function names (as deployed in Supabase). */
window.GEOCODE_FN = 'geocode';
window.VOICE_FN = 'voice-note';
window.SCENARIO_AI_FN = 'scenario-ai';
window.ELEVENLABS_TOKEN_FN = 'elevenlabs-token';

/* ElevenLabs Conversational AI agent — Otto as a real conversation
 * instead of one recorded clip at a time (otto-agent.js). Injected at
 * deploy time from the ELEVENLABS_AGENT_ID env var.
 *
 * The agent id is NOT a secret: a public agent connects with it alone
 * from the browser, which is how conversational widgets work everywhere.
 * A PRIVATE agent additionally needs the elevenlabs-token Edge Function
 * (holding the ELEVENLABS_API_KEY secret) to sign each conversation —
 * the API key never reaches a phone either way.
 *
 * Empty -> Otto stays the recorded debrief; everything still runs.
 * Quick test without deploying: open any page with ?agent=AGENT_ID
 * (and ?noagent=1 forces the recorded debrief back). */
window.ELEVENLABS_AGENT_ID = '__ELEVENLABS_AGENT_ID__';
if (String(window.ELEVENLABS_AGENT_ID).slice(0, 2) === '__') window.ELEVENLABS_AGENT_ID = '';
window.OTTO_AGENT = 'auto'; /* 'off' pins every debrief to the recorder */

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

/* Deploy stamp (UTC date.time-commit), shown in both UIs so a tester can
 * tell at a glance which build they are on. Locally: 'dev'. */
window.BUILD = '__BUILD__';
if (String(window.BUILD).slice(0, 2) === '__') window.BUILD = 'dev';
