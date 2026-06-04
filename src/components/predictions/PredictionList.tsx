import { PredictionForm } from "@/components/predictions/PredictionForm";

export interface PredictionMatchRow {
  /** The match id (the prediction target). */
  id: string;
  homeTeam: string;
  awayTeam: string;
  /** Canonical `"YYYY-MM-DD HH:mm"` wall clock in the tournament zone. */
  kickoffLocal: string;
  /** Computed server-side: kickoff is at/before now (predictions locked). */
  isPast: boolean;
  /** The caller's own prediction, or `null` if they have not predicted. */
  prediction: { homeGoals: number; awayGoals: number } | null;
}

interface Props {
  matches: PredictionMatchRow[];
}

/** Read-only score for a locked (kicked-off) match, or an em dash if none. */
function LockedScore({ prediction }: { prediction: PredictionMatchRow["prediction"] }) {
  return (
    <div className="flex items-center gap-3">
      <span className="tabular-nums">
        {prediction ? `${String(prediction.homeGoals)} – ${String(prediction.awayGoals)}` : "—"}
      </span>
      <span className="text-muted-foreground text-xs font-medium uppercase">Locked</span>
    </div>
  );
}

/**
 * The participant's prediction surface: every match in kickoff order. A
 * not-yet-kicked-off match shows the editable `PredictionForm` (seeded with the
 * caller's own prediction if any); a kicked-off match shows the caller's saved
 * score read-only with a lock indicator. Only the caller's own predictions are
 * ever fetched here — cross-participant blindness is enforced at the DB layer.
 */
export function PredictionList({ matches }: Props) {
  if (matches.length === 0) {
    return <p className="text-muted-foreground text-sm">No matches yet. Check back once the fixtures are published.</p>;
  }

  return (
    <ul className="divide-border divide-y rounded-md border">
      {matches.map((match) => (
        <li key={match.id} className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="font-medium">
                {match.homeTeam} vs {match.awayTeam}
              </span>
              <span className="text-muted-foreground ml-3 text-sm">{match.kickoffLocal}</span>
            </div>
            {match.isPast && <LockedScore prediction={match.prediction} />}
          </div>
          {!match.isPast && (
            <PredictionForm
              matchId={match.id}
              homeTeam={match.homeTeam}
              awayTeam={match.awayTeam}
              initial={match.prediction}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
