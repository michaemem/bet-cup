import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server";
import type { Database } from "@/db/database.types";

/**
 * SERVICE-ROLE ISOLATION — the single load-bearing security constraint of S-01.
 *
 * This is the ONLY module that reads SUPABASE_SERVICE_ROLE_KEY. The service-role
 * key BYPASSES RLS entirely, so this client must NEVER be used to READ per-user
 * data (predictions, profiles, roles, ...) — doing so is the single most likely
 * path to an FR-015 "blindness" leak (a participant seeing another's
 * predictions). Its ONLY sanctioned uses are auth-lifecycle WRITE operations
 * that no RLS path can perform:
 *   - `createUser` (`participants.create`)
 *   - `deleteUser` (`participants.delete`)
 *   - `updateUserById` to set a temp password + the `revoke_user_sessions` RPC
 *     to clear the target's sessions (`participants.resetPassword`, FR-024)
 * Every per-user READ (including the delete/reset target role check) stays on
 * the RLS-respecting SSR client, so this client remains strictly write-only.
 *
 * Built from `@supabase/supabase-js` (NOT `@supabase/ssr`) with no cookie wiring
 * and `persistSession: false`, so it can never pick up or mutate the request's
 * session — it is stateless and request-independent.
 */
export function createAdminAuthClient(): SupabaseClient<Database> | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
