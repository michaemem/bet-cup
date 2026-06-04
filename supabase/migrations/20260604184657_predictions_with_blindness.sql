-- Predictions with Blindness (S-03)
-- The predictions table plus all DB-layer enforcement for the blindness
-- invariant (FR-015/FR-017) and the edit-before-kickoff lock (FR-014). Also
-- widens read access on tournaments/matches so participants can see fixtures
-- (deferred from S-02's admin-only reads).
--
-- The single most important rule in this slice: the predictions SELECT policy
-- is owner-OR-post-kickoff with NO is_admin() branch. Unlike every other
-- per-user policy in the schema (profiles_select, user_roles_select), the admin
-- is NOT exempt here — the admin is a participant and is blind to other
-- participants' pre-kickoff predictions (FR-017). Violating this once nullifies
-- the product, so it is enforced at the DB layer and proven by a CI RLS test.
--
-- The kickoff lock is enforced on BOTH INSERT and UPDATE (not just UPDATE like
-- matches): an upsert could otherwise create a prediction after kickoff via the
-- INSERT path. The match_is_kicked_off() helper evaluates now() per-row at query
-- time so the lock is race-proof; the Action layer adds a friendlier pre-check.
--
-- Reuses F-01's public.set_updated_at() (20260528232000_identity_boundary.sql).
-- Forward-only: the matches/tournaments SELECT policies are dropped and
-- recreated as using (true); admins still satisfy that, so it is additive.

-- 1. predictions: one row per (predictor, match). Edits overwrite via upsert on
--    the unique key (FR-013, no append-only history). Scores are 0..99 (a CHECK
--    that the zod schema and the form mirror). No result/points columns — that
--    is S-04.
create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  predictor_id uuid not null references public.profiles (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  home_goals smallint not null,
  away_goals smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (predictor_id, match_id),
  check (home_goals >= 0 and home_goals <= 99),
  check (away_goals >= 0 and away_goals <= 99)
);

comment on table public.predictions is
  'Per-participant score predictions, one row per (predictor_id, match_id) — edits overwrite (FR-013). BLINDNESS INVARIANT (FR-015/FR-017): the SELECT policy is owner-OR-post-kickoff with NO is_admin() branch, so a prediction is unreadable by anyone but its owner until the match kicks off. Writes are locked to the owner before kickoff (FR-014) on both INSERT and UPDATE.';

-- The (match_id) index covers the match_is_kicked_off()-adjacent policy reads
-- and the post-kickoff reveal queries; (predictor_id) covers the owner's
-- own-rows fetch and the unique-key upsert lookup.
create index predictions_match_id_idx on public.predictions (match_id);
create index predictions_predictor_id_idx on public.predictions (predictor_id);

create trigger updated_at_predictions
  before update on public.predictions
  for each row
  execute function public.set_updated_at();

-- 2. match_is_kicked_off: SECURITY DEFINER (locked search_path) so the
--    predictions policies can read matches.kickoff_time without the caller
--    needing their own row visibility into that match — and so the function is
--    safe to call from a policy. stable so it is evaluated efficiently per
--    statement; it reads now() per row at query time, so there is no cached/stale
--    kickoff path. Returns true once the match's kickoff is at or before now().
create function public.match_is_kicked_off(p_match_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id and m.kickoff_time <= now()
  );
$$;

-- 3. RLS. Owner-OR-post-kickoff read (NO admin branch); owner-AND-not-kicked-off
--    writes on both INSERT and UPDATE. No DELETE policy — predictions are not
--    user-deletable in S-03.
alter table public.predictions enable row level security;

create policy predictions_select on public.predictions
  for select
  to authenticated
  using (predictor_id = auth.uid() or public.match_is_kicked_off(match_id));

create policy predictions_insert on public.predictions
  for insert
  to authenticated
  with check (predictor_id = auth.uid() and not public.match_is_kicked_off(match_id));

create policy predictions_update on public.predictions
  for update
  to authenticated
  using (predictor_id = auth.uid() and not public.match_is_kicked_off(match_id))
  with check (predictor_id = auth.uid() and not public.match_is_kicked_off(match_id));

-- 4. Widen reads deferred from S-02. Forward-only: drop the admin-only SELECT
--    policies and recreate them as using (true) for any authenticated user.
--    Admins are authenticated too, so this is additive to behavior. Admin write
--    policies (insert/update/delete) are untouched.
drop policy tournaments_select on public.tournaments;

create policy tournaments_select_all on public.tournaments
  for select
  to authenticated
  using (true);

drop policy matches_select on public.matches;

create policy matches_select_all on public.matches
  for select
  to authenticated
  using (true);
