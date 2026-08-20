/**
 * Scripted demo conversation. Otto's answers are canned — nothing here talks to
 * a model — but every one of them is grounded in the sample tips and delivery
 * records that the other views show.
 *
 * Answer text supports **bold** spans.
 */

export interface AnswerBullet {
  tone: 'honey' | 'green';
  text: string;
}

export interface AnswerRow {
  tone: 'honey' | 'green';
  label: string;
  meta: string;
  metaTone?: 'muted' | 'warn';
}

export interface OttoAnswer {
  lead: string;
  bullets?: AnswerBullet[];
  rows?: AnswerRow[];
  tail?: string;
  /** Where the answer came from. */
  sources?: string[];
  /** Follow-ups Otto offers under the bubble. */
  actions?: string[];
}

export type ChatTurn =
  | { id: string; role: 'operator'; text: string }
  | { id: string; role: 'otto'; answer: OttoAnswer };

const MONDAYS: OttoAnswer = {
  lead: 'Route 14 failed 9 stops across the last 4 Mondays, and three stops account for 7 of them:',
  bullets: [
    {
      tone: 'honey',
      text: '**Möwensteig 8** (4 fails) — no access tip on file. The building moved to a concierge that is closed on Mondays.',
    },
    {
      tone: 'honey',
      text: '**Alte Werft 3** (2 fails) — the caretaker signs only until 14:00, and Monday loads run late. A matching access tip from Deniz K. is waiting in the curation queue.',
    },
    {
      tone: 'honey',
      text: '**Kranweg 12** (1 fail) — the elevator tip is stale; an update from Jonas B. is pending review.',
    },
  ],
  tail: 'Approving the two pending tips and asking for one debrief at Möwensteig 8 would cover all three.',
  sources: ['Delivery records · 4 Mondays', 'Curation queue · 2 pending', 'Otto debriefs'],
};

const DOOR_CODES: OttoAnswer = {
  lead: 'Five stops on route 14 have a door code on file:',
  rows: [
    { tone: 'green', label: '**Kranweg 12**', meta: 'confirmed Aug 11' },
    { tone: 'green', label: '**Werftstraße 15**', meta: 'confirmed Aug 6' },
    { tone: 'green', label: '**Salzgasse 7**', meta: 'confirmed Jul 30' },
    { tone: 'green', label: '**Hellingweg 2**', meta: 'confirmed Jul 22' },
    { tone: 'honey', label: '**Werftstraße 40**', meta: 'May 30 — going stale', metaTone: 'warn' },
  ],
  tail: 'Werftstraße 40 is the oldest — worth a reconfirm on the next run.',
  sources: ['Rte 14 · 47 stops', '5 door-code tips'],
};

const KRANWEG_BRIEF: OttoAnswer = {
  lead: 'Three tips on file: the gate code is **4711#** (courtyard door left of the ramp, confirmed Aug 11), the **Salzgasse loading bay** is free before 10:00, and the elevator tip is stale — an update from Jonas B. is pending review.',
  sources: ['3 tips · Kranweg 12', '1 pending in queue'],
  actions: [
    'Review the pending update',
    'Stops on Rte 14 without a door code',
    'Ask Rte 14 drivers to reconfirm',
  ],
};

const NO_DOOR_CODE: OttoAnswer = {
  lead: 'Five of the stops with open questions on route 14 have no door code on file:',
  rows: [
    { tone: 'honey', label: '**Möwensteig 8**', meta: 'no tips at all' },
    { tone: 'honey', label: '**Alte Werft 3**', meta: 'parking and access only' },
    { tone: 'honey', label: '**Möwenkai 3**', meta: 'no tips at all' },
    { tone: 'green', label: '**Kaimauer 22**', meta: 'access tip, Jul 18' },
    { tone: 'green', label: '**Salzgasse 19**', meta: 'elevator tip, Jul 25' },
  ],
  tail: 'The first three are worth a debrief on the next run — all three sit inside courtyards.',
  sources: ['Rte 14 · 47 stops', 'Approved tips'],
};

const PENDING_UPDATE: OttoAnswer = {
  lead: 'The pending update for **Kranweg 12** came from Jonas B. yesterday at 16:20: the freight elevator is back in service, so no more stairwell B runs for the upper floors. It replaces the stale elevator tip.',
  tail: 'It is waiting in the curation queue — approve it there and it goes live for every driver on Rte 14.',
  sources: ['Curation queue · Rte 14', 'Otto debrief · Jonas B.'],
};

