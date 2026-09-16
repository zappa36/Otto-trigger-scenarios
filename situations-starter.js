'use strict';

/* ============================================================
 * The starter situations — twenty things a driver reports.
 *
 * The trigger sheet (trigger-scenarios.js) is about WHEN Otto
 * speaks. This sheet is about what happens AFTER the driver
 * presses the big REPORT button and says what they found: the
 * road was closed, there was a dog at the door, the bell does not
 * work, a neighbour took it. One situation is one thing a driver
 * might say first — and Otto's follow-up has to fit THAT, not a
 * script: a closed road wants "for how long, is there a way
 * round"; a dog at the door wants "was anyone with it, is there a
 * safe place to leave the parcel". Each row carries the driver's
 * first words, what the driver knows if asked (and only then), what
 * a relevant follow-up is about, what would be off topic here, and
 * the one-line tip Otto should end up confirming. No rule, no
 * sliders, no pin: a situation is acted out by a simulated driver
 * (elevenlabs/generate-tests.mjs --situations), in four voices, and
 * judged on whether Otto's questions fit and sound like a colleague.
 *
 * The dashboard loads it into its SITUATIONS tab (the empty-state
 * chip), keyless into localStorage, live as one insert — idempotent
 * by title, like the trigger sheet. Edit the rows there; the suite
 * is generated from the rows, not from this file.
 *
 * `stop` names the Kollwitzkiez stop (route-kollwitz.js) the
 * situation is set at, so the simulated driver and Otto share an
 * address, a consignee and the notes on file. Every consignee is
 * invented; the addresses are real.
 * ============================================================ */

