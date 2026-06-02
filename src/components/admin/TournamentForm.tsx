import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { tournamentSchema, type TournamentInput } from "@/lib/schemas/tournament";

interface Props {
  /** The existing tournament when editing; `null` switches to create mode. */
  initial: TournamentInput | null;
}

/**
 * Single create-or-edit form for the one tournament. Defaults the timezone to
 * the admin's browser zone; submits via the `tournament.upsert` Action (which
 * enforces the singleton). On success the page reloads so the server-rendered
 * admin surface reflects the new state.
 */
export function TournamentForm({ initial }: Props) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<TournamentInput>({
    resolver: zodResolver(tournamentSchema),
    defaultValues: {
      name: initial?.name ?? "",
      timeZone: initial?.timeZone ?? browserZone,
    },
  });

  const onSubmit = async (values: TournamentInput) => {
    setServerError(null);
    const { error } = await actions.tournament.upsert(values);
    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          form.setError(field as keyof TournamentInput, { message: messages[0] });
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
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tournament name</FormLabel>
              <FormControl>
                <Input placeholder="World Cup 2026" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="timeZone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Time zone</FormLabel>
              <FormControl>
                <Input placeholder="Europe/Warsaw" {...field} />
              </FormControl>
              <FormDescription>IANA name. Kickoff times are entered and shown in this zone.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError && <p className="text-sm text-red-600">{serverError}</p>}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {initial ? "Save changes" : "Create tournament"}
        </Button>
      </form>
    </Form>
  );
}
