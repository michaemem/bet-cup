/**
 * seed.spec.ts — the E2E SEED EXEMPLAR for this project.
 *
 * This is the single test every future E2E test is modeled on. *What the seed
 * shows is what you get*: if it uses `getByRole`, generated tests do too; if it
 * had a `waitForTimeout`, every generated test would inherit that flake. So it
 * deliberately demonstrates the five conventions, each tagged [convention] below:
 *
 *   1. `getByRole` as the DEFAULT selector — robust against CSS/DOM refactors and
 *      identical to what the agent sees in the accessibility tree.
 *   2. Wait for STATE, never for time — the `Save`→`Update` flip, `toHaveValue(...)`.
 *      No `waitForTimeout`.
 *   3. UNIQUE per-run test data — the score varies each run so a stale row from a
 *      previous run can never make a wrong assertion pass (the prediction analogue
 *      of the seed-test-pattern's `Test Deck ${Date.now()}`).
 *   4. CLEANUP — the participant deletes their OWN pre-kickoff row afterward, so
 *      re-runs start from a known state and leave no residue.
 *   5. A name BOUND TO A RISK from `context/foundation/test-plan.md` — here
 *      Risk #8 (a saved prediction must survive a real SSR reload).
 *
 * Risk protected: #8 — "A participant enters a score, and after a real page
 * reload the SAME score is still rendered (persisted to the DB and re-read by the
 * SSR surface), not lost or reset to the default."
 *
 * Auth is NOT driven in this test — the `setup` project signs in once and saves
 * the session to `playwright/.auth/user.json`, which the chromium project loads
 * via `storageState` (see playwright.config.ts + auth.setup.ts). So the test
 * starts already authenticated as `E2E_PARTICIPANT_*`.
 *
 * Prerequisites to RUN it (this file is the lever; Phase 4 wires the rest — see
 * test-plan.md §6.4/§6.5): the app running (`npm run dev`), a Playwright config
 * with `baseURL`, a seeded participant, and a future (not-yet-kicked-off) match.
 * The fixtures are env-configurable so the seed never hard-codes a local secret:
 *
 *   E2E_PARTICIPANT_USERNAME  the participant's bare username (default: alice)
 *   E2E_PARTICIPANT_PASSWORD  that participant's password
 *   E2E_HOME_TEAM             home side of the target future match
 *   E2E_AWAY_TEAM             away side of the target future match
 *   SUPABASE_URL / SUPABASE_KEY   the app's anon Supabase client (cleanup only)
 */
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import type { Database } from "../../src/db/database.types";
import { synthEmail } from "../../src/lib/username";

const PARTICIPANT_USERNAME = process.env.E2E_PARTICIPANT_USERNAME ?? "alice";
const PARTICIPANT_PASSWORD = process.env.E2E_PARTICIPANT_PASSWORD ?? "participant-only";
const HOME_TEAM = process.env.E2E_HOME_TEAM ?? "Poland";
const AWAY_TEAM = process.env.E2E_AWAY_TEAM ?? "Germany";
const MATCH_LABEL = `${HOME_TEAM} vs ${AWAY_TEAM}`;

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

/**
 * [convention #4] Cleanup helper. There is no delete-prediction button in the UI,
 * so the participant deletes their OWN pre-kickoff row through the anon Supabase
 * client (the RLS owner branch allows it). No service-role, owner-scoped, leaves
 * no residue — exactly the cleanup a generated test should copy.
 */
async function deleteOwnPrediction(): Promise<void> {
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
    email: synthEmail(PARTICIPANT_USERNAME),
    password: PARTICIPANT_PASSWORD,
  });
  if (signInError) throw new Error(`cleanup sign-in failed: ${signInError.message}`);

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id")
    .eq("home_team", HOME_TEAM)
    .eq("away_team", AWAY_TEAM)
    .limit(1)
    .maybeSingle();
  if (matchError) throw new Error(`cleanup match lookup failed: ${matchError.message}`);
  if (!match) return;

  const { error: deleteError } = await supabase
    .from("predictions")
    .delete()
    .eq("predictor_id", session.user.id)
    .eq("match_id", match.id);
  if (deleteError) throw new Error(`cleanup delete failed: ${deleteError.message}`);
}

// [convention #4] Run cleanup AFTER each test (and once defensively before) so the
// test is self-contained and any prior run's residue can't leak in.
test.beforeEach(deleteOwnPrediction);
test.afterEach(deleteOwnPrediction);

test("a participant's own prediction persists after a page reload (Risk #8)", async ({ page }) => {
  // [convention #3] Unique per-run data: a stale row from an earlier run can never
  // satisfy this run's assertion. Constrained to the form's 1–9 range, non-zero so
  // it is always distinguishable from the default 0–0.
  const homeGoals = (Date.now() % 9) + 1;
  const awayGoals = (Math.floor(Date.now() / 1000) % 9) + 1;

  // Already authenticated via storageState (the setup project) — go straight to
  // the surface and enter a score for the target future match, scoped to its row.
  await page.goto("/predictions");
  const row = page.getByRole("listitem").filter({ hasText: MATCH_LABEL });
  await row.getByRole("spinbutton", { name: HOME_TEAM }).fill(String(homeGoals)); // [convention #1]
  await row.getByRole("spinbutton", { name: AWAY_TEAM }).fill(String(awayGoals));
  // First run starts clean (button reads "Save"); tolerate "Update" if a row lingers.
  await row.getByRole("button", { name: /^(Save|Update)$/ }).click();

  // [convention #2] Wait for STATE: on success the page reloads and the button
  // flips to "Update" — the app's own signal that the row was persisted.
  await expect(row.getByRole("button", { name: "Update" })).toBeVisible();

  // The risk (#8): force a real SSR reload and assert the score was re-read from
  // the DB, not just held in the post-submit in-memory form.
  await page.reload();
  const reloadedRow = page.getByRole("listitem").filter({ hasText: MATCH_LABEL });
  await expect(reloadedRow.getByRole("spinbutton", { name: HOME_TEAM })).toHaveValue(String(homeGoals)); // [convention #2]
  await expect(reloadedRow.getByRole("spinbutton", { name: AWAY_TEAM })).toHaveValue(String(awayGoals));
});
