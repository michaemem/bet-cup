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
    .regex(/^[a-z0-9._-]+$/, "Use lowercase letters, digits, dot, underscore or hyphen"),
});

export type ParticipantCreateInput = z.infer<typeof participantCreateSchema>;
