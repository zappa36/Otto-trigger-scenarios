# The driver demo video

[`otto-driver-demo.mp4`](otto-driver-demo.mp4) — two and a half minutes of
**how a driver interacts with Otto**, screen-captured from the real phone
app (`index.html`) running keyless, exactly as `python3 -m http.server`
serves it. One take, one story — starter-sheet scenario **#1 · Parking
loops**, pinned at Akazienstraße 15 (a real stop from the repo's
Schöneberg demo route):

1. **The approach** — Otto reads the pre-arrival notes aloud as the van
   crosses the reading ring: consignee, floor, the dispatch note about
   the bell panel.
2. **The card** — the stop's scenario brief, and one tap on
   **▶ Start test tracking**. That is the driver's last tap for a while.
3. **The pattern** — two slow loops past the door, counted live by the
   trigger detector; then the stop, then wheels turning again —
4. **The debrief** — Otto opens by himself and asks the sheet's own
   question (*"Is it hard to park here at this time? Where did you find
   a spot?"*), the mic opens itself, the driver just talks. The answer
   comes back transcribed, structured, and filed: `1 NOTE SAVED · ACCESS`.
5. **The record** — the pin flips green, the run verdict takes one tap
   (*✓ Right timing*).
6. **The payoff** — next tour, different driver, same address: Otto's
   briefing now ends with *"A driver reported: Loading bay behind the
   bakery (Belziger corner) is free after 18:00 — park there and walk."*

## What is real, what is staged

Everything on screen is the app itself, untouched. The harness stages
the run through the app's own seams, and the corner badge in the video
says so on every frame:

| Real | Staged |
|---|---|
| The whole UI: map, HUD, card, banners, Otto screen, verdict bar | The GPS trace — a scripted drive pushed through `ActivityRec.feed()`, the seam built for replaying routes; fix timestamps run ahead of wall time, so five minutes of driving fit the video like a time-lapse (the detector still sees the full five minutes) |
| The trigger detector counting passes, dwell and resume — the same code a field test runs | `speechSynthesis` — replaced by a silent stand-in that paces like speech and mirrors every line Otto actually speaks into the caption bar (no audio track; most demo viewers are muted anyway) |
| The debrief flow: auto-opened Otto, spoken question, self-opening mic, structured note, pin flip, verdict | The transcription backend — a shim answering with the driver's scripted reply, so the video shows the **live** hands-free flow a deployed build has (keyless clones fall back to the labelled scripted demo instead) |
| The scenario definition — row 1 of `trigger-scenarios.js`, verbatim | The dispatch note and the driver's answer — invented test data, like everything in the kit |

## Regenerate it

```sh
node demo/record-driver-demo.mjs
```

Needs Playwright's Chromium (`npx playwright install chromium` if you
don't have it) and writes `otto-driver-demo.webm` next to this file,
plus `otto-driver-demo.mp4` when an ffmpeg with libx264 is found
(`pip install imageio-ffmpeg` provides one). The script serves the repo
on `127.0.0.1:8123`, blocks every other network request, and drives the
whole take deterministically — edit the `DRIVE` legs, the `ANSWER`, or
the captions and re-run.
