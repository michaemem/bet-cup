import { describe, expect, it } from "vitest";
import { buildHistoryRows, type BuildHistoryInput } from "@/lib/history";

// Pure unit test for the listing rule, points mapping, ordering, and running
// total. No DB — points are fed in as `scores` (the prediction_scores input)
// and must never be re-derived by the builder.

const ZONE = "Europe/Warsaw";

const M_PRED_RESULT = "m-pred-result"; // predicted + resulted → points from scores
const M_PRED_NORESULT = "m-pred-noresult"; // predicted, no result → points null, included
const M_RESULT_NOPRED = "m-result-nopred"; // resulted, no prediction → points 0, included
const M_NONE = "m-none"; // neither → excluded

function baseInput(): BuildHistoryInput {
  return {
    matches: [
      // Deliberately out of kickoff order to exercise the sort.
      { id: M_PRED_RESULT, home_team: "Alpha", away_team: "Bravo", kickoff_time: "2026-06-03T16:00:00.000Z" },
      { id: M_PRED_NORESULT, home_team: "Charlie", away_team: "Delta", kickoff_time: "2026-06-02T16:00:00.000Z" },
      { id: M_RESULT_NOPRED, home_team: "Echo", away_team: "Foxtrot", kickoff_time: "2026-06-01T16:00:00.000Z" },
      { id: M_NONE, home_team: "Golf", away_team: "Hotel", kickoff_time: "2026-06-04T16:00:00.000Z" },
    ],
    predictions: [
      { match_id: M_PRED_RESULT, home_goals: 2, away_goals: 1 },
      { match_id: M_PRED_NORESULT, home_goals: 0, away_goals: 0 },
    ],
    results: [
      { match_id: M_PRED_RESULT, home_score: 2, away_score: 1 },
      { match_id: M_RESULT_NOPRED, home_score: 3, away_score: 0 },
    ],
    scores: [{ match_id: M_PRED_RESULT, points: 3 }],
    zone: ZONE,
  };
}

describe("buildHistoryRows", () => {
  it("includes a match iff a prediction exists OR a result exists", () => {
    const { rows } = buildHistoryRows(baseInput());
    const ids = rows.map((r) => r.matchId);
    expect(ids).toContain(M_PRED_RESULT);
    expect(ids).toContain(M_PRED_NORESULT);
    expect(ids).toContain(M_RESULT_NOPRED);
    expect(ids).not.toContain(M_NONE); // neither prediction nor result → excluded
    expect(rows).toHaveLength(3);
  });

  it("maps points from the scores input for a predicted+resulted match (never recomputed)", () => {
    const { rows } = buildHistoryRows(baseInput());
    const row = rows.find((r) => r.matchId === M_PRED_RESULT);
    expect(row?.points).toBe(3);
    expect(row?.prediction).toEqual({ homeGoals: 2, awayGoals: 1 });
    expect(row?.result).toEqual({ homeScore: 2, awayScore: 1 });
  });

  it("yields null points for a predicted-but-unresolved match", () => {
    const { rows } = buildHistoryRows(baseInput());
    const row = rows.find((r) => r.matchId === M_PRED_NORESULT);
    expect(row?.points).toBeNull();
    expect(row?.result).toBeNull();
    expect(row?.prediction).toEqual({ homeGoals: 0, awayGoals: 0 });
  });

  it("yields 0 points for a resulted match with no prediction", () => {
    const { rows } = buildHistoryRows(baseInput());
    const row = rows.find((r) => r.matchId === M_RESULT_NOPRED);
    expect(row?.points).toBe(0);
    expect(row?.prediction).toBeNull();
    expect(row?.result).toEqual({ homeScore: 3, awayScore: 0 });
  });

  it("orders rows by kickoff time ascending", () => {
    const { rows } = buildHistoryRows(baseInput());
    expect(rows.map((r) => r.matchId)).toEqual([M_RESULT_NOPRED, M_PRED_NORESULT, M_PRED_RESULT]);
  });

  it("sums totalPoints over non-null points only", () => {
    const { totalPoints } = buildHistoryRows(baseInput());
    // 3 (pred+result) + 0 (result, no pred); the null row is skipped.
    expect(totalPoints).toBe(3);
  });

  it("returns an empty summary when there is nothing to show", () => {
    const summary = buildHistoryRows({
      matches: [{ id: M_NONE, home_team: "Golf", away_team: "Hotel", kickoff_time: "2026-06-04T16:00:00.000Z" }],
      predictions: [],
      results: [],
      scores: [],
      zone: ZONE,
    });
    expect(summary.rows).toHaveLength(0);
    expect(summary.totalPoints).toBe(0);
  });
});
