/**
 * Auth setup project — runs ONCE before the e2e specs (see `dependencies` in
 * playwright.config.ts) and saves the signed-in session to STORAGE_STATE
 * (`playwright/.auth/user.json`). Every other project loads that file via
 * `storageState`, so specs start already authenticated and never re-drive the
 * login form — the "authenticate without the UI" rule. This is also the one
 * place the sign-in flow itself is exercised with role-based locators.
 *
 * Signs in as the SAME participant the seed's data + cleanup target
 * (`E2E_PARTICIPANT_*`), so the persisted session and the asserted/cleaned row
 * always belong to one identity. Requires that participant to exist locally and
 * the app + local Supabase to be running.
 */
import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE } from "../../playwright.config";

const PARTICIPANT_USERNAME = process.env.E2E_PARTICIPANT_USERNAME ?? "alice";
const PARTICIPANT_PASSWORD = process.env.E2E_PARTICIPANT_PASSWORD ?? "participant-only";

setup("authenticate", async ({ page }) => {
  await page.goto("/auth/signin");
  await page.getByRole("textbox", { name: "Username" }).fill(PARTICIPANT_USERNAME);
  await page.getByLabel("Password").fill(PARTICIPANT_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Wait for STATE: the post-login redirect proves the session cookie is set
  // before we persist it (never a fixed timeout).
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
