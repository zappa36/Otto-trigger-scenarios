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
  created_at timestamptz not null default now()
);

-- Activity-recognition columns for databases created before them —
-- the phone stamps Google-AR-style states onto debriefs while a test
-- is being tracked (states inferred on-device; see activity-rec.js).
alter table public.messages add column if not exists ar_summary text;
alter table public.messages add column if not exists ar_trace jsonb;

create index if not exists messages_dest_idx on public.messages (destination_id, created_at desc);

-- One row per row of the "Otto triggers" sheet: what should trigger,
-- what Otto should ask, what he should learn — plus the pin where the
-- tester goes to act it out. The destination is the join point: the
-- messages Otto files against it are "what Otto understood".
create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  num integer,                      -- '#' column, for ordering and the pin label
  title text not null,              -- Trigger scenario
  rule text,                        -- Trigger rule (testable)
  ar_states text,                   -- Activity Recognition states
  signals text,                     -- Other signals needed
  timing text,                      -- Timing to talk
  otto_says text,                   -- the question Otto opens the debrief with
  learns text,                      -- What Otto learns (tip type) — the expected outcome
  test_steps text,                  -- How to test it
  destination_id uuid references public.destinations (id) on delete set null,
  verdict text check (verdict in ('pass', 'partial', 'fail')),
  created_at timestamptz not null default now()
);

create index if not exists scenarios_dest_idx on public.scenarios (destination_id);

alter table public.destinations enable row level security;
alter table public.messages enable row level security;
alter table public.scenarios enable row level security;

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
