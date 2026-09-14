/*
 * The live-suite job in .github/workflows/agent-suite.yml lends the loop
 * its poll budget: pollInvocation gives up after LOOP_TIMEOUT_MS (20
 * minutes when unset) and `run` writes results/ only once the poll
 * returns, so a budget the job never raises abandons a long suite with
 * nothing to show for the conversations it paid for — and one raised past
 * the job's own timeout-minutes gets the job killed mid-poll instead,
 * which is the same loss. The two numbers sit a few lines apart in the
 * same file and drift when someone touches one of them; this keeps them
 * together. There is no YAML parser without a dependency, so the file is
 * read the way it is written: one job block, one step inside it.
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
/* one step of a job: from its `- name:` line to the next step */
function step(jobText, label) {
  const m = jobText.match(new RegExp(`- name: ${label}\\n([\\s\\S]*?)(?=\\n      - (?:name|uses):|(?![\\s\\S]))`));
  assert.ok(m, `step "${label}" not found in the live-suite job`);
  return m[1];
}
const number = (text, re) => Number((text.match(re) || [])[1]);

test('the live suite gives the loop a poll budget that fits inside the job', () => {
  const live = job(readFileSync(WORKFLOW, 'utf8'), 'live-suite');
  const jobMs = number(live, /^\s+timeout-minutes:\s*(\d+)\s*$/m) * 60e3;
  assert.ok(jobMs > 0, 'the live-suite job has no timeout-minutes');

  const budget = number(step(live, 'Run the suite'), /^\s+LOOP_TIMEOUT_MS:\s*"?(\d+)"?\s*$/m);
  assert.ok(budget > 0, 'the "Run the suite" step does not set LOOP_TIMEOUT_MS, so the loop polls for its default 20 minutes whatever the job allows');
  assert.ok(budget > 20 * 60e3, `LOOP_TIMEOUT_MS ${budget} ms is not above the loop's own 20-minute default — the line cuts the budget instead of raising it`);

  const headroom = jobMs - budget;
  assert.ok(headroom >= 5 * 60e3, `LOOP_TIMEOUT_MS ${budget} ms leaves ${Math.round(headroom / 60e3)} min of the job's ${jobMs / 60e3} for checkout, push-tests, the summary and the upload — keep at least 5`);
});
