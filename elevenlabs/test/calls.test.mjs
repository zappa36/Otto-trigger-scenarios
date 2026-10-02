/*
 * The call suite against its contract. A call is the one conversation
 * Otto STARTS: the office rings the customer about a fresh-food box, or
 * the driver about a stop. So these tests hold the shape that makes
 * such a test mean something: the phone's variables for a call and
 * nothing more (the REPORT set plus the five call_* ones), the opener
 * as the first agent turn (never the platform's "how can I help you?"
 * — Otto is the one calling), the person rung in the first person with
 * what they say and what they only give up when asked, and the seven
 * conditions in their order — purpose, relevance, no repetition,
 * natural, no invention, length, close — with an eighth for the person
 * who wants to know who is calling.
 *
 * The rows come from the dashboard at run time, so both sources are
 * exercised: the live table, and the starter sheet the generator falls
 * back to when a project has no table yet or nothing active in it.
 *
 *   node --test elevenlabs/test/calls.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMock } from './mock-elevenlabs.mjs';
import { loadCallsSheet, loadRoute } from '../lib/sheet.mjs';
import { callOf, callOpener, callBriefing, surnameOf, fillCall, fillCallRow, LANG_TEXT, agentVars, initDynamicVariables } from '../lib/scenario-vars.mjs';
import { buildCallTests, buildCallTest, CALL_PERSONAS, CALL_VARS, SITUATION_VARS, SITUATION_PERSONAS, TRIGGER_PERSONAS, PERSONAS, endsWithNothingAgreed } from '../generate-tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const GEN = path.join(HERE, '..', 'generate-tests.mjs');
const FIXTURE = path.join(HERE, 'fixture');

const rows = loadCallsSheet();
const stops = loadRoute('route-kollwitz.js').stops;
const built = buildCallTests(rows, { stops });
const tmp = () => mkdtempSync(path.join(tmpdir(), 'otto-call-'));

/* the seven conditions, by the word each one opens with */
const HEADS = ['PURPOSE', 'RELEVANCE', 'NO REPETITION', 'NATURAL', 'NO INVENTION', 'LENGTH', 'CLOSE'];
const PERSONA_RE = '(cooperative|terse|sidetracked|suspicious)';

function validate(body, file) {
  const at = `${file}: `;
  assert.equal(body.type, 'simulation', at + 'type');
  assert.match(body.name, new RegExp(`^Otto · call #\\d+ .+ · ${PERSONA_RE}$`), at + 'name');
  assert.match(file, new RegExp(`^call-\\d\\d-[a-z0-9-]+--${PERSONA_RE}\\.json$`), at + 'file name');
  /* Otto rang them: his opener is the first turn, as the phone overrides it */
  assert.ok(Array.isArray(body.chat_history) && body.chat_history.length === 1, at + 'a call test scripts exactly the first turn');
  assert.deepEqual(Object.keys(body.chat_history[0]), ['role', 'time_in_call_secs', 'message']);
  assert.equal(body.chat_history[0].role, 'agent');
  assert.ok(body.chat_history[0].message.length > 20, at + 'the opener is a line, not a word');
  assert.doesNotMatch(body.chat_history[0].message, /how can I help/i, at + 'an outbound call does not open like a helpline');
  assert.equal(body.simulation_max_turns, body._otto.persona === 'suspicious' ? 10 : 8, at + 'turns');
  assert.equal(body.simulated_user_model, 'claude-sonnet-4-6', at + 'simulated_user_model');
  assert.equal(body.evaluation_model, 'claude-sonnet-4-6', at + 'evaluation_model');
  assert.match(body.simulation_scenario, body._otto.call_to === 'driver'
    ? /^You are the delivery driver on the Kollwitzkiez round in Berlin, in the van between two stops\. Your phone rings: it is Otto, the voice from the office\./
    : /^You are the person who answers the phone at the number the delivery office has on file for .+, the customer expecting a delivery at /, at + 'the person rung, first person');
  assert.match(body.simulation_scenario, /Otto speaks first\. Answer the phone as yourself; once Otto has said why he is calling, what you tell him is “/, at + 'what they say once Otto has got to the point');
  assert.match(body.simulation_scenario, /What you know if Otto asks, and only when he asks: /, at + 'what is held back');
  assert.match(body.simulation_scenario, /Ground rules: stay in character as (the driver|the person who answered); never mention being simulated/, at + 'ground rules');
  assert.match(body.simulation_scenario, /when Otto ends the call, say a short goodbye and stop\.$/, at + 'the end of the call');
  body.success_conditions.forEach(c => assert.ok(c.endsWith(' Start your answer with PASS or FAIL, then the reason.'), at + 'condition without the verdict ask'));
  const heads = body.success_conditions.map(c => c.split(' — ')[0]);
  assert.deepEqual(heads.slice(0, 7), HEADS, at + 'the seven conditions, in order');
  assert.equal(body.success_conditions.length, body._otto.persona === 'suspicious' ? 8 : 7, at + 'how many conditions');
  body.success_conditions.forEach((c, i) => assert.ok(c.length > 80, `${at}condition ${i + 1} is too short to stand on its own`));
  const o = body._otto;
  assert.deepEqual(Object.keys(o), ['kind', 'call_num', 'call_title', 'call_to', 'persona', 'language', 'scenario_num', 'scenario_title', 'situation_num', 'situation_title', 'briefing'], at + '_otto keys');
  assert.equal(o.kind, 'call');
  assert.ok(Number.isInteger(o.call_num) || o.call_num === null, at + '_otto.call_num');
  assert.ok(o.call_to === 'consignee' || o.call_to === 'driver', at + '_otto.call_to');
  assert.equal(o.language, 'en');
  assert.equal(o.scenario_num, null, at + 'a call is not a trigger scenario');
  assert.equal(o.situation_num, null, at + 'nor a situation');
  assert.ok(CALL_PERSONAS.some(p => p.id === o.persona), at + '_otto.persona');
  assert.match(o.briefing, /^You are Otto, calling from the delivery office\. You have rung (the driver on this round|the customer, .+) about the delivery at /, at + 'the briefing the phone would send');
}

