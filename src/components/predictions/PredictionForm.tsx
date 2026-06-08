import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { useForm } from "react-hook-form";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { predictionUpsertSchema, type PredictionUpsertInput } from "@/lib/schemas/prediction";

interface Props {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  /** The caller's existing prediction for this match, or `null` if none yet. */
  initial: { homeGoals: number; awayGoals: number } | null;
}

/**
 * Score-entry form for a single not-yet-kicked-off match. Mirrors
 * `TournamentForm` (RHF + `zodResolver` + `actions.*` + `isInputError`); on
 * success the page reloads so the SSR surface reflects the persisted score.
 * The kickoff lock is enforced by the Action + RLS, not here — this form is
 * only rendered for matches the page computed as not-past.
 */
export function PredictionForm({ matchId, homeTeam, awayTeam, initial }: Props) {
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(predictionUpsertSchema),
    defaultValues: {
      matchId,
      homeGoals: initial?.homeGoals ?? 0,
      awayGoals: initial?.awayGoals ?? 0,
    },
  });

  const onSubmit = async (values: PredictionUpsertInput) => {
    setServerError(null);
    const { error } = await actions.predictions.upsert(values);
    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (field === "homeGoals" || field === "awayGoals") {
            form.setError(field, { message: messages[0] });
          }
        }
      } else {
        setServerError(error.message);
      }
      return;
    }
    window.location.reload();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
        <FormField
          control={form.control}
          name="homeGoals"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{homeTeam}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99}
                  className="w-20"
                  {...field}
                  value={field.value as number}
                  onChange={(event) => {
                    field.onChange(event.target.valueAsNumber);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="awayGoals"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{awayTeam}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99}
                  className="w-20"
                  {...field}
                  value={field.value as number}
                  onChange={(event) => {
                    field.onChange(event.target.valueAsNumber);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError && <p className="w-full text-sm text-red-600">{serverError}</p>}
        <Button type="submit" className="w-full sm:w-auto" disabled={form.formState.isSubmitting}>
          {initial ? "Update" : "Save"}
        </Button>
      </form>
    </Form>
  );
}
