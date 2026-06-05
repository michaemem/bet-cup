import { describe, expect, it } from "vitest";
import { resultUpsertSchema } from "@/lib/schemas/result";

// FR-009 input contract for the result form + `results.upsert` Action, pinned
// independently of the DB CHECK and the Action handler. Expected behavior is
// derived from the schema (`src/lib/schemas/result.ts`): matchId is a uuid and
// both scores are coerced integers in 0..99.
const MATCH_ID = "11111111-1111-4111-8111-111111111111";

describe("resultUpsertSchema", () => {
  it("accepts a valid matchId + scores", () => {
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 2, awayScore: 1 }).success).toBe(true);
  });

  it("accepts the 0 and 99 boundaries", () => {
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 0, awayScore: 0 }).success).toBe(true);
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 99, awayScore: 99 }).success).toBe(true);
  });

  it("coerces numeric strings to integers (the <input> value path)", () => {
    const result = resultUpsertSchema.parse({ matchId: MATCH_ID, homeScore: "3", awayScore: "0" });
    expect(result).toEqual({ matchId: MATCH_ID, homeScore: 3, awayScore: 0 });
  });

  it("rejects negative scores", () => {
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: -1, awayScore: 0 }).success).toBe(false);
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 0, awayScore: -5 }).success).toBe(false);
  });

  it("rejects non-integer scores", () => {
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 1.5, awayScore: 0 }).success).toBe(false);
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 0, awayScore: 2.7 }).success).toBe(false);
  });

  it("rejects scores greater than 99", () => {
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 100, awayScore: 0 }).success).toBe(false);
    expect(resultUpsertSchema.safeParse({ matchId: MATCH_ID, homeScore: 0, awayScore: 100 }).success).toBe(false);
  });

  it("rejects a missing or invalid matchId", () => {
    expect(resultUpsertSchema.safeParse({ homeScore: 1, awayScore: 0 }).success).toBe(false);
    expect(resultUpsertSchema.safeParse({ matchId: "not-a-uuid", homeScore: 1, awayScore: 0 }).success).toBe(false);
  });
});
