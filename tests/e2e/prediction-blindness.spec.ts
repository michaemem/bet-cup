/**
 * prediction-blindness.spec.ts — E2E for Risk #1
 * ("A participant's (or the admin's) prediction is visible to anyone else
 * before that match's kickoff" — context/foundation/test-plan.md §2).
 *
 * WHY E2E (and why this is NOT a duplicate of the shipped integration tests):
 * the DB-withholding core of Risk #1 is already proven at the RLS layer
 * (`src/db/predictions.rls.test.ts`) and at the loader layer
 * (`src/db/history.rls.test.ts` — `loadHistory(A, B)` never leaks a pre-kickoff
 * pick). Neither exercises the RENDERED `/history/[participantId]` page through a
 * real browser: middleware auth gate → routing → SSR → the page's own profile
 * lookup + `loadHistory` → RLS → DB → the actual visible DOM. That full-stack
 * surface — where the page comment admits the `eq()` filter is "a friendly
 * mirror, never the guard" — is the slice only E2E can protect.
 *
 * SHAPE (defeats the test-plan's named anti-patterns "assert UI state instead of
 * the row-fetch" and "test only the predictor's own view"):
 *   - VIEWER is a NON-owner: participant `E2E_PARTICIPANT_*` (alice) via the
 *     setup project's storageState. The owner is never the viewer.
 *   - OWNER is the admin, who is ALSO a participant and (FR-017) NOT exempt from
 *     blindness. Signed in only via the Supabase client to seed — never driven in
 *     the browser. (The admin-as-VIEWER facet is covered at the RLS layer.)
 *   - The same rendered page must REVEAL the owner's post-kickoff pick AND HIDE
 *     the pre-kickoff one — so the blindness assertion can't trivially pass on an
 *     empty page. The deliberate-break check (relax `predictions_select` to
 *     `using (true)`) confirms the blindness assertion actually goes red on a leak.
 *
 * Seeding uses ONLY the admin session (no service-role): the "past" match is
 * created in the near future, predicted (the INSERT lock allows pre-kickoff),
 * then its kickoff is moved into the past via the admin matches_update policy
 * (`using (is_admin() and kickoff_time > now())` checks the EXISTING future
 * value). Cleanup deletes the two stamped matches (predictions cascade).
 *
 * Prerequisites to RUN: local Supabase (`npm run db:start`) + the app (Playwright's
 * webServer boots `npm run dev`). The `E2E_PARTICIPANT_*` viewer is seeded by the
 * committed seed (scripts/seed-template.mjs → supabase/seed.sql.template); the
 * tournament is reused if present, else created here — so this spec is portable to
 * a bare CI DB (see the `e2e` job in .github/workflows/ci.yml). Env knobs:
 *     E2E_PARTICIPANT_USERNAME / _PASSWORD   the VIEWER (defaults alice) — used by setup
 *     ADMIN_EMAIL / ADMIN_PASSWORD           the OWNER whose history is viewed
 *     SUPABASE_URL / SUPABASE_KEY            the app's anon client (seed + cleanup)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import type { Database } from "../../src/db/database.types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
const OWNER_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const OWNER_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

// Unique per-run identifiers so a stale row from an earlier run can never make an
// assertion pass, and parallel runs never collide (the seed-test convention).
const STAMP = Date.now();
const FUTURE_HOME = `BlindFut-${STAMP}-Home`;
const FUTURE_AWAY = `BlindFut-${STAMP}-Away`;
const PAST_HOME = `RevealPast-${STAMP}-Home`;
const PAST_AWAY = `RevealPast-${STAMP}-Away`;
// Distinct, single-digit scores rendered by the page's fmtScore as `H–A` (EN DASH,
// U+2013). The pre-kickoff value must never surface; the post-kickoff one must.
const FUTURE_SCORE = "7\u20131"; // owner's hidden pre-kickoff pick
const PAST_SCORE = "3\u20132"; // owner's revealed post-kickoff pick

let ownerClient: SupabaseClient<Database>;
let ownerId: string;
let tournamentId: string;
// Set only when this spec had to create the tournament (a bare DB, e.g. CI). When
// set, cleanup deletes the whole tournament (cascading its matches + predictions);
// when null we reuse a pre-existing tournament and only delete our stamped matches.
let createdTournamentId: string | null = null;

function freshAnonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function insertMatch(tournamentId: string, home: string, away: string, kickoffIso: string): Promise<string> {
  const { data, error } = await ownerClient
    .from("matches")
    .insert({ tournament_id: tournamentId, home_team: home, away_team: away, kickoff_time: kickoffIso })
    .select("id")
    .single();
  if (error) throw new Error(`seed match (${home}) failed: ${error.message}`);
  return data.id;
}

async function ownerPredicts(matchId: string, home: number, away: number): Promise<void> {
  // The owner's OWN pre-kickoff prediction through the real INSERT path (the
  // predictions_insert policy allows predictor_id = auth.uid() while not kicked off).
  const { error } = await ownerClient
    .from("predictions")
    .insert({ predictor_id: ownerId, match_id: matchId, home_goals: home, away_goals: away });
  if (error) throw new Error(`owner prediction (match ${matchId}) failed: ${error.message}`);
}

async function deleteStampedMatches(): Promise<void> {
  // Matches cascade-delete their predictions (FK on delete cascade). matches_delete
  // is admin-only with no kickoff constraint, so the moved-to-past row deletes fine.
  for (const home of [FUTURE_HOME, PAST_HOME]) {
    const { error } = await ownerClient.from("matches").delete().eq("home_team", home);
    if (error) throw new Error(`cleanup delete (${home}) failed: ${error.message}`);
  }
}

test.beforeAll(async () => {
  ownerClient = freshAnonClient();
  const { data: signIn, error: signInError } = await ownerClient.auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  if (signInError) throw new Error(`owner sign-in failed: ${signInError.message}`);
  ownerId = signIn.user.id;

  // Reuse the singleton tournament when one exists (local dev). On a bare DB
  // (CI) create one so the spec is self-sufficient; cleanup drops what it created.
  const { data: tournament, error: tournamentError } = await ownerClient
    .from("tournaments")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (tournamentError) throw new Error(`tournament lookup failed: ${tournamentError.message}`);
  if (tournament) {
    tournamentId = tournament.id;
  } else {
    const { data: created, error: createError } = await ownerClient
      .from("tournaments")
      .insert({ name: "E2E Blindness Cup", time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (createError) throw new Error(`tournament create failed: ${createError.message}`);
    tournamentId = created.id;
    createdTournamentId = created.id;
  }

  await deleteStampedMatches(); // defensive: clear any residue before seeding

  const farFuture = new Date(STAMP + 7 * 24 * 60 * 60 * 1000).toISOString();
  const nearFuture = new Date(STAMP + 60 * 60 * 1000).toISOString();
  const past = new Date(STAMP - 60 * 60 * 1000).toISOString();

  // Future match: owner predicts it; stays un-kicked-off → must be HIDDEN from the viewer.
  const futureMatchId = await insertMatch(tournamentId, FUTURE_HOME, FUTURE_AWAY, farFuture);
  await ownerPredicts(futureMatchId, 7, 1);

  // Past match: created in the near future so the owner can predict it pre-kickoff,
  // then its kickoff is moved into the past → must be REVEALED to the viewer.
  const pastMatchId = await insertMatch(tournamentId, PAST_HOME, PAST_AWAY, nearFuture);
  await ownerPredicts(pastMatchId, 3, 2);
  const { error: moveError } = await ownerClient.from("matches").update({ kickoff_time: past }).eq("id", pastMatchId);
  if (moveError) throw new Error(`moving past-match kickoff failed: ${moveError.message}`);
});

test.afterAll(async () => {
  await deleteStampedMatches();
  // If we created the tournament for a bare DB, drop it (cascades any residue);
  // a reused pre-existing tournament is left untouched.
  if (createdTournamentId) {
    await ownerClient.from("tournaments").delete().eq("id", createdTournamentId);
  }
  await ownerClient.auth.signOut();
});

test("a participant cannot see another's pre-kickoff prediction in their rendered history (Risk #1)", async ({
  page,
}) => {
  // Viewer is the storageState participant (alice) — a NON-owner. Drive the real
  // user flow: open the owner's cross-participant history page.
  await page.goto(`/history/${ownerId}`);

  // REVEAL first: the SAME rendered page must surface the owner's POST-kickoff
  // prediction. This is both a wait-for-state (the page rendered the owner's row,
  // not a 404/500) and the guard against a decorative blindness assertion that
  // would pass on an empty page.
  const revealedRow = page.getByRole("row").filter({ hasText: PAST_HOME });
  await expect(revealedRow).toBeVisible();
  await expect(revealedRow).toContainText(PAST_SCORE);

  // BLINDNESS: the owner's PRE-kickoff match must be entirely absent from the
  // viewer's rendered history — neither its fixture label nor its score value.
  // Relaxing predictions_select to `using (true)` makes the row appear → red.
  await expect(page.getByText(FUTURE_HOME)).toHaveCount(0);
  await expect(page.getByText(FUTURE_AWAY)).toHaveCount(0);
  await expect(page.getByText(FUTURE_SCORE)).toHaveCount(0);
});
