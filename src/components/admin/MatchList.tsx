import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MatchForm } from "@/components/admin/MatchForm";

export interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  /** Canonical `"YYYY-MM-DD HH:mm"` wall clock in the tournament zone. */
  kickoffLocal: string;
  /** Computed server-side: kickoff is at/before now (edit is locked). */
  isPast: boolean;
}

interface Props {
  timeZone: string;
  matches: MatchRow[];
}

/**
 * The tournament's match list. Each future match exposes an inline edit form
 * (reusing `MatchForm` via `matches.update`); already-kicked-off matches show a
 * locked state and no edit control (FR-008). The lock shown here is advisory —
 * the Action and RLS are the enforced source of truth.
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
              <span className="text-muted-foreground text-xs font-medium uppercase">Locked</span>
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
          {editingId === match.id && !match.isPast && (
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
          )}
        </li>
      ))}
    </ul>
  );
}
