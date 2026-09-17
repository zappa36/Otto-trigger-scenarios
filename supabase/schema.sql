-- ============================================================
-- Destinations, the messages Otto files against them, and the
-- trigger scenarios the dashboard defines around both.
-- Run once in the Supabase SQL editor (paste + Run). Safe to re-run.
-- ============================================================

create table if not exists public.destinations (
  id uuid primary key default gen_random_uuid(),
  title text not null,              -- short name shown on the pin
  addr text,                        -- full address, when known
  lat double precision not null,
  lng double precision not null,
  consignee text,                   -- who the delivery is for ("Maria Weber")
  floor text,                       -- floor / unit ("4th floor", "Apt 12B")
  notes jsonb,                      -- notes on file, newest first: [{id,text,at,by}] — by: 'dispatch' | 'driver'
  route text,                       -- the delivery route this stop belongs to (e.g. the demo route id)
  stop integer,                     -- 1-based position on that route
  created_at timestamptz not null default now()
);

-- Pre-arrival notes columns for databases created before them — what
-- Otto reads ALOUD as a driver approaches the pin: the consignee, the
-- floor, and building notes a dispatcher saved on the dashboard.
-- (Notes left by other drivers need no column: they are the messages
-- already filed against the destination.) Safe to re-run.
alter table public.destinations add column if not exists consignee text;
alter table public.destinations add column if not exists floor text;
alter table public.destinations add column if not exists notes jsonb;

-- Route columns for databases created before them — a destination can be
-- one stop on a delivery route (route-schoeneberg.js ships a 100-stop demo
-- route the dashboard loads as destination rows; several stops may share
-- one address). Safe to re-run.
alter table public.destinations add column if not exists route text;
alter table public.destinations add column if not exists stop integer;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid references public.destinations (id) on delete cascade,
  context text,                     -- what the debrief was about, as shown
  transcript text not null,         -- what was actually said
  title text,                       -- structured summary ("Entrance blocked — use side door")
  category text,                    -- one of NOTE_CATEGORIES (see the voice-note function)
  lat double precision,             -- where the reporter stood
  lng double precision,
  ar_summary text,                  -- observed activity, compact ("IN_VEHICLE 4m → STILL 50s")
  ar_trace jsonb,                   -- segments + any fired trigger (see activity-rec.js)
  via text,                         -- which Otto took the debrief: 'elevenlabs' or null (recorded)
  convo jsonb,                      -- the conversation, turn by turn: [{from:'ai'|'me',text,at}]
  conversation_id text,             -- the ElevenLabs conversation id (null for recorded debriefs)
  grade jsonb,                      -- the dashboard's grade of the conversation: {checks,note,at,agent_version}
  created_at timestamptz not null default now()
);

-- Activity-recognition columns for databases created before them —
-- the phone stamps Google-AR-style states onto debriefs while a test
-- is being tracked (states inferred on-device; see activity-rec.js).
alter table public.messages add column if not exists ar_summary text;
alter table public.messages add column if not exists ar_trace jsonb;

-- Conversation columns, for databases created before Otto could BE an
-- ElevenLabs agent (otto-agent.js). The transcript column still holds
-- what the tester said — `convo` adds what was asked back, which is
-- where a trigger scenario's follow-up questions live.
alter table public.messages add column if not exists via text;
alter table public.messages add column if not exists convo jsonb;

-- Agent-loop columns, for databases created before the agent's prompt
-- got a tuning loop of its own (elevenlabs/). conversation_id is the
-- id ElevenLabs gave the conversation — the join to the agent's own
-- transcript, analysis and evaluation results at the other end of the
-- wire (null for a recorded debrief: there is no conversation there).
-- grade is the designer's verdict on the CONVERSATION, as opposed to
-- the scenario verdict on the trigger: did Otto open with the
-- scenario's question, follow up on what was found, get the expected
-- tip type, keep it short, stay in the right language —
--   {checks:{opener,followup,tip,brevity,language: true|false|null},
--    note, at, agent_version}
-- null = not judged. That is the ground truth the loop scores the
-- prompt against, and a grade with a false in it is what a regression
-- test gets cut from.
alter table public.messages add column if not exists conversation_id text;
alter table public.messages add column if not exists grade jsonb;

