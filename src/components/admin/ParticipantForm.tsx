import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { participantCreateSchema, type ParticipantCreateInput } from "@/lib/schemas/participant";

interface Credentials {
  username: string;
  password: string;
}

/**
 * Admin-facing create form (FR-001). On success the generated password is shown
 * ONCE in a reveal panel — unlike the other admin forms it must NOT auto-reload,
 * because the response holds the only copy of the password. The list refresh is
 * deferred to the "Create another" action.
 */
export function ParticipantForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [copied, setCopied] = useState(false);

  const form = useForm<ParticipantCreateInput>({
    resolver: zodResolver(participantCreateSchema),
    defaultValues: { name: "", username: "" },
  });

  const onSubmit = async (values: ParticipantCreateInput) => {
    setServerError(null);
    const { data, error } = await actions.participants.create(values);
    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          form.setError(field as keyof ParticipantCreateInput, { message: messages[0] });
        }
      } else {
        setServerError(error.message);
      }
      return;
    }
    setCredentials(data);
  };

  const handleCopy = async () => {
    if (!credentials) return;
    await navigator.clipboard.writeText(`Username: ${credentials.username}\nPassword: ${credentials.password}`);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const handleReset = () => {
    setCredentials(null);
    setCopied(false);
    form.reset();
    window.location.reload();
  };

  if (credentials) {
    return (
      <div className="space-y-4 rounded-lg border border-green-600/40 bg-green-50 p-4">
        <p className="text-sm font-medium text-green-800">
          Participant created. Share these credentials now — the password is shown only once.
        </p>
        <dl className="space-y-2 font-mono text-sm">
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground w-20">Username</dt>
            <dd className="font-semibold">{credentials.username}</dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground w-20">Password</dt>
            <dd className="font-semibold">{credentials.password}</dd>
          </div>
        </dl>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={handleCopy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" onClick={handleReset}>
            Create another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Bob Roberts" {...field} />
              </FormControl>
              <FormDescription>Public display name shown across the pool.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input placeholder="bob" autoComplete="off" {...field} />
              </FormControl>
              <FormDescription>Login handle. Lowercase letters, digits, dot, underscore or hyphen.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError && <p className="text-sm text-red-600">{serverError}</p>}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Create participant
        </Button>
      </form>
    </Form>
  );
}