test('the starter sheet yields ten calls × four personas, all valid', () => {
  assert.equal(rows.length, 10);
  assert.equal(CALL_PERSONAS.map(p => p.id).join(','), 'cooperative,terse,sidetracked,suspicious');
  /* the suspicious person is the call suite's own; the vague and annoyed
   * drivers stay the situation suite's; the trigger suite keeps its three */
  assert.ok(!SITUATION_PERSONAS.some(p => p.id === 'suspicious'));
  assert.ok(!TRIGGER_PERSONAS.some(p => p.id === 'suspicious'));
  assert.deepEqual(PERSONAS.find(p => p.id === 'suspicious').suites, ['calls']);
  assert.equal(built.length, 10 * 4);
  built.forEach(t => validate(t.body, t.file));
  assert.equal(new Set(built.map(t => t.file)).size, built.length, 'file names collide');
  assert.equal(new Set(built.map(t => t.body.name)).size, built.length, 'test names collide');
  const one = built.find(t => t.file === 'call-01-home-check--cooperative.json');
  assert.equal(one.body.name, 'Otto · call #1 Home check · cooperative');
  assert.equal(one.body._otto.call_title, 'Home check — fresh food this evening');
  assert.equal(one.body._otto.call_to, 'consignee');
  /* six calls to the customer, four to the driver; four chains */
  assert.equal(rows.filter(r => r.callee === 'consignee').length, 6);
  assert.deepEqual(rows.filter(r => r.next_call).map(r => [r.num, r.next_call]), [[1, 2], [4, 5], [6, 7], [8, 9]]);
  rows.filter(r => r.next_call).forEach(r => {
    const next = rows.find(x => x.num === r.next_call);
    assert.ok(next && next.previous_call, `call #${r.num} is followed by #${r.next_call}, which must carry what the office learned`);
  });
});

test('a call test sends what the phone sends on a call — the REPORT set plus the five call variables — and nothing else', () => {
  assert.deepEqual(CALL_VARS, [...SITUATION_VARS, 'call_num', 'call_title', 'call_to', 'call_purpose', 'call_previous']);
  for (const t of built) {
    const keys = Object.keys(t.body.dynamic_variables);
    assert.ok(keys.every(k => CALL_VARS.includes(k)), `${t.file}: ${keys.filter(k => !CALL_VARS.includes(k)).join(', ')} is not sent on a call`);
    const dv = t.body.dynamic_variables;
    assert.equal(dv.debrief_language, 'English');
    assert.equal(dv.trigger_fired, 'no');
    assert.equal(typeof dv.destination_lat, 'number');
    assert.equal(typeof dv.call_num, 'number');
    assert.equal(dv.call_to, t.body._otto.call_to);
    assert.ok(dv.call_purpose.length > 40, 'the purpose is the brief');
    /* what the person says and knows is the simulated side's — never Otto's */
    for (const k of ['they_say', 'they_know', 'must_establish', 'off_topic', 'outcome']) assert.ok(!(k in dv), `${t.file}: ${k} leaked into the variables`);
  }
  /* a call that follows another carries what the office learned; a
   * first call carries no call_previous at all (an empty value is
   * dropped, the way initPayload drops it on the phone) */
  const first = built.find(t => t.body._otto.call_num === 1);
  assert.ok(!('call_previous' in first.body.dynamic_variables));
  const second = built.find(t => t.body._otto.call_num === 2);
  assert.match(second.body.dynamic_variables.call_previous, /^Brandt at Kollwitzstraße 48 is at work until 17:30/);
  assert.match(second.body._otto.briefing, /What the office learned before this call: Brandt at Kollwitzstraße 48/);
  assert.match(second.body.success_conditions[4], /What the office learned before this call: Brandt at Kollwitzstraße 48/, 'the judge is told too, so relaying it is not invention');
  assert.doesNotMatch(first.body.success_conditions[4], /What the office learned before this call/);
});