create index if not exists messages_dest_idx on public.messages (destination_id, created_at desc);
-- the loop joins field conversations to their grades by this id
create index if not exists messages_convo_idx on public.messages (conversation_id);

-- One row per row of the "Otto triggers" sheet: what should trigger,
-- what Otto should ask, what he should learn — plus the pin where the
-- tester goes to act it out. The destination is the join point: the
-- messages Otto files against it are "what Otto understood".
create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  num integer,                      -- '#' column, for ordering and the pin label
  title text not null,              -- Trigger scenario
  rule text,                        -- Trigger rule (testable) — numbers as {key} placeholders
  ar_states text,                   -- Activity Recognition states
  signals text,                     -- Other signals needed
  timing text,                      -- Timing to talk
  otto_says text,                   -- the question Otto opens the debrief with
  learns text,                      -- What Otto learns (tip type) — the expected outcome
  test_steps text,                  -- How to test it
  described text,                   -- the designer's own words (input of the AI draft)
  params jsonb,                     -- tunable values: [{key,label,value,min,max,step,unit}]
  version integer not null default 1,
  version_note text,                -- one-line changelog of the current version
  version_at timestamptz,
  history jsonb,                    -- prior versions in full: [{version,note,at,fields,params}]
  feedback jsonb,                   -- tester notes: [{id,at,version,via,text,status,applied_version}]
  destination_id uuid references public.destinations (id) on delete set null,
  verdict text check (verdict in ('pass', 'partial', 'fail')),
  created_at timestamptz not null default now()
);

-- Tuning-loop columns for databases created before them — params drive
-- the dashboard sliders (and the phone's trigger detector); version /
-- history / feedback carry the describe → test → feedback → new-version
-- loop. Safe to re-run.
alter table public.scenarios add column if not exists described text;
alter table public.scenarios add column if not exists params jsonb;
alter table public.scenarios add column if not exists version integer not null default 1;
alter table public.scenarios add column if not exists version_note text;
alter table public.scenarios add column if not exists version_at timestamptz;
alter table public.scenarios add column if not exists history jsonb;
alter table public.scenarios add column if not exists feedback jsonb;

create index if not exists scenarios_dest_idx on public.scenarios (destination_id);

-- One row per thing a driver REPORTS. A trigger scenario (above) is
-- about WHEN Otto speaks: a rule, a detector, a pin to act it out at.
-- A situation is about what happens AFTER the driver presses the big
-- REPORT button on the app and says what they found — the road was
-- closed, a dog at the door, the bell does nothing. There is no rule
-- and no trigger here; the pilot has neither. What is tested is the
-- CONVERSATION: does Otto's follow-up fit THAT report (a closed road
-- wants "how long, is there a way round"; a dog wants "was anyone with
-- it, where can the next one go"), does he sound like a colleague, and
-- does he end by confirming the one-line tip the next driver needs.
-- So a row carries the driver's first words, what the driver knows if
-- asked (and only then), what a fitting follow-up is about, what would
-- be off topic here, and that tip — the material a simulated driver is
-- acted out from (elevenlabs/generate-tests.mjs --situations, four
-- personas per row) and the yardstick the run is judged against.
-- `stop` is the Kollwitzkiez stop (route-kollwitz.js) the situation is
-- set at, so driver and Otto share an address, a consignee and the
-- notes on file; null means any stop will do. The dashboard's
-- SITUATIONS tab edits these rows, and the suite is generated from
-- them at run time — situations-starter.js is only the first twenty.
create table if not exists public.situations (
  id uuid primary key default gen_random_uuid(),
  num integer,                      -- '#' column, for ordering and the test file name
  title text not null,              -- what the situation is, short ("A big dog at the door")
  category text check (category is null or category in ('access', 'parking', 'gate_code', 'recipient', 'address', 'hazard', 'other')),
  stop integer,                     -- the Kollwitzkiez stop it is set at; null = the suite picks one
  driver_says text,                 -- the driver's first words after pressing REPORT
  driver_knows text,                -- what the driver can tell, if Otto asks — and only then
  follow_up jsonb,                  -- what a fitting follow-up asks about: ["how long the closure lasts", …]
  off_topic jsonb,                  -- what would not fit here: ["gate codes", "parking"]
  tip text,                         -- the one line Otto should end up confirming
  active boolean not null default true,  -- false = kept, not run (the suite reads the active rows)
  created_at timestamptz not null default now()
);

-- the suite reads the active rows in sheet order
create index if not exists situations_num_idx on public.situations (num);

-- Every tracked test run, fired or not — the dashboard's run log. A run
-- where nothing happened used to leave no data at all, and those are
-- exactly the runs debugging a trigger needs: which stage (pass / stop /
-- resume) it died at, under which knob values.
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid references public.scenarios (id) on delete cascade,
  scenario_version integer,           -- the definition the run tested
  destination_id uuid,                -- the pin at the time (no FK: pin may be re-set)
  started_at timestamptz,
  ended_at timestamptz,
  fired boolean not null default false,
  fired_at timestamptz,
  passes integer not null default 0,  -- pass episodes the detector counted
  stop_seen boolean not null default false,
  ar_summary text,                    -- "ON_FOOT 4m → STILL 30s → ON_FOOT 1m"
  ar_trace jsonb,                     -- segments (see activity-rec.js)
  tuning jsonb,                       -- exact detector values the run used
  fixes jsonb,                        -- raw fix stream, packed (see recordFix in app.js)
  should_fire boolean,                -- tester's verdict at run end; null = not answered
  verdict text,                       -- the full answer: on_time / early / late / false_alarm / quiet_right / missed
  created_at timestamptz not null default now()
);

