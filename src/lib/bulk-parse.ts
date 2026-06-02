import Papa from "papaparse";
import { matchInputSchema } from "@/lib/schemas/match";

/**
 * One parsed row for the bulk-paste preview table. Carries the raw line, the
 * parsed fields, a validity status with an optional message, and an `isPast`
 * flag (past kickoffs are allowed but visibly warned).
 */
export interface ParsedRow {
  /** The original pasted line, verbatim. */
  raw: string;
  homeTeam: string;
  awayTeam: string;
  /** Normalized to the canonical `"YYYY-MM-DD HH:mm"` when possible. */
  kickoffLocal: string;
  status: "valid" | "error";
  /** Present only when `status === "error"`. */
  error?: string;
  /** True when a valid row's kickoff is at/before now. */
  isPast: boolean;
}

const KICKOFF_RAW_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::\d{2})?$/;

/**
 * Normalize a pasted kickoff field to the canonical `"YYYY-MM-DD HH:mm"`.
 * Tolerates a `T` separator, single-digit month/day/hour, and a trailing
 * `:ss` (dropped). Returns `null` when it can't be coerced to the format.
 */
function normalizeKickoff(raw: string): string | null {
  const match = KICKOFF_RAW_RE.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ${h.padStart(2, "0")}:${mi}`;
}

function buildRow(line: string, timeZone: string): ParsedRow {
  // Parse each line independently so the raw text is preserved and the
  // delimiter (`,` / tab / `;` / `|`) is auto-detected per line.
  const parsed = Papa.parse<string[]>(line, { header: false });
  const cols = (parsed.data[0] ?? []).map((c) => c.trim());

  if (cols.length < 3) {
    return {
      raw: line,
      homeTeam: cols[0] ?? "",
      awayTeam: cols[1] ?? "",
      kickoffLocal: cols[2] ?? "",
      status: "error",
      error: "Expected: home, away, kickoff",
      isPast: false,
    };
  }

  const [homeTeam, awayTeam, kickoffRaw] = cols;
  const kickoffLocal = normalizeKickoff(kickoffRaw) ?? kickoffRaw;
  const result = matchInputSchema.safeParse({ homeTeam, awayTeam, kickoffLocal, timeZone });

  if (!result.success) {
    return {
      raw: line,
      homeTeam,
      awayTeam,
      kickoffLocal,
      status: "error",
      error: result.error.issues[0]?.message ?? "Invalid row",
      isPast: false,
    };
  }

  return {
    raw: line,
    homeTeam: result.data.homeTeam,
    awayTeam: result.data.awayTeam,
    kickoffLocal,
    status: "valid",
    isPast: result.data.kickoffUtc.getTime() <= Date.now(),
  };
}

/**
 * Parse pasted fixture text into preview rows. Blank lines are skipped; each
 * non-blank line becomes a `ParsedRow`. Papa Parse handles delimited-text
 * structure (quotes, delimiter detection); domain validation (and the TZ
 * conversion that yields `isPast`) is the Zod schema's job.
 */
export function parseMatchPaste(text: string, timeZone: string): ParsedRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => buildRow(line, timeZone));
}
