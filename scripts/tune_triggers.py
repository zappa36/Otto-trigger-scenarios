#!/usr/bin/env python3
"""Replay recorded test runs offline and tune the trigger knobs on them.

Every tracked run now carries its raw fix stream (`runs.fixes`: t / lat /
lng / speed / AR state at ~1 Hz — see recordFix in app.js). That makes a
run replayable: this script ports the phone's two detector shapes
(pass -> stop -> resume, and park-and-walk) and drives them with the
recorded fixes, so ANY candidate knob values can be scored against runs
that already happened — no car, no tester, no waiting.

Three things it does, in increasing order of ambition:

  verify   Replay each run under the exact tuning it recorded and check
           the port reproduces the recorded outcome. Run this first; a
           low match rate means replay results cannot be trusted yet.

  labels   Emit a CSV template (one row per run) for a human to mark
           what SHOULD have happened (`should_fire` = 1/0). The recorded
           outcome is pre-filled — correct the rows where the detector
           got it wrong. This file is the ground truth for tuning.

  search   Random-search the knob space per scenario, scoring each
           candidate by agreement with the labels; write the winners as
           dashboard-shaped params JSON, ready to paste into a scenario
           (or hand-apply with the sliders).

Data comes straight from Supabase (the pilot policies let the anon key
read) or from a JSON file:

  python3 scripts/tune_triggers.py --url https://XYZ.supabase.co --key ANON_KEY
  python3 scripts/tune_triggers.py --url ... --key ... --emit-labels labels.csv
  python3 scripts/tune_triggers.py --url ... --key ... --labels labels.csv \
      --search 3000 --out tuned.json

  # or offline, from a one-object dump {"runs": [...], "scenarios": [...],
  # "destinations": [...]} (curl the three REST endpoints yourself):
  python3 scripts/tune_triggers.py --input dump.json --labels labels.csv

No dependencies beyond the standard library, like the rest of the kit.
Runs recorded before the `fixes` column exist but cannot be replayed;
they are counted and skipped.
"""

import argparse
import csv
import json
import math
import random
import sys
import urllib.request

# Mirrors TRIG in app.js, in the dashboard's units (seconds, metres).
DEFAULTS = {
    'radius': 150, 'exit_radius': 190, 'pass_speed_max': 9,
    'pass_still_max_s': 25, 'passes_needed': 2,
    'stop_speed': 0.6, 'stop_dwell_s': 45, 'stop_radius': 250,
    'resume_speed': 3,
    'park_radius_max': 400, 'park_stop_s': 30,
    'arrival_radius': 25, 'min_walk_m': 50,
}
SEARCH_KEYS = {
    'passstop': ['radius', 'pass_speed_max', 'pass_still_max_s', 'passes_needed',
                 'stop_speed', 'stop_dwell_s', 'stop_radius', 'resume_speed'],
    'parkwalk': ['park_radius_max', 'park_stop_s', 'arrival_radius', 'min_walk_m'],
}
INT_KEYS = {'passes_needed'}


