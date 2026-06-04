import type { SupabaseClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { ActionError, defineAction } from "astro:actions";
import type { Database } from "@/db/database.types";
import { generatePassword } from "@/lib/password";
import { matchBulkSchema, matchInputSchema, matchUpdateSchema } from "@/lib/schemas/match";
import { participantCreateSchema } from "@/lib/schemas/participant";
import { tournamentSchema } from "@/lib/schemas/tournament";
import { createClient } from "@/lib/supabase";
import { createAdminAuthClient } from "@/lib/supabase-admin";
import { synthEmail } from "@/lib/username";

/**
 * Astro Actions for S-02. Actions are PUBLIC endpoints (`/_actions/<name>`), so
 * every handler re-checks admin in-handler (clean UNAUTHORIZED) AND the DB
 * enforces admin via RLS (bypass-proof backstop) — defense-in-depth, mirroring
 * F-01. The edit-before-kickoff cutoff is likewise enforced twice: an app-layer
 * pre-check for a friendly message, and the RLS `UPDATE USING (kickoff_time >
 * now())` policy as the race-proof source of truth (a past-kickoff row updates
 * zero rows silently — see `matches.update`).
 */

const NOT_CONFIGURED = "Supabase is not configured";
const KICKED_OFF = "This match has already kicked off and can no longer be edited.";
const GENERIC_DB_ERROR = "Something went wrong. Please try again.";

/**
 * Log the full DB error server-side and surface only a stable, generic message,
 * so raw Postgres/PostgREST messages (table/column/constraint names) never reach
 * the client.
 */
function internalError(error: unknown): ActionError {
  console.error("action db error", error);
  return new ActionError({ code: "INTERNAL_SERVER_ERROR", message: GENERIC_DB_ERROR });
}

/**
 * Build a field-scoped input error from inside a handler. Astro only constructs
 * an `ActionInputError` during the input-schema validation step and does not
 * export the class, so to flag a specific field after the schema has passed we
 * stamp an `ActionError` with the documented `AstroActionInputError` serialized
 * shape (`type` + `issues` + `fields`). The client's `isInputError()` reads this
 * shape and rebuilds `error.fields`, so callers map it exactly like a Zod field
 * error (see `ParticipantForm`).
 */
function inputError(field: string, message: string): ActionError {
  return Object.assign(new ActionError({ code: "BAD_REQUEST", message }), {
    type: "AstroActionInputError",
    issues: [{ code: "custom", path: [field], message }],
    fields: { [field]: [message] },
  });
}

/** Throw UNAUTHORIZED unless the caller holds the admin role. */
function requireAdmin(locals: App.Locals): void {
  if (!locals.profile?.roles.includes("admin")) {
    throw new ActionError({ code: "UNAUTHORIZED", message: "Admin access required" });
  }
}

interface AdminContext {
  locals: App.Locals;
  request: Request;
  cookies: AstroCookies;
}

/** Build a request-scoped Supabase client, refusing non-admin callers. */
function adminClient(context: AdminContext): SupabaseClient<Database> {
  requireAdmin(context.locals);
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    throw new ActionError({ code: "INTERNAL_SERVER_ERROR", message: NOT_CONFIGURED });
  }
  return supabase;
}

/** Resolve the single tournament (id + zone), or refuse if none exists yet. */
async function requireTournament(supabase: SupabaseClient<Database>): Promise<{ id: string; time_zone: string }> {
  const { data, error } = await supabase.from("tournaments").select("id, time_zone").limit(1).maybeSingle();
  if (error) throw internalError(error);
  if (!data) throw new ActionError({ code: "BAD_REQUEST", message: "Create the tournament before adding matches." });
  return data;
}

/**
 * The kickoff was converted to UTC client-side using `inputZone`; reject unless
 * it matches the tournament's stored zone. The DB zone is the source of truth,
 * so a crafted or stale client zone can't store an instant inconsistent with
 * what the admin UI renders against.
 */
function assertTournamentZone(inputZone: string, tournamentZone: string): void {
  if (inputZone !== tournamentZone) {
    throw new ActionError({
      code: "BAD_REQUEST",
      message: "Match timezone must match the tournament timezone.",
    });
  }
}

