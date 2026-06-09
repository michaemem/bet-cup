-- Rebalance the FR-018 per-match scoring spread from 3/2/1/0 to 5/3/2/0.
--
-- Only the four point constants change; the tier structure and the load-bearing
-- branch order are identical to 20260605052647_results_scoring_leaderboard.sql
-- (same goal-difference is still tested before same outcome because it subsumes
-- it). A correctly-predicted non-exact draw therefore stays in the difference
-- tier and is worth 3 — symmetric with a correct-margin win; the same-outcome
-- tier (2) remains structurally unreachable for draws.
--
-- The leaderboard's FR-020 exact-score tie-break is re-pointed from points = 3
-- to points = 5 so "most exact scores" keeps meaning the exact tier, not the
-- new same-difference tier.
--
-- Additive, forward-only: `create or replace` of a pure immutable function and a
-- view. No schema/column change, no data backfill — scores recompute read-time
-- from prediction_scores on the next read.

-- score_prediction: FR-018 rule. 5 exact / 3 same goal-difference / 2 same
-- outcome / 0 wrong. Branch order is load-bearing (see header).
create or replace function public.score_prediction(p_home int, p_away int, r_home int, r_away int)
  returns int
  language sql
  immutable
as $$
  select case
    when p_home = r_home and p_away = r_away then 5
    when (p_home - p_away) = (r_home - r_away) then 3
    when sign(p_home - p_away) = sign(r_home - r_away) then 2
    else 0
  end;
$$;

comment on function public.score_prediction(int, int, int, int) is
  'FR-018 scoring: 5 exact / 3 same goal-difference / 2 same outcome / 0 wrong. Order matters — same-difference is tested before same-outcome because it subsumes it.';

-- leaderboard: FR-020 standings. Identical to the prior definition except the
-- exact-score tie-break now counts 5-point (exact) rows.
create or replace view public.leaderboard
  with (security_invoker = true)
as
  select
    pr.id as participant_id,
    pr.display_name,
    coalesce(sum(s.points), 0) as total_points,
    count(*) filter (where s.points = 5) as exact_scores
  from public.profiles_public pr
  left join public.prediction_scores s on s.predictor_id = pr.id
  group by pr.id, pr.display_name
  order by total_points desc, exact_scores desc, lower(pr.display_name) asc;

comment on view public.leaderboard is
  'FR-020 standings: every participant (LEFT JOIN profiles_public so non-predictors show 0 — FR-019), ranked by total_points desc, exact-score count desc, then display_name. security_invoker = true; completeness rides on the post-kickoff-result invariant.';