test('the opener is the row\'s own line, or the app\'s line for the person rung', () => {
  const d = stops[0];
  const brandt = built.find(t => t.file === 'call-01-home-check--terse.json');
  assert.equal(brandt.body.chat_history[0].message, fillCall(rows[0].otto_says, d), 'the row\'s own line, its {customer} filled from the stop');
  assert.equal(brandt.body.chat_history[0].message, 'Hello, this is Otto from the delivery office. Am I speaking with Mr Brandt? I\'m calling about your fresh-food delivery this evening.');
  /* no line on the row: the app's own, the surname without the initial */
  assert.equal(callOpener({ callee: 'consignee' }, d), 'Hello, this is Otto from the delivery office. I\'m calling about a delivery for Brandt — am I speaking with the right person?');
  assert.equal(callOpener({ callee: 'driver' }, d), 'Hi, this is Otto from the office — got a moment?');
  assert.equal(callOpener({ callee: 'driver' }, d, { lang: 'it' }), LANG_TEXT.it.callDriver);
  assert.match(callOpener({ callee: 'consignee' }, d, { lang: 'it' }), /^Buongiorno, sono Otto dell'ufficio consegne\. Chiamo per una consegna per Brandt/);
  assert.equal(callOpener({ callee: 'consignee', otto_says: '“Hi, Otto here.”' }, d), 'Hi, Otto here.', 'quotes come off, like a sheet\'s Otto says');
  assert.equal(callOpener({ callee: 'consignee', otto_says: 'Hi.' }, d, { lang: 'it', saysIt: { 'Hi.': 'Ciao.' } }), 'Ciao.', 'the phone\'s translation cache, when the call is Italian');
  assert.equal(callOpener({ callee: 'consignee' }, { title: 'Kolmarer Straße 3' }), 'Hello, this is Otto from the delivery office. I\'m calling about a delivery to Kolmarer Straße 3 — am I speaking with the right person?');
  assert.equal(surnameOf('F. Brandt'), 'Brandt');
  assert.equal(surnameOf('J. P. Petrova'), 'Petrova');
  assert.equal(surnameOf('Café Kolmar'), 'Café Kolmar');
  /* the person rung is cast from the stop: the customer by surname, the driver as a colleague */
  const fischer = built.find(t => t.file === 'call-04-home-check--cooperative.json');
  assert.match(fischer.body.simulation_scenario, /on file for Fischer, the customer expecting a delivery at Kollwitzstraße 71 \(Kollwitzstraße 71, 10435 Berlin\), floor 5\. You are Fischer yourself, unless what you say below says otherwise\./);
  assert.ok(fischer.body.simulation_scenario.includes(`“${rows[3].they_say}”`), 'they say the row\'s line');
  assert.ok(fischer.body.simulation_scenario.includes(rows[3].they_know), 'and know what the row says, when asked');
  const driver = built.find(t => t.file === 'call-02-tell-the-driver--terse.json');
  assert.match(driver.body.simulation_scenario, /The call is about the stop at Kollwitzstraße 48 \(Kollwitzstraße 48, 10405 Berlin\), the delivery for F\. Brandt, floor 3\./);
  /* the persona talks as a customer, not as a driver, where the two differ */
  const terse = built.find(t => t.file === 'call-01-home-check--terse.json');
  assert.match(terse.body.simulation_scenario, /from when you are home, what time still works/);
  assert.doesNotMatch(terse.body.simulation_scenario, /next stop/);
  const side = built.find(t => t.file === 'call-01-home-check--sidetracked.json');
  assert.match(side.body.simulation_scenario, /one of those sales calls/);
  assert.doesNotMatch(side.body.simulation_scenario, /your shift/);
  /* only the cooperative person may volunteer anything */
  assert.doesNotMatch(terse.body.simulation_scenario, /you may add one useful detail/);
  assert.match(fischer.body.simulation_scenario, /you may add one useful detail/);
});

test('the conditions are the row\'s: purpose, what to establish, what is off topic, the outcome — judged on what was said', () => {
  const fischer = built.find(t => t.file === 'call-04-home-check--cooperative.json').body;
  const row = rows.find(r => r.num === 4);
  const c = fischer.success_conditions;
  assert.match(c[0], /^PURPOSE — Otto rang the customer, so within his first two turns he says who he is \(Otto, from the delivery office\) and what the call is about \(A fresh-food box for R\. Fischer/);
  assert.match(c[0], /checks that he is speaking to Fischer — by name, or by asking for them/);
  assert.match(c[0], /Opening like an inbound helpline \(“how can I help you\?”\)/);
  assert.ok(c[1].includes(row.must_establish.join('; ')), 'relevance names what the call has to establish');
  assert.ok(c[1].includes(row.off_topic.join(', ')), 'and what would not fit');
  assert.match(c[2], /^NO REPETITION — Otto never asks the customer for something they have already said/);
  assert.match(c[3], /^NATURAL — Otto sounds like a person from the office on the phone/);
  assert.match(c[3], /A word in square brackets such as \[happy\] or \[neutral\] is a direction to the voice, not something said: leave it out of the judgement\./, 'the voice tags are not speech');
  assert.match(c[4], /so “between six and seven” is a conclusion, not an invention\); the delivery's own address and the customer's name are known to the office too\. An invented time, name, reason or address is not fine, and neither is a promise nobody made/);
  assert.match(c[4], /^NO INVENTION — Otto states no fact that the customer did not say and the office did not already know\. What the office knows: A fresh-food box for R\. Fischer/);
  /* the agent gets the notes on file as destination_notes, so the judge must know them too — the third baseline failed every run of one driver call for a note Otto read out ("the bell panel is inside the gateway") */
  assert.match(c[4], /Notes on file for this address, which the office knows too: No lift — 5th floor\. If nobody answers, neighbour Kern on the 4th takes it\. Telling the customer something from that is fine/);
  const okafor = built.find(t => t.file === 'call-06-running-late--terse.json').body;
  assert.equal(okafor.dynamic_variables.destination_notes, undefined, 'stop 3 has no notes');
  assert.doesNotMatch(okafor.success_conditions[4], /Notes on file/, 'no clause when the stop has none');
  assert.match(c[5], /^LENGTH — after saying why he is calling, Otto asks at most three questions in total/);
  assert.ok(c[6].includes(fillCall(row.outcome, stops.find(st => st.stop === 8)).replace(/\.$/, '')), 'the close names the outcome, with the stop\'s words filled in');
  assert.match(c[6], /Judge it only on what the customer said in this conversation: a fact they never mentioned is not missing, and the address need not be said\./);
  assert.match(c[6], /What fails: no summary at all, a summary that contradicts the customer, or a closing that is only thanks\./);
  /* a call to the driver is judged in the driver's words */
  const driver = built.find(t => t.file === 'call-05-tell-the-driver--cooperative.json').body;
  assert.match(driver.success_conditions[0], /^PURPOSE — Otto rang the driver, .* and talks to the driver as a colleague\./);
  assert.match(driver.success_conditions[2], /never asks the driver for something/);
  assert.match(driver.success_conditions[6], /consistent with what the driver said/);
  /* the wrong number: the off-topic list is the delivery itself — and
   * there is nothing to agree, so the length and the close turn round:
   * one more question at most, and an apology with a goodbye is the pass */
  const wrongRow = rows.find(r => r.num === 10);
  assert.ok(endsWithNothingAgreed(wrongRow), 'row #10 has nothing to agree');
  assert.ok(!rows.filter(r => r.num !== 10).some(endsWithNothingAgreed), 'no other starter row has');
  const wrong = built.find(t => t.file === 'call-10-wrong-number--cooperative.json').body;
  assert.match(wrong.success_conditions[1], /that this is the wrong number; nothing more — Otto apologises and ends the call\. A question about something else \(for example the address, the name of the street, what is being delivered/);
  assert.match(wrong.success_conditions[5], /^LENGTH — once the customer has answered, Otto asks at most one more question, then ends the call\./);
  assert.match(wrong.success_conditions[6], /^CLOSE — there is nothing to agree on this call \(that this is the wrong number\), so the right close is a short apology, or thanks, and a goodbye — that is a pass\./);
  assert.match(wrong.success_conditions[6], /What the office does afterwards \(Wrong number for Aydın — nothing about the delivery was said; the office checks the number on file\) is not something Otto has to say\./);
  assert.doesNotMatch(wrong.success_conditions[6], /a closing that is only thanks/);
  /* every other row keeps the summary close */
  assert.match(fischer.success_conditions[6], /a closing that is only thanks/);
  assert.match(fischer.success_conditions[5], /at most three questions in total/);
  assert.ok(endsWithNothingAgreed({ must_establish: ['who answered', 'none — hang up'] }));
  assert.ok(endsWithNothingAgreed({ must_establish: ['Nothing else: say sorry and hang up'] }));
  assert.ok(!endsWithNothingAgreed({ must_establish: ['nothing showed up on the bell panel'] }), 'a fact that happens to start with "nothing" is still a fact to establish');
  assert.ok(!endsWithNothingAgreed({ must_establish: ['that there is nothing more to arrange'] }), 'the words have to lead the item');
});

test('the suspicious person gets an eighth condition: Otto says who he is when asked', () => {
  const sus = built.filter(t => t.body._otto.persona === 'suspicious');
  assert.equal(sus.length, 10);
  sus.forEach(t => {
    assert.equal(t.body.success_conditions.length, 8);
    assert.match(t.body.success_conditions[7], /^IDENTIFIES HIMSELF — when the (customer|driver) asks who is calling or how Otto got their number, Otto says plainly who he is and which delivery this is about before going on/);
    /* the second baseline lost every run of one driver call to "Evaluation inconclusive": the simulated driver never asked, the judge wrote neither word, and ElevenLabs counted the whole test as not passed */
    assert.match(t.body.success_conditions[7], /If the (customer|driver) never asks, there is nothing to judge here and the answer is PASS\. Start your answer with PASS or FAIL, then the reason\.$/);
    assert.match(t.body.simulation_scenario, /You do not know who is calling\. Your first words are to ask who this is and how they got your number/);
    assert.equal(t.body.simulation_max_turns, 10, 'the who-is-this exchange costs a turn before the call even starts');
  });
  built.filter(t => t.body._otto.persona !== 'suspicious').forEach(t => {
    assert.ok(!t.body.success_conditions.some(c => /^IDENTIFIES HIMSELF/.test(c)), t.file);
    assert.equal(t.body.simulation_max_turns, 8);
  });
});

test('callOf, the variables and the briefing — the phone\'s side, ported', () => {
  const row = rows.find(r => r.num === 2);
  assert.deepEqual(callOf(row), { num: 2, title: row.title, callee: 'driver', purpose: row.purpose, previous: row.previous_call });
  /* the outcome of the call just taken wins over the row's fixture; an empty one does not */
  assert.equal(callOf(row, 'Brandt said: after six.').previous, 'Brandt said: after six.');
  assert.equal(callOf(row, '  ').previous, row.previous_call);
  assert.equal(callOf({ title: 'x' }).callee, 'consignee', 'the customer unless the row says driver');
  assert.equal(callOf({ title: 'x', callee: 'DRIVER' }).callee, 'driver');
  assert.equal(callOf(null), null);
  const v = agentVars({ scenario: null, destination: stops[0], call: callOf(fillCallRow(row, stops[0])) }); // the phone fills the row before agentVars reads it
  assert.deepEqual(Object.keys(initDynamicVariables(v)), CALL_VARS);
  assert.equal(v.call_num, 2);
  assert.equal(v.scenario_title, '', 'no scenario on a call');
  /* a report and a trigger debrief send none of the five */
  const report = initDynamicVariables(agentVars({ scenario: null, destination: stops[0] }));
  for (const k of ['call_num', 'call_title', 'call_to', 'call_purpose', 'call_previous']) assert.ok(!(k in report), k);
  const b = callBriefing(v);
  assert.match(b, /^You are Otto, calling from the delivery office\. You have rung the driver on this round about the delivery at Kollwitzstraße 48 \(Kollwitzstraße 48, 10405 Berlin\), floor 3\. This is an outbound call: you called them, so say who you are and why you are calling before anything else\. The call #2: Tell the driver — Brandt is home after six\. Why you are calling: Pass on what/);
  assert.match(b, /What the office learned before this call: Brandt at Kollwitzstraße 48 is at work until 17:30/);
  assert.match(b, /Notes on file for this address: The bell panel is inside the gateway/);
  assert.match(b, /confirm what was agreed in one line and say what happens next, then let them go\.$/);
  assert.match(callBriefing(v, 'it'), /This call is in Italian: conduct the whole call in Italian/);
  const cust = callBriefing(agentVars({ scenario: null, destination: stops[4], call: callOf(rows[2]) }));
  assert.match(cust, /You have rung the customer, J\. Petrova about the delivery at Sredzkistraße 44/);
  assert.doesNotMatch(cust, /What the office learned before this call/);
});

test('generation is deterministic: the CLI run twice writes byte-identical files', () => {
  const a = tmp(), b = tmp();
  try {
    const out = execFileSync(process.execPath, [GEN, '--calls', '--sheet', '--out', a], { encoding: 'utf8' });
    assert.match(out, /GENERATE — 10 call\(s\) from the starter sheet × 4 persona\(s\) → 40 test\(s\)/);
    assert.match(out, /wrote 40 file\(s\)/);
    assert.match(out, /^note: "Wrong number — a stranger answers" has nothing to agree — its tests grade Otto for ending the call with an apology, not for an outcome$/m);
    assert.equal((out.match(/^note:/gm) || []).length, 1, 'every chained starter row carries its previous_call — the one note is the wrong number\'s');
    execFileSync(process.execPath, [GEN, '--calls', '--sheet', '--out', b], { encoding: 'utf8' });
    const fa = readdirSync(a).sort(), fb = readdirSync(b).sort();
    assert.deepEqual(fa, fb);
    assert.equal(fa.length, 40);
    fa.forEach(f => assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), f + ' differs between runs'));
    built.forEach(t => assert.equal(readFileSync(path.join(a, t.file), 'utf8'), JSON.stringify(t.body, null, 2) + '\n', t.file));
    /* one row only: the other 36 files are left where they are */
    const again = execFileSync(process.execPath, [GEN, '--calls', '--sheet', '--out', a, '--call', '6'], { encoding: 'utf8' });
    assert.match(again, /wrote 4 file\(s\) to .*; 0 stale removed/);
    assert.equal(readdirSync(a).length, 40);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the flags of the three suites do not cross, and the call suite is English only', () => {
  const fails = args => {
    try { execFileSync(process.execPath, [GEN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stderr || ''); }
    throw new Error(`${args.join(' ')} did not fail`);
  };
  assert.match(fails(['--calls', '--lang', 'it']), /the call suite is English only/);
  assert.match(fails(['--calls', '--scenario', '2']), /--scenario picks a trigger row; with --calls use --call N/);
  assert.match(fails(['--calls', '--situation', '2']), /--situation picks a situation row; with --calls use --call N/);
  assert.match(fails(['--situations', '--call', '2']), /--call picks a call row; with --situations use --situation N/);
  assert.match(fails(['--call', '2']), /--call picks a call row; without --calls use --scenario N/);
  assert.match(fails(['--situations', '--calls']), /--situations and --calls are two suites — one at a time/);
  const usage = execFileSync(process.execPath, [GEN, '--help'], { encoding: 'utf8' });
  assert.match(usage, /--calls\s+the CALL suite: Otto rings the customer or the driver/);
});

test('--calls reads the calls table, and falls back to the sheet when there is none', async () => {
  const mock = await startMock(FIXTURE);
  const run = async args => {
    const out = tmp();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [GEN, '--calls', '--supabase', mock.url, 'anon-key', '--out', out, ...args], { encoding: 'utf8' });
      const files = readdirSync(out).sort();
      const bodies = Object.fromEntries(files.map(f => [f, JSON.parse(readFileSync(path.join(out, f), 'utf8'))]));
      return { log: stdout, files, read: f => bodies[f] };
    } finally { rmSync(out, { recursive: true, force: true }); }
  };
  try {
    /* the live rows: the active ones only, in num order, a test per
     * persona — a row without a stop still gets one, a row without an
     * opener gets the app's line, and jsonb lists arrive however they do */
    let r = await run([]);
    assert.match(r.log, /GENERATE — 2 call\(s\) from Supabase \(http:\/\/127\.0\.0\.1:\d+\) × 4 persona\(s\) → 8 test\(s\)/);
    assert.equal(r.files.length, 8);
    assert.deepEqual(r.files.filter(f => f.endsWith('--suspicious.json')), ['call-02-home-check--suspicious.json', 'call-04-tell-the-driver--suspicious.json']);
    const got = mock.requests.filter(x => x.path === '/rest/v1/calls');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].query, { select: '*', active: 'eq.true', order: 'num.asc.nullslast' });
    assert.ok(got[0].auth.apikey && got[0].auth.bearer, 'the anon key in both headers, like every Supabase read');
    const one = r.read('call-02-home-check--cooperative.json');
    validate(one, 'call-02-home-check--cooperative.json');
    assert.equal(one._otto.call_title, 'Home check — nobody home until eight');
    assert.equal(one.dynamic_variables.destination_title, 'Husemannstraße 14', 'the row\'s own stop');
    assert.equal(one.chat_history[0].message, 'Hello, this is Otto from the delivery office. Am I speaking with Mr Aydın?');
    const two = r.read('call-04-tell-the-driver--terse.json');
    validate(two, 'call-04-tell-the-driver--terse.json');
    assert.equal(two.dynamic_variables.destination_title, stops[3].title, 'a row without a stop lands on the stop with its number, like a situation');
    assert.equal(two.chat_history[0].message, 'Hi, this is Otto from the office — got a moment?', 'no opener on the row: the app\'s line for the driver');
    assert.ok(two.success_conditions[1].includes('what the driver does with the stop; when the box will be delivered'), 'must_establish came through as a JSON string');
    assert.ok(two.success_conditions[1].includes('for example parking'), 'off_topic as a bare string');
    assert.match(two.dynamic_variables.call_previous, /^Aydın at Husemannstraße 14 is home from 20:00/);

    /* a project whose schema.sql predates the table: one line, then the
     * starter ten — a button must not come back with nothing to run */
    mock.state.callsTable = false;
    r = await run([]);
    assert.match(r.log, /^Supabase \(http:\/\/127\.0\.0\.1:\d+\) has no calls table yet — generating from calls-starter\.js instead \(run supabase\/schema\.sql there to get one\)$/m);
    assert.match(r.log, /GENERATE — 10 call\(s\) from the starter sheet × 4 persona\(s\) → 40 test\(s\)/);
    assert.equal(r.files.length, 40);

    /* the table is there but empty, or everything in it is switched off */
    mock.state.callsTable = true;
    mock.state.calls = [];
    r = await run([]);
    assert.match(r.log, /has no active row — generating from calls-starter\.js instead$/m);
    assert.equal(r.files.length, 40);
  } finally {
    await mock.close();
  }
});

