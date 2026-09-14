/*
 * The scenario as the agent hears it — the phone's own functions, ported
 * so a generated test carries exactly the dynamic variables a phone
 * sends on a real run, and nothing a phone never would. Mirrors, one
 * for one:
 *
 *   app.js         stripQuotes, sentence, fmtParamVal, fillParams,
 *                  notesOnFile, scenarioShape, resolveSays, questionFor,
 *                  LANG_TEXT's own spoken lines and voiceOpts().greeting
 *                  (agentGreeting here), agentVars, agentBriefing
 *   otto-agent.js  initPayload's dynamic-variable filter
 *                  (initDynamicVariables here)
 *
 * A change to any of those must be mirrored here. test/generate.test.mjs
 * reads agentVars' key list straight out of app.js and fails the moment
 * the two drift, so the mirror cannot go stale in silence.
 *
 * What the browser reads from live objects arrives here as arguments:
 * the destination (`current`), the run (`tracking` — null when the
 * debrief was opened by hand after tracking ended), the activity
 * recognition snapshot (`ActivityRec` — null when not armed), the
 * distance from the last fix to the pin (`LiveGeo.position`), the card's
 * language pick (`testLang`) and the translated openers scenario-ai
 * cached on the phone (`saysItCache`). The one measurement the phone
 * derives from coordinates, the parking distance (distM of the parking
 * fix to the pin), arrives as the number itself: a synthetic run has
 * no fix stream to derive it from.
 */

/* NOTES.maxNotes in app.js — the newest notes on file read aloud, and
 * the only ones the agent is told about */
export const NOTES = { maxNotes: 3 };

