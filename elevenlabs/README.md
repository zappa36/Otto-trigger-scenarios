# elevenlabs/ — the tuning loop for Otto's prompt

The dashboard tunes the trigger *detector*: sliders, versions, feedback,
a proposed vN+1, and `scripts/tune_triggers.py` replaying recorded runs
offline. This folder is the same loop for the *agent* — the ElevenLabs
Conversational AI agent that is Otto when the phone opens a live
conversation (`otto-agent.js`). Its prompt is the knob; the evidence is
two-fold:

- **a suite** of ElevenLabs simulation tests carrying the *same dynamic
  variables a phone sends* on a real run (`generate-tests.mjs` mirrors
  `agentVars()` in `app.js`, and its test fails the moment the two
  drift). There are two of them: the **situations** — what a driver
  reports after pressing the big REPORT button, which is all the pilot
  has and the suite the buttons run by default ([below](#the-situation-suite)) — and the
  **triggers**, one test per row of the "Otto triggers" sheet × persona,
  for when a trigger fires the conversation instead;
- **the field**: every real conversation the agent had, with the
  analysis ElevenLabs ran on it, joined to the grade the designer gave
  the debrief on the dashboard (did Otto open with the scenario's
  question, follow up on what was found, get the tip type, keep it
  short, stay in the language).

Both are scored, a model proposes the smallest prompt diff the evidence
supports, the diff goes on an agent **branch**, the suite runs there, and
a human merges. Nothing in here edits the live prompt on its own.

**The prompt is confidential and this repository is public.** Nothing in
here prints it, diffs it in a log, or stores what a change to it was
for — see [Confidential prompt](#confidential-prompt).

Plain Node (>= 20, ESM, `node --test`), no dependencies — like
`mock-api/`. The REST API is called directly; the ElevenLabs CLI is
optional (below) and only for keeping the agent's config in git.

## The four stages, as commands

| Stage | What | Command |
|---|---|---|
| 1 · record | the conversation id lands on every agent debrief (`otto-agent.js`); the dashboard grades it; ElevenLabs grades every call with the criteria in `analysis.json` | `node loop.mjs configure` |
| 2 · suite | one simulation test per row × persona — the situation rows, the scenario sheet, or both; the run published for the dashboard | `npm run generate:situations` → `node loop.mjs push-tests` → `node loop.mjs run --filter "Otto · situation"` → `publish` |
| 3 · field | conversations + analysis + grades pulled and joined; a debrief graded bad becomes a next-reply regression test | `node loop.mjs pull` → `score` → `cut` |
| 4 · improve | a minimal prompt diff, on a branch, compared, promoted by hand | `propose` → `branch` → `run --branch` → `compare` → `promote` |

```
node generate-tests.mjs [--sheet | --supabase [URL KEY]] [--out DIR] [--lang en,it] [--scenario N]
node generate-tests.mjs --situations [--supabase [URL KEY] | --sheet | --file JSON] [--out DIR] [--situation N]

node loop.mjs <command> [--dry-run] [--quiet] [--dir DIR] [flags]

configure                       evaluation + data collection + overrides (analysis.json) onto the agent
push-tests [--no-mock-tools]    test_configs/**.json -> ElevenLabs tests, by name; writes tests.lock.json;
                                  the agent's tools are mocked for the suite (a client tool has no phone to answer it)
run        [--branch ID] [--repeat N=3] [--filter TEXT] [--label TEXT]
pull       [--since ISO | --days N=14] [--no-stamp]
score      [--results FILE] [--field FILE]
cut        [--field FILE]
propose    [--results FILE] [--field FILE] [--prompt FILE | --agent] [--quiet]
branch     --proposal FILE [--name TEXT]
compare    --base FILE --branch FILE [--margin 0.25]
promote    --branch ID [--target BRANCH_ID] [--force] [--quiet]
publish    [--results FILE] [--run-url URL] [--verdict accept|reject] [--reason TEXT]
```

`--filter` is how one suite is run on its own: the generator names the
situation tests `Otto · situation #N …` and the trigger tests
`Otto · #N …`, so `--filter "Otto · situation"` and `--filter "Otto · #"`
each pick one, and no filter runs everything in `tests.lock.json`.

`--dry-run` prints every request a command would send — method, path,
body — and sends nothing; it needs no key, which makes it the safe way
to see what a command does. `--quiet` keeps the prompt, its diff and a
branch's version note off stdout, for a run whose log is published; it
takes nothing else away, and it also stops a dry run printing bodies
(the proposer's body *is* the prompt). `--dir` (or `LOOP_DIR`) moves
every file the loop reads and writes; the tests use it to stay out of
this folder.

## Environment

| Variable | What | Where it lives |
|---|---|---|
| `ELEVENLABS_API_KEY` | **secret** — the workspace key; every live command refuses to run without it | your shell / a CI secret. Never in browser code, never logged, never committed |
| `ELEVENLABS_AGENT_ID` | the agent the phone opens (public by design — the same value `config.js` carries) | shell / CI |
| `OPENAI_API_KEY` | **secret** — the proposer (the repo's existing provider; `scenario-ai` uses the same key) | shell / CI |
| `LOOP_MODEL` | the proposer's model, default `gpt-4o` | optional |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | where the debriefs and grades are (`pull` reads them) and where a suite run is published for the dashboard (`publish` adds an `agent_runs` row); default: the kit's project, the same pair `scripts/tune_triggers.py` carries | optional |
| `LOOP_DIR` | same as `--dir` | optional |
| `LOOP_POLL_MS` | how often `run` polls the invocation; default `5000` (5 s) | optional |
| `LOOP_TIMEOUT_MS` | when `run` gives up on it; default `1200000` (20 min). It then prints the invocation id to poll by hand and writes no results file — a big suite with a high `--repeat` may need more; the buttons set 80 minutes inside a 90-minute job | optional |
| `LOOP_RETRY_MS`, `ELEVENLABS_BASE_URL`, `OPENAI_BASE_URL` | the retry back-off and the two API base URLs — test knobs, so the suite can point the loop at its in-process mock; the defaults are the real services | optional |

The API key travels only in the `xi-api-key` header. The dry-run printer
redacts the secrets it was handed in case one ever lands in a body.

## Day one

```sh
cd elevenlabs
export ELEVENLABS_API_KEY=…  ELEVENLABS_AGENT_ID=agent_…  OPENAI_API_KEY=…

node loop.mjs configure            # criteria + data collection on the agent; the overrides the phone needs
npm run generate:situations        # test_configs/situations/ from the live rows (--sheet for the starter twenty)
node loop.mjs push-tests           # create / update by name -> tests.lock.json
node loop.mjs run --label main --filter "Otto · situation"   # the baseline: 3 runs per test, results/<stamp>-main.json
node loop.mjs publish              # that run onto the dashboard: a row of agent_runs, shown per row

# … drivers drive and press REPORT; on the dashboard, grade the conversations …

node loop.mjs pull                 # field/<stamp>.json: conversations + analysis + grades
node loop.mjs score                # per row: suite pass rate, field grade rate, failures by reason
node loop.mjs cut                  # a debrief graded bad -> test_configs/regressions/<conversation_id>.json
node loop.mjs push-tests           # the regressions join the suite

node loop.mjs propose              # proposals/<stamp>.json: the prompt, a one-line note, the diff (--quiet in CI); honours the RUNS tab's NOT A PROBLEM list (accepted_findings)
node loop.mjs branch --proposal proposals/<stamp>.json        # the note becomes the branch's description
node loop.mjs run --branch <created_branch_id> --label branch --filter "Otto · situation"
node loop.mjs compare --base results/<stamp>-main.json --branch results/<stamp>-branch.json
node loop.mjs publish --verdict accept --reason "…"   # the branch run, with compare's word
node loop.mjs promote --branch <created_branch_id>    # the version note comes from the branch itself
node loop.mjs run --label main --filter "Otto · situation"    # the new baseline
node loop.mjs publish
```

`npm run generate` (no suffix) generates the *trigger* suite into
`test_configs/`, which is committed; the situation files are not.

`compare` says **ACCEPT** when no situation — every driver type and
repeat together, twelve calls or more — loses more than a quarter of
its calls (`--margin 0.25`), the total does not fall, *and* at least one
situation improves; anything else is **REJECT**, exit code 1. It is
judged by situation, not by test, because a test is three calls: a
score out of three can only be 0, 33, 67 or 100, and the same agent
loses single calls by chance on every run, so a per-test rule rejected
everything. Only tests present in both runs count: a driver type added
since the baseline is left out of the verdict and named in the output,
so the baseline need not be re-run for it. `promote` merges the branch
into the agent's main branch and archives it, then tells you to pull the
config into git with the note as the version description.

`publish` is how a run reaches the person it is for. The designer grades
the field debriefs on `dashboard.html`, per row; the suite's verdict on
the same row belongs next to them, not in a job summary on GitHub. So
the latest results file (or `--results FILE`) becomes one row of the
`agent_runs` table: per test the runs, passes and pass rate, the first
failure's one-line *why* and that run whole — the evaluator's rationale
and the turns it judged — plus the totals per situation (`by_situation`)
and per scenario (`by_scenario`); on a branch run, `--verdict` and
`--reason` carry compare's word and its reason line. There is no
`--note`: what a branch changed says what the prompt says, and this
table is world-readable. `--run-url` is the Actions run page (the
buttons pass it; by hand there is none). It prints the row's id; a
project whose `schema.sql` predates the table gets "re-run
supabase/schema.sql" and exit 1, and the results file stays where it
is.

## The situation suite

In the pilot there are no triggers. The driver finishes a stop, presses
the big **REPORT** button on the phone and says what they found — *the
road was closed*, *a big dog at the door*, *the bell does nothing*. What
matters is what happens next: Otto's follow-up has to fit **that**
report, not a script, and after at most three questions he confirms the
tip in one line and lets the driver go. That is what this suite
measures, and it is the suite the buttons run by default.

**A situation row** is one thing a driver might report. Twenty of them
ship in `situations-starter.js`; the dashboard's SITUATIONS tab loads
them into the `situations` table and that is where they are edited from
then on. Each row carries:

| Column | What |
|---|---|
| `num`, `title` | the row's number and a short name ("A big dog at the door") |
| `category` | `access` · `parking` · `gate_code` · `recipient` · `address` · `hazard` · `other` |
| `stop` | the Kollwitzkiez stop (`route-kollwitz.js`) it is set at — driver and Otto share an address, a consignee and the notes on file; empty cycles through the twelve |
| `driver_says` | the driver's first words, the line the simulated driver opens with |
| `driver_knows` | what the driver can tell **if asked, and only then** — the material Otto's questions have to pull out |
| `follow_up` | what a fitting follow-up asks about, as a list |
| `off_topic` | what would not fit here (this row's wrong answers) |
| `tip` | the one line Otto should end up confirming |
| `active` | false = kept on the tab, left out of the suite |

**Five personas** (`personas.json`), one test each, so a row is five
conversations: **cooperative** (answers fully, adds the one useful
detail), **terse** (three to six words, volunteers nothing),
**sidetracked** (opens with the weather, then answers), **vague** —
who opens with *"it didn't really work out at that one"* and only says
what happened when Otto asks — and **annoyed**, fed up and behind on
the round: short, sharp answers, an irritated remark, asks to be let
go, never abusive. The last two exist only in this suite. Eight turns
each, ten for the vague one, whose first exchange says nothing yet.

The test carries **no `chat_history`**: Otto opens with his own first
message from the agent config, the way the button flow leaves him to,
and the simulated driver reports when asked (or straight away if Otto
only greets). Its dynamic variables are exactly what the phone sends
with no scenario and no trigger — the stop (`destination_*`),
`debrief_language`, and `trigger_fired: "no"` — and nothing else: no
rule, no measurements, no "Otto says" line.

**Six conditions**, in this order, each written to stand on its own
(the evaluator sees one at a time):

1. **RELEVANCE** — Otto's first follow-up is about what the driver
   reported and asks about one of the row's `follow_up` items. Something
   off topic, or a question that could follow any report at all, fails.
2. **NO REPETITION** — he never asks for what the driver already said.
3. **NATURAL** — a colleague on the phone: a short acknowledgement
   before the question, plain words, no lecturing, no form-filling, no
   read-backs mid-conversation.
4. **NO INVENTION** — no fact the driver did not say. Asking is fine.
5. **LENGTH** — at most three follow-up questions after the driver has
   said what happened, then he closes; one good question is enough when
   the driver has already said the rest. The opening greeting is not a
   question and is not counted. Four follow-ups fails.
6. **CLOSE** — he confirms the tip in one line, consistent with what the
   driver said, and lets the driver go. Judged on what the driver said
   in that call: a fact the driver never gave is not missing, and the
   address need not be said. What fails is no tip, a wrong tip, or
   thanks alone.

The **control row** (#20, "nothing to report") turns three of them
round: at most one confirming question, no probing, and a close that
says there is nothing to note — a suite that never accepts "nothing
happened" teaches the prompt to invent problems. The **vague** persona
gets a seventh: before anything specific, one open question to find out
what happened. Any row whose `follow_up` says "nothing" is a control.

**Generated at run time, never committed.** The rows live on the
dashboard, so the files are cut from the live table on every press of a
button (`node generate-tests.mjs --situations`, the anon key by
default) into `test_configs/situations/`, which is gitignored. A project
whose `schema.sql` predates the table, or whose tab is empty, falls back
to `situations-starter.js` and says so in one line, so a button never
comes back with nothing to run. `--sheet` forces the starter twenty,
`--file JSON` reads rows from a file, `--situation N` does one row.

Both suites live in one ElevenLabs workspace and are told apart by
name — `Otto · situation #3 …` against `Otto · #3 …` — which is all the
`suite` input on the buttons and `--filter` on `run` need.

**The driver and the judge are cast by name.** Every test file names
the model that plays the simulated driver and the model that judges the
call (`simulated_user_model`, `evaluation_model` — `SIMULATION_MODELS`
in `generate-tests.mjs`, both the platform default at the time of
writing). Left unset, ElevenLabs's default would decide, and a change to
that default moves a baseline with no change to the prompt. Change them
on purpose, regenerate, and treat the next run as a new baseline.

**The designer's decisions.** The dashboard's RUNS tab reads each run
as a report — what went well, what went wrong, what to change — and
every finding there has a **NOT A PROBLEM** button. What is marked
lands in `accepted_findings` (key, title, note) and stays out of every
later report; `propose` reads the same table and hands it to the
proposer as `designer_decisions`, behaviours it must not "fix" whatever
a failing rationale says. No table yet (a `schema.sql` that predates
it) is reported in one line and the proposer simply gets none.

## Confidential prompt

Otto's prompt is the work. This repository is public, and so is
everything a run of the buttons writes: the job log, the job summary,
the artifacts, and the `agent_runs` table (the open pilot policies let
anyone read it with the anon key). So the prompt lives in **one place —
ElevenLabs** — and the loop is built to keep it there.

**What never leaves ElevenLabs**

- the prompt itself. `propose --quiet` prints how many characters
  changed and the name of the file it wrote — never the text. `branch`
  prints ids. The one request that carries the prompt (`POST …/branches`)
  never prints what came back either: a validator quoting the field it
  refused would quote the prompt.
- the **diff**. It is written to `proposals/<stamp>.json` on the machine
  that ran `propose`, which is gitignored and uploaded as no artifact.
- the **note** — the one line saying what a change was for. It goes to
  ElevenLabs as the agent branch's `description`, and `promote` reads it
  back from there (`GET /v1/convai/agents/{id}/branches/{branch_id}`)
  instead of carrying a proposal file around. `publish` has no `--note`
  and the `agent_runs.note` column is always null; `promote --quiet`
  does not print it.
- `agent_configs/` — what the ElevenLabs CLI pulls. **Never commit it**:
  it is the prompt in a file. It is in `.gitignore` and it stays there.

**What the public repo does carry**, on purpose: the transcripts of the
**simulated** conversations (a made-up driver talking to the agent — the
evidence a pass rate means something), the pass rates themselves, the
evaluator's reason for a failure, `tests.lock.json`, and the test files
for the trigger suite. None of those quote the prompt.

`--quiet` is the switch, on `propose` and `promote`; the buttons pass
it. It takes nothing else away — counts, ids, pass rates and transcripts
still print — and it also stops a dry run printing request bodies, since
the proposer's body *is* the prompt.

## Without a terminal: the buttons

The same runbook, pressed instead of typed. The repository's
`agent-suite` workflow (`.github/workflows/agent-suite.yml`) has a *Run
workflow* form under Actions → agent-suite with one dropdown; each
button runs one stage on a GitHub runner and writes the table into the
run's job summary (the run page, "Summary" at the top):

The form has two dropdowns: **action** (which stage) and **suite**
(which tests — *situations*, the default and the pilot's own; *triggers*,
the scenario sheet; or *all*). Every action but *configure* regenerates
the situation tests from the live rows before it pushes anything, so a
row edited on the dashboard is in the next press.

| Button | Runs | Summary ends with |
|---|---|---|
| **configure** | `configure` | the next button |
| **baseline** | `generate --situations` → `push-tests` → `run --label main` → `publish` (`repeat`, `filter` from the form; Mondays 06:00 UTC too) | the suite's pass rates |
| **field** | `pull --days N` → `score` → `cut` → `push-tests` | what was pulled, scored and cut |
| **propose** | the field again → `propose --quiet` → `branch` → `run --branch … --label branch` → `compare` against the latest baseline → `publish` with the verdict | the branch run's table, **ACCEPT** or **REJECT** with the branch id, and the next button — *not* the proposal, the diff or the note |
| **try** | `run --branch <branch from the form> --label branch` → `compare` against the latest baseline → `publish` with the verdict | the same, for a branch that already exists: a prompt edited by hand in the ElevenLabs dashboard, tried without a model and without `OPENAI_API_KEY`. The form takes the branch's **name** as typed in ElevenLabs or its `agtbrch_…` id; the agent's own id is refused by name |
| **promote** | `promote --branch <branch_id from the form> --quiet` → `run --label main` → `publish` | the new baseline |

One-time setup, in the browser: Settings → Secrets and variables →
Actions. Add `ELEVENLABS_API_KEY` as a **secret**, `ELEVENLABS_AGENT_ID`
as a **variable** (the id the phone uses — the same value as the Vercel
env var), and `OPENAI_API_KEY` as a secret for *propose* (*try* needs
neither the model nor that key). A button pressed without the key fails
with those instructions.

State between presses: `tests.lock.json` and `test_configs/regressions/`
are committed back to the branch the run started from by the workflow
itself (as `github-actions[bot]`). `results/` and `field/` are uploaded
as the run's Artifacts — `loop-baseline` (baseline, promote) and
`loop-field` — and *propose* and *try* download the latest
`loop-baseline` to compare against (running the suite on the live agent
first when there is none). **`proposals/` is uploaded nowhere**: it
carries the prompt, and *promote* no longer needs it, since the version
note is read back from the branch. Artifacts expire after ninety days.
Two presses at once queue behind each other.

Every suite a button runs is also published as an `agent_runs` row (the
kit's Supabase project unless the job is given another
`SUPABASE_URL` / `SUPABASE_ANON_KEY`), and the summary ends with
"Results are on the scenarios dashboard (dashboard.html), per
scenario." A publish that fails does not fail the button — the suite
was paid for, its summary and artifact still land — and the summary
says "results not published" with the loop's last line, which names the
fix (most likely: re-run `supabase/schema.sql` on that project).

### Tools, mocked for the suite

The suite runs with no phone on the other end. A **client tool** the
agent calls — `report_incident`, say — has nobody to answer it, and
ElevenLabs fails the run outright ("Client tools are not supported in
simulation tests"): the first live baseline lost 21 of 33 tests to
exactly that, not to the prompt. So `push-tests` looks up the tools the
agent carries and sends every simulation test with `tool_mock_config`
(mock all, error when a tool has no mock) and one `tool_mock_overrides`
entry per tool; system tools are left out, ElevenLabs never mocks
those. The answer is a receipt that asks to be kept quiet ("OK. Handled
in the background. Do not tell the driver…"): an answer that read like
a sentence in the tool's name came back out of the agent's mouth as
"I've noted that" mid-call in 57 of 78 failed calls on the first
situations baseline, so what the suite measures was partly its own
mock. The tool calls themselves are kept on the saved failed run — as
`tools` on the agent turn spoken next — and the dashboard shows "sent
the report to the app just before this line" there. The mocks are keyed by tool id, so
they are added at push time and the files under `test_configs/` stay
agent-independent; a file that carries its own mock block keeps it.
`--no-mock-tools` sends the files as they are. Each entry is a LIST of
answers per tool id — the API allows several, chosen by their
parameter conditions, and refuses a bare object.

**The judge's word per check.** Every success condition ends with
"Start your answer with PASS or FAIL, then the reason", and the judge
answers one paragraph per condition — "Criterion 3: FAIL. Otto read the
whole report back…" — so the verdicts are read, not guessed
(`verdictsOf` in `loop.mjs`). A results file carries them three ways:
`failure.verdicts`, the word per condition on the kept failed run;
`checks` per test, pass and fail counts per condition over every run
of that test, passed runs included; and `summary.by_check` on the
published `agent_runs` row, the same over the whole suite. The RUNS
tab's "notes by check" table shows them.

**Two calls kept per test.** `failure` is the first failed run, whole
— the judge's notes and the turns it judged, tool calls marked. From
now on `success` is kept the same way: the shortest passed run with
any words in it, so the dashboard can put a good call next to the bad
one, and a suggestion's "after" can be Otto's own words rather than a
line written from the sheet. Null when no passed run had a transcript.

The **why** line on a failed test (the table, the dashboard chip) is
the evaluator's summary when it says something of its own
("Unsupported client tool"), otherwise the first paragraph the judge
marked FAIL, and — for a rationale from before the conditions asked
for a verdict — the first paragraph that reads as a failure
("Criterion 4: … four questions, exceeding the limit of three"). The
whole rationale is kept under `failure`.

### What each command leaves behind

| File | Written by | What |
|---|---|---|
| `test_configs/scenario-NN-<slug>--<persona>[-it].json` | `generate` | one request body for `POST /v1/convai/agent-testing/create`, plus `_otto` (scenario, persona, language, the briefing) which the loop strips before posting |
| `test_configs/regressions/<conversation_id>.json` | `cut` | an `llm` test cut from the real conversation. For a follow-up / tip / brevity / language failure: the turns before the LAST agent turn, a success condition from those checks and the designer's note, and that last turn — the reply graded bad — as the failure example. For a debrief failed on the opener ALONE: cut before the FIRST agent turn (no `chat_history`), so the reply scored is the opener itself. A test cut mid-conversation carries no opener demand, and `cut` says how many it left out |
| `tests.lock.json` | `push-tests` | `{"<test name>": "<test id>"}` — committed, so a fresh clone updates rather than duplicates |
| `results/<stamp>-<label>.json` | `run` | per test: runs, passed, pass_rate, the failure rationales, the first failed run whole (`why`, `failure`), branch/version |
| `results/score-<stamp>.json` | `score` | per scenario: suite pass rate, field grade rate, checks failed, failures by reason |
| `field/<stamp>.json` | `pull` | conversations joined to their debrief, grade and scenario |
| `proposals/<stamp>.json` | `propose` (`branch` adds the branch ids) | prompt, note, rationale, unified diff. Gitignored, and uploaded as no artifact: this is the confidential one |
| `test_configs/situations/situation-NN-<slug>--<persona>.json` | `generate --situations` | one simulation test per situation row × persona, from the LIVE rows at run time; gitignored, regenerated every run |
| a row of `agent_runs` (Supabase, not a file) | `publish` | the results file as the dashboard reads it: `tests` — per test its scenario **or situation**, persona, language, runs / passed / pass rate, `why` (the first failure, one line) and `failure` (that run's rationale and transcript; null when every run passed) — and `summary` (totals, and the same per row under `by_scenario` / `by_situation`); the agent, branch, version and invocation ids; `run_url`; on a branch run, `verdict` and `verdict_reason`. Never the note |

`results/`, `field/`, `proposals/`, `agent_configs/` and
`test_configs/situations/` are gitignored; the rest is meant to be
committed.

### Grades

The dashboard stores a grade on the debrief row (`messages.grade`):

```json
{ "checks": { "opener": true, "followup": false, "tip": false, "brevity": true, "language": null },
  "note": "Never asked where the loading bay is", "at": "…", "agent_version": null }
```

`null` = not judged. A debrief is *graded* when any check is judged or a
note was left, *graded bad* when any check is false — that is what `cut`
cuts from and what `score` counts. `pull` stamps `agent_version` with the
conversation's `version_id` (the dashboard cannot know it), so a grade
stays comparable after the prompt moves on; `--no-stamp` skips the write.

The opener is the odd one out. On the phone it is the sheet's "Otto says"
line, sent as the `first_message` override — the prompt only writes the
opening turn when the agent refuses that override (`configure` prints
which overrides are enabled). So an `opener` failure points at the
override or the sheet line before it points at the prompt, and only a
debrief failed on the opener alone becomes a first-turn test.

## The ElevenLabs CLI (optional): the prompt on your own machine

The loop never needs the CLI. It is the convenient way to have the
agent's config to hand while you work on it:

```sh
npm i -g @elevenlabs/cli          # or: brew install elevenlabs
elevenlabs agents init
elevenlabs agents pull --agent $ELEVENLABS_AGENT_ID     # -> agent_configs/
elevenlabs agents push --version-description "Ask where they parked first"
```

**`agent_configs/` is gitignored and must stay that way** — it is the
prompt in a file, and this repository is public (see [Confidential
prompt](#confidential-prompt)). Pull it, work with it, leave it out of
the commit.

`propose` reads the current prompt from any JSON under `agent_configs/`
that carries `conversation_config.agent.prompt.prompt` before it falls
back to `GET agent`; `--prompt FILE` (text, or such a JSON) overrides
both, `--agent` forces the GET. The CLI's file layout is its own — the
loop looks for that one field and nothing else.

## Cost

The suite is LLM-only: a simulation test is a simulated tester talking to
the agent's LLM, judged by an evaluation model — no TTS, no minutes.
`--repeat N` multiplies that (3 by default, up to 20); `--filter` runs a
subset. `pull` reads; the only thing it pays for is nothing. `propose` is
one chat completion, its input trimmed to 80 000 characters (the worst
tests and the latest debriefs survive; `propose` prints what it left
out) and its output sized to echo the prompt back. Field conversations cost what they cost on the
phone, and the post-call analysis `configure` switches on adds a small
LLM charge per call.

## The blind spot

A *trigger* test sends the agent the phone's **dynamic variables** and
the scenario's opening line. The phone also sends a **contextual
update** —
the same briefing in plain sentences (`agentBriefing()` in `app.js`) —
which the testing API has no slot for. An agent whose prompt leans on
the briefing rather than on `{{scenario_rule}}`-style variables will
look worse in the suite than in the field. `_otto.briefing` in every
generated test carries the text; a prompt that references the variables
is the fix.

## Unverified

Everything the loop sends was checked against the API reference
(`https://elevenlabs.io/docs/api-reference/…`, append `.md` for the
markdown). What the docs do not settle:

- Whether `PATCH /v1/convai/agents/{id}` with `platform_settings`
  **merges or replaces** its other keys, and whether an agent already on
  `platform_settings.analysis_items` honours the legacy `evaluation` /
  `data_collection` fields. `configure` sends the agent's whole
  `platform_settings` back with its three keys merged in — minus the two
  spots the reference marks read-only, `safety` and
  `queueing_config.hold_audio` — so auth, privacy, call limits, widget
  and attached tests survive under either reading; it then reads the
  agent back, warning if the criteria did not land.
- Whether `conversation_config` on `POST …/branches` merges a partial
  object (`{agent:{prompt:{prompt}}}`) into the parent version, as
  "changes to apply" suggests, or needs the full config.
- Nothing about the branch's own note: `GET
  /v1/convai/agents/{agent_id}/branches/{branch_id}` is documented to
  answer with `id, name, agent_id, description, created_at,
  last_committed_at, is_archived, …`, and `description` is what `branch`
  set — that is where `promote` reads the version note from. The merge
  endpoint takes no note of its own (only `target_branch_id`,
  `archive_source_branch`, `force`), so the note stays on the branch
  rather than becoming the merged version's description.
- `success_examples` / `failure_examples` on an `llm` test are described
  as "non-empty list … optional", so `cut` sends no `success_examples`
  and exactly one failure example (the reply that was graded bad). How
  much weight the evaluator gives that example next to the
  `success_condition` is not documented.
- `chat_history` on an `llm` test is optional, and `cut` leaves it out
  for a first-turn (opener) test. Whether the agent's LLM then writes
  the opening turn from the prompt, or ElevenLabs answers with the
  agent's configured `first_message`, the reference does not say; the
  first-turn test assumes the former.
- The ElevenLabs CLI's `agent_configs/` layout (only the one field is
  read, anywhere in any JSON there).
- The test list's `search` is described as a filter by name; the loop
  matches the exact name within what comes back, so a looser search
  costs nothing.

## Tests

```sh
cd elevenlabs && npm test
```

`test/loop.test.mjs` runs every command against an in-process mock of
the three services (`test/mock-elevenlabs.mjs`; its Supabase has an
`agent_runs` table that can be switched off, for the schema hint) on
`test/fixture/`, in a temp folder; it checks the requests, the files,
the row `publish` posts, that a command without its key sends nothing,
and that `--dry-run` sends nothing.
`test/generate.test.mjs` checks the trigger generator against the sheet
and `app.js`. `test/situations.test.mjs` checks the situation suite: the
twenty starter rows × four personas, the six conditions in their order
(and the control row's three, and the vague persona's seventh), no
`chat_history`, the exact dynamic-variable key set, determinism, and
both sources — the live table and the fallback to the starter sheet when
a project has no table or nothing active in it.
`test/workflow.test.mjs` reads the live-suite job in
`.github/workflows/agent-suite.yml` and checks the poll budget it hands
the loop fits inside the job's own timeout, that every step which runs
the suite publishes it, that the situation tests are generated before
anything is pushed, that the `suite` input picks the filter, and that
nothing the buttons write can carry the prompt, its diff or its note.
