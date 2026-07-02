import { describe, expect, it } from "vitest";
import { buildMatchPredictionRows, formatPoints, type BuildMatchPredictionsInput } from "@/lib/match-predictions";

// Pure unit test for the per-match merge rules: roster (leaderboard) ordering,
// the "—"/null placeholder for non-predictors, isSelf marking, points sourced
// from `scores` (never recomputed), 0 for non-predictor-with-result, null for
// locked-no-result, and kicked-off-only inclusion. Points are fed in as
// `scores` (the prediction_scores input).

const ALICE = "alice-id";
const BOB = "bob-id";
const CAROL = "carol-id"; // in roster, never predicts

const M_RESULT = "m-result"; // kicked off, has a result
const M_LOCKED = "m-locked"; // kicked off, no result yet
const M_FUTURE = "m-future"; // NOT kicked off → must be absent from the map

// Roster is already in leaderboard order: Bob, then Alice, then Carol.
function baseInput(): BuildMatchPredictionsInput {
  return {
    roster: [
      { participantId: BOB, displayName: "Bob" },
      { participantId: ALICE, displayName: "Alice" },
      { participantId: CAROL, displayName: "Carol" },
    ],
    predictions: [
      { match_id: M_RESULT, predictor_id: ALICE, home_goals: 2, away_goals: 1 },
      { match_id: M_RESULT, predictor_id: BOB, home_goals: 0, away_goals: 0 },
      { match_id: M_LOCKED, predictor_id: ALICE, home_goals: 1, away_goals: 1 },
    ],
    results: [{ match_id: M_RESULT, home_score: 2, away_score: 1 }],
    scores: [
      { match_id: M_RESULT, predictor_id: ALICE, points: 3 },
      { match_id: M_RESULT, predictor_id: BOB, points: 0 },
    ],
    kickedOffMatchIds: [M_RESULT, M_LOCKED],
    viewerId: ALICE,
  };
}

describe("buildMatchPredictionRows", () => {
  it("(a) lists participants in roster (leaderboard) order", () => {
    const views = buildMatchPredictionRows(baseInput());
    const view = views.get(M_RESULT);
    expect(view?.participants.map((p) => p.participantId)).toEqual([BOB, ALICE, CAROL]);
  });

  it("(b) a non-predictor shows prediction null and points 0 when a result exists", () => {
    const views = buildMatchPredictionRows(baseInput());
    const carol = views.get(M_RESULT)?.participants.find((p) => p.participantId === CAROL);
    expect(carol?.prediction).toBeNull();
    expect(carol?.points).toBe(0);
  });

  it("(c) isSelf is set only for the viewer", () => {
    const views = buildMatchPredictionRows(baseInput());
    const view = views.get(M_RESULT);
    expect(view?.participants.find((p) => p.participantId === ALICE)?.isSelf).toBe(true);
    expect(view?.participants.find((p) => p.participantId === BOB)?.isSelf).toBe(false);
    expect(view?.participants.find((p) => p.participantId === CAROL)?.isSelf).toBe(false);
  });

  it("(d) with a result, predictors get their scores points and result is populated", () => {
    const views = buildMatchPredictionRows(baseInput());
    const view = views.get(M_RESULT);
    expect(view?.result).toEqual({ homeScore: 2, awayScore: 1 });
    const alice = view?.participants.find((p) => p.participantId === ALICE);
    const bob = view?.participants.find((p) => p.participantId === BOB);
    expect(alice?.points).toBe(3);
    expect(alice?.prediction).toEqual({ homeGoals: 2, awayGoals: 1 });
    expect(bob?.points).toBe(0);
    expect(bob?.prediction).toEqual({ homeGoals: 0, awayGoals: 0 });
  });

  it("(e) locked-no-result yields null points for everyone and result null", () => {
    const views = buildMatchPredictionRows(baseInput());
    const view = views.get(M_LOCKED);
    expect(view?.result).toBeNull();
    for (const participant of view?.participants ?? []) {
      expect(participant.points).toBeNull();
    }
    // Alice predicted; Bob and Carol did not.
    expect(view?.participants.find((p) => p.participantId === ALICE)?.prediction).toEqual({
      homeGoals: 1,
      awayGoals: 1,
    });
    expect(view?.participants.find((p) => p.participantId === BOB)?.prediction).toBeNull();
  });

  it("(f) only kicked-off matches appear in the map", () => {
    const views = buildMatchPredictionRows(baseInput());
    expect(views.has(M_RESULT)).toBe(true);
    expect(views.has(M_LOCKED)).toBe(true);
    expect(views.has(M_FUTURE)).toBe(false);
    expect(views.size).toBe(2);
  });

  it("returns an empty map when no match has kicked off", () => {
    const views = buildMatchPredictionRows({ ...baseInput(), kickedOffMatchIds: [] });
    expect(views.size).toBe(0);
  });
});

describe("formatPoints", () => {
  it("renders null (no score) as an em dash, not a fake zero", () => {
    expect(formatPoints(null)).toBe("—");
  });

  it("renders a real zero as 0 pts", () => {
    expect(formatPoints(0)).toBe("0 pts");
  });

  it("renders a positive score as N pts", () => {
    expect(formatPoints(5)).toBe("5 pts");
  });
});
