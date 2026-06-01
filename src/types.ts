/**
 * Framework-facing entity and DTO types. Hand-written, distinct from the
 * generated Supabase row types in `@/db/database.types`. UI components and
 * `Astro.locals` consume these shapes; the mapping from generated DB rows
 * happens in `@/lib/supabase`.
 */

/** A role a user can hold. An admin also holds `participant` (FR-017). */
export type UserRole = "admin" | "participant";

/** The authenticated user's public identity, carried through `Astro.locals`. */
export interface Profile {
  id: string;
  displayName: string;
  roles: UserRole[];
}
