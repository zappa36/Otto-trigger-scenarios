# ParcelVox dispatcher dashboard

A desktop-first dashboard for ParcelVox, a route knowledge base: the curated record of how to
deliver to every stop — door codes, parking, elevator status, access quirks — owned by the depot
instead of living in drivers' heads. The user is a dispatch manager who wants to understand
delivery issues and improve delivery performance.

Built from the Claude Design handoff in [`project/`](project/); the intent behind it lives in the
transcripts in [`chats/`](chats/).

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve the built bundle
```

React 18 + TypeScript on Vite. Styling is CSS Modules over the token set in
`src/styles/tokens.css`; there is no CSS framework.

## How it ships

The surrounding repo is a flat static site — Vercel serves the root
(`outputDirectory: "."`) and its build script never runs npm. Rather than teach
that pipeline about Vite, the app is bundled into a single self-contained file
and committed at the repo root, where Vercel serves it like any other page.
`dashboard.html` links to it as **DISPATCHER ↗**.

So after changing anything in here, rebuild and copy the bundle up:

```bash
npm run build && node scripts/bundle-standalone.mjs
cp dist/parcelvox-dashboard.html ../parcelvox-dashboard.html
```

That trade is deliberate: a ~650 KB generated file lives in git, but the deploy
pipeline stays untouched and there is no build step to break. If the app ever
earns a real build on Vercel, delete the root copy and teach
`scripts/vercel-build.sh` to run the two commands above instead.

The deployed page shape also carries `<script src="config.js"></script>`, so the
same deploy-time-injected Supabase values the phone and the trigger dashboard read
reach this page too — that is the whole live hookup
([details](#connected-to-the-real-app-map-and-notes)). Locally the placeholders
leave it keyless and the store is the shared localStorage instead.

The bundler writes a second file, `dist/parcelvox-dashboard.artifact.html` — the
same page as a body fragment, for publishing to a Claude Artifact, which supplies
its own document wrapper. Deploy the first; publish the second (it has no
`config.js` and stays in sample mode by design).

## The six views

| View | What it does |
| --- | --- |
| **Map** (default) | Live when the surrounding app has stops on file: the real destinations from the shared store, framed on the data — route lines in driving order, amber pins where pre-arrival notes wait, green where a driver debriefed; click a stop to read and edit its notes ([see below](#connected-to-the-real-app-map-and-notes)). Empty store → the fictional citywide sample: all 8 routes fanning out from the Nordhaven depot, Rte 14 highlighted, Kranweg 12 marked with Otto's orb. The Ask panel beside it is the primary pane either way. |
| **Routes** | Coverage, failed stops and ETA accuracy per route, with a note on every route that runs late. Rows open the route detail. |
| **Route detail** | Rte 14 stop by stop: tips on file, last confirmed, and the last four Mondays. |
| **Curation queue** | Tips from Otto debriefs awaiting review — approve, edit or reject. The nav badge tracks what is left. |
| **Drivers** | Contribution only: tips shared, tips accepted, routes covered. No pace, speed, or stops per hour. |
| **Analytics** | ETA accuracy, failed stops by cause, capture rate by route, tip freshness. |
| **Ask** | Plain-language questions answered from the approved knowledge base, by voice or text. |

## Connected to the real app: map and notes

The two surfaces around this repo — the phone (`index.html`) and the trigger-scenarios dashboard
(`dashboard.html`) — share one store of destinations and pre-arrival notes. The dispatcher
dashboard's **Map view reads and writes that same store**, through `src/otto/depot.ts`, which
mirrors the app's `backend.js` and decides once at load:

- **Supabase**, when the deployed page carries real values in `config.js` (the standalone bundle
  loads it from its own origin; deploy-time injection fills it — see [How it ships](#how-it-ships)).
  Reads poll every 30 s, REST only, exactly like `dashboard.js`; writes `PATCH` the
  `destinations` row.
- **localStorage** otherwise, under the same keys the other two pages use (`od_destinations` /
  `od_messages`). Same origin means same store: load the Schöneberg demo route on
  `dashboard.html` and this map goes live off the storage event, no reload.

With stops on file, the map frames itself on the data and draws the real thing: route lines in
driving order, flat dots for plain stops (green once a driver has debriefed), standing **amber
pins where pre-arrival notes are on file**. Click any stop and the **stop panel** opens — every
parcel behind that door, its consignee and floor (editable), the dispatch notes Otto reads aloud
on approach (add and remove them right here), and the latest real driver debriefs, read-only. A
note added here is read out on the driver's phone on its next approach.

The map moves: drag to pan, scroll to zoom, `+` / `−` / `⌖` controls. Every stop is drawn
wherever it is — a Natural Earth countries backdrop (see
[attribution](public/data/ATTRIBUTION.md)) takes over from the Bezirk detail once the camera
leaves Berlin, so pins in another city or country sit on real land, not in a void. The default
view frames the main cluster (outliers are clipped from the automatic fit); when stops sit
outside the current view, a **"n stops beyond this view — show all"** pill jumps out far enough
to see everything at once, and the zoom-out floor always reaches that far.

An empty store is not an error: the map falls back to the fictional sample below, labelled as
such. The artifact build ships no `config.js` and stays on the sample by design.

## What is real and what is scripted

Beyond the [live map and notes](#connected-to-the-real-app-map-and-notes), everything on screen is
fictional sample data — Nordhaven depot, its routes, drivers and stops do not exist. Two more
things are genuinely live:

- **The map geometry.** Real Berlin district shapes, projected with `d3-geo` and tilted back in
  CSS perspective; pins counter-rotate to stand upright on the plane. The geometry is vendored at
  `public/data/berliner-bezirke.geojson` — see its [attribution](public/data/ATTRIBUTION.md).
- **The interactions.** Nav, route drill-in, map filters, queue approve/edit/reject with
  undo, and both chat threads all work against local state.

**Otto's answers are scripted**, not generated — `src/data/chat.ts` matches a question to a canned
answer and falls back when nothing matches. The voice capture is a scripted transcript too; no
microphone is ever opened. The UI says so where a viewer could be misled — in live mode the Ask
panel labels itself a scripted demo, and the sidebar chip says which parts are real.

## Layout

```
src/
  App.tsx              shell: left nav + view switch
  components/          BerlinMap, StopPanel (the live stop sheet), Chat bubbles, Composer, VoiceCapture, OttoOrb, Icons, EtaTrendChart
  views/               one file per view, each with its CSS module
  data/                sample content — routes, stops, queue, drivers, analytics, map geometry, chat script
  otto/                the wire to the real app: depot.ts (shared store, Supabase / localStorage), doors.ts (door + route grouping), useDepot
  hooks/               useOttoThread (scripted conversation), useVoiceCapture (timer + partial transcript)
  state/               useCurationQueue (review state behind the nav badge)
  styles/              tokens.css (palette, type, motion) and shared.module.css (cards, tables, chips, meters)
```

## Design source

- `project/ParcelVox Dashboard.dc.html` — the design that was implemented
- `project/berlin-map.html` — the map prototype the `BerlinMap` component reproduces
- `project/HANDOFF-README.md` — the original handoff instructions
- `chats/` — the design conversations, including the decisions that shaped it (ETA accuracy over
  first-attempt success, real geography over a schematic, chat as the primary pane)

Two things were open in the handoff and have been settled here: Analytics ships **candidate A, the
overview grid** (candidate B and its A/B switcher are dropped), and all route rows open the Rte 14
detail, as the design's own footnote states.
