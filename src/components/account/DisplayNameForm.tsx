import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { changeDisplayNameSchema, type ChangeDisplayNameInput } from "@/lib/schemas/account";

interface Props {
  /** The caller's current display name, used to pre-fill the field. */
  currentDisplayName: string;
}

/**
 * Change-display-name island (FR-023). Mirrors `ParticipantForm` error handling
 * (`isInputError` → `form.setError`, else `setServerError`). The display name is
 * pre-filled; the change requires confirming the current password. On success we
 * show an inline message and reload so the new name propagates to the dashboard
 * greeting, leaderboard, and history surfaces (all read-through `display_name`).
 */
export function DisplayNameForm({ currentDisplayName }: Props) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const form = useForm<ChangeDisplayNameInput>({
    resolver: zodResolver(changeDisplayNameSchema),
    defaultValues: { displayName: currentDisplayName, currentPassword: "" },
  });

  const onSubmit = async (values: ChangeDisplayNameInput) => {
    setServerError(null);
    const { error } = await actions.account.changeDisplayName(values);
    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          form.setError(field as keyof ChangeDisplayNameInput, { message: messages[0] });
        }
      } else {
        setServerError(error.message);
      }
      return;
    }
    setSuccess(true);
    setTimeout(() => {
      window.location.reload();
    }, 1200);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display name</FormLabel>
              <FormControl>
                <Input autoComplete="name" {...field} />
              </FormControl>
              <FormDescription>Shown on the leaderboard and in other participants&apos; history.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError && <p className="text-sm text-red-600">{serverError}</p>}
        {success && <p className="text-sm text-green-600">Display name updated.</p>}
        <Button type="submit" className="w-full sm:w-auto" disabled={form.formState.isSubmitting || success}>
          Save display name
        </Button>
      </form>
    </Form>
  );
}
