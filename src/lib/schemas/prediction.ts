import { z } from "zod";

/**
 * Shared validation for the prediction form (`zodResolver`) and the
 * `predictions.upsert` Action (`input`). No `.transform()` (unlike the match
 * schema), so input === output and forms see a single field-values type — the
 * `matchFormSchema` style.
 *
 * The 0..99 goal range mirrors the `predictions` CHECK constraint added in the
 * S-03 migration, so the form, the Action, and the DB all reject the same
 * out-of-range scores. `z.coerce.number()` lets the numeric `<input>` string
 * values validate as integers.
 */
export const predictionUpsertSchema = z.object({
  matchId: z.uuid(),
  homeGoals: z.coerce.number().int().min(0, "Score must be 0 or more").max(99, "Score must be 99 or less"),
  awayGoals: z.coerce.number().int().min(0, "Score must be 0 or more").max(99, "Score must be 99 or less"),
});

export type PredictionUpsertInput = z.infer<typeof predictionUpsertSchema>;
