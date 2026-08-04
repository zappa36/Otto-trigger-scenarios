# Destination debrief

One loop: **pin a real address on a live map → walk over → tell Otto what
you found.** Otto transcribes and structures the voice message, files it
against the destination, and the pin flips to reported.

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

## On your phone

GPS and the microphone both require **https** (or localhost). There is
no build step, so any static host serves the repo as-is.

**Vercel:** import this repository, set Framework Preset to **Other**,
leave Build Command empty and Output Directory at the default — the site
is the repo root. Open the production URL
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

## Going live (real Otto, shared destinations)

Three things to provide, all server-side:

1. **Supabase project** — run [`supabase/schema.sql`](supabase/schema.sql)
   in the SQL editor, copy the Project URL + anon key into
   [`config.js`](config.js). Destinations and messages are then shared
   between phones instead of per-device.
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
3. **Optionally a Google Maps browser key** in `config.js` for real map
   tiles (JS API with Static Maps fallback). Without it the grid backdrop
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
| `index.html` | Phone shell: map, HUD, add-sheet, card, Otto screen |
| `app.js` | Destinations, messages, the card, Otto wiring |
| `backend.js` | Merged Supabase client for both kits + this app's tables |
| `config.js` | Keys — all optional |
| `voice-note.js/.css` | verbatim from voice-notes-kit |
| `geolocate.js`, `field-map.js/.css` | verbatim from field-map-kit |
| `supabase/schema.sql` | `destinations` + `messages`, RLS |
| `supabase/functions/` | `voice-note` + `geocode`, verbatim from the kits |
