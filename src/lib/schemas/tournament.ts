import { z } from "zod";

/**
 * The single tournament's editable fields. Imported by both the Action
 * (server validation) and the React form (`zodResolver`) so client and server
 * validate identically. The singleton constraint (only one tournament) is
 * enforced by `tournament.upsert`, not this schema.
 */
export const tournamentSchema = z.object({
  name: z.string().trim().min(1, "Tournament name is required"),
  timeZone: z.string().trim().min(1, "Time zone is required"),
});

export type TournamentInput = z.infer<typeof tournamentSchema>;
