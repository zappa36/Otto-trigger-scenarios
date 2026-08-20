'use strict';

/* ============================================================
 * The starter sheet — ten Otto trigger scenarios on file.
 *
 * One scenario is one row of the deck's "Otto triggers" sheet,
 * every column filled in: the situation, a testable rule with its
 * numbers as {key} placeholders, the Activity Recognition states,
 * the other signals, when Otto may talk, the question he opens
 * with, the tip type he should come back with, and how a tester
 * acts it out. Together they walk one delivery front to back:
 * the approach (crawl, blocked street), the park (loops, far
 * walk, sprint stop), the door (entrance hunt, wrong pin), the
 * handover (nobody home, long wait) — and one clean run as the
 * control, where the pass is Otto saying nothing at all.
 *
 * Row 1 is the deck's own worked example, verbatim. Params whose
 * keys match the phone's detector (radius, passes_needed,
 * stop_dwell_s, arrival_radius, …) drive the live trigger on the
 * next test run — the sheet ships with rows 1 and 2 fully
 * detectable and says so, in the row, where the demo detector
 * cannot fire (a blocked street is a NON-arrival; judging the
 * silent run is the data). Extra keys (max_stop_s, foot_search_s,
 * pin_offset_m, …) are spec values for the production trigger:
 * sliders, versioned, exported — just not wired to the phone yet.
 *
 * The dashboard loads it (the link in the ⎘ PASTE FROM EXCEL
 * sheet, or the empty-state chip) the way it loads the demo
 * route: keyless into localStorage, live as one insert. Loading
 * is idempotent by title — rows already in the list are skipped,
 * so a deleted row can be restored by loading again. Every row
 * still needs its test address after loading; a scenario without
 * a pin cannot be tested, and the dashboard says so loudly.
 * ============================================================ */

