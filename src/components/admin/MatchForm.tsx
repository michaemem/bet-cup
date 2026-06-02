import { zodResolver } from "@hookform/resolvers/zod";
import { actions, isInputError } from "astro:actions";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { matchFormSchema, type MatchFormValues } from "@/lib/schemas/match";
import { cn } from "@/lib/utils";

export interface EditableMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  /** Canonical `"YYYY-MM-DD HH:mm"` wall clock in the tournament zone. */
  kickoffLocal: string;
}

interface Props {
  /** The tournament's IANA zone; submitted verbatim with each row. */
  timeZone: string;
  /** Present when editing an existing match; absent for the add form. */
  match?: EditableMatch;
  /** Called after a successful save (e.g. to close an inline editor). */
  onSaved?: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-parts date → `"YYYY-MM-DD"` (no zone math: treated as tournament-zone wall clock). */
function toYmd(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Split a canonical `"YYYY-MM-DD HH:mm"` into a picker Date + `"HH:mm"` time. */
function splitKickoff(value: string): { date: Date | undefined; time: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return { date: undefined, time: "" };
  const [, y, mo, d, h, mi] = match;
  return { date: new Date(Number(y), Number(mo) - 1, Number(d)), time: `${h}:${mi}` };
}

/**
 * Composed kickoff entry: Popover + Calendar for the date and a native time
 * input. Emits the canonical `"YYYY-MM-DD HH:mm"` string (or `""` until both
 * date and time are set) through the controlled `value`/`onChange` pair.
 */
function KickoffField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const parsed = splitKickoff(value);
  const [date, setDate] = useState<Date | undefined>(parsed.date);
  const [time, setTime] = useState<string>(parsed.time);
  const [open, setOpen] = useState(false);

  const emit = (nextDate: Date | undefined, nextTime: string) => {
    if (nextDate && /^\d{2}:\d{2}$/.test(nextTime)) {
      onChange(`${toYmd(nextDate)} ${nextTime}`);
    } else {
      onChange("");
    }
  };

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn("w-44 justify-start font-normal", !date && "text-muted-foreground")}
          >
            <CalendarIcon className="mr-2 size-4" />
            {date ? format(date, "PPP") : "Pick a date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            onSelect={(next) => {
              setDate(next);
              emit(next, time);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        aria-label="Kickoff time"
        className="w-32"
        value={time}
        onChange={(event) => {
          setTime(event.target.value);
          emit(date, event.target.value);
        }}
      />
    </div>
  );
}

/**
 * Add or edit a single match in the tournament timezone. The form validates
 * with the non-transforming `matchFormSchema` (so field types line up), then
 * submits the raw values — including the canonical kickoff string — to the
 * Action, which re-validates and converts to UTC server side. On success the
 * page reloads so the list reflects the change.
 */
export function MatchForm({ timeZone, match, onSaved }: Props) {
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<MatchFormValues>({
    resolver: zodResolver(matchFormSchema),
    defaultValues: {
      homeTeam: match?.homeTeam ?? "",
      awayTeam: match?.awayTeam ?? "",
      kickoffLocal: match?.kickoffLocal ?? "",
      timeZone,
    },
  });

  const submit = async () => {
    setServerError(null);
    const values = form.getValues();
    const { error } = match
      ? await actions.matches.update({ ...values, id: match.id })
      : await actions.matches.add(values);

    if (error) {
      if (isInputError(error)) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (field === "homeTeam" || field === "awayTeam" || field === "kickoffLocal") {
            form.setError(field, { message: messages[0] });
          }
        }
      } else {
        setServerError(error.message);
      }
      return;
    }

    onSaved?.();
    window.location.reload();
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async () => {
          await submit();
        })}
        className="space-y-4"
      >
        <div className="flex flex-wrap gap-3">
          <FormField
            control={form.control}
            name="homeTeam"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Home</FormLabel>
                <FormControl>
                  <Input placeholder="Home team" className="w-40" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="awayTeam"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Away</FormLabel>
                <FormControl>
                  <Input placeholder="Away team" className="w-40" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="kickoffLocal"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Kickoff ({timeZone})</FormLabel>
                <FormControl>
                  <KickoffField value={field.value} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {serverError && <p className="text-sm text-red-600">{serverError}</p>}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {match ? "Save match" : "Add match"}
        </Button>
      </form>
    </Form>
  );
}