test('rows from a file, a chain whose next row is missing, and an inactive row', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'rows.json');
    const list = [
      { num: 3, title: 'Hand-fed call', callee: 'consignee', purpose: 'Check whether somebody is home.', they_say: 'Not until nine.', they_know: 'Home from 21:00.', must_establish: ['from when somebody is home'], off_topic: ['parking'], outcome: 'Home from nine.', next_call: 8 },
      { num: 5, title: 'Off', active: false, callee: 'driver', purpose: 'x', they_say: 'y', they_know: 'z', must_establish: ['a'], off_topic: ['b'], outcome: 'c' },
    ];
    execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify({calls: JSON.parse(process.argv[2])}))', file, JSON.stringify(list)]);
    const out = path.join(dir, 'out');
    const log = execFileSync(process.execPath, [GEN, '--calls', '--file', file, '--out', out], { encoding: 'utf8' });
    assert.match(log, /GENERATE — 1 call\(s\) from .*rows\.json × 4 persona\(s\) → 4 test\(s\)/);
    assert.match(log, /^note: "Hand-fed call" names call #8 as the call that follows it, and there is no such row — on the phone nothing rings after it$/m);
    const body = JSON.parse(readFileSync(path.join(out, 'call-03-hand-fed-call--terse.json'), 'utf8'));
    validate(body, 'call-03-hand-fed-call--terse.json');
    /* a chained row whose next row has no previous_call is named too */
    const chained = [
      { num: 1, title: 'First', callee: 'consignee', purpose: 'p', they_say: 's', they_know: 'k', must_establish: ['m'], off_topic: ['o'], outcome: 'u', next_call: 2 },
      { num: 2, title: 'Second', callee: 'driver', purpose: 'p', they_say: 's', they_know: 'k', must_establish: ['m'], off_topic: ['o'], outcome: 'u', previous_call: '' },
    ];
    execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', file, JSON.stringify(chained)]);
    const log2 = execFileSync(process.execPath, [GEN, '--calls', '--file', file, '--out', path.join(dir, 'out2')], { encoding: 'utf8' });
    assert.match(log2, /^note: "Second" follows "First" but has no previous_call — its tests tell Otto nothing about the call before$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const some = [
    { num: 1, title: 'On', callee: 'consignee', purpose: 'p', they_say: 's', they_know: 'k', must_establish: ['m'], off_topic: ['o'], outcome: 'u' },
    { num: 2, title: 'Off', active: false, callee: 'driver', purpose: 'p', they_say: 's', they_know: 'k', must_establish: ['m'], off_topic: ['o'], outcome: 'u' },
  ];
  assert.equal(buildCallTests(some, { stops }).length, 4);
  assert.equal(buildCallTests(some, { stops, only: 1 }).length, 4);
  assert.equal(buildCallTests(some, { stops, only: 2 }).length, 0);
  /* a row with no number of its own still gets a valid test */
  const t = buildCallTest({ row: { title: 'Unnumbered', callee: 'driver', purpose: 'p', they_say: 's', they_know: 'k', must_establish: ['m'], off_topic: ['o'], outcome: 'u' }, persona: CALL_PERSONAS[0], stops });
  assert.equal(t.file, 'call-00-unnumbered--cooperative.json');
  assert.equal(t.body.name, 'Otto · call Unnumbered · cooperative');
  assert.equal(t.body._otto.call_num, null);
  assert.ok(!('call_num' in t.body.dynamic_variables), 'no number, no variable');
});