export const stripQuotes = s => String(s || '').trim().replace(/^[“”"']+/, '').replace(/[“”"']+$/, '');

/* sheet cells rarely end in a full stop; text stitched into a briefing
 * needs one, or two sentences read as one confused one */
export const sentence = s => { const t = String(s || '').trim(); return /[.!?…]$/.test(t) ? t : t + '.'; };

const fmtParamVal = v => String(Math.abs(+v) >= 100 ? Math.round(+v) : Math.round(+v * 100) / 100);
export const fillParams = (text, params) =>
  String(text == null ? '' : text).replace(/\{([a-z][a-z0-9_]*)\}/gi, (m, k) => {
    const p = Array.isArray(params) ? params.find(x => x && x.key === k) : null;
    return p && isFinite(+p.value) ? fmtParamVal(p.value) : m;
  });

/* jsonb from Supabase, plain array from a route file, string if hand-fed */
export const notesOnFile = d => {
  let n = d && d.notes;
  if (typeof n === 'string') { try { n = JSON.parse(n); } catch { n = null; } }
  return Array.isArray(n) ? n.filter(x => x && String(x.text || '').trim()) : [];
};

/* which detector shape a scenario arms — the park-and-walk shape is the
 * only one that measures a parking distance and a walk */
export const scenarioShape = sc =>
  ((sc && Array.isArray(sc.params) && sc.params.some(p => p && p.key === 'arrival_radius')) ? 'parkwalk' : 'passstop');

/* {park_m} / {walk_m} in a scenario's "Otto says" become the measured
 * distances of THIS run — Otto quotes what he saw */
export function resolveSays(text, run) {
  const tr = run;
  return String(text)
    .replace(/\{park_m\}/g, tr && tr.park_distance_m != null ? String(Math.round(tr.park_distance_m)) : 'some')
    .replace(/\{walk_m\}/g, tr ? String(Math.round(tr.walk_m || 0)) : 'some');
}

/* The question as the phone speaks it: the cached Italian when the
 * tester picked 🇮🇹 and the translation landed, the English original
 * otherwise. `saysIt` is that cache, keyed by the English line. */
export function questionFor(sc, { run = null, lang = 'en', saysIt = {} } = {}) {
  if (sc && sc.otto_says) {
    const src = stripQuotes(sc.otto_says);
    const it = (lang === 'it' && saysIt[src]) || null;
    return { text: resolveSays(it || src, run), lang: it ? 'it-IT' : 'en-US' };
  }
  return { text: lang === 'it' ? 'Cosa hai trovato?' : 'What did you find?', lang: lang === 'it' ? 'it-IT' : 'en-US' };
}

/* The app's own spoken lines (LANG_TEXT in app.js), the two the agent
 * can end up opening with. The `ask` fallback above belongs to the
 * keyless recorder; the AGENT's first message for a row without an
 * "Otto says" line is `at` — the phone overrides first_message with
 * voiceOpts().greeting, and that is what agentGreeting below returns
 * for such a row. test/generate.test.mjs reads both `at` lines out of
 * app.js and fails when these drift. */
export const LANG_TEXT = {
  en: {
    plain: 'Tap the mic and tell me what you found.',
    at: d => `This is ${d.title}${d.addr ? ' — ' + d.addr : ''}. What's the situation there? Tap the mic and describe what you see.`,
  },
  it: {
    plain: 'Tocca il microfono e dimmi cosa hai trovato.',
    at: d => `Questa è ${d.title}${d.addr ? ' — ' + d.addr : ''}. Com'è la situazione lì? Tocca il microfono e descrivi cosa vedi.`,
  },
};

/* voiceOpts().greeting in app.js — the line the phone hands the agent
 * as its first message: the row's "Otto says" question when the row has
 * one, the app's greeting for the destination otherwise. A generated
 * test that opened with anything else would grade the agent against an
 * opener no phone ever overrode it with. */
export function agentGreeting(sc, d, { run = null, lang = 'en', saysIt = {} } = {}) {
  if (sc && sc.otto_says) return questionFor(sc, { run, lang, saysIt }).text;
  const t = LANG_TEXT[lang === 'it' ? 'it' : 'en'];
  return d ? t.at(d) : t.plain;
}

/* agentVars() in app.js, key for key and in the same order. Everything
 * measured is what THIS run measured. */
export function agentVars({ scenario: sc, destination: d, run: tr = null, activity = null, distance_to_pin_m = null, lang = 'en', saysIt = {} }) {
  const p = sc && sc.params;
  const v = {
    destination_title: d ? d.title : '',
    destination_address: d ? (d.addr || `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`) : '',
    destination_lat: d ? d.lat : '',
    destination_lng: d ? d.lng : '',
    destination_consignee: d ? String(d.consignee || '') : '',
    destination_floor: d ? String(d.floor || '') : '',
    destination_notes: d ? notesOnFile(d).slice(0, NOTES.maxNotes)
      .map(n => (n.by === 'driver' ? 'a driver reported: ' : '') + n.text).join('; ') : '',
    scenario_num: sc && sc.num != null ? sc.num : '',
    scenario_title: sc ? sc.title : '',
    scenario_version: sc ? (sc.version || 1) : '',
    scenario_question: sc && sc.otto_says ? questionFor(sc, { run: tr, lang, saysIt }).text : '',
    debrief_language: lang === 'it' ? 'Italian' : 'English',
    scenario_rule: sc ? fillParams(sc.rule, p) : '',
    scenario_ar_states: sc ? sc.ar_states || '' : '',
    scenario_signals: sc ? sc.signals || '' : '',
    scenario_timing: sc ? fillParams(sc.timing, p) : '',
    scenario_test_steps: sc ? fillParams(sc.test_steps, p) : '',
    expected_tip_type: sc ? sc.learns || '' : '',
    trigger_fired: tr && tr.fired ? 'yes' : 'no',
    trigger_passes: tr ? tr.passes : '',
    trigger_stopped: tr ? (tr.stopped ? 'yes' : 'no') : '',
    park_distance_m: tr && tr.shape === 'parkwalk' && tr.park_distance_m != null ? Math.round(tr.park_distance_m) : '',
    walk_m: tr && tr.shape === 'parkwalk' ? Math.round(tr.walk_m || 0) : '',
    activity_state: activity ? String(activity.state || '') : '',
    activity_summary: activity ? String(activity.summary || '') : '',
  };
  if (distance_to_pin_m != null && d) v.distance_to_pin_m = Math.round(distance_to_pin_m);
  return v;
}

/* the measured facts of a fired run, in the briefing's words — reused
 * by the generator so a test's persona and success conditions quote
 * the same numbers the agent was given */
export function measuredBits(v) {
  const bits = [];
  if (v.trigger_passes !== '' && v.trigger_passes > 0) bits.push(`${v.trigger_passes} slow pass${v.trigger_passes === 1 ? '' : 'es'} near the pin`);
  if (v.trigger_stopped === 'yes') bits.push('a stop');
  if (v.park_distance_m !== '') bits.push(`parked ${v.park_distance_m} m from the pin`);
  if (v.walk_m !== '') bits.push(`walked ${v.walk_m} m`);
  return bits;
}

/* agentBriefing() in app.js — the contextual update the phone sends as
 * the conversation opens, from the variables above */
export function agentBriefing(v, lang = 'en') {
  const lines = [];
  lines.push(`You are Otto, debriefing a field tester who has just acted out a trigger scenario at ${v.destination_title || 'a destination'}${v.destination_address ? ` (${v.destination_address})` : ''}.`);
  if (v.scenario_title) lines.push(`Scenario${v.scenario_num !== '' ? ' #' + v.scenario_num : ''}: ${sentence(v.scenario_title + ' (v' + v.scenario_version + ')')}`);
  if (v.scenario_rule) lines.push(`The trigger rule under test: ${sentence(v.scenario_rule)}`);
  if (v.expected_tip_type) lines.push(`What this debrief should end up teaching us (tip type): ${v.expected_tip_type}.`);
  const onFile = [];
  if (v.destination_consignee) onFile.push(`the consignee is ${v.destination_consignee}${v.destination_floor ? ' (' + v.destination_floor + ')' : ''}`);
  else if (v.destination_floor) onFile.push(`the delivery goes to ${v.destination_floor}`);
  if (v.destination_notes) onFile.push(`notes on file: ${v.destination_notes}`);
  if (onFile.length) lines.push(sentence(`Pre-arrival notes on file, read to them on the way in: ${onFile.join('; ')}`));
  if (v.trigger_fired === 'yes') {
    const bits = measuredBits(v);
    lines.push(`The trigger fired on this run${bits.length ? ': the phone measured ' + bits.join(', ') + '.' : '.'}`);
  } else {
    lines.push('This debrief was opened by hand — the trigger did not fire on this run.');
  }
  if (v.activity_summary) lines.push(`Activity the phone observed: ${v.activity_summary}.`);
  lines.push('Ask about what they actually found on the ground, keep it to a couple of short questions, and let them go.');
  if (lang === 'it') lines.push('This tester chose Italian: conduct the entire debrief in Italian — every question and reply.');
  return lines.join(' ');
}

/* initPayload() in otto-agent.js: everything goes up as a string, an
 * empty value goes up as nothing at all — a null there reads as "null"
 * in the prompt. Numbers stay numbers. */
export function initDynamicVariables(vars) {
  const dynamic_variables = {};
  Object.keys(vars || {}).forEach(k => {
    const v = vars[k];
    if (v === null || v === undefined || v === '') return;
    dynamic_variables[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  });
  return dynamic_variables;
}