def dist_m(lat1, lng1, lat2, lng2):
    to_r = math.radians
    d_lat, d_lng = to_r(lat2 - lat1), to_r(lng2 - lng1)
    h = (math.sin(d_lat / 2) ** 2
         + math.cos(to_r(lat1)) * math.cos(to_r(lat2)) * math.sin(d_lng / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def unpack_fixes(fixes):
    """Packed rows -> [{t, lat, lng, sp, state, stepping}] in seconds."""
    if not fixes or not fixes.get('rows'):
        return []
    states = fixes.get('states') or ['UNKNOWN', 'STILL', 'ON_FOOT', 'IN_VEHICLE']
    out = []
    for r in fixes['rows']:
        try:
            t, lat, lng, sp, si, step = (list(r) + [0, 0])[:6]
            out.append({'t': float(t), 'lat': float(lat), 'lng': float(lng),
                        'sp': max(0.0, float(sp)),
                        'state': states[int(si)] if 0 <= int(si) < len(states) else 'UNKNOWN',
                        'stepping': bool(step)})
        except (TypeError, ValueError, IndexError):
            continue
    return out


def cfg_for(run, scenario):
    """The knob values a replay of this run starts from: the run's own
    recorded tuning, holes filled from the scenario's current params,
    then the defaults — same precedence the phone applies live."""
    cfg = dict(DEFAULTS)
    for p in (scenario or {}).get('params') or []:
        k = p.get('key') if isinstance(p, dict) else None
        try:
            if k in cfg:
                cfg[k] = float(p.get('value'))
        except (TypeError, ValueError):
            pass
    tuning = run.get('tuning')
    if isinstance(tuning, str):
        try:
            tuning = json.loads(tuning)
        except ValueError:
            tuning = None
    for k, v in (tuning or {}).items():
        if k in cfg and isinstance(v, (int, float)):
            cfg[k] = float(v)
    return cfg


def shape_of(run, scenario):
    tuning = run.get('tuning') or {}
    if isinstance(tuning, dict) and tuning.get('shape') in ('passstop', 'parkwalk'):
        return tuning['shape']
    params = (scenario or {}).get('params') or []
    return 'parkwalk' if any(isinstance(p, dict) and p.get('key') == 'arrival_radius'
                             for p in params) else 'passstop'


def replay_passstop(samples, cfg, dest):
    """Port of detectorStep in app.js (pass -> stop -> resume)."""
    exit_r = cfg['exit_radius']
    if exit_r <= cfg['radius']:
        exit_r = round(cfg['radius'] * 1.25)  # same hysteresis guard as trigOf
    passes, inside = 0, False
    inside_max_still = inside_speed_sum = inside_n = 0
    still_start, stopped, resume_n = None, False, 0
    fired, fired_t = False, None
    for s in samples:
        t, sp = s['t'], s['sp']
        dist = dist_m(s['lat'], s['lng'], dest['lat'], dest['lng'])
        if sp <= cfg['stop_speed'] and dist <= cfg['stop_radius']:
            if still_start is None:
                still_start = t
            dwell = t - still_start
            if inside:
                inside_max_still = max(inside_max_still, dwell)
            if not stopped and passes >= cfg['passes_needed'] and dwell >= cfg['stop_dwell_s']:
                stopped = True
                if not fired and cfg['resume_speed'] <= cfg['stop_speed']:
                    fired, fired_t = True, t  # walking debriefs fire AT the stop
        else:
            still_start = None
        if not inside and dist <= cfg['radius']:
            inside, inside_max_still, inside_speed_sum, inside_n = True, 0, 0, 0
        if inside:
            inside_speed_sum += sp
            inside_n += 1
        if inside and dist >= exit_r:
            inside = False
            mean = inside_speed_sum / inside_n if inside_n else 0
            if 0.3 < mean <= cfg['pass_speed_max'] and inside_max_still < cfg['pass_still_max_s']:
                passes += 1
        if stopped and not fired:
            if sp >= cfg['resume_speed']:
                resume_n += 1
                if resume_n >= 2:
                    fired, fired_t = True, t
            else:
                resume_n = 0
    return {'fired': fired, 'fired_t': fired_t, 'passes': passes, 'stopped': stopped}


def replay_parkwalk(samples, cfg, dest):
    """Port of parkWalkStep in app.js (park the vehicle, walk in, arrive)."""
    saw_vehicle, last_vehicle, vehicle_still_since = False, None, None
    parked_at, walk_m, last_walk = None, 0.0, None
    fired, fired_t = False, None
    for s in samples:
        t, sp = s['t'], s['sp']
        d_pin = dist_m(s['lat'], s['lng'], dest['lat'], dest['lng'])
        in_vehicle = s['state'] == 'IN_VEHICLE' or sp >= 4
        if in_vehicle:
            saw_vehicle = True
            last_vehicle = s
            if parked_at and not fired and walk_m < 20:  # that was traffic, not parking
                parked_at, walk_m, last_walk = None, 0.0, None
            if (parked_at is None and sp <= cfg['stop_speed']
                    and cfg['arrival_radius'] < d_pin <= cfg['park_radius_max']):
                if vehicle_still_since is None:
                    vehicle_still_since = t
                if t - vehicle_still_since >= cfg['park_stop_s']:
                    parked_at = s
            elif sp > cfg['stop_speed']:
                vehicle_still_since = None
            continue
        if parked_at is None and saw_vehicle:
            at = last_vehicle or s
            d_park = dist_m(at['lat'], at['lng'], dest['lat'], dest['lng'])
            if cfg['arrival_radius'] < d_park <= cfg['park_radius_max']:
                parked_at, walk_m, last_walk = at, 0.0, None
        if parked_at is None or fired:
            continue
        if last_walk is not None:
            seg = dist_m(last_walk['lat'], last_walk['lng'], s['lat'], s['lng'])
            if 1 < seg < 60:  # GPS jumps filtered, as on the phone
                walk_m += seg
        last_walk = s
        walked = max(walk_m, dist_m(parked_at['lat'], parked_at['lng'], s['lat'], s['lng']))
        if d_pin <= cfg['arrival_radius'] and walked >= cfg['min_walk_m']:
            fired, fired_t = True, t
    return {'fired': fired, 'fired_t': fired_t,
            'parked': parked_at is not None, 'walk_m': round(walk_m)}


def replay(run, cfg, scenario, dest):
    samples = unpack_fixes(run.get('fixes') if isinstance(run.get('fixes'), dict)
                           else json.loads(run['fixes']) if isinstance(run.get('fixes'), str) and run['fixes'] else None)
    if not samples:
        return None
    shape = shape_of(run, scenario)
    fn = replay_parkwalk if shape == 'parkwalk' else replay_passstop
    return fn(samples, cfg, dest)


# ---------- data in ----------

def fetch(url, key, path):
    req = urllib.request.Request(
        url.rstrip('/') + path,
        headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def load(args):
    if args.input:
        with open(args.input, encoding='utf-8') as f:
            dump = json.load(f)
        runs = dump.get('runs') or []
        scenarios = dump.get('scenarios') or []
        dests = dump.get('destinations') or []
    elif args.url and args.key:
        runs = fetch(args.url, args.key, '/rest/v1/runs?select=*&order=created_at.desc&limit=1000')
        scenarios = fetch(args.url, args.key, '/rest/v1/scenarios?select=*')
        dests = fetch(args.url, args.key, '/rest/v1/destinations?select=*')
    else:
        sys.exit('need --url + --key, or --input dump.json (see --help)')
    return (runs,
            {s['id']: s for s in scenarios},
            {d['id']: d for d in dests})


def replayable(runs, scenarios, dests):
    """(run, scenario, dest) triples that can actually be replayed."""
    out, no_fixes, no_dest = [], 0, 0
    for r in runs:
        if not r.get('fixes'):
            no_fixes += 1
            continue
        d = dests.get(r.get('destination_id'))
        if not d:
            no_dest += 1
            continue
        out.append((r, scenarios.get(r.get('scenario_id')), d))
    if no_fixes:
        print(f'  ({no_fixes} run(s) predate the fixes column — cannot replay, skipped)')
    if no_dest:
        print(f'  ({no_dest} run(s) whose destination is gone — skipped)')
    return out


# ---------- the three jobs ----------

def verify(triples):
    """Replay under the recorded tuning; the port should agree with the phone."""
    match = 0
    print(f'\nVERIFY — replaying {len(triples)} run(s) under their own recorded tuning\n')
    print(f'{"run":<10} {"scenario":<28} {"n":>5}  {"recorded":<9} {"replayed":<9} ok')
    for run, sc, dest in triples:
        res = replay(run, cfg_for(run, sc), sc, dest)
        rec = bool(run.get('fired'))
        rep = bool(res and res['fired'])
        ok = rec == rep
        match += ok
        n = len((run.get('fixes') or {}).get('rows') or [])
        title = ((sc or {}).get('title') or '?')[:28]
        print(f'{str(run.get("id"))[:8]:<10} {title:<28} {n:>5}  '
              f'{"FIRED" if rec else "no fire":<9} {"FIRED" if rep else "no fire":<9} '
              f'{"✓" if ok else "✗ MISMATCH"}')
    if triples:
        print(f'\n{match}/{len(triples)} match. Mismatches usually mean the fix stream is too '
              'coarse for that run (long runs downsample) — trust search results accordingly.')


def emit_labels(triples, path):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['run_id', 'should_fire', 'recorded_fired', 'scenario', 'started_at'])
        for run, sc, _ in triples:
            w.writerow([run.get('id'), 1 if run.get('fired') else 0,
                        1 if run.get('fired') else 0,
                        (sc or {}).get('title') or '', run.get('started_at') or ''])
    print(f'\nwrote {path} — set should_fire to what SHOULD have happened '
          '(1 = Otto should have spoken, 0 = he should have stayed quiet), then re-run with '
          f'--labels {path} --search N')


def read_labels(path):
    labels = {}
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            v = str(row.get('should_fire', '')).strip()
            if v in ('0', '1'):
                labels[row['run_id']] = v == '1'
    return labels


def search_scenario(entries, base_cfg, keys, ranges, iters):
    """Random search; score = label agreement, tie-break = least drift."""
    def score(cfg):
        hits = 0
        for run, sc, dest, should in entries:
            res = replay(run, cfg, sc, dest)
            if res and res['fired'] == should:
                hits += 1
        drift = sum(abs(cfg[k] - base_cfg[k]) / (ranges[k][1] - ranges[k][0] or 1) for k in keys)
        return hits, -drift
    best_cfg, best = dict(base_cfg), score(base_cfg)
    for _ in range(iters):
        cand = dict(base_cfg)
        for k in keys:
            lo, hi = ranges[k]
            cand[k] = random.randint(int(lo), int(hi)) if k in INT_KEYS \
                else round(random.uniform(lo, hi), 1)
        s = score(cand)
        if s > best:
            best_cfg, best = cand, s
    # the smallest change that keeps the score: walk each key back to its
    # current value and keep the reset whenever accuracy holds — a human
    # reads "stop_dwell 45 -> 67" much better than seven moved knobs
    for k in keys:
        if best_cfg[k] != base_cfg[k]:
            trial = dict(best_cfg)
            trial[k] = base_cfg[k]
            s = score(trial)
            if s >= best:
                best_cfg, best = trial, s
    return best_cfg, best[0], score(dict(base_cfg))[0]


def search(triples, labels, iters, out_path):
    by_sc = {}
    for run, sc, dest in triples:
        if run.get('id') in labels and sc:
            by_sc.setdefault(sc['id'], []).append((run, sc, dest, labels[run['id']]))
    if not by_sc:
        sys.exit('no labeled, replayable runs matched a scenario — check the labels CSV')
    print(f'\nSEARCH — {iters} candidates per scenario, scored on labeled runs\n')
    out = {}
    for sc_id, entries in by_sc.items():
        run0, sc, dest0, _ = entries[0]
        base = cfg_for(run0, sc)
        keys = SEARCH_KEYS[shape_of(run0, sc)]
        # a scenario's own param ranges bound the search; ±60% otherwise
        ranges = {}
        by_key = {p.get('key'): p for p in (sc.get('params') or []) if isinstance(p, dict)}
        for k in keys:
            p = by_key.get(k)
            try:
                lo, hi = float(p['min']), float(p['max'])
            except (TypeError, KeyError, ValueError):
                lo, hi = base[k] * 0.4, base[k] * 1.6
            ranges[k] = (min(lo, hi), max(lo, hi)) if hi > lo else (base[k] * 0.4, base[k] * 1.6)
        tuned, after, before = search_scenario(entries, base, keys, ranges, iters)
        n = len(entries)
        print(f'{(sc.get("title") or sc_id)[:44]:<46} {before}/{n} -> {after}/{n} correct')
        for k in keys:
            if tuned[k] != base[k]:
                print(f'    {k}: {base[k]:g} -> {tuned[k]:g}')
        # dashboard params shape, existing entries preserved
        params = [dict(p) for p in (sc.get('params') or []) if isinstance(p, dict)]
        for k in keys:
            p = next((x for x in params if x.get('key') == k), None)
            if p:
                p['value'] = tuned[k]
            elif tuned[k] != base[k]:
                params.append({'key': k, 'label': k.replace('_', ' '), 'value': tuned[k],
                               'min': round(ranges[k][0], 1), 'max': round(ranges[k][1], 1),
                               'step': 1, 'unit': 's' if k.endswith('_s') else
                               ('' if k in INT_KEYS else 'm' if 'speed' not in k else 'm/s')})
        out[sc_id] = {'title': sc.get('title'), 'labeled_runs': n,
                      'correct_before': before, 'correct_after': after, 'params': params}
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2)
        print(f'\nwrote {out_path} — per-scenario tuned params in the dashboard\'s shape')


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='Supabase project URL')
    ap.add_argument('--key', help='Supabase anon key')
    ap.add_argument('--input', help='offline dump: {"runs":[],"scenarios":[],"destinations":[]}')
    ap.add_argument('--emit-labels', metavar='CSV', help='write the labeling template and exit')
    ap.add_argument('--labels', metavar='CSV', help='ground truth (run_id, should_fire)')
    ap.add_argument('--search', type=int, metavar='N', default=0,
                    help='random-search N candidates per scenario (needs --labels)')
    ap.add_argument('--out', metavar='JSON', help='where --search writes tuned params')
    ap.add_argument('--seed', type=int, default=7, help='search RNG seed (default 7)')
    args = ap.parse_args()
    random.seed(args.seed)

    runs, scenarios, dests = load(args)
    print(f'{len(runs)} run(s), {len(scenarios)} scenario(s), {len(dests)} destination(s)')
    triples = replayable(runs, scenarios, dests)
    if not triples:
        sys.exit('nothing replayable yet — track some runs with the fixes column deployed first')

    if args.emit_labels:
        emit_labels(triples, args.emit_labels)
        return
    if args.search:
        if not args.labels:
            sys.exit('--search needs --labels (make one with --emit-labels first)')
        verify(triples)
        search(triples, read_labels(args.labels), args.search, args.out)
        return
    verify(triples)


if __name__ == '__main__':
    main()
