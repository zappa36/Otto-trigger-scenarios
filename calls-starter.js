'use strict';

/* ============================================================
 * The starter calls — ten calls Otto makes from the back office.
 *
 * The trigger sheet (trigger-scenarios.js) is about WHEN Otto
 * speaks; the situations (situations-starter.js) about what he
 * asks back after the driver presses REPORT. Both start with the
 * driver talking. A CALL starts with Otto: the office rings the
 * customer (the consignee) or the driver with a purpose — a
 * fresh-food box is on the round, will somebody be home; the
 * driver is running late, does the new time still work; the
 * customer is away, skip the stop — and the person called says
 * what they say: not home before six, leave it with the neighbour,
 * twenty minutes behind, wrong number.
 *
 * One row is one call. It carries who is called (the consignee at
 * a Kollwitzkiez stop, or the driver on that round), why Otto is
 * calling, the line he opens with, what the person says once Otto
 * has got to the point, what they know if asked (and only then),
 * what the call has to establish, what would be off topic, and
 * the one-line outcome Otto should end the call confirming. A row
 * can name the call that FOLLOWS it (`next_call`): the home check
 * that finds nobody home is followed by the call that tells the
 * driver, and `previous_call` on that second row is what the
 * office learned on the first one — the fixture the suite tests
 * it with, and on the phone the live outcome of the call just
 * taken replaces it.
 *
 * The dashboard loads it into its CALLS tab (the empty-state chip),
 * keyless into localStorage, live as one insert — idempotent by
 * title, like the other sheets. Edit the rows there; the suite is
 * generated from the rows, not from this file. The phone reads
 * the same rows for its TAKE A CALL list (⚙ settings), and falls
 * back to this file when the backend has no calls table yet.
 *
 * `stop` names the Kollwitzkiez stop (route-kollwitz.js) the call
 * is about, so Otto, the simulated customer and the designer on
 * the phone share an address, a consignee and the notes on file.
 * Every consignee is invented; the addresses are real.
 * ============================================================ */