-- The raw fix stream, for databases created before it: what the detector
-- SAW (t/lat/lng/speed/state at ~1 Hz), where ar_trace only says what it
-- concluded. This is what lets a run be replayed offline against other
-- detector values — see scripts/tune_triggers.py.
alter table public.runs add column if not exists fixes jsonb;

-- The tester's one-tap verdict, asked on the phone the moment tracking
-- stops, while the run is still fresh in their head. A fired run gets
-- the timing question (on_time / early / late / false_alarm); a silent
-- run gets quiet_right / missed. should_fire is the boolean the tuner
-- labels with (early and late still mean a debrief was warranted);
-- verdict keeps the full answer, so "too early" can pull the fire
-- later. Together with `fixes` this is the ground truth the offline
-- tuner (and any learned trigger later) trains against.
alter table public.runs add column if not exists should_fire boolean;
alter table public.runs add column if not exists verdict text;

create index if not exists runs_scenario_idx on public.runs (scenario_id, created_at desc);

-- The Delivered / Not delivered tap on a route stop (app.js) — the
-- phone's stand-in for the courier's parcel scan. One row per tap, so
-- a tour (one route on one day) can be rebuilt from the rows: which
-- stops were done, in what order, when, and how long the door took
-- (arrived_at is the first fix inside the arrival ring, when the phone
-- had one). Route and stop are copied from the stop so the tour
-- survives a re-pin; the destination link is for the door's notes.
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid references public.destinations (id) on delete cascade,
  route text,                       -- the stop's route id
  stop integer,                     -- its position on that route
  outcome text not null default 'delivered' check (outcome in ('delivered', 'failed')),
  arrived_at timestamptz,           -- first fix inside the arrival ring, if any
  delivered_at timestamptz not null default now(),  -- the tap itself
  lat double precision,             -- where the phone stood at the tap
  lng double precision,
  accuracy double precision,        -- of that fix, in metres
  created_at timestamptz not null default now()
);

create index if not exists visits_dest_idx on public.visits (destination_id, created_at desc);
create index if not exists visits_route_idx on public.visits (route, delivered_at desc);

