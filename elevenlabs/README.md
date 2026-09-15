# elevenlabs/ — the tuning loop for Otto's prompt

The dashboard tunes the trigger *detector*: sliders, versions, feedback,
a proposed vN+1, and `scripts/tune_triggers.py` replaying recorded runs
offline. This folder is the same loop for the *agent* — the ElevenLabs
Conversational AI agent that is Otto when the phone opens a live
conversation (`otto-agent.js`). Its prompt is the knob; the evidence is
two-fold:

- **a suite** of ElevenLabs simulation tests, one per row of the "Otto
  triggers" sheet × persona, carrying the *same dynamic variables a
  phone sends* on a real run (`generate-tests.mjs` mirrors `agentVars()`
  in `app.js`, and its test fails the moment the two drift);
- **the field**: every real conversation the agent had, with the
  analysis ElevenLabs ran on it, joined to the grade the designer gave
  the debrief on the dashboard (did Otto open with the scenario's
  question, follow up on what was found, get the tip type, keep it
  short, stay in the language).

Both are scored, a model proposes the smallest prompt diff the evidence
supports, the diff goes on an agent **branch**, the suite runs there, and
a human merges. Nothing in here edits the live prompt on its own.

Plain Node (>= 20, ESM, `node --test`), no dependencies — like
`mock-api/`. The REST API is called directly; the ElevenLabs CLI is
optional (below) and only for keeping the agent's config in git.

## The four stages, as commands

| Stage | What | Command |
|---|---|---|
| 1 · record | the conversation id lands on every agent debrief (`otto-agent.js`); the dashboard grades it; ElevenLabs grades every call with the criteria in `analysis.json` | `node loop.mjs configure` |
| 2 · suite | one simulation test per scenario row × persona, from the sheet; the run published for the dashboard | `npm run generate` → `node loop.mjs push-tests` → `node loop.mjs run` → `publish` |
| 3 · field | conversations + analysis + grades pulled and joined; a debrief graded bad becomes a next-reply regression test | `node loop.mjs pull` → `score` → `cut` |
| 4 · improve | a minimal prompt diff, on a branch, compared, promoted by hand | `propose` → `branch` → `run --branch` → `compare` → `promote` |

```
node loop.mjs <command> [--dry-run] [--dir DIR] [flags]

configure                       evaluation + data collection + overrides (analysis.json) onto the agent
push-tests [--no-mock-tools]    test_configs/**.json -> ElevenLabs tests, by name; writes tests.lock.json;
                                  the agent's tools are mocked for the suite (a client tool has no phone to answer it)
run        [--branch ID] [--repeat N=3] [--filter TEXT] [--label TEXT]
pull       [--since ISO | --days N=14] [--no-stamp]
score      [--results FILE] [--field FILE]
cut        [--field FILE]
propose    [--results FILE] [--field FILE] [--prompt FILE | --agent]
branch     --proposal FILE [--name TEXT]
compare    --base FILE --branch FILE [--margin 0.1]
promote    --branch ID [--target BRANCH_ID] [--proposal FILE] [--force]
publish    [--results FILE] [--run-url URL] [--verdict accept|reject] [--reason TEXT] [--note TEXT]
```

`--dry-run` prints every request a command would send — method, path,
body — and sends nothing; it needs no key, which makes it the safe way
to see what a command does. `--dir` (or `LOOP_DIR`) moves every file the
loop reads and writes; the tests use it to stay out of this folder.

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
npm run generate                   # test_configs/ from the starter sheet (--supabase for your own rows)
node loop.mjs push-tests           # create / update by name -> tests.lock.json
node loop.mjs run --label main     # the baseline: 3 runs per test, results/<stamp>-main.json
node loop.mjs publish              # that run onto the dashboard: a row of agent_runs, shown per scenario

# … testers drive; on the dashboard, grade the agent debriefs (GRADE THE CONVERSATION) …

node loop.mjs pull                 # field/<stamp>.json: conversations + analysis + grades
node loop.mjs score                # per scenario: suite pass rate, field grade rate, failures by reason
node loop.mjs cut                  # a debrief graded bad -> test_configs/regressions/<conversation_id>.json
node loop.mjs push-tests           # the regressions join the suite

