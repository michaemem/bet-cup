-- Results, Scoring & Leaderboard (S-04, north star)
-- Completes the product's core loop: post-kickoff result storage, the FR-018
-- scoring rule as a pure SQL function, and the read-time prediction-score +
-- leaderboard views. Scoring is computed read-time so a result correction
-- (FR-010) recomputes everything for free — there is nothing to invalidate.
--
-- Why a SEPARATE match_results table (not result columns on matches): the
-- matches UPDATE policy is `using (is_admin() and kickoff_time > now())` (the
-- FR-008 pre-kickoff fixture-edit lock, 20260602180000_tournament_and_matches.sql).
-- It filters out every post-kickoff match row, so results — which by definition
-- are entered AFTER kickoff — could never be written onto matches. A dedicated
-- table gets its own post-kickoff-ONLY admin write policy, the mirror image of
-- the fixture lock.
--
-- BLINDNESS INTERACTION (the load-bearing invariant): results can only exist
-- once a match has kicked off (the INSERT/UPDATE guard below). Once kicked off,
-- every prediction for that match is already world-visible via the S-03
-- predictions_select policy (owner-OR-post-kickoff). So an invoker-rights
-- leaderboard view sees ALL scored predictions for ANY caller, yet still cannot
-- leak an unscored (pre-kickoff) prediction — there is no result to score it
-- against. Completeness rides on this invariant, not on a definer bypass.
--
-- Reuses F-01's public.set_updated_at() and public.is_admin()
-- (20260528232000_identity_boundary.sql) and S-03's public.match_is_kicked_off()
-- (20260604184657_predictions_with_blindness.sql). Forward-only.

-- 1. match_results: one result row per match (UNIQUE match_id), written only by
--    the admin and only after kickoff. Correction is an UPDATE (upsert on the
--    unique key) — no DELETE path in this slice. Scores 0..99 mirror the
--    predictions CHECK and the zod schema. Cascades on match deletion.
create table public.match_results (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique references public.matches (id) on delete cascade,
  home_score smallint not null,
  away_score smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (home_score >= 0 and home_score <= 99),
  check (away_score >= 0 and away_score <= 99)
);

comment on table public.match_results is
  'Final score per match, one row per match_id — corrections overwrite (FR-010). Admin-only writes, locked to POST-kickoff (the mirror of the matches FR-008 pre-kickoff lock). Results are publicly readable: they only exist post-kickoff, when predictions are already world-visible, so reading a result leaks nothing.';

create trigger updated_at_match_results
  before update on public.match_results
  for each row
  execute function public.set_updated_at();

-- 2. RLS. Reads are open to any authenticated user (results are public; they
--    only exist post-kickoff). Writes require admin AND a kicked-off match —
--    match_is_kicked_off() is the same time-source S-03 uses, evaluating now()
--    per row so the guard is race-proof. No DELETE policy (correction is upsert).
alter table public.match_results enable row level security;

create policy match_results_select on public.match_results
  for select
  to authenticated
  using (true);

create policy match_results_insert on public.match_results
  for insert
  to authenticated
  with check (public.is_admin() and public.match_is_kicked_off(match_id));

create policy match_results_update on public.match_results
  for update
  to authenticated
  using (public.is_admin() and public.match_is_kicked_off(match_id))
  with check (public.is_admin() and public.match_is_kicked_off(match_id));

-- 3. score_prediction: the FR-018 rule as a pure, immutable function. Order is
--    load-bearing — equal goal-difference is checked BEFORE equal outcome
--    because equal difference subsumes (implies) equal outcome, so the ladder
--    collapses to: exact 3 → same-difference 2 → same-outcome 1 → wrong 0.
--    No table access, so no security context is needed.
create function public.score_prediction(p_home int, p_away int, r_home int, r_away int)
  returns int
  language sql
  immutable
as $$
  select case
    when p_home = r_home and p_away = r_away then 3
    when (p_home - p_away) = (r_home - r_away) then 2
    when sign(p_home - p_away) = sign(r_home - r_away) then 1
    else 0
  end;
$$;

comment on function public.score_prediction(int, int, int, int) is
  'FR-018 scoring: 3 exact / 2 same goal-difference / 1 same outcome / 0 wrong. Order matters — same-difference is tested before same-outcome because it subsumes it.';

-- 4. prediction_scores: per-prediction points for every SCORED (i.e. played)
--    match. security_invoker = true so the caller's own predictions RLS applies:
--    only predictions the caller may read appear. By the post-kickoff-result
--    invariant, a row only joins to a result once the match has kicked off, at
--    which point predictions_select reveals it to everyone — so every scored
--    prediction is visible to every caller, and nothing pre-kickoff leaks.
create view public.prediction_scores
  with (security_invoker = true)
as
  select
    p.predictor_id,
    p.match_id,
    p.home_goals,
    p.away_goals,
    r.home_score,
    r.away_score,
    public.score_prediction(p.home_goals, p.away_goals, r.home_score, r.away_score) as points
  from public.predictions p
  join public.match_results r on r.match_id = p.match_id;

comment on view public.prediction_scores is
  'Per-prediction FR-018 points, only for matches that have a result (i.e. played). security_invoker = true: the caller''s predictions RLS applies, but the post-kickoff-result invariant means every scored prediction is already world-visible, so the leaderboard built on this is complete.';

-- 5. leaderboard: every participant ranked (FR-020). LEFT JOIN from
--    profiles_public so a participant who predicted nothing still appears with
--    total_points = 0 (FR-019). Tie-break: total_points desc, then exact-score
--    count desc, then display_name alphabetical. security_invoker = true; the
--    completeness argument is the same invariant as prediction_scores.
create view public.leaderboard
  with (security_invoker = true)
as
  select
    pr.id as participant_id,
    pr.display_name,
    coalesce(sum(s.points), 0) as total_points,
    count(*) filter (where s.points = 3) as exact_scores
  from public.profiles_public pr
  left join public.prediction_scores s on s.predictor_id = pr.id
  group by pr.id, pr.display_name
  order by total_points desc, exact_scores desc, lower(pr.display_name) asc;

comment on view public.leaderboard is
  'FR-020 standings: every participant (LEFT JOIN profiles_public so non-predictors show 0 — FR-019), ranked by total_points desc, exact-score count desc, then display_name. security_invoker = true; completeness rides on the post-kickoff-result invariant.';

-- 6. Grants. Reads for any authenticated user; the views inherit invoker rights.
grant select on public.match_results to authenticated;
grant select on public.prediction_scores to authenticated;
grant select on public.leaderboard to authenticated;