-- Every run of the agent suite (elevenlabs/loop.mjs run — the ElevenLabs
-- simulation tests cut from the scenario and situation sheets), published by
-- `loop.mjs publish`: the agent-suite workflow does it after every
-- suite it runs, a terminal can too. The suite's results used to live
-- only in a job summary and an artifact on GitHub, while the designer
-- grades the field debriefs on dashboard.html — and a scenario's suite
-- verdict belongs next to its field verdict, not three clicks away.
-- One row per run: which agent, branch and version took it, how many
-- runs per test, and per test how many passed with the FIRST failed
-- run whole (the evaluator's rationale and the turns it judged), so a
-- card can show which turn went wrong rather than only that one did.
-- A branch run from `propose` also carries compare's word and reason:
-- whether it was promoted, and why. What the branch's prompt actually
-- says, and the one-line note the proposal gave it, never reach this
-- table — anyone can read it with the anon key, and the prompt is the
-- confidential part of the work.
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,           -- the ElevenLabs agent the suite ran against
  label text,                       -- the run's label: main (a baseline), branch, or what --label said
  branch_id text,                   -- the agent branch the suite ran on; null = the agent's main branch
  version_id text,                  -- the agent version that took the runs
  invocation_id text,               -- the ElevenLabs test invocation, to find the runs there
  repeat integer,                   -- runs per test the suite was asked for
  run_url text,                     -- the GitHub Actions run page; null when run by hand
  verdict text check (verdict in ('accept', 'reject')),  -- compare's word, on a branch run from propose; null otherwise
  verdict_reason text,              -- compare's reason line
  note text,                        -- unused, and always null: the prompt is confidential and this table is world-readable, so what a branch changed stays in ElevenLabs (the branch's own description)
  tests jsonb not null,             -- per test: [{name,test_id,kind,scenario_num,scenario_title,situation_num,situation_title,persona,language,runs,passed,pass_rate,why,failure:{test_run_id,rationale,verdicts:[pass|fail|unknown]?,transcript:[{role,message,tools?:[name]}]}|null,success:{the same shape — the shortest passed run with words in it}|null,checks:{"<n>":{pass,fail}}|null}]
  summary jsonb,                    -- {tests,tests_at_100,runs,passed,pass_rate,by_scenario:{"<num>":{…}},by_situation:{"<num>":{tests,runs,passed,pass_rate}},by_check?:{"<n>":{pass,fail}}} — by_check is the judge's own PASS/FAIL per condition over every call, since the conditions asked for one
  ran_at timestamptz not null,      -- when the suite ran (the results file's stamp)
  created_at timestamptz not null default now()
);

-- the dashboard reads the latest runs of one agent, newest first
create index if not exists agent_runs_agent_idx on public.agent_runs (agent_id, ran_at desc);

-- The designer's "not a problem" list. A finding the dashboard's RUNS
-- tab raised — a pattern in the failed calls, or a suggested prompt
-- change — that the designer has ruled fine by design (Otto's opening
-- greeting, say). One row per finding key; saving the same key again
-- only updates the note. Every run report hides those findings (a
-- collapsed "you said these are fine" list keeps them in view, with
-- UNDO), and the loop's propose step hands them to the proposer as
-- decisions it must not touch. World-readable like the rest of the
-- pilot, so: no prompt text in the note.
create table if not exists public.accepted_findings (
  key text primary key,             -- the finding's stable id on the RUNS tab
  title text not null,              -- the finding, as the report worded it
  note text,                        -- why it is fine, in the designer's words (optional)
  decided_at timestamptz not null default now()
);

alter table public.destinations enable row level security;
alter table public.messages enable row level security;
alter table public.scenarios enable row level security;
alter table public.situations enable row level security;
alter table public.runs enable row level security;
alter table public.visits enable row level security;
alter table public.agent_runs enable row level security;
alter table public.accepted_findings enable row level security;

-- ------------------------------------------------------------
-- OPEN PILOT POLICIES (the default in this kit)
--
-- No accounts, so the anon key can read and write. A deliberate
-- pilot trade-off: anyone who can load the page can add and
-- edit. Switch to the signed-in block below before this carries
-- anything you would miss.
-- ------------------------------------------------------------

drop policy if exists "anyone reads destinations" on public.destinations;
create policy "anyone reads destinations" on public.destinations
  for select to anon, authenticated using (true);

drop policy if exists "anyone writes destinations" on public.destinations;
create policy "anyone writes destinations" on public.destinations
  for insert to anon, authenticated with check (true);

-- the dashboard re-pins a scenario's address in place
drop policy if exists "anyone updates destinations" on public.destinations;
create policy "anyone updates destinations" on public.destinations
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone deletes destinations" on public.destinations;
create policy "anyone deletes destinations" on public.destinations
  for delete to anon, authenticated using (true);

drop policy if exists "anyone reads messages" on public.messages;
create policy "anyone reads messages" on public.messages
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds messages" on public.messages;
create policy "anyone adds messages" on public.messages
  for insert to anon, authenticated with check (true);

-- the dashboard rewords and removes debriefs — a bad take must not
-- ride into a client demo, or be read to the next driver
drop policy if exists "anyone updates messages" on public.messages;
create policy "anyone updates messages" on public.messages
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone deletes messages" on public.messages;
create policy "anyone deletes messages" on public.messages
  for delete to anon, authenticated using (true);

drop policy if exists "anyone reads scenarios" on public.scenarios;
create policy "anyone reads scenarios" on public.scenarios
  for select to anon, authenticated using (true);

drop policy if exists "anyone writes scenarios" on public.scenarios;
create policy "anyone writes scenarios" on public.scenarios
  for insert to anon, authenticated with check (true);

drop policy if exists "anyone updates scenarios" on public.scenarios;
create policy "anyone updates scenarios" on public.scenarios
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone deletes scenarios" on public.scenarios;
create policy "anyone deletes scenarios" on public.scenarios
  for delete to anon, authenticated using (true);

-- the situations sheet is edited on the dashboard the way the trigger
-- sheet is: added, reworded, deactivated, thrown away
drop policy if exists "anyone reads situations" on public.situations;
create policy "anyone reads situations" on public.situations
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds situations" on public.situations;
create policy "anyone adds situations" on public.situations
  for insert to anon, authenticated with check (true);

drop policy if exists "anyone updates situations" on public.situations;
create policy "anyone updates situations" on public.situations
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone deletes situations" on public.situations;
create policy "anyone deletes situations" on public.situations
  for delete to anon, authenticated using (true);

drop policy if exists "anyone reads runs" on public.runs;
create policy "anyone reads runs" on public.runs
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds runs" on public.runs;
create policy "anyone adds runs" on public.runs
  for insert to anon, authenticated with check (true);

-- the phone patches the tester's verdict onto a run after it was logged
drop policy if exists "anyone updates runs" on public.runs;
create policy "anyone updates runs" on public.runs
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone reads visits" on public.visits;
create policy "anyone reads visits" on public.visits
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds visits" on public.visits;
create policy "anyone adds visits" on public.visits
  for insert to anon, authenticated with check (true);

-- the tap's undo on the phone
drop policy if exists "anyone deletes visits" on public.visits;
create policy "anyone deletes visits" on public.visits
  for delete to anon, authenticated using (true);

drop policy if exists "anyone reads agent_runs" on public.agent_runs;
create policy "anyone reads agent_runs" on public.agent_runs
  for select to anon, authenticated using (true);

-- the loop publishes a run; nothing updates or deletes one. A run is a
-- record of what the agent did on a day, and the newest row is the
-- current picture — an older one is the history the trail is for.
drop policy if exists "anyone adds agent_runs" on public.agent_runs;
create policy "anyone adds agent_runs" on public.agent_runs
  for insert to anon, authenticated with check (true);

-- the designer's decisions: made and unmade on the RUNS tab, read by
-- the dashboard and by the loop's propose step
drop policy if exists "anyone reads accepted_findings" on public.accepted_findings;
create policy "anyone reads accepted_findings" on public.accepted_findings
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds accepted_findings" on public.accepted_findings;
create policy "anyone adds accepted_findings" on public.accepted_findings
  for insert to anon, authenticated with check (true);

drop policy if exists "anyone updates accepted_findings" on public.accepted_findings;
create policy "anyone updates accepted_findings" on public.accepted_findings
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anyone deletes accepted_findings" on public.accepted_findings;
create policy "anyone deletes accepted_findings" on public.accepted_findings
  for delete to anon, authenticated using (true);

-- ------------------------------------------------------------
-- SIGNED-IN POLICIES
--
-- Uncomment (and drop the open ones) once the app has accounts.
-- Requires owner columns:
--
--   alter table public.destinations add column if not exists owner uuid
--     references auth.users (id) default auth.uid();
--   alter table public.messages add column if not exists owner uuid
--     references auth.users (id) default auth.uid();
--
-- create policy "signed-in writes destinations" on public.destinations
--   for insert to authenticated with check (owner = auth.uid());
-- create policy "owners delete destinations" on public.destinations
--   for delete to authenticated using (owner = auth.uid());
-- create policy "signed-in adds messages" on public.messages
--   for insert to authenticated with check (owner = auth.uid());
-- ------------------------------------------------------------
