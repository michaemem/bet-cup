// Runtime stub for the `astro:env/server` virtual module, used only by Vitest
// (aliased in vitest.config.ts). Maps the server secrets onto process.env so a
// test importing real Supabase clients points at the local stack. Empty when the
// env is unset, which makes the integration-only lanes self-skip cleanly.
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
export const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? "";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
