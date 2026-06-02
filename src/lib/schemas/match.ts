import { z } from "zod";
import { KICKOFF_LOCAL_FORMAT, localToUtc, parseWallClock } from "@/lib/time";

/**
 * Shared match schemas, imported by both the Actions (server validation) and
 * the React forms (`zodResolver`) so client and server validate identically.
 *
 * `kickoffLocal` is the canonical `"YYYY-MM-DD HH:mm"` wall-clock string in the
 * tournament zone (see `@/lib/time`). The schema `.transform()`s it into a UTC
 * `Date` (`kickoffUtc`) for `timestamptz` storage. Past kickoffs are NOT
 * blocked here (decision: allowed-with-warning); past-ness is computed
 * separately for the preview warning flag.
 *
 * Because the schema changes the type (string → Date), forms must use the
 * input/output split:
 *   useForm<z.input<typeof matchInputSchema>, unknown, z.output<typeof matchInputSchema>>
 */
const matchFields = z.object({
  homeTeam: z.string().trim().min(1, "Home team is required"),
  awayTeam: z.string().trim().min(1, "Away team is required"),
  kickoffLocal: z.string().trim().min(1, "Kickoff is required"),
  timeZone: z.string().trim().min(1, "Time zone is required"),
});

function toMatch<T extends z.infer<typeof matchFields>>(val: T, ctx: z.RefinementCtx) {
  const parts = parseWallClock(val.kickoffLocal);
  if (!parts) {
    ctx.addIssue({
      code: "custom",
      message: `Kickoff must be ${KICKOFF_LOCAL_FORMAT} (24h)`,
      path: ["kickoffLocal"],
    });
    return z.NEVER;
  }
  const { kickoffLocal: _kickoffLocal, ...rest } = val;
  return { ...rest, kickoffUtc: localToUtc(parts, val.timeZone) };
}

/** Add a single match. Output carries `kickoffUtc: Date` (UTC instant). */
export const matchInputSchema = matchFields.transform(toMatch);

/**
 * Form-side schema: validates the same fields (incl. the canonical kickoff
 * format) but does NOT transform string → Date, so react-hook-form / shadcn
 * `FormField` see a single field-values type (input === output). The raw values
 * it yields are exactly the Action input shape; the Action re-validates and
 * converts via `matchInputSchema` server-side.
 */
export const matchFormSchema = matchFields.refine((val) => parseWallClock(val.kickoffLocal) !== null, {
  message: `Kickoff must be ${KICKOFF_LOCAL_FORMAT} (24h)`,
  path: ["kickoffLocal"],
});

export type MatchFormValues = z.infer<typeof matchFormSchema>;

/** Edit an existing match. Same shape plus the row `id`. */
export const matchUpdateSchema = matchFields.extend({ id: z.uuid() }).transform(toMatch);

/** Bulk add: a non-empty batch of match inputs (one atomic insert). */
export const matchBulkSchema = z.object({
  matches: z.array(matchInputSchema).min(1, "Add at least one match"),
});

export type MatchInput = z.input<typeof matchInputSchema>;
export type MatchOutput = z.output<typeof matchInputSchema>;
export type MatchUpdateInput = z.input<typeof matchUpdateSchema>;
