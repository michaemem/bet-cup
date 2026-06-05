import { z } from "zod";

/**
 * Shared validation for the participant create form and Action. No password
 * field — the initial password is generated server-side and revealed once. The
 * username is lowercased here so client and server agree with the
 * case-insensitive login mapping and the `lower(username)` unique index.
 */
export const participantCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    // Alphanumeric start/end with single `.`/`_`/`-` separators only between
    // them: no leading/trailing/consecutive separators, so every accepted
    // username is also a valid email local-part for the synthetic-email mapping
    // (otherwise GoTrue could 422 on a name that isn't actually taken).
    .regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, "Use lowercase letters and digits, separated by single . _ or -"),
});

export type ParticipantCreateInput = z.infer<typeof participantCreateSchema>;

/** Validates the delete target id (the participant's `auth.users`/`profiles` id). */
export const participantDeleteSchema = z.object({
  id: z.uuid(),
});

export type ParticipantDeleteInput = z.infer<typeof participantDeleteSchema>;
