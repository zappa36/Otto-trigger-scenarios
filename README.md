# Destination debrief

One loop: **pin a real address on a live map → walk over → tell Otto what
you found.** Otto transcribes and structures the voice message, files it
against the destination, and the pin flips to reported.

On top of that loop sits a second surface,
[`dashboard.html`](dashboard.html): define **Otto trigger scenarios**
(straight out of the deck's "Otto triggers" sheet), give each one a clear
Google-Maps address, send a tester out to act it out, and compare what
Otto understood with what the scenario said should happen.

This is the original
[driversense_rewards](https://github.com/zappa36/driversense_rewards)
challenge flow with the economy removed. Kept and dropped, deliberately:

| | |
|---|---|
| ✓ Destination pins at real, geocoded addresses | ✗ Cash payout |
| ✓ Live map on the phone, GPS position | ✗ 2-device consensus |
| ✓ Otto voice debrief, structured messages | ✗ 75 m proximity gate |
| ✓ The satisfying pin flip (red → green ✓) | ✗ XP, levels, wallet |
| ✓ Distance to the destination on the card | |

The proximity gate existed so nobody could claim money without being on
site; with no money it is only friction, so the card *shows* distance but
never blocks the recording. To bring the gate back it is one line in
`openOtto` (`app.js`):

```js
if (Geo.position && distM(Geo.position, d) > 75) { /* show "get closer" */ return; }
```

## Try it

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Zero configuration runs the whole loop on-device: grid map backdrop,
address search via OpenStreetMap (or pasted coordinates), destinations in
localStorage, and Otto as the scripted demo — clearly labelled as such.
Open `http://localhost:8000/dashboard.html` for the scenarios dashboard —
in this mode both pages share the browser's localStorage and keep each
other fresh across tabs, so the whole define → test → compare loop can be
felt on one machine.

## The trigger-scenarios dashboard

`dashboard.html` is the test designer's surface; the phone app is the
tester's. One scenario is one row of the "Otto triggers" sheet — same
columns, same wording:

| # | Trigger scenario | Trigger rule (testable) | Activity Recognition states | Other signals needed | Timing to talk | Otto says | What Otto learns (tip type) | How to test it |
|---|---|---|---|---|---|---|---|---|

The loop:

1. **Define** — "+ New scenario", or copy rows straight out of the Excel
   sheet and use "Paste from Excel" (tab-separated clipboard rows, quoted
   multi-line cells and the header row both handled).
2. **Pin** — every scenario gets a clear Google-Maps address: search one,
   or paste coordinates ("52.5346, 13.4109"). The dashboard shows the
   address, its exact coordinates, and keyless **Open in Google Maps** /
   **Street View** links; the pin lands on the live map and on every
   tester's phone. A scenario without an address is flagged loudly —
   it cannot be tested.
3. **Test** — on the phone, the destination card carries the scenario's
   "how to test it" steps, and Otto opens the debrief with the scenario's
   own question (the "Otto says" column). The phone is the tester's
   surface only: destinations are defined and managed on the dashboard,
   and the phone's old add-a-destination sheet is gone.
4. **Compare** — the dashboard puts the definition (**defined — what
   should happen**) next to the messages Otto filed (**what Otto
   understood**: category, structured title, raw transcript). A category
   that matches the expected tip type is flagged `= EXPECTED TYPE`. Close
   the case with a **PASS / PARTIAL / FAIL** verdict per scenario.

Statuses roll up in the header and colour the pins: *needs address* →
*awaiting test* (red, like the phone) → *debriefed · n* (cyan) → verdict
(green / amber / orange).

Going live is the same story as the rest of the app: re-run
[`supabase/schema.sql`](supabase/schema.sql) (safe to re-run) to add the
`scenarios` table, and every phone sees the dashboard's pins. Worth doing
at the same time: set the voice function's `NOTE_CATEGORIES` secret to
your tip types (e.g. `PARKING,ACCESS,HAZARD,HOURS,INFO`) so Otto's
categories can line up with the "What Otto learns" column, and point
`ASSISTANT_BRIEF` at trigger debriefs.

## Activity recognition (and the Google AR API)

The deck's trigger rules are written against
[Google's Activity Recognition API](https://developers.google.com/location-context/activity-recognition)
— IN_VEHICLE, ON_FOOT, STILL and friends. That API lives in Google Play
Services, so it exists **on Android only**; a browser cannot call it.
[`activity-rec.js`](activity-rec.js) does the honest next-best thing and
keeps a seam open for the real one:

- **Same vocabulary, web signals.** GPS speed (its own `watchPosition`;
  the Geo kit stays untouched) plus accelerometer **step cadence** via
  `devicemotion` — the signal that separates a slow drive from a walk at
  the same speed — produce committed states with confidence and
  hysteresis: `IN_VEHICLE`, `ON_FOOT`, `STILL`, `UNKNOWN`. Red lights
  don't flip to STILL instantly, creeping traffic stays IN_VEHICLE.
  Every snapshot says `source: 'web'`, so nothing downstream mistakes
  the approximation for the real thing. (iOS asks for motion permission
  on the first tap; without it, states run on GPS speed alone.)

- **The real API plugs into the same seam — and the wrapper exists:**
  [`android/`](android/) is a small WebView app that loads the deployed
  site and pipes real Play Services detected activities into
  `ActivityRec.inject('IN_VEHICLE', 92)` (`source: 'native'`), which
  silences the web heuristic while fresh. The `android-apk` GitHub
  Action builds the installable APK on every push touching `android/` —
  see [`android/README.md`](android/README.md).
  `ActivityRec.feed({lat, lng, speed})` accepts fused-location fixes the
  same way — and also replays recorded routes, which is how the trigger
  detector is tested without a car.

- **Tracking a test.** "▶ Start test tracking" on a scenario card (or
  the AR chip in the HUD) arms it. The screen stays awake (wake lock),
  the chip shows the live state, and every debrief saved while tracking
  carries `ar_summary` ("IN_VEHICLE 4m → STILL 50s → ON_FOOT 1m") and
  the full `ar_trace` — shown on the dashboard right under what Otto
  understood, next to the scenario's expected AR states. Re-run
  `schema.sql` to add the two columns.

- **The map drives along.** While tracking, ActivityRec's continuous
  fixes feed the map: the position dot moves live (losing its stale
  grey), the card's distance readout updates, and a 🚗 marker rides your
  position while the state is IN_VEHICLE (🚶 on foot). Untracked, the
  map stays tap-to-refresh — continuous GPS is a deliberate,
  battery-honest choice you switch on per test.

- **The sample trigger actually runs.** While tracking, the phone
  detects the deck's scenario #1 for real: 2 slow passes inside ~150 m
  of the pin without stopping, then the stop, then moving again → the
  **OTTO TRIGGER FIRED** banner pops (with a buzz), tap it and Otto asks
  the scenario's question. The thresholds sit in one `TRIG` block at the
  top of `app.js` — the deck calls them drafts to tune, so they are
  plainly tunable. The card shows live progress ("TRACKING · 1 SLOW
  PASS · WAITING FOR YOUR STOP"), and the fired trigger is stamped into
  the message (`TRIGGER FIRED · 2 PASSES + STOP` on the dashboard).

## On your phone

GPS and the microphone both require **https** (or localhost). There is
no build step, so any static host serves the repo as-is.

**Vercel:** import this repository, set Framework Preset to **Other**
and leave Output Directory at the default — the site is the repo root,
and [`vercel.json`](vercel.json) supplies the build command (it only
injects the Maps key, see below). For **live Google map tiles**, add a
`GMAPS_BROWSER_KEY` environment variable (Project → Settings →
Environment Variables) holding a Maps key referrer-locked to your
domain — the same deploy-time injection `driversense_rewards` uses.
Without the variable the deploy still succeeds and the map stays on the
grid backdrop. Open the production URL
(`https://<project>.vercel.app`) on the phone; Chrome asks for location
on first use and for the mic on the first debrief.

**GitHub Pages** works the same way: Settings → Pages → Deploy from a
branch → `main` / (root).

For the backends to accept the page, add its origin to both Edge
Functions' `ALLOWED_ORIGINS` secret — use the **production** domain.
The check is an exact match, so Vercel's per-deployment preview URLs
(`<project>-<hash>-<team>.vercel.app`) will be rejected; on previews the
app simply stays in demo mode. Add a specific preview origin temporarily
if you need to test the live backend from one.

## Going live (real Otto, shared scenarios)

Three things to provide — none of them edits a file:
[`scripts/vercel-build.sh`](scripts/vercel-build.sh) injects every value
into `config.js` at deploy time from Vercel env vars, so the public repo
never carries them.

1. **Supabase project** — create a free project, run
   [`supabase/schema.sql`](supabase/schema.sql) once in the SQL editor,
   then add two Vercel env vars (Project Settings → Environment
   Variables, Production): `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   (both under Project Settings → API in Supabase) — and redeploy.
   Scenarios, pins and debriefs are then shared: define on the
   dashboard, every phone sees the same pins. Without these the app
   still runs, but each browser keeps its own localStorage copy.
2. **Both Edge Functions** — deploy
   [`voice-note`](supabase/functions/voice-note/index.ts) (Otto:
   transcription + structuring; needs the `OPENAI_API_KEY` secret) and
   [`geocode`](supabase/functions/geocode/index.ts) (worldwide address
   search + street names; needs `GMAPS_SERVER_KEY`). Set `ALLOWED_ORIGINS`
   on both. Optional persona tuning via `ASSISTANT_NAME`,
   `ASSISTANT_BRIEF`, `NOTE_CATEGORIES` — e.g.:

   ```sh
   supabase secrets set ASSISTANT_BRIEF="short observations about a destination they were sent to check (blocked entrances, construction, changed access, anything off)"
   ```
3. **Optionally a Google Maps browser key** for the real, pannable map:
   your position on live Google tiles, one-finger pan, pinch and
   scroll-wheel zoom (plus +/− buttons and the recenter button on the live
   map). The key never lives in the repo — same mechanism as
   `driversense_rewards`: `config.js` carries a `__GMAPS_KEY__`
   placeholder and the deploy injects the `GMAPS_BROWSER_KEY` env var
   (the build command in [`vercel.json`](vercel.json); it fails the
   build if the placeholder drifted, and ships keyless with a note when
   the variable is missing). Create the key in the Google Cloud console
   with **Maps JavaScript API**, **Maps Static API** and **Geocoding
   API** enabled (the third powers house-number address search), then
   lock it down — it is a public browser key by design, so the locks
   and the caps are the protection, not secrecy: restrict it to your
   site's HTTP referrer (the exact domain, never `*.vercel.app/*`),
   restrict it to those three APIs, cap each API's daily quota, and set
   a billing budget alert. Delete any older unrestricted key. Quick
   test without deploying: open the production site with
   `?gkey=YOUR_API_KEY` (a referrer-locked key works only on pages
   served from the allowed domain). Without a key the grid backdrop
   carries the pins — Directions and Street View still open the real
   Google Maps app either way, keyless, via the Maps URLs API.

## How it composes

The two extracted kits are used **verbatim** — byte-identical copies,
which is the point of having extracted them:

| From | Files | Provides |
|---|---|---|
| `voice-notes-kit` | `voice-note.js`, `voice-note.css`, `supabase/functions/voice-note/` | The Otto debrief |
| `field-map-kit` | `geolocate.js`, `field-map.js`, `field-map.css`, `supabase/functions/geocode/` | Position + live map |
| new | `app.js`, `index.html`, `backend.js`, `config.js`, `supabase/schema.sql` | Destinations, the card, the wiring |
| new | `dashboard.html`, `dashboard.js` | Trigger scenarios: define, pin, compare, verdict |

The dashboard composes through the same seams: `FieldMap.mount` draws the
scenario pins (status as `color`/`icon`), `Geo.simulate` centres the
desktop map on the scenarios (flagged, as always, as not a real fix), and
`Backend` gains the `scenarios` table alongside destinations and
messages. The scenario's destination is the join point — the messages
Otto files against it ARE "what Otto understood".

The composition happens entirely through the kits' public seams:

- `FieldMap.mount({ markers })` — destinations become pins; `reportedIds`
  drives the red→green flip through marker `color`/`icon`/`label`.
- `VoiceNote.mount({ context, greeting, extra, onSaved })` — `context()`
  names the current destination, `greeting()` frames the debrief around
  it, `extra()` stamps `destination_id` + reporter coordinates into the
  saved row, `onSaved` flips the pin.
- `backend.js` is the union of the two kits' backends (each widget expects
  a global `Backend` with its own methods) plus the
  `destinations`/`messages` tables.

## Things worth knowing

- **Demo messages are flagged.** A debrief completed in scripted mode
  still flips the pin so the loop can be felt end-to-end, but the message
  carries `demo: true` and is labelled `DEMO` in the card. Nothing counts
  it as real data.
- **Address search is time-boxed.** Every geocoder leg aborts after a few
  seconds and degrades to a hint that teaches the coordinate-paste path
  ("52.5346, 13.4109" — long-press a spot in Google Maps to copy). A
  lookup that hangs is worse than one that fails.
- **A stale GPS fix is visible.** Cached or simulated positions grey the
  device marker and say so in the chip; distance readouts from a stale fix
  are labelled.
- **Open RLS by default.** Same pilot trade-off as the kits — anyone with
  the page can write. The signed-in policy upgrade is commented at the
  bottom of `schema.sql`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Phone shell: map, HUD, card, Otto screen (pins come from the dashboard) |
| `app.js` | Destinations, messages, the card, Otto wiring |
| `dashboard.html` | Desktop shell: scenario list, map, form / address / import sheets |
| `dashboard.js` | Trigger scenarios: CRUD, Excel paste-import, address pinning, compare + verdict |
| `activity-rec.js` | Google-AR-style activity states from web signals; `inject()`/`feed()` seams for the real Android API |
| `backend.js` | Merged Supabase client for both kits + this app's tables |
| `config.js` | Keys — all optional; placeholders filled at deploy time |
| `vercel.json`, `scripts/vercel-build.sh` | Deploy-time injection of `GMAPS_BROWSER_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `voice-note.js/.css` | verbatim from voice-notes-kit |
| `geolocate.js`, `field-map.js/.css` | verbatim from field-map-kit |
| `supabase/schema.sql` | `destinations` + `messages` + `scenarios`, RLS |
| `supabase/functions/` | `voice-note` + `geocode`, verbatim from the kits |