export const server = {
  participants: {
    /**
     * Admin-only participant creation (FR-001). Creates the auth user via the
     * isolated service-role client (the ONLY use of that client); the F-01
     * `handle_new_user` trigger then seeds the profile (with `username` from
     * metadata) + `participant` role — nothing is written via the anon client,
     * so `adminClient` is deliberately NOT used here. The generated password is
     * returned once for the admin to share out-of-band; it is never stored.
     */
    create: defineAction({
      accept: "json",
      input: participantCreateSchema,
      handler: async (input, context) => {
        requireAdmin(context.locals);

        const admin = createAdminAuthClient();
        if (!admin) {
          throw new ActionError({ code: "INTERNAL_SERVER_ERROR", message: NOT_CONFIGURED });
        }

        const password = generatePassword();
        const { error } = await admin.auth.admin.createUser({
          email: synthEmail(input.username),
          password,
          email_confirm: true,
          user_metadata: { display_name: input.name, username: input.username },
        });

        if (error) {
          // GoTrue returns code "email_exists" (HTTP 422) for an already-
          // registered email. Confirmed against the local stack in Phase 2 and
          // pinned by the Phase 4 duplicate test. Map it to a friendly field
          // error on `username`; never surface the raw message (it would reveal
          // the synthetic-email scheme). Anything else is a generic 500.
          if (error.code === "email_exists" || error.status === 422) {
            throw inputError("username", "That username is taken.");
          }
          throw internalError(error);
        }

        return { username: input.username, password };
      },
    }),
  },
  tournament: {
    /** Singleton create-or-edit: update the existing tournament, else insert. */
    upsert: defineAction({
      accept: "json",
      input: tournamentSchema,
      handler: async (input, context) => {
        const supabase = adminClient(context);
        const { data: existing, error: readErr } = await supabase
          .from("tournaments")
          .select("id")
          .limit(1)
          .maybeSingle();
        if (readErr) throw internalError(readErr);

        const values = { name: input.name, time_zone: input.timeZone };
        const query = existing
          ? supabase.from("tournaments").update(values).eq("id", existing.id)
          : supabase.from("tournaments").insert(values);

        const { data, error } = await query.select("id, name, time_zone").single();
        if (error) throw internalError(error);
        return data;
      },
    }),
  },
  matches: {
    /** Add a single match (one-by-one form). */
    add: defineAction({
      accept: "json",
      input: matchInputSchema,
      handler: async (input, context) => {
        const supabase = adminClient(context);
        const tournament = await requireTournament(supabase);
        assertTournamentZone(input.timeZone, tournament.time_zone);
        const { data, error } = await supabase
          .from("matches")
          .insert({
            tournament_id: tournament.id,
            home_team: input.homeTeam,
            away_team: input.awayTeam,
            kickoff_time: input.kickoffUtc.toISOString(),
          })
          .select("id")
          .single();
        if (error) throw internalError(error);
        return data;
      },
    }),
    /** Insert the validated batch in one atomic call (bulk-paste confirm). */
    bulkAdd: defineAction({
      accept: "json",
      input: matchBulkSchema,
      handler: async (input, context) => {
        const supabase = adminClient(context);
        const tournament = await requireTournament(supabase);
        input.matches.forEach((match) => {
          assertTournamentZone(match.timeZone, tournament.time_zone);
        });
        const rows = input.matches.map((match) => ({
          tournament_id: tournament.id,
          home_team: match.homeTeam,
          away_team: match.awayTeam,
          kickoff_time: match.kickoffUtc.toISOString(),
        }));
        const { data, error } = await supabase.from("matches").insert(rows).select("id");
        if (error) throw internalError(error);
        return { count: data.length };
      },
    }),
    /** Edit teams/kickoff, refused once the match has kicked off (FR-008). */
    update: defineAction({
      accept: "json",
      input: matchUpdateSchema,
      handler: async (input, context) => {
        const supabase = adminClient(context);
        const tournament = await requireTournament(supabase);
        assertTournamentZone(input.timeZone, tournament.time_zone);

        // App-layer pre-check: a friendlier/earlier message than the silent
        // RLS zero-row result below (which remains the race-proof guard).
        const { data: current } = await supabase
          .from("matches")
          .select("kickoff_time")
          .eq("id", input.id)
          .maybeSingle();
        // Distinguish "no such match" from the kickoff lock so a stale/bad id
        // doesn't masquerade as "already kicked off".
        if (!current) {
          throw new ActionError({ code: "NOT_FOUND", message: "Match not found." });
        }
        if (new Date(current.kickoff_time).getTime() <= Date.now()) {
          throw new ActionError({ code: "FORBIDDEN", message: KICKED_OFF });
        }

        const { data, error } = await supabase
          .from("matches")
          .update({
            home_team: input.homeTeam,
            away_team: input.awayTeam,
            kickoff_time: input.kickoffUtc.toISOString(),
          })
          .eq("id", input.id)
          .select("id");
        if (error) throw internalError(error);

        // RLS `UPDATE USING (kickoff_time > now())` filters a past-kickoff row
        // out silently: zero rows, no error. Treat that as the lock firing.
        if (data.length === 0) throw new ActionError({ code: "FORBIDDEN", message: KICKED_OFF });
        return data[0];
      },
    }),
  },
};
