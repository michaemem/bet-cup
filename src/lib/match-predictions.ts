import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/db/database.types";
import { readAllPages } from "@/lib/paginate";

// Per-match "See others' predictions" assembly (extends S-05). Mirrors
// `src/lib/history.ts` but pivots on match → participants instead of
// participant → matches: for each kicked-off match it produces the
// leaderboard-ordered roster, each participant's prediction (or null), and the
// match result + per-participant points when a result exists.
//
// Points are NEVER computed here — they come from the `prediction_scores` view
// (the single SQL source of truth for FR-018). Blindness is enforced by the
// `predictions` RLS policy (owner OR match_is_kicked_off), not by this module;
// scoping the reads to `kickedOffMatchIds` is a friendly mirror of that
// boundary, never the guard.

export interface MatchPredictionParticipantRow {
  participantId: string;
  displayName: string;
  isSelf: boolean;
  prediction: { homeGoals: number; awayGoals: number } | null;
  points: number | null;
}

export interface MatchPredictionsView {
  result: { homeScore: number; awayScore: number } | null;
  participants: MatchPredictionParticipantRow[];
}

export interface MatchPredictionsRosterInput {
  participantId: string;
  displayName: string;
}

export interface MatchPredictionsPredictionInput {
  match_id: string;
  predictor_id: string;
  home_goals: number;
  away_goals: number;
}

export interface MatchPredictionsResultInput {
  match_id: string;
  home_score: number;
  away_score: number;
}

export interface MatchPredictionsScoreInput {
  match_id: string;
  predictor_id: string;
  points: number;
}

export interface BuildMatchPredictionsInput {
  roster: MatchPredictionsRosterInput[];
  predictions: MatchPredictionsPredictionInput[];
  results: MatchPredictionsResultInput[];
  scores: MatchPredictionsScoreInput[];
  kickedOffMatchIds: Iterable<string>;
  viewerId: string;
}

function compositeKey(matchId: string, predictorId: string): string {
  return `${matchId}::${predictorId}`;
}

/**
 * Pure merge of roster + predictions + results + scores into per-match views.
 *
 * Emits one `MatchPredictionsView` per kicked-off match. Each view's
 * `participants` array follows roster (leaderboard) order; per participant:
 * their prediction or `null`, `isSelf` for the viewer, and `points` sourced from
 * `scores` when present, `0` when a result exists but no prediction (mirror of
 * `history.ts`), else `null` (no result yet). Predictions and scores are keyed
 * by the COMPOSITE `(match_id, predictor_id)` because points are per-participant
 * here, unlike the single-participant `history.ts`.
 */
export function buildMatchPredictionRows(input: BuildMatchPredictionsInput): Map<string, MatchPredictionsView> {
  const { roster, predictions, results, scores, kickedOffMatchIds, viewerId } = input;

  const predictionByKey = new Map(predictions.map((p) => [compositeKey(p.match_id, p.predictor_id), p]));
  const pointsByKey = new Map(scores.map((s) => [compositeKey(s.match_id, s.predictor_id), s.points]));
  const resultByMatch = new Map(results.map((r) => [r.match_id, r]));

  const views = new Map<string, MatchPredictionsView>();

  for (const matchId of kickedOffMatchIds) {
    const resultRow = resultByMatch.get(matchId) ?? null;
    const result = resultRow ? { homeScore: resultRow.home_score, awayScore: resultRow.away_score } : null;

    const participants: MatchPredictionParticipantRow[] = roster.map((member) => {
      const key = compositeKey(matchId, member.participantId);
      const predictionRow = predictionByKey.get(key) ?? null;
      const prediction = predictionRow
        ? { homeGoals: predictionRow.home_goals, awayGoals: predictionRow.away_goals }
        : null;

      let points: number | null;
      if (pointsByKey.has(key)) {
        points = pointsByKey.get(key) ?? null;
      } else if (result && !prediction) {
        points = 0;
      } else {
        points = null;
      }

      return {
        participantId: member.participantId,
        displayName: member.displayName,
        isSelf: member.participantId === viewerId,
        prediction,
        points,
      };
    });

    views.set(matchId, { result, participants });
  }

  return views;
}

/**
 * Run the four session-client reads under RLS and assemble the per-match views.
 * Throws on the first query error so callers can map a throw to a 500 (the
 * per-read error channel from `predictions/index.astro`). Never uses the
 * service-role client. Short-circuits to an empty map when no match has kicked
 * off so `.in()` is never called with an empty list.
 */
export async function loadMatchPredictions(
  supabase: SupabaseClient<Database>,
  viewerId: string,
  kickedOffMatchIds: string[],
): Promise<Map<string, MatchPredictionsView>> {
  if (kickedOffMatchIds.length === 0) {
    return new Map<string, MatchPredictionsView>();
  }

  // No explicit .order(): the leaderboard view carries the FR-020 tie-break
  // ORDER BY (total_points desc, exact-score count desc, then display_name).
  // Unfiltered — the roster is the global standings.
  const { data: roster, error: rosterError } = await supabase
    .from("leaderboard")
    .select("participant_id, display_name");
  if (rosterError) throw new Error("match-predictions: failed to load leaderboard", { cause: rosterError });

  // Paged: this read fans out to participants x kicked-off matches, which
  // crosses PostgREST's max_rows cap in a large tournament. `.order()` on the
  // unique (match_id, predictor_id) key gives stable page boundaries.
  let predictions;
  try {
    predictions = await readAllPages((from, to) =>
      supabase
        .from("predictions")
        .select("match_id, predictor_id, home_goals, away_goals")
        .in("match_id", kickedOffMatchIds)
        .order("match_id")
        .order("predictor_id")
        .range(from, to),
    );
  } catch (error) {
    throw new Error("match-predictions: failed to load predictions", { cause: error });
  }

  // One row per match (unique match_id) — bounded by match count, so a single
  // read is safe.
  const { data: results, error: resultsError } = await supabase
    .from("match_results")
    .select("match_id, home_score, away_score")
    .in("match_id", kickedOffMatchIds);
  if (resultsError) throw new Error("match-predictions: failed to load match_results", { cause: resultsError });

  // Paged: same fan-out as predictions (one row per scored prediction).
  let scores;
  try {
    scores = await readAllPages((from, to) =>
      supabase
        .from("prediction_scores")
        .select("match_id, predictor_id, points")
        .in("match_id", kickedOffMatchIds)
        .order("match_id")
        .order("predictor_id")
        .range(from, to),
    );
  } catch (error) {
    throw new Error("match-predictions: failed to load prediction_scores", { cause: error });
  }

  // View columns are nullable in the generated types; coerce/drop to reach the
  // non-null builder shapes (mirror of leaderboard/index.astro + history.ts).
  const rosterInputs: MatchPredictionsRosterInput[] = [];
  for (const member of roster) {
    if (member.participant_id !== null) {
      rosterInputs.push({
        participantId: member.participant_id,
        displayName: member.display_name ?? "—",
      });
    }
  }

  const scoreInputs: MatchPredictionsScoreInput[] = [];
  for (const score of scores) {
    if (score.match_id !== null && score.predictor_id !== null && score.points !== null) {
      scoreInputs.push({ match_id: score.match_id, predictor_id: score.predictor_id, points: score.points });
    }
  }

  return buildMatchPredictionRows({
    roster: rosterInputs,
    predictions,
    results,
    scores: scoreInputs,
    kickedOffMatchIds,
    viewerId,
  });
}