node loop.mjs propose              # proposals/<stamp>.json: the prompt, a one-line note, the diff
node loop.mjs branch --proposal proposals/<stamp>.json
node loop.mjs run --branch <created_branch_id> --label branch
node loop.mjs compare --base results/<stamp>-main.json --branch results/<stamp>-branch.json
node loop.mjs publish --verdict accept --reason "…" --note "…"   # the branch run, with compare's word and the proposal's note
node loop.mjs promote --branch <created_branch_id> --proposal proposals/<stamp>.json
node loop.mjs run --label main     # the new baseline
node loop.mjs publish
```

`compare` says **ACCEPT** when no test drops by more than the margin (ten
points by default) *and* at least one previously failing test improves;
anything else is **REJECT**, exit code 1. `promote` merges the branch
into the agent's main branch and archives it, then tells you to pull the
config into git with the note as the version description.

`publish` is how a run reaches the person it is for. The designer grades
the field debriefs on `dashboard.html`, per scenario; the suite's verdict
on the same scenario belongs next to them, not in a job summary on
GitHub. So the latest results file (or `--results FILE`) becomes one
row of the `agent_runs` table: per test the runs, passes and pass rate,
the first failure's one-line *why* and that run whole — the evaluator's
rationale and the turns it judged — plus the totals per scenario; on a
branch run from `propose`, `--verdict` / `--reason` / `--note` carry
compare's word, its reason line and the proposal's note. `--run-url` is
the Actions run page (the buttons pass it; by hand there is none). It
prints the row's id; a project whose `schema.sql` predates the table
gets "re-run supabase/schema.sql" and exit 1, and the results file stays
where it is.

## Without a terminal: the buttons

The same runbook, pressed instead of typed. The repository's
`agent-suite` workflow (`.github/workflows/agent-suite.yml`) has a *Run
workflow* form under Actions → agent-suite with one dropdown; each
button runs one stage on a GitHub runner and writes the table into the
run's job summary (the run page, "Summary" at the top):

| Button | Runs | Summary ends with |
|---|---|---|
| **configure** | `configure` | the next button |
| **baseline** | `push-tests` → `run --label main` → `publish` (`repeat`, `filter` from the form; Mondays 06:00 UTC too) | the suite's pass rates |
| **field** | `pull --days N` → `score` → `cut` → `push-tests` | what was pulled, scored and cut |
| **propose** | the field again → `propose` → `branch` → `run --branch … --label branch` → `compare` against the latest baseline → `publish` with the verdict | **ACCEPT** or **REJECT**, and the branch id |
| **promote** | `promote --branch <branch_id from the form>` → `run --label main` → `publish` | the new baseline |

One-time setup, in the browser: Settings → Secrets and variables →
Actions. Add `ELEVENLABS_API_KEY` as a **secret**, `ELEVENLABS_AGENT_ID`
as a **variable** (the id the phone uses — the same value as the Vercel
env var), and `OPENAI_API_KEY` as a secret for *propose*. A button
pressed without the key fails with those instructions.

State between presses: `tests.lock.json` and `test_configs/regressions/`
are committed back to the branch the run started from by the workflow
itself (as `github-actions[bot]`). `results/`, `field/` and `proposals/`
are uploaded as the run's Artifacts — `loop-baseline` (baseline,
promote), `loop-field`, `loop-proposal` — and *propose* downloads the
latest `loop-baseline` to compare against (running the suite on the
live agent first when there is none), *promote* the latest
`loop-proposal` for the version note. Artifacts expire after ninety
days. Two presses at once queue behind each other.

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
entry per tool, answering in the tool's name; system tools are left
out, ElevenLabs never mocks those. The mocks are keyed by tool id, so
they are added at push time and the files under `test_configs/` stay
agent-independent; a file that carries its own mock block keeps it.
`--no-mock-tools` sends the files as they are.

The **why** line on a failed test (the table, the dashboard chip) is
the evaluator's summary when it says something of its own
("Unsupported client tool"), and otherwise — the summary is usually
just "Evaluation failed" — the first success condition whose paragraph
reads as a failure ("Criterion 4: … four questions, exceeding the
limit of three"). The whole rationale is kept under `failure`.

### What each command leaves behind

| File | Written by | What |
|---|---|---|
| `test_configs/scenario-NN-<slug>--<persona>[-it].json` | `generate` | one request body for `POST /v1/convai/agent-testing/create`, plus `_otto` (scenario, persona, language, the briefing) which the loop strips before posting |
| `test_configs/regressions/<conversation_id>.json` | `cut` | an `llm` test cut from the real conversation. For a follow-up / tip / brevity / language failure: the turns before the LAST agent turn, a success condition from those checks and the designer's note, and that last turn — the reply graded bad — as the failure example. For a debrief failed on the opener ALONE: cut before the FIRST agent turn (no `chat_history`), so the reply scored is the opener itself. A test cut mid-conversation carries no opener demand, and `cut` says how many it left out |
| `tests.lock.json` | `push-tests` | `{"<test name>": "<test id>"}` — committed, so a fresh clone updates rather than duplicates |
| `results/<stamp>-<label>.json` | `run` | per test: runs, passed, pass_rate, the failure rationales, the first failed run whole (`why`, `failure`), branch/version |
| `results/score-<stamp>.json` | `score` | per scenario: suite pass rate, field grade rate, checks failed, failures by reason |
| `field/<stamp>.json` | `pull` | conversations joined to their debrief, grade and scenario |
| `proposals/<stamp>.json` | `propose` (`branch` adds the branch ids) | prompt, note, rationale, unified diff |
| a row of `agent_runs` (Supabase, not a file) | `publish` | the results file as the dashboard reads it: `tests` — per test its scenario, persona, language, runs / passed / pass rate, `why` (the first failure, one line) and `failure` (that run's rationale and transcript; null when every run passed) — and `summary` (totals, and the same per scenario under `by_scenario`); the agent, branch, version and invocation ids; `run_url`; on a branch run from `propose`, `verdict`, `verdict_reason` and `note` |

`results/`, `field/` and `proposals/` are gitignored; the rest is meant
to be committed.

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

## The ElevenLabs CLI (optional): the prompt in git

The loop never needs the CLI. It is the convenient way to keep the
agent's config next to the tests:

```sh
npm i -g @elevenlabs/cli          # or: brew install elevenlabs
elevenlabs agents init
elevenlabs agents pull --agent $ELEVENLABS_AGENT_ID     # -> agent_configs/
elevenlabs agents push --version-description "Ask where they parked first"
```

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

A test sends the agent the phone's **dynamic variables** and the
scenario's opening line. The phone also sends a **contextual update** —
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
`test/generate.test.mjs` checks the generator against the sheet and
`app.js`. `test/workflow.test.mjs` reads the live-suite job in
`.github/workflows/agent-suite.yml` and checks the poll budget it hands
the loop fits inside the job's own timeout, and that every step which
runs the suite publishes it.
