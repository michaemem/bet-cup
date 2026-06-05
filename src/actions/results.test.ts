/**
 * Guard test for S-04 `results.upsert` (FR-009/FR-010).
 *
 * Exercises the REAL Action handler: `astro:actions` and `astro:env/server` are
 * virtual modules unresolvable outside the Astro build, so vitest.config.ts
 * aliases them to runtime stubs (`defineAction` reduced to identity so `.handler`
 * is reachable). This pins the admin guard, which fires before any DB call — so
 * it runs ALWAYS (incl. the default `npm test` / CI gate), no Supabase needed.
 * The post-kickoff write guard and the full upsert path are covered by the live
 * RLS suite (`src/db/results-scoring.rls.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { resultUpsertSchema } from "@/lib/schemas/result";

// `astro:actions` (ActionError + identity `defineAction`) and `astro:env/server`
// are aliased to runtime stubs in vitest.config.ts, so importing the real
// `server` object below resolves cleanly and the config's `.handler` is reachable.
const { server } = await import("@/actions/index");

// The public `ActionClient` type doesn't expose `.handler`, but the mocked
// `defineAction` (identity) means the config object — including `handler` — is
// exactly what's stored. Reach it through a narrow local contract.
type UpsertHandler = (
  input: { matchId: string; homeScore: number; awayScore: number },
  context: {
    locals: { profile: { roles: string[] } | null };
    request: Request;
    cookies: unknown;
  },
) => Promise<{ id: string }>;

const upsertHandler = (server.results.upsert as unknown as { handler: UpsertHandler }).handler;

const MATCH_ID = "00000000-0000-4000-8000-000000000000";

/** Invoke the real handler with schema-validated input (mimics Astro's pipeline). */
async function upsert(roles: ("admin" | "participant")[]) {
  const input = resultUpsertSchema.parse({ matchId: MATCH_ID, homeScore: 2, awayScore: 1 });
  return upsertHandler(input, {
    locals: { profile: { roles } },
    request: new Request("http://localhost/_actions/results.upsert"),
    cookies: {},
  });
}

describe("results.upsert admin guard (always runs)", () => {
  it("refuses a non-admin caller with UNAUTHORIZED (before any DB call)", async () => {
    await expect(upsert(["participant"])).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a caller with no profile with UNAUTHORIZED (before any DB call)", async () => {
    const input = resultUpsertSchema.parse({ matchId: MATCH_ID, homeScore: 0, awayScore: 0 });
    await expect(
      upsertHandler(input, {
        locals: { profile: null },
        request: new Request("http://localhost/_actions/results.upsert"),
        cookies: {},
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
