/**
 * Live-DB RLS / edit-lock integration test for S-02 (matches).
 *
 * RLS is enforced by Postgres, NOT the Supabase client — a mocked client can
 * never exercise it. This test therefore hits a REAL local Supabase stack
 * (`npx supabase start`) with per-role sessions and pins the FR-008 boundary:
 *
 *   (a) a participant-role session cannot insert/update matches (RLS denial),
 *   (b) the admin cannot UPDATE a match whose kickoff is in the past — the
 *       `matches_update USING (kickoff_time > now())` policy filters the row
 *       out, so the write affects zero rows (the race-proof lock).
 *
 * It self-skips unless the DB URL AND both keys are set, so it does NOT run in
 * the default `npm test` / CI gate (CI has no Supabase stack). Run it locally:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- matches.rls
 *
 * Keys come from `npx supabase status` — the newer CLI labels them
 * "Publishable" (= anon) and "Secret" (= service_role). The admin credentials
 * default to the local seed (`admin@betcup.local` / `local-only`); local email
 * login must be enabled (`[auth.email] enable_signup = true` in config.toml).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Require the DB URL AND both keys: running with a DB URL but placeholder/empty
// keys would otherwise fail confusingly at sign-in instead of skipping.
const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

const PARTICIPANT_EMAIL = `rls-participant-${Date.now().toString()}@betcup.local`;
const PARTICIPANT_PASSWORD = "participant-only";

function freshClient(key: string): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const client = freshClient(ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

describe.skipIf(!dbConfigured)("matches RLS + edit-lock (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let participant: SupabaseClient<Database>;
  let tournamentId: string;
  let participantUserId: string | undefined;

  beforeAll(async () => {
    service = freshClient(SERVICE_ROLE_KEY);

    // A confirmed participant user. handle_new_user seeds the participant role
    // (and only that, since the email is not app.admin_email).
    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email: PARTICIPANT_EMAIL,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
    });
    if (createErr) throw new Error(`participant create failed: ${createErr.message}`);
    participantUserId = created.user.id;

    admin = await signedInClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    participant = await signedInClient(PARTICIPANT_EMAIL, PARTICIPANT_PASSWORD);

    // Admin seeds the tournament every match references.
    const res = await admin
      .from("tournaments")
      .insert({ name: "RLS Test Cup", time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (res.error) throw new Error(`tournament insert failed: ${res.error.message}`);
    tournamentId = res.data.id;
  });

  afterAll(async () => {
    // Cascade-deletes the matches via the tournament FK.
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    if (participantUserId) await service.auth.admin.deleteUser(participantUserId);
  });

  /** Admin-seeds one match and returns its id (used to set up the lock cases). */
  async function seedMatch(kickoffIso: string, home = "H", away = "A"): Promise<string> {
    const res = await admin
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: home, away_team: away, kickoff_time: kickoffIso })
      .select("id")
      .single();
    if (res.error) throw new Error(`seed match failed: ${res.error.message}`);
    return res.data.id;
  }

  it("lets the admin insert a future match", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: "A", away_team: "B", kickoff_time: future })
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies a participant inserting a match (RLS)", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await participant
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: "X", away_team: "Y", kickoff_time: future })
      .select("id");

    // INSERT with a violated WITH CHECK raises an RLS error (code 42501).
    expect(error).not.toBeNull();
  });

  it("denies a participant updating a match (RLS — zero rows)", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const matchId = await seedMatch(future, "C", "D");

    // UPDATE filtered out by RLS USING returns zero rows (no error).
    const { data, error } = await participant
      .from("matches")
      .update({ home_team: "HACKED" })
      .eq("id", matchId)
      .select("id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("denies the admin updating a past-kickoff match (FR-008 lock — zero rows)", async () => {
    // INSERT has no time check, so the admin can seed a past-kickoff row...
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const matchId = await seedMatch(past, "Past", "Lock");

    // ...but the UPDATE policy's `kickoff_time > now()` filters it out: zero rows.
    const { data, error } = await admin.from("matches").update({ home_team: "TooLate" }).eq("id", matchId).select("id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("lets the admin update a future match (sanity — the lock is not blanket)", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const matchId = await seedMatch(future, "Edit", "Me");

    const { data, error } = await admin
      .from("matches")
      .update({ home_team: "Edited" })
      .eq("id", matchId)
      .select("id, home_team");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.home_team).toBe("Edited");
  });
});