/* The back-office agent: the calls run on a second agent with its own
 * prompt, so Otto's is never touched. One id, carried the way the first
 * one is: a config.js placeholder the deploy injects (with the kit's own
 * agent as the default), the phone opening calls on it, the loop's
 * criteria for it. */
test('the back-office agent is wired through config, the deploy, the phone and the loop', () => {
  const config = readFileSync(path.join(REPO, 'config.js'), 'utf8');
  assert.match(config, /^window\.ELEVENLABS_CALL_AGENT_ID = '__ELEVENLABS_CALL_AGENT_ID__';$/m, 'the placeholder the deploy injects');
  const def = config.match(/^if \(String\(window\.ELEVENLABS_CALL_AGENT_ID\)\.slice\(0, 2\) === '__'\) window\.ELEVENLABS_CALL_AGENT_ID = '([^']*)';$/m);
  assert.ok(def, 'the runtime guard with the default');
  assert.match(def[1], /^agent_[a-z0-9]{20,}$/, 'the default is an agent id, not the placeholder');
  assert.match(readFileSync(path.join(REPO, 'scripts', 'vercel-build.sh'), 'utf8'), /^sub ELEVENLABS_CALL_AGENT_ID __ELEVENLABS_CALL_AGENT_ID__$/m, 'the deploy injects it');
  const app = readFileSync(path.join(REPO, 'app.js'), 'utf8');
  assert.match(app, /get\('callagent'\) \|\| window\.ELEVENLABS_CALL_AGENT_ID/, 'the phone reads the id, ?callagent= first');
  assert.match(app, /const id = calling \? callAgentId\(\) : OttoAgent\.agentId\(\);/, 'a call goes to the back-office agent, a report to Otto');
  assert.match(app, /OttoAgent\.prefetchUrl\(callAgentId\(\)\)/, 'the back-office agent\'s line is signed ahead of the Answer tap');
  const agent = readFileSync(path.join(REPO, 'otto-agent.js'), 'utf8');
  assert.match(agent, /agent: null, chip: 'ELEVENLABS',/, 'mount takes the agent to open');
  assert.match(agent, /const freshUrl = id => \(signed\.url && signed\.id === id &&/, 'a signed URL is only reused for the agent it was signed for');
  assert.match(agent, /socketUrl\(mountAgentId\(\)\)/);
  const fn = readFileSync(path.join(REPO, 'supabase', 'functions', 'elevenlabs-token', 'index.ts'), 'utf8');
  assert.match(fn, /const pinned = csv\('ELEVENLABS_AGENT_ID', ''\);/, 'the token function pins several agents, comma-separated');
  assert.match(fn, /not one this function signs for/, 'and refuses another rather than signing for Otto');
  /* the criteria file for that agent: the same shape as analysis.json */
  const spec = JSON.parse(readFileSync(path.join(HERE, '..', 'analysis-calls.json'), 'utf8'));
  const ps = spec.platform_settings;
  const ids = ps.evaluation.criteria.map(c => c.id);
  assert.deepEqual(ids, ['otto_call_purpose', 'otto_call_outcome', 'otto_three_questions', 'otto_no_invention', 'otto_one_language', 'otto_closed_politely']);
  assert.equal(new Set(ids).size, ids.length, 'criterion ids collide');
  ps.evaluation.criteria.forEach(c => { assert.equal(c.type, 'prompt'); assert.equal(c.scope, 'conversation'); assert.ok(c.conversation_goal_prompt.length > 120, c.id + ' is too short to grade by'); });
  assert.deepEqual(Object.keys(ps.data_collection), ['call_outcome', 'reached_right_person', 'somebody_home', 'question_count', 'callee_language']);
  assert.equal(ps.overrides.conversation_config_override.agent.first_message, true, 'a call opens with the row\'s line: the override must be allowed');
  assert.equal(ps.overrides.conversation_config_override.agent.language, true);
});

