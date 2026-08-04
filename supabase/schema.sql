-- ============================================================
-- Destinations and the messages Otto files against them.
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
  created_at timestamptz not null default now()
);

create index if not exists messages_dest_idx on public.messages (destination_id, created_at desc);

alter table public.destinations enable row level security;
alter table public.messages enable row level security;

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

drop policy if exists "anyone deletes destinations" on public.destinations;
create policy "anyone deletes destinations" on public.destinations
  for delete to anon, authenticated using (true);

drop policy if exists "anyone reads messages" on public.messages;
create policy "anyone reads messages" on public.messages
  for select to anon, authenticated using (true);

drop policy if exists "anyone adds messages" on public.messages;
create policy "anyone adds messages" on public.messages
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
