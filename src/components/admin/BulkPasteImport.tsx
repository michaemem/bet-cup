import { actions, isInputError } from "astro:actions";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseMatchPaste } from "@/lib/bulk-parse";
import { matchInputSchema } from "@/lib/schemas/match";
import { cn } from "@/lib/utils";

interface Props {
  /** The tournament's IANA zone, submitted with every row. */
  timeZone: string;
}

interface EditRow {
  homeTeam: string;
  awayTeam: string;
  kickoffLocal: string;
  status: "valid" | "error";
  error?: string;
  isPast: boolean;
}

/** Re-validate a single edited row against the shared schema (TZ + format). */
function validate(row: Pick<EditRow, "homeTeam" | "awayTeam" | "kickoffLocal">, timeZone: string): EditRow {
  const result = matchInputSchema.safeParse({ ...row, timeZone });
  if (!result.success) {
    return { ...row, status: "error", error: result.error.issues[0]?.message ?? "Invalid row", isPast: false };
  }
  return { ...row, status: "valid", error: undefined, isPast: result.data.kickoffUtc.getTime() <= Date.now() };
}

/**
 * Paste → preview → confirm. The textarea parses on change into an editable
 * table; each row shows valid/error status (with the reason) and a warning on
 * past-kickoff rows. Errored rows can be fixed inline (re-validated live).
 * Confirm is enabled only when zero rows are in error, and saves the whole
 * batch atomically via `matches.bulkAdd`.
 */
export function BulkPasteImport({ timeZone }: Props) {
  const [rows, setRows] = useState<EditRow[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onPaste = (text: string) => {
    setServerError(null);
    setRows(
      parseMatchPaste(text, timeZone).map((row) => ({
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        kickoffLocal: row.kickoffLocal,
        status: row.status,
        error: row.error,
        isPast: row.isPast,
      })),
    );
  };

  const updateField = (index: number, field: "homeTeam" | "awayTeam" | "kickoffLocal", value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? validate({ ...row, [field]: value }, timeZone) : row)));
  };

  const hasErrors = rows.some((row) => row.status === "error");
  const canConfirm = rows.length > 0 && !hasErrors && !submitting;

  const confirm = async () => {
    setServerError(null);
    setSubmitting(true);
    const batch = rows.map((row) => ({
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      kickoffLocal: row.kickoffLocal,
      timeZone,
    }));
    const { error } = await actions.matches.bulkAdd({ matches: batch });
    if (error) {
      setServerError(isInputError(error) ? "Some rows are invalid — fix the highlighted fields." : error.message);
      setSubmitting(false);
      return;
    }
    window.location.reload();
  };

  return (
    <div className="space-y-4">
      <textarea
        className={cn(
          "border-input min-h-28 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm",
          "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
        )}
        placeholder={"Paste one match per line:\nHome, Away, 2026-06-01 18:00"}
        onChange={(event) => {
          onPaste(event.target.value);
        }}
      />

      {rows.length > 0 && (
        <div className="space-y-2">
          <ul className="space-y-2">
            {rows.map((row, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <Input
                  aria-label={`Home team, row ${String(index + 1)}`}
                  className="w-full sm:w-36"
                  value={row.homeTeam}
                  onChange={(event) => {
                    updateField(index, "homeTeam", event.target.value);
                  }}
                />
                <Input
                  aria-label={`Away team, row ${String(index + 1)}`}
                  className="w-full sm:w-36"
                  value={row.awayTeam}
                  onChange={(event) => {
                    updateField(index, "awayTeam", event.target.value);
                  }}
                />
                <Input
                  aria-label={`Kickoff, row ${String(index + 1)}`}
                  className="w-full sm:w-44"
                  value={row.kickoffLocal}
                  onChange={(event) => {
                    updateField(index, "kickoffLocal", event.target.value);
                  }}
                />
                {row.status === "valid" ? (
                  <span className={cn("text-xs font-medium", row.isPast ? "text-amber-600" : "text-green-600")}>
                    {row.isPast ? "Valid — already kicked off" : "Valid"}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-red-600">{row.error}</span>
                )}
              </li>
            ))}
          </ul>

          {serverError && <p className="text-sm text-red-600">{serverError}</p>}

          <div className="flex items-center gap-3">
            <Button type="button" onClick={() => void confirm()} disabled={!canConfirm}>
              {submitting ? "Saving…" : `Confirm ${String(rows.length)} match${rows.length === 1 ? "" : "es"}`}
            </Button>
            {hasErrors && (
              <span className="text-muted-foreground text-xs">Fix the errored rows to enable Confirm.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
