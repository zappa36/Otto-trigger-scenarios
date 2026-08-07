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
  created_at timestamptz not null default now()
);

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

create index if not exists messages_dest_idx on public.messages (destination_id, created_at desc);

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
  created_at timestamptz not null default now()
);

create index if not exists runs_scenario_idx on public.runs (scenario_id, created_at desc);

alter table public.destinations enable row level security;
alter table public.messages enable row level security;
alter table public.scenarios enable row level security;
alter table public.runs enable row level security;

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

drop policy if exists "anyone reads runs" on public.runs;
create policy "anyone reads runs" on public.runs
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds runs" on public.runs;
create policy "anyone adds runs" on public.runs
  for insert to anon, authenticated with check (true);

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
