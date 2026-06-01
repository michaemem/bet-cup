import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { SUPABASE_URL, SUPABASE_KEY } from "astro:env/server";
import type { Database } from "@/db/database.types";
import type { Profile } from "@/types";

export function createClient(requestHeaders: Headers, cookies: AstroCookies) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return null;
  }
  return createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll() {
        return parseCookieHeader(requestHeaders.get("Cookie") ?? "").map(({ name, value }) => ({
          name,
          value: value ?? "",
        }));
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookies.set(name, value, options);
        });
      },
    },
  });
}

/**
 * Load the authenticated user's profile + roles into the framework-facing
 * `Profile` DTO. The Phase 1 trigger guarantees a row exists for every authed
 * user, so a `null` return signals a race / inconsistency worth logging.
 */
export async function loadProfile(supabase: SupabaseClient<Database>, userId: string): Promise<Profile | null> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", userId)
    .maybeSingle();

  if (error || !profile) {
    // The Phase 1 trigger guarantees a row for every authed user, so this
    // indicates a query failure or a race/inconsistency worth surfacing.
    console.error("[loadProfile] profile lookup failed", { userId, error });
    return null;
  }

  const { data: roleRows, error: rolesError } = await supabase.from("user_roles").select("role").eq("user_id", userId);

  if (rolesError) {
    console.error("[loadProfile] roles lookup failed", { userId, error: rolesError });
  }

  return {
    id: profile.id,
    displayName: profile.display_name,
    roles: (roleRows ?? []).map((row) => row.role),
  };
}
