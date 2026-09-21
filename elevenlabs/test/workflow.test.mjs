/*
 * The live-suite job in .github/workflows/agent-suite.yml lends the loop
 * its poll budget: pollInvocation gives up after LOOP_TIMEOUT_MS (20
 * minutes when unset) and `run` writes results/ only once the poll
 * returns, so a budget the job never raises abandons a long suite with
 * nothing to show for the conversations it paid for — and one raised past
 * the job's own timeout-minutes gets the job killed mid-poll instead,
 * which is the same loss. The two numbers sit a few lines apart in the
 * same file and drift when someone touches one of them; this keeps them
 * together. The budget lives in the job's env, so every button that runs
 * the suite (baseline, propose, promote) gets it — a step that set its
 * own would be the one that drifts. There is no YAML parser without a
 * dependency, so the file is read the way it is written: one job block,
 * its env block, its steps.
 *
 * The same job is where a suite's results reach the dashboard: every
 * step that runs the suite publishes it (loop.mjs publish) — a step
 * that ran and did not would leave a run the designer never sees, and
 * the five run sites are far enough apart in the file to lose one.
 *
 * And it is where the prompt could leak. The prompt is confidential and
 * this repository is public: a job log, a job summary, an artifact and
 * the agent_runs table are all readable by anyone the moment they are
 * written. The rules that keep it out of them are spread over a dozen
 * lines of bash — --quiet on propose and promote, no proposal artifact,
 * no --note on publish, no propose/branch output pasted into a summary
 * — and every one of them is one careless edit from being undone, so
 * they are checked here as well.
 *
 *   node --test            (from elevenlabs/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'agent-suite.yml');

/* one top-level job: from its `  name:` line to the next key at that indent */
function job(yaml, name) {
  const m = yaml.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm'));
  assert.ok(m, `job "${name}" not found in ${WORKFLOW}`);
  return m[1];
}
/* the job's own env block: from `    env:` to the next key at that indent */
function jobEnv(jobText) {
  const m = jobText.match(/^    env:\n([\s\S]*?)(?=^    \S|(?![\s\S]))/m);
  assert.ok(m, 'the live-suite job has no env: block of its own');
  return m[1];
}
const number = (text, re) => Number((text.match(re) || [])[1]);

test('the live suite gives the loop a poll budget that fits inside the job', () => {
  const live = job(readFileSync(WORKFLOW, 'utf8'), 'live-suite');
  const jobMs = number(live, /^\s+timeout-minutes:\s*(\d+)\s*$/m) * 60e3;
  assert.ok(jobMs > 0, 'the live-suite job has no timeout-minutes');

  const budget = number(jobEnv(live), /^\s+LOOP_TIMEOUT_MS:\s*"?(\d+)"?\s*$/m);
  assert.ok(budget > 0, 'the live-suite job env does not set LOOP_TIMEOUT_MS, so the loop polls for its default 20 minutes whatever the job allows');
  assert.ok(budget > 20 * 60e3, `LOOP_TIMEOUT_MS ${budget} ms is not above the loop's own 20-minute default — the line cuts the budget instead of raising it`);

  const headroom = jobMs - budget;
  assert.ok(headroom >= 5 * 60e3, `LOOP_TIMEOUT_MS ${budget} ms leaves ${Math.round(headroom / 60e3)} min of the job's ${jobMs / 60e3} for checkout, push-tests, the summary and the upload — keep at least 5`);

  /* every place the suite runs is a step of this job, under that env */
  const runs = (live.match(/loop\.mjs "\$\{args\[@\]\}"|node loop\.mjs run\b/g) || []).length;
  assert.ok(runs >= 3, `expected the suite to run in the baseline, propose and promote paths of live-suite, found ${runs} run invocation(s)`);
});

/* the job's steps: from each `      - name:` line to the next one */
const steps = jobText => jobText.split(/^      - (?=name:)/m).slice(1).map(t => ({ name: (t.match(/^name:\s*(.*)$/m) || [])[1] || '', text: t }));