window.CALLS_SHEET = {
  id: 'otto-calls-starter',
  name: 'The calls Otto makes',
  calls: [
    {
      num: 1,
      title: 'Home check — fresh food this evening',
      callee: 'consignee',
      stop: 1,
      purpose: 'A fresh-food box for F. Brandt is on today\'s round, due between 17:00 and 19:00. Fresh food is handed to the customer in person — it cannot be left at the door or with a neighbour. Find out whether somebody will be home in that window, and if not, from when.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Mr Brandt? I\'m calling about your fresh-food delivery this evening.',
      previous_call: '',
      they_say: 'Oh — I\'m still at work. I won\'t be home before six.',
      they_know: 'At work until 17:30, home by 18:00 at the latest, then in all evening. Wants the box handed over in person; the neighbour Weber takes ordinary parcels but should not get the fresh food. The phone number the office called is the right one. The bell panel is inside the gateway.',
      must_establish: ['whether somebody will be home between 17:00 and 19:00', 'if not, from what time somebody will be home', 'whether a delivery after that time works for them today'],
      off_topic: ['parking', 'the gate code', 'where the driver is right now', 'what is in the box'],
      outcome: 'Nobody home before 18:00 — the driver comes after six; the office tells the driver.',
      next_call: 2,
    },
    {
      num: 2,
      title: 'Tell the driver — Brandt is home after six',
      callee: 'driver',
      stop: 1,
      purpose: 'Pass on what the customer at Kollwitzstraße 48 said about being home, and agree what the driver does with that stop: when they will be there, and that the fresh-food box stays in the cool box until then.',
      otto_says: 'Hi, Otto from the office here — got a moment? It\'s about the fresh-food box for Brandt, Kollwitzstraße 48.',
      previous_call: 'Brandt at Kollwitzstraße 48 is at work until 17:30 and home from 18:00; he wants the fresh-food box handed over in person after six.',
      they_say: 'Go on. I\'d be on Kollwitzstraße in about twenty minutes, so around half four.',
      they_know: 'Kollwitzstraße 48 is the 4th stop on the round. The driver can move it to the end of the round, which gets them there at about 18:15. The box is in the cool box and fine until 19:00. Nothing else on the round changes.',
      must_establish: ['that the driver understood the new time — after 18:00', 'what the driver does with the stop — moves it to the end of the round, or comes back', 'when the driver expects to be there'],
      off_topic: ['how the customer sounded', 'the gate code', 'parking on Kollwitzstraße'],
      outcome: 'Stop 4 moves to the end of the round — the driver is at Brandt\'s around 18:15, the box in the cool box until then.',
      next_call: null,
    },
    {
      num: 3,
      title: 'Home check — somebody is home, nothing to arrange',
      callee: 'consignee',
      stop: 5,
      purpose: 'A fresh-food box for J. Petrova is on today\'s round, due between 15:00 and 17:00. Fresh food is handed over in person. Find out whether somebody will be home in that window; if yes, there is nothing more to arrange.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Ms Petrova? I\'m calling about your fresh-food delivery this afternoon.',
      previous_call: '',
      they_say: 'Yes, that\'s me — I\'m home all afternoon, come whenever you like.',
      they_know: 'Home all day today. Hard of hearing: the driver should ring twice and give it a minute. Fourth floor, no lift. Nothing else to arrange.',
      must_establish: ['whether somebody will be home between 15:00 and 17:00'],
      off_topic: ['the lift', 'parking', 'the neighbours', 'another delivery day'],
      outcome: 'Petrova is home all afternoon — the driver comes as planned; ring twice and give it a minute.',
      next_call: null,
    },
    {
      num: 4,
      title: 'Home check — away until tomorrow, neighbour offered',
      callee: 'consignee',
      stop: 8,
      purpose: 'A fresh-food box for R. Fischer is on today\'s round, due between 17:00 and 19:00. Fresh food is handed to the customer in person — never to a neighbour, never left outside. Find out whether somebody will be home; if not, agree a new day and time.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Mr Fischer? I\'m calling about your fresh-food delivery this evening.',
      previous_call: '',
      they_say: 'I\'m away until tomorrow evening — can\'t you just leave it with Kern next door? She takes my parcels.',
      they_know: 'Away for work, back tomorrow at about 18:00. The neighbour Kern on the 4th floor takes ordinary parcels and is usually home. Tomorrow between 18:00 and 20:00 works. Nobody else has a key.',
      must_establish: ['whether somebody will be home between 17:00 and 19:00', 'that the fresh food cannot go to the neighbour — said plainly and politely', 'when the customer is back, and a new day and time that works'],
      off_topic: ['the lift', 'parking', 'the gate code', 'what the neighbour thinks'],
      outcome: 'Fischer is away until tomorrow evening — the box does not go to Kern; new delivery tomorrow between 18:00 and 20:00; the office tells the driver to skip the stop today.',
      next_call: 5,
    },
    {
      num: 5,
      title: 'Tell the driver — skip Fischer today',
      callee: 'driver',
      stop: 8,
      purpose: 'Tell the driver that the stop at Kollwitzstraße 71 is off today\'s round and why, and that the fresh-food box goes back to the depot for tomorrow evening. Make sure the driver does not try the neighbour.',
      otto_says: 'Hi, Otto from the office here — a quick one about Kollwitzstraße 71, the Fischer box.',
      previous_call: 'Fischer at Kollwitzstraße 71 is away until tomorrow evening. The fresh-food box must not go to the neighbour Kern; redelivery tomorrow between 18:00 and 20:00.',
      they_say: 'Okay — so I skip 71 and the box comes back with me?',
      they_know: 'Kollwitzstraße 71 is the 8th stop; skipping it saves about ten minutes. The box stays in the cool box and goes back to the depot at the end of the round. The driver can mark the stop as not delivered in the app.',
      must_establish: ['that the driver skips the stop today', 'that the box comes back to the depot — not to the neighbour', 'that the driver marks the stop as not delivered in the app'],
      off_topic: ['why the customer is away', 'the gate code', 'parking'],
      outcome: 'Stop 8 is skipped today — the box comes back to the depot for tomorrow 18:00–20:00; the driver marks it not delivered.',
      next_call: null,
    },
    {
      num: 6,
      title: 'Running late — when will the driver reach Okafor',
      callee: 'driver',
      stop: 3,
      purpose: 'The round is behind schedule. Find out how late the driver is and when they expect to reach Knaackstraße 22, where a fresh-food box for L. Okafor is due at 17:30, so the office can warn the customer.',
      otto_says: 'Hi, Otto from the office here — how are you doing for time? I\'m looking at the Okafor box on Knaackstraße 22.',
      previous_call: '',
      they_say: 'Yeah, I\'m behind — about twenty minutes. Traffic on Prenzlauer Allee.',
      they_know: 'Twenty minutes behind. Will reach Knaackstraße 22 at about 17:50 instead of 17:30. The cool box is fine. Two stops come before it. Would rather the office called only the fresh-food customers, not every stop.',
      must_establish: ['how far behind the driver is', 'when the driver expects to reach Knaackstraße 22'],
      off_topic: ['why the traffic is bad', 'the customer\'s phone number', 'the other stops in detail'],
      outcome: 'The driver reaches Okafor at about 17:50, twenty minutes late — the office warns the customer.',
      next_call: 7,
    },
    {
      num: 7,
      title: 'Late notice — twenty minutes late, the customer can wait',
      callee: 'consignee',
      stop: 3,
      purpose: 'Warn L. Okafor that the fresh-food box due at 17:30 will arrive about twenty minutes late, at about 17:50, and check that this still works. Fresh food is handed over in person. If the new time does not work, agree another one.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Ms Okafor? It\'s about your fresh-food delivery — the driver is running a little late.',
      previous_call: 'The driver is about twenty minutes behind and expects to reach Knaackstraße 22 at about 17:50 instead of 17:30.',
      they_say: 'Hmm. I have to leave at six, so that\'s cutting it close.',
      they_know: 'Leaves the house at 18:00 sharp. 17:50 works if the driver is punctual. If the driver slips past 18:00, tomorrow at 17:30 would be fine. No neighbour should get the fresh food.',
      must_establish: ['whether 17:50 still works for the customer', 'what happens if the driver is later than that — a fallback time'],
      off_topic: ['why the driver is late', 'parking', 'the gate code', 'what is in the box'],
      outcome: 'Okafor can take the box until 18:00 — 17:50 works; if the driver is later than six, redeliver tomorrow at 17:30.',
      next_call: null,
    },
    {
      num: 8,
      title: 'Late notice — forty minutes late, the customer cannot wait',
      callee: 'consignee',
      stop: 9,
      purpose: 'Warn S. Haddad that the fresh-food box due at 17:30 will arrive about forty minutes late, at about 18:10, and check whether that still works. Fresh food is handed over in person and cannot be left outside. If the new time does not work, agree a new day and time.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Mr Haddad? It\'s about your fresh-food delivery — the driver is running late.',
      previous_call: 'The driver is about forty minutes behind and expects to reach Husemannstraße 1 at about 18:10 instead of 17:30.',
      they_say: 'No, that doesn\'t work — I\'m leaving at half five and I won\'t be back before nine.',
      they_know: 'Leaves at 17:30, back at about 21:00. Tomorrow morning between 08:00 and 10:00 works. Nobody else at home. Does not want the box left in the hallway.',
      must_establish: ['whether 18:10 still works for the customer', 'if not, a new day and time that does'],
      off_topic: ['why the driver is late', 'parking', 'the bakery downstairs', 'what is in the box'],
      outcome: 'Haddad is out from 17:30 and back after 21:00 — new delivery tomorrow between 08:00 and 10:00; the office tells the driver to skip the stop today.',
      next_call: 9,
    },
    {
      num: 9,
      title: 'Tell the driver — skip Haddad, tomorrow morning instead',
      callee: 'driver',
      stop: 9,
      purpose: 'Tell the driver that Husemannstraße 1 is off today\'s round — the customer cannot wait for the late delivery — and that the fresh-food box goes back to the depot for tomorrow morning.',
      otto_says: 'Hi, Otto from the office again — about Husemannstraße 1, the Haddad box.',
      previous_call: 'Haddad at Husemannstraße 1 leaves at 17:30 and cannot take the box at 18:10; new delivery tomorrow between 08:00 and 10:00.',
      they_say: 'Fine, I\'ll leave that one. Does it go on tomorrow\'s first round then?',
      they_know: 'Skipping the stop saves about eight minutes and makes the rest of the round less late. The box goes back to the depot in the cool box. The driver cannot see tomorrow\'s rounds in the app; the office plans those.',
      must_establish: ['that the driver skips the stop today', 'that the box comes back to the depot for tomorrow morning'],
      off_topic: ['why the customer cannot wait', 'parking', 'the other late stops in detail'],
      outcome: 'Stop 9 is skipped today — the box comes back to the depot for tomorrow 08:00–10:00; the office plans the morning round.',
      next_call: null,
    },
    {
      num: 10,
      title: 'Wrong number — a stranger answers',
      callee: 'consignee',
      stop: 6,
      purpose: 'A fresh-food box for M. Aydın is on today\'s round, due between 17:00 and 19:00. Find out whether somebody will be home. If the person who answers is not the customer and does not know them, apologise and end the call — tell a stranger nothing about the delivery, the address or the customer.',
      otto_says: 'Hello, this is Otto from the delivery office. Am I speaking with Mr Aydın?',
      previous_call: '',
      they_say: 'Sorry, who? There\'s no Aydın here — you\'ve got the wrong number.',
      they_know: 'Has never heard of anyone called Aydın. Has no delivery coming. Mildly curious what this is about, but has nothing to do with it.',
      must_establish: ['that this is the wrong number', 'nothing more — Otto apologises and ends the call'],
      off_topic: ['the address', 'the name of the street', 'what is being delivered', 'the delivery window', 'asking the stranger to pass on a message'],
      outcome: 'Wrong number for Aydın — nothing about the delivery was said; the office checks the number on file.',
      next_call: null,
    },
  ],
};