const RECONFIRM: OttoAnswer = {
  lead: 'I can queue a reconfirm for the next run. On Rte 14 that is **three tips**:',
  rows: [
    { tone: 'honey', label: '**Werftstraße 40** · door code', meta: 'May 30', metaTone: 'warn' },
    { tone: 'honey', label: '**Alte Werft 3** · parking', meta: 'Jun 12', metaTone: 'warn' },
    { tone: 'honey', label: '**Kranweg 12** · elevator', meta: 'update already pending' },
  ],
  tail: 'Jonas B. and Deniz K. share the rotation — Otto asks each of them at the stop, and a yes or no is enough.',
  sources: ['Rte 14 · 3 stale tips', 'Rotation · Jonas B. · Deniz K.'],
};

const GOING_STALE: OttoAnswer = {
  lead: '**23 tips** pass 90 days without a reconfirm this month. They sit on five routes:',
  rows: [
    { tone: 'honey', label: '**Rte 22** · Gewerbehof süd', meta: '7 tips', metaTone: 'warn' },
    { tone: 'honey', label: '**Rte 17** · Möwenkai', meta: '6 tips', metaTone: 'warn' },
    { tone: 'honey', label: '**Rte 14** · Werftviertel', meta: '5 tips', metaTone: 'warn' },
    { tone: 'green', label: '**Rte 12** · Hafen west', meta: '3 tips' },
    { tone: 'green', label: '**Rte 18** · Speicherstadt', meta: '2 tips' },
  ],
  tail: 'Depot-wide, 68% of the 486 approved tips were confirmed in the last 30 days.',
  sources: ['486 approved tips', 'Tip freshness'],
};

const NEEDS_PARKING: OttoAnswer = {
  lead: 'Eleven of this week’s 39 failed stops had no current parking tip. Four of them failed more than once:',
  rows: [
    { tone: 'honey', label: '**Alte Werft 3** · Rte 14', meta: 'parking tip stale', metaTone: 'warn' },
    { tone: 'honey', label: '**Möwenkai 21** · Rte 17', meta: 'tip pending review' },
    { tone: 'honey', label: '**Gewerbehof süd 2** · Rte 22', meta: 'tip pending review' },
    { tone: 'honey', label: '**Hafenstraße 14** · Rte 12', meta: 'no parking tip' },
  ],
  tail: 'Two of the four already have a tip waiting in the curation queue.',
  sources: ['Failed stops · this week', 'Curation queue · 2 pending'],
};

const RTE_18_CHANGES: OttoAnswer = {
  lead: 'One change on **Rte 18** this week: Ruth H. reported at 07:42 this morning that the front gate code at Speicherweg 5 changed to **2481#**. The old code stopped working and a neighbour let her in.',
  tail: 'It is pending review in the curation queue. Nothing else on the route changed — ETA accuracy holds at 93%.',
  sources: ['Curation queue · Rte 18', 'Otto debrief · Ruth H.'],
};

const FALLBACK: OttoAnswer = {
  lead: 'That one is outside the scripted demo. In the live product I would answer it from the approved tips and the depot’s delivery records.',
  tail: 'The suggestions below are wired up — try one of those.',
};

const SCRIPT: { match: RegExp; answer: OttoAnswer }[] = [
  { match: /pending update|review the pending/i, answer: PENDING_UPDATE },
  { match: /reconfirm/i, answer: RECONFIRM },
  { match: /without a door code|need (a |an )?door code/i, answer: NO_DOOR_CODE },
  { match: /door code/i, answer: DOOR_CODES },
  { match: /kranweg/i, answer: KRANWEG_BRIEF },
  { match: /stale|fresh/i, answer: GOING_STALE },
  { match: /parking/i, answer: NEEDS_PARKING },
  { match: /(rte|route) ?18/i, answer: RTE_18_CHANGES },
  { match: /monday|fail/i, answer: MONDAYS },
];

/** Picks Otto's scripted reply for a question. Never throws — falls back. */
export function answerFor(question: string): OttoAnswer {
  return SCRIPT.find((entry) => entry.match.test(question))?.answer ?? FALLBACK;
}

/** Opening thread on the Ask view. */
export const ASK_THREAD: ChatTurn[] = [
  { id: 'ask-1', role: 'operator', text: 'Why does route 14 fail on Mondays?' },
  { id: 'ask-2', role: 'otto', answer: MONDAYS },
  { id: 'ask-3', role: 'operator', text: 'Which stops on route 14 have door codes?' },
  { id: 'ask-4', role: 'otto', answer: DOOR_CODES },
];

export const ASK_SUGGESTIONS = [
  'Which tips go stale this month?',
  'Which stops still need parking tips?',
  'What changed on Rte 18 this week?',
];

/** Opening thread in the map's Ask panel, grounded on the selected stop. */
export const MAP_THREAD: ChatTurn[] = [
  { id: 'map-1', role: 'operator', text: 'Anything I should know about Kranweg 12?' },
  { id: 'map-2', role: 'otto', answer: KRANWEG_BRIEF },
];

/** What Otto has heard so far in the live capture shown on the map. */
export const MAP_PARTIAL_TRANSCRIPT = 'Which stops on route 14 still need a door code';
