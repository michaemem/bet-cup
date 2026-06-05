import { z } from "zod";

/**
 * Shared validation for the result form (`zodResolver`) and the `results.upsert`
 * Action (`input`). Mirrors `predictionUpsertSchema`: no `.transform()`, so
 * input === output and the form sees a single field-values type.
 *
 * The 0..99 range mirrors the `match_results` CHECK constraint from the S-04
 * migration, so the form, the Action, and the DB all reject the same
 * out-of-range scores. `z.coerce.number()` lets the numeric `<input>` string
 * values validate as integers.
 */
export const resultUpsertSchema = z.object({
  matchId: z.uuid(),
  homeScore: z.coerce.number().int().min(0, "Score must be 0 or more").max(99, "Score must be 99 or less"),
  awayScore: z.coerce.number().int().min(0, "Score must be 0 or more").max(99, "Score must be 99 or less"),
});

export type ResultUpsertInput = z.infer<typeof resultUpsertSchema>;
