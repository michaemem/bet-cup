-- Tournament & Matches (S-02)
-- The two domain tables this slice owns: the single tournament (name + IANA
-- timezone) and its match list (home/away/kickoff). Admin-only at the data
-- layer via F-01's is_admin() helper; participant read access is opened later
-- by S-03. Kickoff is stored as timestamptz (UTC at rest) so it can drive
-- S-03's blindness lock and S-04's scoring without timezone drift.
--
-- The FR-008 edit-before-kickoff lock is the matches UPDATE policy:
-- using (is_admin() and kickoff_time > now()). A past-kickoff row is filtered
-- out of the UPDATE's row set, so the write silently affects zero rows — the
-- Action layer treats an empty returned set as a lock failure (race-proof).
--
-- Reuses F-01's public.is_admin() (SECURITY DEFINER, recursion-safe) and
-- public.set_updated_at() (20260528232000_identity_boundary.sql).
-- No home_score/away_score columns here — results + scoring are S-04.

-- 1. tournaments: the single tournament. Singleton is enforced by the Action
--    layer (tournament.upsert), not a DB constraint (PRD Non-Goal: single
--    tournament; no multi-tournament schema).
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  time_zone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tournaments is
  'The single BetCup tournament (name + IANA time_zone). Singleton is enforced at the application layer (tournament.upsert), not the schema. Admin-only RLS; S-03 opens participant read.';
comment on column public.tournaments.time_zone is
  'IANA zone name (e.g. Europe/Warsaw). Wall-clock match kickoffs are entered in this zone and converted to UTC for storage.';

create trigger updated_at_tournaments
  before update on public.tournaments
  for each row
  execute function public.set_updated_at();

-- 2. matches: the tournament's fixtures. kickoff_time is timestamptz (UTC at
--    rest). The (tournament_id, kickoff_time) index covers the ordered list
--    query and the kickoff_time > now() lock predicate.
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  home_team text not null,
  away_team text not null,
  kickoff_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.matches is
  'Fixtures for the tournament. kickoff_time is UTC (timestamptz); enter wall-clock in the tournament zone and convert. Admin-only RLS with a kickoff_time > now() UPDATE lock (FR-008); S-03 opens participant read. No result columns — scoring is S-04.';

create index matches_tournament_kickoff_idx
  on public.matches (tournament_id, kickoff_time);

create trigger updated_at_matches
  before update on public.matches
  for each row
  execute function public.set_updated_at();

-- 3. RLS. Both tables are admin-only for every operation. is_admin() is the
--    F-01 SECURITY DEFINER helper (reads the caller's own roles, recursion-safe).
alter table public.tournaments enable row level security;
alter table public.matches enable row level security;

-- tournaments: admin-only read/write. No kickoff lock (the tournament itself
-- has no kickoff); editing name/time_zone is always allowed for the admin.
create policy tournaments_select on public.tournaments
  for select
  to authenticated
  using (public.is_admin());

create policy tournaments_insert on public.tournaments
  for insert
  to authenticated
  with check (public.is_admin());

create policy tournaments_update on public.tournaments
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy tournaments_delete on public.tournaments
  for delete
  to authenticated
  using (public.is_admin());

-- matches: admin-only read/write. UPDATE additionally requires the kickoff to
-- be in the future (FR-008 edit-before-kickoff lock) — this is the source of
-- truth; the app layer pre-check only produces a friendlier message.
create policy matches_select on public.matches
  for select
  to authenticated
  using (public.is_admin());

create policy matches_insert on public.matches
  for insert
  to authenticated
  with check (public.is_admin());

create policy matches_update on public.matches
  for update
  to authenticated
  using (public.is_admin() and kickoff_time > now())
  with check (public.is_admin());

create policy matches_delete on public.matches
  for delete
  to authenticated
  using (public.is_admin());