window.SITUATIONS_SHEET = {
  id: 'otto-situations-starter',
  name: 'What the driver reports',
  situations: [
    {
      num: 1,
      title: 'Road closed — could not reach the address',
      category: 'hazard',
      stop: 4,
      driver_says: "I couldn't get to the address at all — the road is closed off.",
      driver_knows: 'Roadworks have closed Rykestraße at the Knaackstraße end. A sign on the barrier says until Friday. A detour via Sredzkistraße gets within about 100 m and you can walk the rest. The parcel was not delivered; it is back in the van.',
      follow_up: ['how long the closure lasts, or what the sign says', 'whether there is a way round, or a point to park and walk from', 'whether the parcel was delivered in the end or is still in the van'],
      off_topic: ['the recipient', 'gate codes', 'where the driver parked'],
      tip: 'Rykestraße is closed at the Knaackstraße end until Friday — come via Sredzkistraße and walk the last 100 m.',
    },
    {
      num: 2,
      title: 'A big dog at the door',
      category: 'hazard',
      stop: 3,
      driver_says: "There was a big dog outside the door, loose, so I didn't go up to it.",
      driver_knows: 'A large dog, no lead, no owner in sight, in the front yard behind a low gate. It barked but did not come at the gate. The driver rang from outside the gate; nobody answered. The parcel went back in the van. There is a shop two doors down that has taken parcels before.',
      follow_up: ['whether anyone was with the dog, or whether it was behind something', 'whether the driver could reach the bell or the door at all', 'a safe alternative for next time — a neighbour, a shop, a time when someone is home'],
      off_topic: ['parking', 'the road', 'gate codes'],
      tip: 'Loose dog in the front yard at Knaackstraße 22 — do not go in; ring from the gate, or leave it with the shop two doors down.',
    },
    {
      num: 3,
      title: 'No doorbell, or the bell does nothing',
      category: 'access',
      stop: 9,
      driver_says: 'The bell does nothing at this one. I stood there pressing it and nothing.',
      driver_knows: 'The panel has the names but no button lights up and no sound. Knocking on the glass door worked: a neighbour on the ground floor opened after a minute. The consignee on the first floor was in and took the parcel. The neighbour said the panel has been dead for weeks.',
      follow_up: ['how the driver got in in the end', 'whether the recipient was home and took it', 'what works instead next time — knocking, a phone call, a side entrance'],
      off_topic: ['parking', 'the road', 'dogs'],
      tip: 'The bell panel at Husemannstraße 1 is dead — knock on the glass door, the ground-floor neighbour opens.',
    },
    {
      num: 4,
      title: 'Gate needs a code',
      category: 'gate_code',
      stop: 1,
      driver_says: "The gate's locked and it wants a code. Nothing on the label, so I couldn't get in.",
      driver_knows: 'A keypad on the street gate. No code on the parcel or in the app. The driver called the number on the parcel; the recipient did not pick up. A resident let the driver in after five minutes. The bell panel is inside the gateway, as the note said. Parcel delivered to the recipient in person.',
      follow_up: ['whether the driver got the code from anyone, or got in another way', 'whether the code is on file anywhere, or the recipient could give it', 'how long it cost and whether the parcel was delivered'],
      off_topic: ['parking', 'the dog', 'the road'],
      tip: 'Kollwitzstraße 48 has a keypad on the street gate and the code is not on file — get it from the recipient before the next delivery.',
    },
    {
      num: 5,
      title: 'Intercom broken — nobody can buzz you in',
      category: 'access',
      stop: 5,
      driver_says: 'The intercom is broken — she was home but couldn\'t buzz me in.',
      driver_knows: 'The recipient answered her phone and said the door opener has been broken since the weekend. She came down four floors to open. There is no lift. She asked whether drivers could call ahead. Parcel delivered.',
      follow_up: ['how the parcel was handed over in the end', 'whether the recipient knows how long it will stay broken', 'what to do next time — call ahead, a set time, a neighbour'],
      off_topic: ['parking', 'the road', 'gate codes'],
      tip: 'At Sredzkistraße 44 the door opener is broken — call the recipient from the street, she comes down to open (fourth floor, no lift).',
    },
    {
      num: 6,
      title: 'The pin is wrong — the door is on the other street',
      category: 'address',
      stop: 10,
      driver_says: 'The map sent me to the wrong place — the actual entrance is round the corner on the other street.',
      driver_knows: 'The pin sits on Wörther Straße, but the entrance to number 38 is on the side street, Kollwitzstraße, about 60 m from where the pin is. There is a small sign by the door. The driver found it after walking around the block once. Parcel delivered.',
      follow_up: ['where the real entrance is — which street, which side, how far from the pin', 'what to look for — a sign, a landmark', 'whether the parcel was delivered'],
      off_topic: ['the dog', 'gate codes', 'parking'],
      tip: 'The entrance to Wörther Straße 38 is round the corner on Kollwitzstraße, about 60 m from the pin — look for the small sign by the door.',
    },
    {
      num: 7,
      title: 'A neighbour took the parcel',
      category: 'recipient',
      stop: 8,
      driver_says: 'Nobody home, so the neighbour took it. Fischer wasn\'t there.',
      driver_knows: 'The recipient on the fifth floor did not answer. The neighbour on the same floor, name Weber, took the parcel and signed. The driver put a card in the letterbox. Weber said she works from home most days and is happy to take parcels.',
      follow_up: ['which neighbour — name, floor, door', 'whether a card was left for the recipient', 'whether that neighbour is a good option in general'],
      off_topic: ['parking', 'the road', 'gate codes'],
      tip: 'Kollwitzstraße 71, fifth floor: if Fischer is out, Weber next door takes parcels and is usually home.',
    },
    {
      num: 8,
      title: 'Nobody home and no safe place to leave it',
      category: 'recipient',
      stop: 6,
      driver_says: 'Nobody there, and there\'s nowhere safe to leave it, so it\'s coming back with me.',
      driver_knows: 'No answer on the bell, no neighbour answered either. The letterbox is too small, the hallway is open to the street, no parcel box. The driver left a card. The recipient did not pick up the phone. It was around 11:00.',
      follow_up: ['whether a neighbour was tried', 'whether there is a parcel box, a shop or a safe spot nearby', 'what time it was, and whether a later time might work'],
      off_topic: ['the road', 'the dog', 'gate codes'],
      tip: 'Husemannstraße 14: no safe place and no neighbour at 11:00 — try after 17:00 or ask the recipient for a drop-off spot.',
    },
    {
      num: 9,
      title: 'Dark stairwell, fifth floor, no lift',
      category: 'access',
      stop: 8,
      driver_says: 'Fifth floor, no lift, and the stairwell light doesn\'t work — I nearly fell going up.',
      driver_knows: 'The light switch in the stairwell does nothing after the second floor. The driver used the phone torch. The recipient was home and took the parcel. There is a caretaker, according to a sign in the entrance, with a phone number.',
      follow_up: ['whether the driver got the parcel delivered', 'whether anyone knows about the light — a caretaker, the recipient', 'what to bring or do next time — a torch, a daytime delivery'],
      off_topic: ['parking', 'gate codes', 'the road'],
      tip: 'Kollwitzstraße 71: no light in the stairwell above the second floor and no lift — bring a torch, deliver in daylight; a caretaker\'s number is on the sign in the entrance.',
    },
    {
      num: 10,
      title: 'Scaffolding blocks the entrance — side door',
      category: 'access',
      stop: 2,
      driver_says: 'The front is all scaffolding, you can\'t get to the door. Had to go round the side.',
      driver_knows: 'Scaffolding and a builders\' fence across the whole front. A paper sign says entrance via the side door in the courtyard, reached through the passage on the left. The café is open and took the parcel as usual. The builders said it will be like this for about two months.',
      follow_up: ['where the way in is now — which side, any sign', 'how long the works will last', 'whether the parcel was delivered'],
      off_topic: ['the dog', 'gate codes', 'the recipient\'s working hours'],
      tip: 'Kolmarer Straße 3 is behind scaffolding for about two months — use the passage on the left to the side door in the courtyard.',
    },
    {
      num: 11,
      title: 'No parking anywhere — loading bay round the corner',
      category: 'parking',
      stop: 7,
      driver_says: 'Parking was hopeless, I went round twice. Ended up in the loading bay round the corner.',
      driver_knows: 'Nothing on Sredzkistraße at that hour. The loading bay on Husemannstraße, about 40 m from the door, was free. It is like this every weekday morning before ten. The parcel was delivered to the bookshop.',
      follow_up: ['where exactly the driver stopped in the end', 'whether that spot works in general — time of day, restrictions', 'how far it is to the door'],
      off_topic: ['the dog', 'gate codes', 'the intercom'],
      tip: 'Sredzkistraße 20: no stopping on the street in the morning — the loading bay on Husemannstraße, 40 m away, is free before ten.',
    },
    {
      num: 12,
      title: 'Reception takes parcels only until three',
      category: 'recipient',
      stop: 4,
      driver_says: 'The practice was shut, they only take parcels until three apparently.',
      driver_knows: 'A sign on the practice door: deliveries until 15:00. The driver arrived at 15:40. Nobody else in the building takes parcels for the practice. The parcel went back in the van. The practice is open from 08:00.',
      follow_up: ['what the sign or the staff said about hours', 'whether anyone else in the building can take it', 'when the driver arrived, and when to come next time'],
      off_topic: ['parking', 'the dog', 'the road'],
      tip: 'Praxis Dr. Ehlers at Rykestraße 13 takes deliveries only 08:00–15:00 — put it early on the route.',
    },
    {
      num: 13,
      title: 'The shop is closed on Mondays',
      category: 'recipient',
      stop: 12,
      driver_says: 'Closed. Turns out the studio doesn\'t open on Mondays.',
      driver_knows: 'A sign in the window: closed Mondays, open Tuesday to Saturday from 10:00. Nobody answered the bell of the flat above. The parcel went back in the van. There is no note about this in the app.',
      follow_up: ['what the opening hours are', 'whether anyone else at the address could take it', 'whether the parcel is back in the van'],
      off_topic: ['parking', 'the road', 'gate codes'],
      tip: 'Studio Nordlicht at Kollwitzstraße 64 is closed on Mondays — deliver Tuesday to Saturday after ten.',
    },
    {
      num: 14,
      title: 'Felt unsafe — an aggressive person at the entrance',
      category: 'hazard',
      stop: 11,
      driver_says: 'There was a guy at the entrance shouting at everyone, I didn\'t feel safe going in.',
      driver_knows: 'A man in the doorway, shouting and blocking the door, apparently drunk. Not a resident as far as the driver could tell. The driver waited in the van for ten minutes, then left. The parcel was not delivered. It was about 09:30.',
      follow_up: ['whether the driver is okay, and whether they left', 'whether it seemed a one-off or something that happens there', 'whether the parcel was delivered or is coming back'],
      off_topic: ['parking', 'gate codes', 'the bell'],
      tip: 'Kollwitzstraße 64: a driver felt unsafe at the entrance on a weekday morning — one-off as far as we know; do not force a delivery if it happens again.',
    },
    {
      num: 15,
      title: 'The code on the label does not work',
      category: 'gate_code',
      stop: 1,
      driver_says: 'The code on the label doesn\'t work anymore. Stood there like an idiot.',
      driver_knows: 'The code printed on the label was refused three times. A resident said the code was changed last month. The resident let the driver in. The recipient was home and took the parcel and gave the new code.',
      follow_up: ['whether the driver got in, and how', 'whether the recipient could give the new code', 'whether the parcel was delivered'],
      off_topic: ['parking', 'the dog', 'the road'],
      tip: 'Kollwitzstraße 48: the gate code on file changed last month — the recipient has the new one.',
    },
    {
      num: 16,
      title: 'Two buildings with the same number',
      category: 'address',
      stop: 11,
      driver_says: 'There are two number 64s here, front house and back house. Took me a while.',
      driver_knows: 'The front house and a rear building share the number 64. Conti lives in the rear building, through the passage and across the courtyard, second floor. The bell panel for the rear building is in the courtyard, not on the street. Parcel delivered.',
      follow_up: ['which of the two the recipient is in, and how to get there', 'where the bells are', 'whether the parcel was delivered'],
      off_topic: ['parking', 'the dog', 'the road'],
      tip: 'Kollwitzstraße 64: Conti is in the rear building — through the passage, across the courtyard, bells in the courtyard, second floor.',
    },
    {
      num: 17,
      title: 'Icy ramp at the entrance',
      category: 'hazard',
      stop: 5,
      driver_says: 'The ramp up to the door was pure ice, I nearly went over with the trolley.',
      driver_knows: 'The ramp to the entrance is in the shade and had not been gritted. There are steps next to it with a handrail that were fine. The driver used the steps on the way out. Parcel delivered.',
      follow_up: ['whether the driver is okay', 'whether there is a safer way in — steps, another door', 'whether the parcel was delivered'],
      off_topic: ['gate codes', 'the recipient\'s hours', 'the intercom'],
      tip: 'Sredzkistraße 44: the ramp ices over in the shade — use the steps with the handrail next to it.',
    },
    {
      num: 18,
      title: 'Too big for the parcel box — left with the bakery',
      category: 'recipient',
      stop: 9,
      driver_says: 'Didn\'t fit in the parcel box, so the bakery downstairs took it.',
      driver_knows: 'The building has a parcel box in the hallway but the parcel was too big for it. The recipient was out. The bakery on the ground floor takes parcels for the house and is open until 18:00. The driver left a card saying so.',
      follow_up: ['where exactly the parcel is now, and until when', 'whether a card was left for the recipient', 'whether the bakery is a good option in general'],
      off_topic: ['parking', 'the road', 'gate codes'],
      tip: 'Husemannstraße 1: large parcels go to the bakery on the ground floor (open until 18:00); the box in the hallway is small.',
    },
    {
      num: 19,
      title: 'Lift out of order',
      category: 'access',
      stop: 5,
      driver_says: 'Lift\'s broken, four floors up on foot with a heavy one.',
      driver_knows: 'A sign on the lift: out of order, repair not before next week. The recipient on the fourth floor was home. The parcel weighed about 20 kg. Delivered.',
      follow_up: ['how long the lift will be out', 'whether the parcel was delivered', 'whether the recipient could come down for heavy ones meanwhile'],
      off_topic: ['parking', 'the dog', 'the road'],
      tip: 'Sredzkistraße 44: lift out of order until next week — for heavy parcels ask Petrova to come down.',
    },
    {
      num: 20,
      title: 'Nothing to report — a normal delivery',
      category: 'other',
      stop: 3,
      driver_says: 'All good at this one, nothing special. Handed it over and off.',
      driver_knows: 'The recipient was home, answered the bell at once, took the parcel. Nothing was unusual about the street, the entrance or the building.',
      follow_up: ['nothing — one short confirmation that there is nothing to note is enough'],
      off_topic: ['any probing for a problem that was not there', 'parking', 'the road', 'the recipient'],
      tip: 'Knaackstraße 22: nothing to note — a normal delivery.',
    },
  ],
};