test('every step of the live suite that runs the suite publishes it for the dashboard', () => {
  const live = job(readFileSync(WORKFLOW, 'utf8'), 'live-suite');
  const runners = steps(live).filter(s => /args=\(run /.test(s.text));
  assert.ok(runners.length >= 4, `expected the suite to run in four steps (baseline, propose without a baseline, propose on the branch, promote), found ${runners.length}`);
  for (const s of runners) {
    const publishes = (s.text.match(/node loop\.mjs publish\b/g) || []).length;
    assert.ok(publishes >= 1, `"${s.name}" runs the suite and never publishes it`);
    /* a publish that fails must not lose the run: wrapped in an if, the summary told */
    assert.match(s.text, /if node loop\.mjs publish /, `"${s.name}" lets a failed publish fail the step`);
    assert.match(s.text, /results not published — /, `"${s.name}" does not tell the summary when the publish failed`);
    assert.match(s.text, /Results are on the scenarios dashboard \(dashboard\.html\), per scenario\./, `"${s.name}" does not point the summary at the dashboard`);
    assert.match(s.text, /publish .*--run-url "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID"/, `"${s.name}" publishes without the run's page`);
  }
  /* a branch run carries compare's word and its reason — and not the
   * note, which would say what the prompt changed */
  const branchRuns = runners.filter(s => /--label branch/.test(s.text));
  assert.equal(branchRuns.length, 2, 'the branch runs are propose and try');
  for (const s of branchRuns) {
    assert.match(s.text, /publish --results "\$br" .*--verdict "\$word" --reason "\$reason"/, s.name);
    assert.doesNotMatch(s.text, /loop\.mjs publish[^\n]*--note/, `"${s.name}" publishes the proposal's note into a world-readable table`);
  }
});

/* The situation tests are the dashboard's rows, not this repository's:
 * they are gitignored and generated at the start of every run. A path
 * that pushed tests without generating them first would run whatever
 * the last run happened to leave on the runner — or nothing at all. */
test('every suite the buttons run generates the situation tests from the live rows first', () => {
  const live = job(readFileSync(WORKFLOW, 'utf8'), 'live-suite');
  const all = steps(live);
  const gen = all.findIndex(s => /node generate-tests\.mjs --situations/.test(s.text));
  assert.ok(gen >= 0, 'no step generates the situation tests');
  assert.match(all[gen].text, /if: steps\.plan\.outputs\.go == 'true' && steps\.plan\.outputs\.action != 'configure'/, 'the generate step skips only configure');
  const push = all.findIndex(s => /node loop\.mjs push-tests/.test(s.text));
  assert.ok(push > gen, 'push-tests runs before the situation tests are generated');
  for (const action of ['baseline', 'field', 'propose', 'try', 'models']) {
    assert.ok(all[push].text.includes(`action == '${action}'`), `push-tests skips the ${action} button`);
  }
});

/* The models button: a branch that differs from the live Otto in the
 * language model alone, the suite on the rows the form names, the
 * comparison, and the run published with compare's word — never a
 * prompt, which model-branch does not carry in the first place. */
test('the models button cuts a branch with the model and runs the suite on the rows named', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const inputs = (yaml.match(/workflow_dispatch:\n    inputs:\n([\s\S]*?)\n  schedule:/) || [])[1] || '';
  for (const name of ['model', 'reasoning', 'rows']) assert.match(inputs, new RegExp(`^      ${name}:$`, 'm'), `no ${name} input on the form`);
  assert.match(inputs, /^          - models$/m, 'models is not a choice of the action dropdown');
  assert.match(inputs, /reasoning:\n[\s\S]*?options:\n          - keep\n          - none\n          - minimal\n          - low\n          - medium\n          - high\n          - xhigh\n          - max/, 'the reasoning choices are ElevenLabs\' own words (never a bare off: YAML reads it as false)');
  const live = job(yaml, 'live-suite');
  assert.match(live, /if ! \[ "\$REPEAT" -ge 1 \]/, 'a trial of one run per test must be allowed');
  assert.match(live, /if \[ "\$ACTION" = "models" \] && \[ -z "\$MODEL" \]; then\n\s+echo "::error::models needs model/, 'a models press without a model must fail with the instructions');
  /* by the command, not the word: the step before carries the models
   * step's comment block */
  const step = steps(live).find(s => /node loop\.mjs model-branch/.test(s.text));
  assert.ok(step, 'no step runs model-branch');
  assert.match(step.text, /if: steps\.plan\.outputs\.go == 'true' && steps\.plan\.outputs\.action == 'models'/);
  assert.match(step.text, /node loop\.mjs model-branch --model "\$MODEL" --reasoning "\$REASONING" --out "\$RUNNER_TEMP\/model-branch\.json"/);
  assert.match(step.text, /args=\(run --branch "\$bid" --repeat "\$REPEAT" --label model\)/);
  assert.match(step.text, /if \[ -n "\$ROWS" \]; then args\+=\(--rows "\$ROWS"\); fi/, 'the rows from the form narrow the run');
  assert.match(step.text, /node loop\.mjs compare --base "\$base" --branch "\$br"/);
  assert.match(step.text, /publish --results "\$br" .*--verdict "\$word" --reason "\$reason"/);
  assert.doesNotMatch(step.text, /--note/);
  /* the baseline to compare against is fetched for this button too */
  const fetch = steps(live).find(s => /name=loop-baseline/.test(s.text));
  assert.ok(fetch && fetch.text.includes("action == 'models'"), 'the models button does not fetch the latest baseline');
  assert.match(live, /MODEL: \$\{\{ inputs\.model \}\}\n\s+REASONING: \$\{\{ inputs\.reasoning \|\| 'keep' \}\}\n\s+ROWS: \$\{\{ inputs\.rows \}\}/, 'the three inputs reach the job env');
});

/* The prompt is confidential and every one of these surfaces is public
 * the moment it is written. */
test('nothing the buttons write can carry the prompt, its diff or its note', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const live = job(yaml, 'live-suite');
  /* proposals/ never leaves the runner: no artifact carries it */
  const artifacts = live.split(/^      - uses: actions\/upload-artifact/m).slice(1);
  assert.ok(artifacts.length >= 2, 'the baseline and field artifacts are still uploaded');
  artifacts.forEach(a => assert.doesNotMatch(a, /proposals/, 'an artifact carries proposals/'));
  assert.doesNotMatch(live, /loop-proposal/, 'the proposal artifact is gone, and nothing downloads one');
  /* and no summary line pastes the output of propose or branch */
  const summaryLines = live.split('\n').filter(l => /GITHUB_STEP_SUMMARY|^\s+echo .*```/.test(l));
  summaryLines.forEach(l => assert.doesNotMatch(l, /TEMP\/(propose|branch)\.txt|proposals\//, `a summary line carries ${l.trim().slice(0, 60)}`));
  assert.doesNotMatch(live, /TEMP\/(propose|branch)\.txt/, 'propose and branch output is not captured at all');
  /* the two commands that can print it are asked not to */
  assert.match(live, /node loop\.mjs propose --quiet/);
  assert.match(live, /node loop\.mjs promote --branch "\$BRANCH_ID" --quiet/);
});

/* The two suites live in one ElevenLabs workspace and are told apart by
 * the names the generator gives them; `suite` is the button for that. */
test('the suite input picks the filter, situations by default', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const input = yaml.match(/^      suite:\n([\s\S]*?)(?=^      \S)/m);
  assert.ok(input, 'no suite input on the form');
  assert.match(input[1], /^\s+default: situations$/m, 'the pilot runs the situations, so they are the default');
  ['situations', 'triggers', 'all'].forEach(o => assert.match(input[1], new RegExp(`^\\s+- ${o}$`, 'm')));
  const live = job(yaml, 'live-suite');
  const plan = steps(live).find(s => /Plan the run/.test(s.name));
  assert.match(plan.text, /situations\) filter="Otto · situation"/);
  assert.match(plan.text, /triggers\)\s+filter="Otto · #"/);
  assert.match(plan.text, /all\)\s+filter=""/);
  assert.match(plan.text, /echo "FILTER=\$filter" >> "\$GITHUB_ENV"/);
  /* the form's own filter still wins, and the resolved one is what the
   * steps read — the job env must not shadow it */
  assert.match(plan.text, /filter="\$FILTER_INPUT"/);
  assert.doesNotMatch(live, /^      FILTER: /m, 'a job-level FILTER would override the one the plan step resolved');
  /* try needs a branch to run on */
  assert.match(plan.text, /\[ "\$ACTION" = "try" \].*\[ -z "\$BRANCH_ID" \]/);
});
