import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MatchForm } from "@/components/admin/MatchForm";
import { ResultForm } from "@/components/admin/ResultForm";

export interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  /** Canonical `"YYYY-MM-DD HH:mm"` wall clock in the tournament zone. */
  kickoffLocal: string;
  /** Computed server-side: kickoff is at/before now (edit is locked). */
  isPast: boolean;
  /** The match's saved result, or `null` if none entered yet. */
  result: { homeScore: number; awayScore: number } | null;
}

interface Props {
  timeZone: string;
  matches: MatchRow[];
}

/**
 * The tournament's match list. Each future match exposes an inline fixture-edit
 * form (reusing `MatchForm` via `matches.update`); already-kicked-off matches are
 * fixture-locked (FR-008) and instead expose an inline result-entry form
 * (`ResultForm` via `results.upsert`), pre-filled with any saved result for
 * correction (FR-010). Both locks shown here are advisory — the Actions and RLS
 * are the enforced source of truth.
 */
export function MatchList({ timeZone, matches }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (matches.length === 0) {
    return <p className="text-muted-foreground text-sm">No matches yet. Add one above or paste a fixture list.</p>;
  }

  return (
    <ul className="divide-border divide-y rounded-md border">
      {matches.map((match) => (
        <li key={match.id} className="p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="font-medium">
                {match.homeTeam} vs {match.awayTeam}
              </span>
              <span className="text-muted-foreground ml-3 text-sm">{match.kickoffLocal}</span>
            </div>
            {match.isPast ? (
              <span className="text-muted-foreground text-xs font-medium uppercase">
                {match.result ? "Result entered" : "Awaiting result"}
              </span>
            ) : editingId === match.id ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingId(match.id);
                }}
              >
                Edit
              </Button>
            )}
          </div>
          {match.isPast ? (
            <div className="mt-3 border-t pt-3">
              <ResultForm
                matchId={match.id}
                homeTeam={match.homeTeam}
                awayTeam={match.awayTeam}
                initial={match.result}
              />
            </div>
          ) : (
            editingId === match.id && (
              <div className="mt-3 border-t pt-3">
                <MatchForm
                  timeZone={timeZone}
                  match={{
                    id: match.id,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    kickoffLocal: match.kickoffLocal,
                  }}
                  onSaved={() => {
                    setEditingId(null);
                  }}
                />
              </div>
            )
          )}
        </li>
      ))}
    </ul>
  );
}
