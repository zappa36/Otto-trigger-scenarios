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
 * the four run sites are far enough apart in the file to lose one.
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
  /* the branch run carries compare's word and the proposal's note */
  const propose = runners.find(s => /--label branch/.test(s.text));
  assert.ok(propose, 'no step runs the suite on the branch');
  assert.match(propose.text, /publish --results "\$br" .*--verdict "\$word" --reason "\$reason" --note "\$note"/);
});
