# Parcelvox Analytics API — mock

A working stand-in for the analytics read surface described in the CTO's
contract (`GET /v1/analytics/…`). Nothing here is the real backend; it is
the contract turned into a server so the dispatcher dashboard can be built
against it today and swapped to the real base URL later, unchanged.

Two kinds of data come out of it, always tellable apart:

- **Real** — the rows the Otto phone and the trigger-scenarios dashboard
  write to the shared Supabase store, reshaped into the contract: every
  door on file is a **place**, every debrief a **report**, every dispatch
  note **guidance**, every walk with ✓ Delivered taps a **tour**, every
  tracked trigger run an **outreach** row and a **gap alert**. One real
  driver: the tester (`real_driver.name` in `seed.json`).
- **Invented** — the history one tester cannot have produced: a small crew
  of drivers who have been working the routes on file for the last 90
  days, with completed stops, dwell times, reports, outreach and gap
  alerts. Deterministic from `seed.json`, so ids and numbers are stable
  across restarts. Every invented row carries `"invented": true`.

## Run it

```sh
cd mock-api
node server.mjs            # http://localhost:8787/v1/analytics — reads the shared store
```

No dependencies; Node 20 or newer. The status page at
<http://localhost:8787/> says what is loaded, real versus invented counts,
and the key. The store is re-read every minute, so a debrief recorded on the
phone shows up within a minute.

```sh
curl -H "Authorization: Bearer pvx_dev_analytics_read" \
  "http://localhost:8787/v1/analytics/places?from=2026-06-01T00:00:00Z&to=2026-12-31T00:00:00Z&bbox=13.40,52.52,13.43,52.55"
```

Settings (env vars override `seed.json`):

| Setting | Env | Default | Meaning |
|---|---|---|---|
| port | `PORT` | 8787 | |
| keys | `MOCK_API_KEYS` | `pvx_dev_analytics_read` | comma-separated; a key starting with `demo_` or `sdk_` answers `403 scope_denied`, as the contract says |
| latency | `MOCK_LATENCY` | `200-800` | ms range added to every answer; `0` for tests |
| store | `MOCK_SUPABASE_URL`, `MOCK_SUPABASE_ANON_KEY` | the kit's project | where the real rows come from |
| fixture | `MOCK_FIXTURE` | — | a JSON file of rows instead of the store (`test/fixture.json`) |
| invented history | `MOCK_INVENTED` (`0` to disable), `MOCK_HISTORY_DAYS`, `MOCK_SEED` | on, 90, `parcelvox-2026` | |
| real driver | `MOCK_REAL_DRIVER` | `Otto tester` | the name every real row is attributed to |

`seed.json` is the hand-editable side: the invented drivers' names, route
names, how many days of history. Change it and restart.

## Tests

```sh
node --test
```

They run the server on a fixture (a snapshot of the store plus one
hand-made walk and two trigger runs) with no latency and check auth, the
query envelope, the error codes, cursor pagination and every endpoint's
shape against the contract.

## How the app's rows become the contract

| Contract | From | Notes |
|---|---|---|
| place | `destinations` grouped by street + number (+ postcode) | a scenario pin and a route stop at one address are one place; `place_id` is stable across restarts |
| report | `messages` (non-demo) | `category` as filed (old labels mapped), `summary` = Otto's title, `location_source` = `trace_correlation` when the phone had a fix, `stop_id` = the destination row; `tour_id` only when a walk was on file that day |
| guidance | dispatch notes on a destination | `kind` from the wording (warn / instruct / ask), always `active` |
| tour | `visits` grouped by route + Berlin calendar day | one stop per destination row (`parcel_count` 1, stacked rows are separate stops); `status` closed when every stop was tapped, active while the last tap is under 3 h old, else abandoned |
| stop.dwell_seconds | `visits.arrived_at` → `delivered_at` | only when the phone saw itself inside the 30 m ring first |
| outreach | `runs` | a fired trigger = `sent`, `answered` when a debrief followed within 45 min; a silent run = `skipped` (`low_confidence`); approach scenarios are `pre_stop`, the rest `post_stop` |
| gap alert | `runs` that fired | verdict on_time / early / late → `confirmed_issue`, false_alarm → `false_positive`, none → `no_answer` |
| question | `scenarios.otto_says`, per version | asked on the runs; invented events fill the history |
| driver | one real (the tester) + the invented crew | |

## Where the contract does not fit the app (for the CTO)

- **Route identity.** The contract's tour has no route. The dashboard's
  Routes page needs one, so tours here carry `route_id` and `route_name`
  as an extension. Confirm or drop.
- **Transcripts and conversations.** A debrief's transcript, the nine-turn
  conversation with Otto and the activity trace are the richest things in
  the store; the contract carries only `summary`. The open question about
  `structured` on `/reports` is the same question.
- **Parcels.** The app has no parcel ids; `parcel_id` is `null` on real
  reports and every real stop is one parcel.
- **Media.** Nothing on the app side yet; `media_count` is 0 on real rows.
- **Scenario names.** Outreach and gap alerts come from named trigger
  scenarios; the contract has no field for which scenario fired.
- **Missed triggers.** The run log knows when Otto should have spoken and
  did not (`verdict: missed`); the gap-alert metrics only count firings.
- **`from`/`to` versus `service_date_from`/`to` on `/tours`.** Both are
  accepted; here a tour matches `from`/`to` by its first scan and the date
  filters narrow further. The contract does not say which wins.
- **Language.** Otto writes English titles whatever language the driver
  spoke; the transcript stays in the original.
- **Keys in the browser.** `analytics:read` reads a whole carrier. The
  dashboard calls this mock directly with a dev key; the real API will
  need a proxy or a browser-safe token that the contract does not define.