window.TRIGGER_SHEET = {
  id: 'otto-triggers-starter',
  name: 'Otto triggers',
  scenarios: [
    {
      num: 1,
      title: 'Parking loops — driver circles the block looking for parking',
      described: 'The driver has a delivery but cannot find parking, so they circle the block a few times slowly before finally stopping.',
      rule: 'Vehicle passes within ~{radius} m of the stop {passes_needed}× below {pass_speed_max} m/s without stopping, then stands ≥{stop_dwell_s} s within {stop_radius} m. Deck says 3 slow loops; every number here is a slider.',
      ar_states: 'IN_VEHICLE the whole time',
      signals: 'GPS trace vs stop pin; speed',
      timing: 'Wait — ask when back in the car after the stop',
      otto_says: '“Is it hard to park here at this time? Where did you find a spot?”',
      learns: 'ACCESS — parking / loading-zone tip',
      test_steps: 'Simulate a delivery address, drive around the block twice, then stop',
      params: [
        { key: 'radius', label: 'Pass radius', value: 150, min: 40, max: 400, step: 5, unit: 'm' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 2, min: 0, max: 5, step: 1, unit: '×' },
        { key: 'pass_speed_max', label: 'Max pass speed', value: 9, min: 2, max: 15, step: 0.5, unit: 'm/s' },
        { key: 'stop_dwell_s', label: 'Stop dwell', value: 45, min: 10, max: 180, step: 5, unit: 's' },
        { key: 'stop_radius', label: 'Stop radius', value: 250, min: 50, max: 500, step: 10, unit: 'm' },
      ],
    },
    {
      num: 2,
      title: 'Park & walk — parked far out, walked the last stretch',
      described: 'Parking at the door never works at this address. The driver knows it, gives up early, parks at the spot that always works and walks the rest — the distance is the tip.',
      rule: 'Vehicle parks within {park_radius_max} m of the pin — the vehicle→walking flip marks the spot, a vehicle standing ≥{park_stop_s} s is the fallback — then the driver walks ≥{min_walk_m} m and arrives within {arrival_radius} m of the pin on foot.',
      ar_states: 'IN_VEHICLE → WALKING (the flip is the parking spot) → STILL at the door',
      signals: 'Parking position vs pin; walked path length; walk time',
      timing: 'On arrival at the door, on foot — only then is the walk a measured fact',
      otto_says: '“You parked about {park_m} m out and walked {walk_m} m — was there nothing closer, or is that the smart spot for this address?”',
      learns: 'ACCESS — the parking spot that actually works for this address',
      test_steps: 'Drive to a few hundred meters from the pin, park properly, walk the rest of the way. Otto speaks when you reach the door, quoting your measured distances.',
      params: [
        { key: 'park_radius_max', label: 'Parking counts within', value: 400, min: 100, max: 800, step: 25, unit: 'm' },
        { key: 'park_stop_s', label: 'Vehicle standstill = parked', value: 30, min: 10, max: 120, step: 5, unit: 's' },
        { key: 'min_walk_m', label: 'Minimum walk', value: 50, min: 20, max: 300, step: 10, unit: 'm' },
        { key: 'arrival_radius', label: 'Arrived within', value: 25, min: 10, max: 60, step: 5, unit: 'm' },
      ],
    },
    {
      num: 3,
      title: 'Sprint stop — hazards on, dash to the door',
      described: 'No legal spot anywhere, so the driver stops in the street with the hazards on and sprints the parcel to the door. Whether the street tolerates that — and where the loading zone hides — is the tip.',
      rule: 'Vehicle stops within {stop_radius} m of the pin, stands ≥{stop_dwell_s} s, and is moving again within {max_stop_s} s of first standing — a dash, not a parked delivery. The short total stop is the signature; the debrief asks whether it works here.',
      ar_states: 'IN_VEHICLE → STILL in the traffic lane → brief ON_FOOT possible → IN_VEHICLE again',
      signals: 'Total standstill time; stop position in the street vs the pin',
      timing: 'Straight after moving off, while the manoeuvre is fresh',
      otto_says: '“Quick one — did stopping in the street work here, or is there a loading zone the map doesn’t show?”',
      learns: 'PARKING — whether a hazards-on stop is tolerated, and where the loading zone is',
      test_steps: 'Stop briefly right at the pin as if double-parked, walk a parcel to the door, drive off within two minutes; answer Otto once rolling.',
      params: [
        { key: 'stop_radius', label: 'Stop counts within', value: 60, min: 20, max: 200, step: 5, unit: 'm' },
        { key: 'stop_dwell_s', label: 'Minimum standstill', value: 20, min: 10, max: 90, step: 5, unit: 's' },
        { key: 'max_stop_s', label: 'Still a dash below', value: 120, min: 30, max: 300, step: 10, unit: 's' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
        { key: 'resume_speed', label: 'Moving-again speed', value: 3, min: 1, max: 8, step: 0.5, unit: 'm/s' },
      ],
    },
    {
      num: 4,
      title: 'Entrance hunt — at the address, but where is the way in?',
      described: 'The pin is reached, the building found — and then the search starts: the front door is around the corner, in the courtyard, behind the shop.',
      rule: 'Vehicle stops within {stop_radius} m of the pin (≥{stop_dwell_s} s), then ON_FOOT for ≥{foot_search_s} s inside ~{radius} m of the pin without the debrief starting — the tester is hunting for the way in.',
      ar_states: 'IN_VEHICLE → STILL (arrival) → ON_FOOT searching → STILL at the real entrance',
      signals: 'On-foot GPS trace circling the building; time on foot with no arrival',
      timing: 'Wait — ask when back at the vehicle, not mid-search',
      otto_says: '“Was the entrance easy to find? Where is it, exactly — and what should the next driver look for?”',
      learns: 'ENTRANCE — where the real way in is',
      test_steps: 'Park near the pin, walk to the wrong side of the building first, spend ~2 min searching, then return to the car and answer Otto.',
      params: [
        { key: 'stop_radius', label: 'Arrival stop radius', value: 120, min: 30, max: 300, step: 5, unit: 'm' },
        { key: 'stop_dwell_s', label: 'Arrival stop dwell', value: 20, min: 5, max: 120, step: 5, unit: 's' },
        { key: 'foot_search_s', label: 'On-foot search time', value: 90, min: 20, max: 300, step: 10, unit: 's' },
        { key: 'radius', label: 'Search radius', value: 80, min: 20, max: 200, step: 5, unit: 'm' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
      ],
    },
    {
      num: 5,
      title: 'The wrong pin — the door is not where the map says',
      described: 'Navigation says arrived; the building says otherwise. The real door sits well away from where the map put the pin, and every driver after this one will hunt again unless the correction is filed.',
      rule: 'Arrival stop within {stop_radius} m of the pin (≥{stop_dwell_s} s), then the debrief is delivered ≥{pin_offset_m} m away from the pin — the tester is at the real door, the pin is not.',
      ar_states: 'IN_VEHICLE → STILL → ON_FOOT to the real door → STILL there',
      signals: 'Debrief position vs the pin — the filed report carries the reporter’s coordinates; walked trace',
      timing: 'At the real door — say where you actually are while standing there',
      otto_says: '“The map pin seems off — where is the real door compared to where it sent you?”',
      learns: 'ACCESS — a pin correction: where the door really is',
      test_steps: 'Pin the scenario deliberately one block off. Drive to the pin, then walk to the “real” door you chose and debrief from there — the filed position is the correction.',
      params: [
        { key: 'stop_radius', label: 'Arrival stop radius', value: 120, min: 30, max: 300, step: 5, unit: 'm' },
        { key: 'stop_dwell_s', label: 'Arrival stop dwell', value: 20, min: 5, max: 120, step: 5, unit: 's' },
        { key: 'pin_offset_m', label: 'Pin counts as wrong from', value: 75, min: 25, max: 300, step: 5, unit: 'm' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
        { key: 'resume_speed', label: 'Moving-again speed', value: 1, min: 0.5, max: 8, step: 0.5, unit: 'm/s' },
      ],
    },
    {
      num: 6,
      title: 'Nobody home — rang, waited, bounced',
      described: 'The drive, the park, the walk, the bell — and nobody answers. The parcel rides on, and the only thing learned is when this door actually opens. Unless Otto asks.',
      rule: 'Normal arrival (stop within {stop_radius} m, ≥{stop_dwell_s} s standing), total time at the door under {door_dwell_max_s} s, then moving off again — a delivery attempt that bounced.',
      ar_states: 'IN_VEHICLE → STILL / brief ON_FOOT at the door → IN_VEHICLE away',
      signals: 'Short door dwell; time of day vs typical delivery windows',
      timing: 'On driving off — the attempt is over, the lesson is not',
      otto_says: '“No luck at the door? When is somebody actually there — or is there a neighbour or a shop that takes parcels?”',
      learns: 'HOURS — when this door answers, and who takes parcels when it doesn’t',
      test_steps: 'Arrive normally, walk to the door, wait ~30 s as if ringing, walk back and drive off. Answer Otto once rolling.',
      params: [
        { key: 'stop_radius', label: 'Arrival stop radius', value: 100, min: 30, max: 300, step: 5, unit: 'm' },
        { key: 'stop_dwell_s', label: 'Arrival stop dwell', value: 25, min: 10, max: 120, step: 5, unit: 's' },
        { key: 'door_dwell_max_s', label: 'A bounce stays under', value: 120, min: 30, max: 600, step: 10, unit: 's' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
      ],
    },
    {
      num: 7,
      title: 'Long wait — the handover eats the schedule',
      described: 'Goods-in queues, reception hunts for a stamp, the one person with a key is at lunch. The dwell is the signal; the workaround is the tip.',
      rule: 'A cumulative ≥{stop_dwell_s} s standing within {stop_radius} m of the pin — far longer than a normal handover. Shuffling forward in a queue (interruptions shorter than {still_grace_s} s) pauses the clock instead of resetting it.',
      ar_states: 'ON_FOOT or STILL near the pin — the long STILL is the signal',
      signals: 'Dwell time vs pin; opening hours; time of day',
      timing: 'Wait — ask on leaving, when hands are free',
      otto_says: '“That took a while — how long did you actually wait, and is there a faster way in here?”',
      learns: 'INFO — realistic waiting time and how to skip it',
      test_steps: 'Go to the pin, stand in the waiting area ≥5 min (a few steps forward now and then are fine), then leave and answer Otto.',
      params: [
        { key: 'stop_radius', label: 'Waiting radius', value: 60, min: 15, max: 200, step: 5, unit: 'm' },
        { key: 'stop_dwell_s', label: 'Wait threshold', value: 300, min: 60, max: 1200, step: 30, unit: 's' },
        { key: 'still_grace_s', label: 'Queue-shuffle grace', value: 60, min: 10, max: 180, step: 5, unit: 's' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
      ],
    },
    {
      num: 8,
      title: 'Blocked street — got close, never arrived',
      described: 'Construction fence, a moving truck, police tape: the street is shut, the driver turns off short of the address and has to find another way. The map will keep sending everyone else the same way.',
      rule: 'Approach to within {radius} m of the pin below {pass_speed_max} m/s, then movement away again without any stop of ≥{stop_dwell_s} s inside {stop_radius} m — an approach that never became an arrival.',
      ar_states: 'IN_VEHICLE approach → slow crawl / brief STILL at the blockage → IN_VEHICLE away, no arrival',
      signals: 'GPS trace turning short of the pin; speed drop at the blockage',
      timing: 'Soon after turning away, once driving smoothly',
      otto_says: '“Looks like you couldn’t get through — what’s blocking the street, and which way around works?”',
      learns: 'CLOSURE — the blockage and the detour that works',
      test_steps: 'Drive toward the pin, slow as if blocked, turn around short of it and drive off. The demo detector fires only on a real stop, so expect a silent run — end tracking and judge it “✗ should have spoken”: that verdict is the data the production trigger is built from.',
      params: [
        { key: 'radius', label: 'Approach counts within', value: 100, min: 30, max: 300, step: 5, unit: 'm' },
        { key: 'pass_speed_max', label: 'Max approach speed', value: 8, min: 2, max: 15, step: 0.5, unit: 'm/s' },
        { key: 'stop_dwell_s', label: 'Real-stop threshold', value: 30, min: 10, max: 120, step: 5, unit: 's' },
        { key: 'stop_radius', label: 'No stop inside', value: 250, min: 50, max: 500, step: 10, unit: 'm' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 1, min: 0, max: 3, step: 1, unit: '×' },
      ],
    },
    {
      num: 9,
      title: 'Crawl approach — the last street costs minutes',
      described: 'The last few hundred meters crawl: a narrow one-way, a school at opening time, cobblestones and parked trucks. Every future route past this address should know.',
      rule: 'Inside {radius} m of the pin, ≥{crawl_s} s continuously below {pass_speed_max} m/s while still IN_VEHICLE, ending in the arrival stop (≥{stop_dwell_s} s within {stop_radius} m).',
      ar_states: 'IN_VEHICLE at walking pace (the crawl) → STILL at arrival',
      signals: 'Speed profile over the approach; time-in-segment vs what the street usually takes',
      timing: 'Right after the arrival stop, as movement resumes — the crawl is still fresh',
      otto_says: '“That last stretch was slow — what makes it crawl, and is it always like this at this hour?”',
      learns: 'HAZARD — what slows the approach, and when',
      test_steps: 'Drive the last ~300 m to the pin at walking pace, stop as arrived, then step out. Otto asks as you move again; the speed trace shows the crawl.',
      params: [
        { key: 'radius', label: 'Crawl counts within', value: 300, min: 100, max: 600, step: 10, unit: 'm' },
        { key: 'crawl_s', label: 'Crawl duration', value: 60, min: 20, max: 300, step: 10, unit: 's' },
        { key: 'pass_speed_max', label: 'Crawl speed below', value: 4, min: 1, max: 8, step: 0.5, unit: 'm/s' },
        { key: 'stop_dwell_s', label: 'Arrival stop dwell', value: 30, min: 10, max: 120, step: 5, unit: 's' },
        { key: 'stop_radius', label: 'Arrival stop radius', value: 100, min: 30, max: 300, step: 5, unit: 'm' },
        { key: 'passes_needed', label: 'Slow passes needed', value: 0, min: 0, max: 3, step: 1, unit: '×' },
        { key: 'resume_speed', label: 'Moving-again speed', value: 1, min: 0.5, max: 8, step: 0.5, unit: 'm/s' },
      ],
    },
    {
      num: 10,
      title: 'Clean run — the control: Otto stays quiet',
      described: 'A completely ordinary delivery: drive up, park at the door, hand over, drive on. Nothing to learn — so the pass is Otto saying nothing at all.',
      rule: 'A direct approach, one ordinary stop, departure — no repeated passes, no excessive dwell. The trigger under test must NOT fire: with {passes_needed} slow passes required and {stop_dwell_s} s dwell armed, any Otto question on this run is a false positive.',
      ar_states: 'IN_VEHICLE → STILL at the door → brief ON_FOOT → IN_VEHICLE — nothing unusual',
      signals: 'None — that is the point; the run log records what the detector saw anyway',
      timing: 'Never — a fired trigger on this run is the finding',
      otto_says: '“If you are hearing this, the trigger fired on a normal delivery — tell me what you were doing when I spoke up.”',
      learns: 'Nothing — a silent run is the pass; any debrief filed here documents a false positive',
      test_steps: 'Do the most boring delivery you can: drive straight to the pin, park, walk in, walk out, drive off. End tracking and judge the silent run “✓ right call”. If Otto speaks, answer him — the debrief documents the false positive.',
      params: [
        { key: 'passes_needed', label: 'Slow passes needed', value: 2, min: 0, max: 5, step: 1, unit: '×' },
        { key: 'stop_dwell_s', label: 'Stop dwell', value: 45, min: 10, max: 180, step: 5, unit: 's' },
        { key: 'radius', label: 'Pass radius', value: 150, min: 40, max: 400, step: 5, unit: 'm' },
        { key: 'stop_radius', label: 'Stop radius', value: 250, min: 50, max: 500, step: 10, unit: 'm' },
      ],
    },
  ],
};
