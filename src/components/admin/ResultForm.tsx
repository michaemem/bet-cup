import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { useForm } from "react-hook-form";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { resultUpsertSchema, type ResultUpsertInput } from "@/lib/schemas/result";

interface Props {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  /** The match's saved result, or `null` if none entered yet (pre-fills for correction). */
  initial: { homeScore: number; awayScore: number } | null;
}

/**
 * Result-entry form for a single already-kicked-off match. Mirrors
 * `PredictionForm` (RHF + `zodResolver` + `actions.*` + `isInputError`); on
 * success the page reloads so the SSR surface reflects the persisted result.
 * The post-kickoff write guard is enforced by the Action + RLS, not here — this
 * form is only rendered for matches the page computed as past.
 */
export function ResultForm({ matchId, homeTeam, awayTeam, initial }: Props) {
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(resultUpsertSchema),
    defaultValues: {
      matchId,
      homeScore: initial?.homeScore ?? 0,
      awayScore: initial?.awayScore ?? 0,
    },
  });

  const onSubmit = async (values: ResultUpsertInput) => {
    setServerError(null);
    const { error } = await actions.results.upsert(values);
    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (field === "homeScore" || field === "awayScore") {
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
          name="homeScore"
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
          name="awayScore"
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
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {initial ? "Update result" : "Save result"}
        </Button>
      </form>
    </Form>
  );
}