/* the phone's side of the contract: app.js builds the same five
 * variables and the same default openers, read out of its source */
test('app.js carries the call variables and the openers the suite assumes', () => {
  const src = readFileSync(path.join(REPO, 'app.js'), 'utf8');
  for (const k of ['call_num', 'call_title', 'call_to', 'call_purpose', 'call_previous']) assert.match(src, new RegExp(`^\\s+${k}:\\s`, 'm'), `app.js agentVars() has no ${k}`);
  const lines = [...src.matchAll(/^\s+(callConsignee|callDriver): (d => `[^`\n]*`|'(?:[^'\\\n]|\\.)*'),$/gm)];
  assert.equal(lines.length, 4, 'app.js should carry callConsignee and callDriver under en and it');
  const d = { title: 'Kollwitzstraße 48', consignee: 'F. Brandt' };
  const surname = c => String(c || '').trim().replace(/^(?:[A-ZÀ-Þ]\.\s*)+/, '').trim() || String(c || '').trim();
  const evalLine = m => new Function('surnameOf', 'return ' + m[2])(surname);
  const got = lines.map(m => (typeof evalLine(m) === 'function' ? evalLine(m)(d) : evalLine(m)));
  assert.deepEqual(got, [LANG_TEXT.en.callConsignee(d), LANG_TEXT.en.callDriver, LANG_TEXT.it.callConsignee(d), LANG_TEXT.it.callDriver], 'the phone\'s openers drifted from lib/scenario-vars.mjs');
});

/* ---- the words a row leaves to its stop ---- */
test('a row may say {address}, {customer}, {name}, {floor} or {stop}: the stop fills them in', () => {
  const d = { title: 'Kollwitzstraße 71', addr: 'Kollwitzstraße 71, 10435 Berlin', consignee: 'R. Fischer', floor: '5', stop: 8 };
  assert.equal(fillCall('the stop at {address}, the {customer} box ({name}, floor {floor}, stop {stop}; {full_address})', d),
    'the stop at Kollwitzstraße 71, the Fischer box (R. Fischer, floor 5, stop 8; Kollwitzstraße 71, 10435 Berlin)');
  assert.equal(fillCall('{{address}} and {{ customer }} the ElevenLabs way', d), 'Kollwitzstraße 71 and Fischer the ElevenLabs way');
  assert.equal(fillCall('{Address} reads either way', d), 'Kollwitzstraße 71 reads either way');
  assert.equal(fillCall('{gate_code} is nobody\'s; {floor} has nothing here', { title: 'X' }), '{gate_code} is nobody\'s; {floor} has nothing here', 'what the stop has nothing for stays as written');
  assert.equal(fillCall('nothing to fill', null), 'nothing to fill');
  assert.equal(fillCall(null, d), '');
  const row = fillCallRow({ title: 'Skip {customer}', purpose: 'the stop at {address}', must_establish: ['that {customer} is skipped', 7], they_say: '', next_call: 5 }, d);
  assert.equal(row.title, 'Skip {customer}', 'the title is a label and stays');
  assert.equal(row.purpose, 'the stop at Kollwitzstraße 71');
  assert.deepEqual(row.must_establish, ['that Fischer is skipped', 7]);
  assert.equal(row.they_say, '');
  assert.equal(row.next_call, 5);
  assert.equal(fillCallRow(null, d), null);
});

test('the generated tests read the filled words — no placeholder reaches ElevenLabs', () => {
  const row = { num: 5, title: 'Skip Fischer today', callee: 'driver', stop: 8,
    purpose: 'Tell the driver that the stop at {address} is off today\'s round.', otto_says: 'Hi — about {address}, the {customer} box.',
    previous_call: '{customer} at {address} is away.', they_say: 'So I skip {address}?', they_know: '{address} is stop {stop}.',
    must_establish: ['that the driver skips {address}'], off_topic: ['the gate code'], outcome: 'Stop {stop} is skipped — {name} gets it tomorrow.', next_call: null };
  const b = buildCallTest({ row, persona: PERSONAS.find(p => p.id === 'terse'), stops }).body;
  assert.equal(b.chat_history[0].message, 'Hi — about Kollwitzstraße 71, the Fischer box.');
  assert.equal(b.dynamic_variables.call_purpose, 'Tell the driver that the stop at Kollwitzstraße 71 is off today\'s round.');
  assert.equal(b.dynamic_variables.call_previous, 'Fischer at Kollwitzstraße 71 is away.');
  assert.match(b.simulation_scenario, /what you tell him is “So I skip Kollwitzstraße 71\?”/);
  assert.match(b.simulation_scenario, /Kollwitzstraße 71 is stop 8\./);
  assert.match(b.success_conditions[1], /that the driver skips Kollwitzstraße 71/);
  assert.match(b.success_conditions[6], /Stop 8 is skipped — R\. Fischer gets it tomorrow/);
  assert.match(b._otto.briefing, /Why you are calling: Tell the driver that the stop at Kollwitzstraße 71/);
  assert.doesNotMatch(JSON.stringify(b), /\{\{?\s*[a-z][a-z0-9_]*\s*\}?\}/i, 'nothing left to fill anywhere in the test');
  /* the name is a label: left as written, so the dashboard can match a run's results to the row */
  assert.equal(buildCallTest({ row: { ...row, title: 'Skip {customer} today' }, persona: PERSONAS.find(p => p.id === 'terse'), stops }).body._otto.call_title, 'Skip {customer} today');
  /* a row without a stop lands on the stop with its number, and the words follow it there */
  const loose = buildCallTest({ row: { ...row, stop: '' }, persona: PERSONAS.find(p => p.id === 'terse'), stops }).body;
  assert.equal(loose.dynamic_variables.destination_title, stops[4].title);
  assert.match(loose.dynamic_variables.call_purpose, new RegExp(`the stop at ${stops[4].title} is off`));
});

test('the starter rows leave their stops to the stop', () => {
  rows.forEach(r => {
    const st = stops.find(s => s.stop === +r.stop);
    assert.ok(st, `#${r.num} names a stop`);
    const own = [st.title, surnameOf(st.consignee)];
    for (const k of ['purpose', 'otto_says', 'previous_call', 'they_say', 'they_know', 'outcome']) {
      own.forEach(w => assert.ok(!String(r[k] || '').includes(w), `#${r.num} ${k} spells out "${w}" where a placeholder would follow the stop`));
    }
    for (const k of ['must_establish', 'off_topic']) r[k].forEach(x => own.forEach(w => assert.ok(!x.includes(w), `#${r.num} ${k}: "${x}"`)));
  });
  built.forEach(t => assert.doesNotMatch(JSON.stringify({ ...t.body, name: '' }), /\{\{?\s*[a-z][a-z0-9_]*\s*\}?\}/i, t.file));
});

test('app.js and dashboard.js carry fillCall word for word', () => {
  const grab = (src, what) => {
    const m = /(?:export )?const CALL_PLACEHOLDER[\s\S]*?const fillCallRow[\s\S]*?\n};\n/.exec(src);
    assert.ok(m, `${what}: the fillCall block`);
    return m[0].replace(/^export /gm, '');
  };
  const lib = grab(readFileSync(path.join(HERE, '..', 'lib', 'scenario-vars.mjs'), 'utf8'), 'lib');
  assert.equal(grab(readFileSync(path.join(REPO, 'app.js'), 'utf8'), 'app.js'), lib, 'app.js drifted from lib/scenario-vars.mjs');
  assert.equal(grab(readFileSync(path.join(REPO, 'dashboard.js'), 'utf8'), 'dashboard.js'), lib, 'dashboard.js drifted from lib/scenario-vars.mjs');
});
