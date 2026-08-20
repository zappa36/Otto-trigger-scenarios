# Chat

_Started 2026-08-19 07:39 UTC_

---

## User

Continuing from "ETA accuracy tracking".

## Assistant

We were building a live delivery dashboard for ParcelVox (a voice-agent dispatch system) centered on ETA accuracy tracking and a real-geography Berlin map with route visualization.

Key decisions made:
- Dropped first-attempt success metric; ETA accuracy (84.6%) became the primary KPI, with notes on low performers (gate waits, bridge openings, loading zones).
- Chat as the primary pane, map as secondary — citywide Berlin view with all 8 routes visible.
- Switched from toy schematic to real geography (WGS84 Bezirk boundaries via m-hoerz/berlin-shapes) after discovering the d3 winding-order bug that collapsed the city to a dot.
- Simplified pin clutter: removed green/gray dots, kept only 9 amber "tips going stale" pins plus one special Otto-marked stop (Kranweg 12).
- All routes now radiate from Nordhaven depot (marked with a square).
- Differentiated chat speakers: green headset-person for the operator, Otto's gradient orb (navy pupils added) for the voice agent.
- Added three quick-action chips below Otto's responses.

Current state: ParcelVox Dashboard.html is a standalone 886 KB offline file with fonts, d3 runtime, and real Berlin geometry fully inlined. The map shows 12 districts, 8 routes fanning from the depot, selective amber pins, and Kranweg 12 marked with Otto's orb avatar. The chat has avatar icons for both speakers and quick actions. Everything is out for review.

No open steps pending — the dashboard is complete and exported.

Files involved: ParcelVox Dashboard.html (main export), berlin-map.html (map source), ParcelVox Dashboard.dc.html (design tool source).

