# Destination debrief

One loop: **pin a real address on a live map → walk over → tell Otto what
you found.** Otto transcribes and structures the voice message, files it
against the destination, and the pin flips to reported.

On top of that loop sits a second surface,
[`dashboard.html`](dashboard.html): define **Otto trigger scenarios**
(straight out of the deck's "Otto triggers" sheet), give each one a clear
Google-Maps address, send a tester out to act it out, and compare what
Otto understood with what the scenario said should happen. Point
`ELEVENLABS_AGENT_ID` at your own agent and Otto stops being a recorder
and becomes a conversation — [with the scenario as its
context](#otto-as-your-elevenlabs-agent).

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

## The tuning loop (describe → draft → test → feedback → v2)

The end goal of all this testing is an **algorithm per scenario** —
trigger rules with numbers that survived contact with reality. The
dashboard runs that loop end to end:

1. **Describe.** In "+ New scenario", write what happens in your own
   words and hit **✨ Draft the fields** — every sheet column is filled
   in, and every number in the rule is extracted as a **tunable value**
   (`{radius}`-style placeholder + value/min/max/unit). With the
   `scenario-ai` Edge Function deployed that is a real AI draft — hard
   grounding rules keep it about exactly what was described, and a
   too-short description gets called out rather than guessed around;
   without the function, a built-in archetype template (parking loops,
   entrance hunt, long wait, blocked route, generic dwell) — labelled as
   a demo draft, like everything scripted in this kit. Either way the
   draft lands in the form to be edited before saving. The **test
   address is set right in the form** (search or paste coordinates; an
   address mentioned in the description comes back as a search to
   confirm) — the separate picker only pops up if it was skipped.
2. **Tune with sliders.** An expanded scenario shows its tunable values
   as sliders; the rule text follows the drag live. Params whose keys
   match the detector's (`radius`, `passes_needed`, `stop_dwell_s`, …)
   **drive the phone's live trigger detector on the next run** — the
   `TRIG` defaults in `app.js` are only the fallback. Saving a drag cuts
   a new version with an auto-changelog ("Tuned: Pass radius
   150→120 m").
3. **Leave feedback by voice.** After a run, **🎙 Record test feedback**
   on the scenario: with the backend live the clip is transcribed by the
   voice function; keyless, the browser's own on-device speech
   recognition types along (or just type). The note is stored against
   the version it commented on.
4. **A new version is proposed.** Saved feedback comes straight back as
   a **proposed vN+1** — changed fields and moved values shown as an
   editable old→new diff with a changelog note. Live, that is the AI
   reading your feedback plus the recent debrief results; keyless, a
   labelled heuristic (explicit numbers like "make it 80 m" move the
   nearest matching value; "never fired" / "fired too often" nudge the
   thresholds). Apply it (or discard — the feedback stays on record).
5. **The trail is the record.** Every scenario carries its version chip,
   the full history with per-version notes (any version can be
   restored), and which feedback went into which version. Debriefs are
   stamped with the scenario version *and* the exact detector values the
   run used, so results stay comparable across versions. And every
   tracked run is logged **even when nothing fires** — the dashboard's
   run log says which stage it died at ("1 PASS · NO STOP", "STOP SEEN ·
   NEVER RESUMED"), under which knob values, with the observed activity
   trace; the status badge flips to "RAN n× · NO FIRE" so a silent test
   is never mistaken for no test. (Runs land in the `runs` table —
   re-run `schema.sql` once to create it.)
6. **Export the algorithm.** **Spec JSON ⇩** on a scenario (or **⇩
   SPECS** in the header for all of them) downloads the machine-readable
   spec: resolved rule, tuned params with their ranges, version history,
   feedback trail, and every structured test result — ready to hand to
   whoever builds the production trigger.

### Replay runs offline, tune on the record

Every tracked run also records its **raw fix stream** (`runs.fixes`:
position, speed and AR state at ~1 Hz, downsampled on long runs) — what
the detector *saw*, where `ar_trace` only says what it concluded. And
the moment tracking stops, the phone asks the tester for **the verdict
while the run is still fresh** — one tap, skippable. A run where Otto
spoke gets the timing question (*"how was his timing?"* — ✓ right
timing / ⏱ too early / ⏱ too late / ✗ false alarm); a silent run gets
✓ right call / ✗ should have spoken. The answer lands on the run
(`runs.verdict` + `runs.should_fire`) and shows on the dashboard's run
log as a chip. Together the two are ground truth: what was seen, plus
what should have happened *and when* — collected in the field, judged
in the field, nothing to remember later.

[`scripts/tune_triggers.py`](scripts/tune_triggers.py) (standard-library
Python — like the rest of the kit, no dependencies) then runs the whole
tuning loop on that record instead of another drive:

```sh
# does the offline port agree with what the phone did? (run this first)
python3 scripts/tune_triggers.py --url https://XYZ.supabase.co --key ANON_KEY

# search the knob space against the field verdicts; smallest change wins
python3 scripts/tune_triggers.py --url ... --key ... --search 3000 --out tuned.json

# verdicts skipped or fat-fingered in the field? correct them in a CSV
python3 scripts/tune_triggers.py --url ... --key ... --emit-labels labels.csv
python3 scripts/tune_triggers.py --url ... --key ... --labels labels.csv --search 3000
```

The search stays inside each scenario's slider ranges, reports
before/after accuracy per scenario ("1/2 → 2/2 correct ·
`stop_dwell_s: 45 → 67`"), and writes `tuned.json` in the dashboard's
own params shape. Deliberately minimal: it prefers the smallest change
that fits the verdicts, so what comes out reads like a changelog entry,
not a black box. A handful of judged runs per scenario is enough to
start — and the same fix streams are the training data for anything
more ambitious later (a learned trigger model needs exactly this
record). Runs logged before the `fixes` column are skipped with a
count.

Going live is the same story as the rest of the app: re-run
[`supabase/schema.sql`](supabase/schema.sql) (safe to re-run — it adds
the `scenarios` table, the tuning-loop columns and the pre-arrival
notes columns), and deploy
[`scenario-ai`](supabase/functions/scenario-ai/index.ts) next to
`voice-note` (same `OPENAI_API_KEY` and `ALLOWED_ORIGINS` secrets) for
real drafts and revisions. Worth doing at the same time: set the voice
function's `NOTE_CATEGORIES` secret to your tip types (e.g.
`PARKING,ACCESS,HAZARD,HOURS,INFO`) so Otto's categories can line up
with the "What Otto learns" column, and point `ASSISTANT_BRIEF` at
trigger debriefs — `scenario-ai` reads `NOTE_CATEGORIES` too, so drafted
scenarios expect tip types Otto can actually file.

## Otto as your ElevenLabs agent

A one-shot voice note cannot ask a follow-up, and a trigger scenario is
exactly the situation where the follow-up is the point ("you circled
twice and then parked 200 m away — what stopped you getting closer?").
Point the app at an [ElevenLabs Conversational
AI](https://elevenlabs.io/docs/agents-platform/overview) agent and the
debrief becomes a real conversation: the agent's voice out, the phone's
mic in, both interruptible, ended by the tester or by the agent.

Set one environment variable and redeploy:

| Variable | Where | What |
|---|---|---|
| `ELEVENLABS_AGENT_ID` | Vercel env vars | your agent's id — that is the whole setup for a **public** agent |
| `ELEVENLABS_API_KEY` | the `elevenlabs-token` function's secrets | only for a **private** agent; the key never reaches a phone |

Then deploy
[`elevenlabs-token`](supabase/functions/elevenlabs-token/index.ts) if the
agent is private (same `ALLOWED_ORIGINS` secret as the others; set
`ELEVENLABS_AGENT_ID` on it too and the function can only ever sign
conversations for that one agent), and re-run
[`schema.sql`](supabase/schema.sql) for the two columns that hold the
conversation. Quick test without deploying anything: open the phone page
with `?agent=YOUR_AGENT_ID` (and `?noagent=1` forces the recorded
debrief back). The mic self-test behind the version chip names which
Otto the phone will actually open.

**The scenario is what the agent is told about**, in three layers, so it
works whether or not the agent's prompt was written for this app:

1. **Dynamic variables** — reference them in your prompt as
   `{{scenario_rule}}`, `{{expected_tip_type}}`, `{{park_distance_m}}`
   and so on. The full set is `destination_title`,
   `destination_address`, `destination_lat/lng`,
   `destination_consignee`, `destination_floor`, `destination_notes`
   (the [pre-arrival notes](#pre-arrival-notes--otto-reads-before-you-arrive)
   on file), `scenario_num`,
   `scenario_title`, `scenario_version`, `scenario_question`,
   `scenario_rule`, `scenario_ar_states`, `scenario_signals`,
   `scenario_timing`, `scenario_test_steps`, `expected_tip_type`,
   `trigger_fired`, `trigger_passes`, `trigger_stopped`,
   `park_distance_m`, `walk_m`, `distance_to_pin_m`, `activity_state`,
   `activity_summary`. Rules arrive with their tuned numbers already
   filled in, and every measurement is what *this* run measured.
2. **A contextual update** — the same briefing in plain sentences, sent
   as the conversation opens, so an agent whose prompt names none of
   those variables still knows which test just fired.
3. **The first message** — the sheet's "Otto says" column, verbatim.
   This is the *only* override sent: your prompt, voice, tools and
   knowledge base are left exactly as you built them. (It needs
   "first message" enabled under the agent's security → overrides
   settings; if it is not, the session reconnects once without it and
   the agent opens in its own words.)

What comes back is the same debrief as before: the tester's side of the
conversation is the transcript, structured into the same title +
category the dashboard matches against the expected tip type, filed
against the pin, flipping it green. The dashboard marks it `◆ AGENT` and
carries the whole exchange turn by turn under **the conversation** —
what Otto had to *ask* to get the answer is half of what a trigger
scenario is being tested for, and it rides along into the exported
spec JSON.

Everything degrades the way the rest of the kit does. No agent id → the
recorded debrief, unchanged. Agent configured but unreachable → the
conversation hands over to the recorded debrief in place, mid-screen,
and a fired trigger still gets its spoken question. No Supabase → the
conversation still runs (the agent id is a browser credential by
design); only the structuring and the shared row are missing, and the
debrief is saved locally with its own first sentence as the title.

Two things it does on purpose: it asks for the microphone at **"Start
test tracking"**, not when the trigger fires — a permission dialog
raised in traffic is a debrief lost — and it ends a conversation by
itself after five minutes, or ninety seconds of silence, because both
ends of that wire are metered by the minute.

## Pre-arrival notes — Otto reads before you arrive

A note that has to be read off a screen at the door helps nobody in
traffic. So when a destination has notes on file, **Otto reads them
aloud on the way in** — once, hands-free, the first time the phone
comes within ~350 m of the pin (the `NOTES` block in `app.js`; driving
back out past ~700 m re-arms it, so a new approach is a new reading):

> "Heads up — Kollwitzstraße 18, about 300 meters ahead. Delivery is
> for Maria Weber, floor 4. From dispatch: the elevator is broken, use
> the stairs. A driver reported: entrance blocked — use the side door."

Three kinds of notes feed that briefing, in that order:

- **Consignee details** — name and floor/unit, set in the dashboard's
  **PRE-ARRIVAL NOTES** block on any pinned scenario (they live on the
  destination row).
- **Dispatcher notes** — free-text building notes ("the elevator is
  broken"), added and removed in the same block. Newest first; the
  newest three are read.
- **What other drivers found** — the latest two real debriefs already
  filed against the pin: the structured title where Otto made one, the
  raw words otherwise. Demo debriefs stay out, as everywhere — nothing
  counts them as real data.

The reading uses the same keyless browser speech as the sample trigger
(the Android wrapper's own TTS when installed), with a banner as the
visual record — tap it to open the card, ✕ to stop the reading
mid-sentence. The destination card shows the same notes under
**PRE-ARRIVAL NOTES** with a 🔊 replay button for the kerb. A fired
trigger or an open debrief always outranks a reading. And with
[Otto as an ElevenLabs agent](#otto-as-your-elevenlabs-agent), the
debrief that follows knows what was read on the way in
(`{{destination_consignee}}`, `{{destination_floor}}`,
`{{destination_notes}}`, plus a line in the contextual update), so it
can follow up on the notes instead of hearing about them cold.

Approaches are judged on fresh fixes only — the continuous stream
while activity recognition is armed (it arms itself at app open), the
Geo kit's one-shot fixes otherwise; a cached position never narrates
an approach that happened an hour ago. Live, the notes ride the
`destinations` row (re-run `schema.sql` once for the three columns —
`consignee`, `floor`, `notes`) and land in the exported spec JSON;
keyless, localStorage — the dashboard and the phone keep each other
fresh the same way scenarios do.

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
  position while the state is IN_VEHICLE (🚶 on foot). Activity
  recognition arms itself at app open (testers kept walking with it
  off); the AR chip toggles it off in one tap when battery matters.

- **The sample trigger actually runs.** While tracking, the phone
  detects the deck's scenario #1 for real: 2 slow passes inside ~150 m
  of the pin without stopping, then the stop, then moving again → the
  phone buzzes and **Otto opens by himself**, asks the scenario's
  question out loud (browser speech synthesis, keyless) and starts
  listening the moment he finishes; the answer sends itself after a
  clear pause (say "stop" and fall quiet, or just pause) and Otto
  speaks his reply too — a fully hands-free debrief. With an
  [ElevenLabs agent configured](#otto-as-your-elevenlabs-agent) the same
  fired trigger opens a live conversation instead, in your agent's own
  voice, and the follow-ups are real. The thresholds sit in one `TRIG` block at the
  top of `app.js` — the deck calls them drafts to tune, and tuned they
  are: a scenario's params (the dashboard's sliders) override any of
  them per test run, `TRIG` is only the fallback. The card shows live
  progress ("TRACKING · 1 SLOW PASS · WAITING FOR YOUR STOP"), and the
  fired trigger is stamped into the message with the scenario version
  and the exact values the run used (`TRIGGER FIRED · 2 PASSES + STOP ·
  v2` on the dashboard).

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
2. **The Edge Functions** — deploy
   [`voice-note`](supabase/functions/voice-note/index.ts) (Otto:
   transcription + structuring; needs the `OPENAI_API_KEY` secret),
   [`geocode`](supabase/functions/geocode/index.ts) (worldwide address
   search + street names; needs `GMAPS_SERVER_KEY`) and
   [`scenario-ai`](supabase/functions/scenario-ai/index.ts) (the
   dashboard's describe→draft and feedback→new-version loop; shares
   `OPENAI_API_KEY`) — plus
   [`elevenlabs-token`](supabase/functions/elevenlabs-token/index.ts) if
   Otto is a private ElevenLabs agent (see above; a public agent needs
   no function at all). Set `ALLOWED_ORIGINS` on all of them. Optional
   persona tuning via `ASSISTANT_NAME`, `ASSISTANT_BRIEF`,
   `NOTE_CATEGORIES` — e.g.:

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

The two extracted kits arrived as byte-identical copies. `field-map-kit`
still is one; `voice-notes-kit` has since grown one field-driven
extension here: **hands-free stop** — the recording watches its own
level and a clear pause after speech sends the clip (say "stop" and
fall quiet, or just pause; the function strips the trailing control
word). Everything else is the kit as extracted:

| From | Files | Provides |
|---|---|---|
| `voice-notes-kit` | `voice-note.js`, `voice-note.css`, `supabase/functions/voice-note/` | The Otto debrief (+ hands-free stop, added here) |
| `field-map-kit` | `geolocate.js`, `field-map.js`, `field-map.css`, `supabase/functions/geocode/` | Position + live map |
| new | `app.js`, `index.html`, `backend.js`, `config.js`, `supabase/schema.sql` | Destinations, the card, the wiring |
| new | `dashboard.html`, `dashboard.js`, `supabase/functions/scenario-ai/` | Trigger scenarios: define, pin, compare, verdict — and the tuning loop (draft, sliders, feedback, versions, spec export) |
| new | `otto-agent.js`, `supabase/functions/elevenlabs-token/` | Otto as your own ElevenLabs agent: the same debrief as a live conversation, with the scenario as its context |

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
| `otto-agent.js` | Otto as a live ElevenLabs agent conversation — the kit's mount seams over a WebSocket, with the scenario as its context |
| `dashboard.html` | Desktop shell: scenario list, map, form / address / import sheets |
| `dashboard.js` | Trigger scenarios: CRUD, describe→draft, tunable-value sliders, voice feedback → proposed versions, history, spec export, Excel paste-import, address pinning, compare + verdict |
| `activity-rec.js` | Google-AR-style activity states from web signals; `inject()`/`feed()` seams for the real Android API |
| `backend.js` | Merged Supabase client for both kits + this app's tables |
| `config.js` | Keys — all optional; placeholders filled at deploy time |
| `vercel.json`, `scripts/vercel-build.sh` | Deploy-time injection of `GMAPS_BROWSER_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `voice-note.js/.css` | from voice-notes-kit + hands-free pause-to-send |
| `geolocate.js`, `field-map.js/.css` | verbatim from field-map-kit |
| `supabase/schema.sql` | `destinations` (incl. pre-arrival notes: consignee / floor / dispatcher notes) + `messages` (incl. the agent conversation) + `scenarios` (incl. params / versions / feedback), RLS |
| `supabase/functions/` | `voice-note` (kit + trailing-"stop" strip + a text path for agent conversations) + `geocode` (verbatim) + `scenario-ai` (draft & revise) + `elevenlabs-token` (signed URLs for a private agent) |
