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

The bundler writes a second file, `dist/parcelvox-dashboard.artifact.html` — the
same page as a body fragment, for publishing to a Claude Artifact, which supplies
its own document wrapper. Deploy the first; publish the second.

## The six views

| View | What it does |
| --- | --- |
| **Map** (default) | Citywide Berlin view — all 8 routes fanning out from the Nordhaven depot, Rte 14 highlighted, amber pins on stops whose tips are going stale, and Kranweg 12 marked with Otto's orb. The Ask panel beside it is the primary pane. |
| **Routes** | Coverage, failed stops and ETA accuracy per route, with a note on every route that runs late. Rows open the route detail. |
| **Route detail** | Rte 14 stop by stop: tips on file, last confirmed, and the last four Mondays. |
| **Curation queue** | Tips from Otto debriefs awaiting review — approve, edit or reject. The nav badge tracks what is left. |
| **Drivers** | Contribution only: tips shared, tips accepted, routes covered. No pace, speed, or stops per hour. |
| **Analytics** | ETA accuracy, failed stops by cause, capture rate by route, tip freshness. |
| **Ask** | Plain-language questions answered from the approved knowledge base, by voice or text. |

## What is real and what is scripted

Everything on screen is fictional sample data — Nordhaven depot, its routes, drivers and stops do
not exist. Two things are genuinely live:

- **The map.** Real Berlin district geometry, projected with `d3-geo` and tilted back in CSS
  perspective; pins counter-rotate to stand upright on the plane. The geometry is vendored at
  `public/data/berliner-bezirke.geojson` — see its [attribution](public/data/ATTRIBUTION.md).
- **The interactions.** Nav, route drill-in, map tip-type filters, queue approve/edit/reject with
  undo, and both chat threads all work against local state.

**Otto's answers are scripted**, not generated — `src/data/chat.ts` matches a question to a canned
answer and falls back when nothing matches. The voice capture is a scripted transcript too; no
microphone is ever opened. The UI says so where a viewer could be misled.

## Layout

```
src/
  App.tsx              shell: left nav + view switch
  components/          BerlinMap, Chat bubbles, Composer, VoiceCapture, OttoOrb, Icons, EtaTrendChart
  views/               one file per view, each with its CSS module
  data/                sample content — routes, stops, queue, drivers, analytics, map geometry, chat script
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
