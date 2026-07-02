import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatPoints, type MatchPredictionParticipantRow } from "@/lib/match-predictions";
import { cn } from "@/lib/utils";

interface Props {
  homeTeam: string;
  awayTeam: string;
  result: { homeScore: number; awayScore: number } | null;
  participants: MatchPredictionParticipantRow[];
}

function formatScore(pair: { homeGoals: number; awayGoals: number } | null): string {
  return pair ? `${String(pair.homeGoals)}–${String(pair.awayGoals)}` : "—";
}

/**
 * Presentational dialog listing every participant's prediction for one
 * kicked-off match, in leaderboard-standings order (the `participants` prop is
 * already ordered by the loader). When a result exists the header shows it and a
 * Points column appears (predictors get their scored points, non-predictors 0).
 * All data is loaded server-side and passed in — the dialog never fetches, so
 * the cross-participant blindness boundary stays entirely DB-enforced.
 */
export function MatchPredictionsDialog({ homeTeam, awayTeam, result, participants }: Props) {
  const fixture = `${homeTeam} vs ${awayTeam}`;
  const showPoints = result !== null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          See others&apos; predictions
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fixture}</DialogTitle>
          <DialogDescription>
            {result
              ? `Result: ${String(result.homeScore)}–${String(result.awayScore)}`
              : "Match in progress — predictions revealed, no result yet."}
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-border max-h-[60vh] divide-y overflow-y-auto">
          {participants.map((participant) => (
            <li key={participant.participantId} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span className={cn("min-w-0 break-words", participant.isSelf && "font-medium")}>
                {participant.displayName}
                {participant.isSelf && <span className="text-muted-foreground ml-2 text-xs">(you)</span>}
              </span>
              <span className="flex shrink-0 items-center gap-4 tabular-nums">
                <span>{formatScore(participant.prediction)}</span>
                {showPoints && (
                  <span className="text-muted-foreground w-12 text-right">{formatPoints(participant.points)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
