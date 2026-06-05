import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/db/database.types";
import { formatInZone } from "@/lib/time";

// Shared assembly for the participant match-history pages (S-05). Both the
// own-history page (`/history`) and the cross-participant page
// (`/history/[participantId]`) go through this one tested code path. The merge
// is split into a pure, DB-free `buildHistoryRows` (unit-testable) and an async
// `loadHistory` that runs the four session-client reads under RLS.
//
// Points are NEVER computed here — they come from the `prediction_scores` view
// (the single SQL source of truth for FR-018). Blindness is enforced by the
// `predictions` RLS policy, not by this module; filtering predictions/scores by
// the target id is a friendly mirror of that boundary, never the guard.

export interface HistoryRow {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  kickoffLocal: string;
  isPast: boolean;
  prediction: { homeGoals: number; awayGoals: number } | null;
  result: { homeScore: number; awayScore: number } | null;
  points: number | null;
}

export interface HistorySummary {
  rows: HistoryRow[];
  totalPoints: number;
}

export interface HistoryMatchInput {
  id: string;
  home_team: string;
  away_team: string;
  kickoff_time: string;
}

export interface HistoryPredictionInput {
  match_id: string;
  home_goals: number;
  away_goals: number;
}

export interface HistoryResultInput {
  match_id: string;
  home_score: number;
  away_score: number;
}

export interface HistoryScoreInput {
  match_id: string;
  points: number;
}

export interface BuildHistoryInput {
  matches: HistoryMatchInput[];
  predictions: HistoryPredictionInput[];
  results: HistoryResultInput[];
  scores: HistoryScoreInput[];
  zone: string;
}

/**
 * Pure merge of matches + predictions + results + scores into display rows.
 *
 * Listing rule: a match appears iff the viewed participant has a prediction for
 * it OR a result exists. Points are read from `scores` (`prediction_scores`)
 * when present, else 0 when a result exists but there's no prediction, else null
 * (predicted-but-unresolved). Rows are ordered by kickoff ascending and
 * `totalPoints` is the sum of non-null points.
 */
export function buildHistoryRows(input: BuildHistoryInput): HistorySummary {
  const { matches, predictions, results, scores, zone } = input;

  const predictionByMatch = new Map(predictions.map((p) => [p.match_id, p]));
  const resultByMatch = new Map(results.map((r) => [r.match_id, r]));
  const pointsByMatch = new Map(scores.map((s) => [s.match_id, s.points]));

  const now = Date.now();
  const orderedMatches = [...matches].sort(
    (a, b) => new Date(a.kickoff_time).getTime() - new Date(b.kickoff_time).getTime(),
  );

  const rows: HistoryRow[] = [];
  let totalPoints = 0;

  for (const match of orderedMatches) {
    const prediction = predictionByMatch.get(match.id) ?? null;
    const result = resultByMatch.get(match.id) ?? null;

    if (!prediction && !result) continue;

    let points: number | null;
    if (pointsByMatch.has(match.id)) {
      points = pointsByMatch.get(match.id) ?? null;
    } else if (result && !prediction) {
      points = 0;
    } else {
      points = null;
    }

    if (points !== null) totalPoints += points;

    const utc = new Date(match.kickoff_time);
    rows.push({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      kickoffLocal: formatInZone(utc, zone),
      isPast: utc.getTime() <= now,
      prediction: prediction ? { homeGoals: prediction.home_goals, awayGoals: prediction.away_goals } : null,
      result: result ? { homeScore: result.home_score, awayScore: result.away_score } : null,
      points,
    });
  }

  return { rows, totalPoints };
}

/**
 * Run the four session-client reads for `targetUserId` under RLS and assemble
 * the summary. Throws on the first query error so callers can map a throw to a
 * 500 (the per-read error channel from `predictions/index.astro`, preserved
 * through one entry point). Never uses the service-role client.
 */
export async function loadHistory(
  supabase: SupabaseClient<Database>,
  targetUserId: string,
  zone: string,
): Promise<HistorySummary> {
  const { data: matches, error: matchesError } = await supabase
    .from("matches")
    .select("id, home_team, away_team, kickoff_time");
  if (matchesError) throw new Error("history: failed to load matches");

  // Only the target's predictions: pre-kickoff picks of OTHER participants are
  // excluded by the predictions_select RLS policy; the eq() narrows to the one
  // participant whose history we're showing.
  const { data: predictions, error: predictionsError } = await supabase
    .from("predictions")
    .select("match_id, home_goals, away_goals")
    .eq("predictor_id", targetUserId);
  if (predictionsError) throw new Error("history: failed to load predictions");

  const { data: results, error: resultsError } = await supabase
    .from("match_results")
    .select("match_id, home_score, away_score");
  if (resultsError) throw new Error("history: failed to load match_results");

  const { data: scores, error: scoresError } = await supabase
    .from("prediction_scores")
    .select("match_id, points")
    .eq("predictor_id", targetUserId);
  if (scoresError) throw new Error("history: failed to load prediction_scores");

  const scoreInputs: HistoryScoreInput[] = [];
  for (const score of scores) {
    if (score.match_id !== null && score.points !== null) {
      scoreInputs.push({ match_id: score.match_id, points: score.points });
    }
  }

  return buildHistoryRows({
    matches,
    predictions,
    results,
    scores: scoreInputs,
    zone,
  });
}
