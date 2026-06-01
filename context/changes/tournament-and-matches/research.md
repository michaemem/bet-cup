# S-02 `tournament-and-matches` — solution & library survey

> Scope: implement S-02 from `context/foundation/roadmap.md` (admin creates the
> single tournament, populates its match list one-by-one or via bulk paste with
> parsed-preview-then-confirm, and edits matches before kickoff).
> Constraint: compatible with `context/foundation/tech-stack.md` — Astro 6 SSR +
> React 19 + Tailwind 4 + shadcn/ui + Supabase/Postgres + Cloudflare Workers,
> with `zod@4` already installed.
> Researched 2026-06-01 via web search.

## Stack baseline (already installed, per `package.json`)

`zod@^4.4.3`, React 19, Tailwind 4, `lucide-react`, shadcn pipeline (`button`,
`@radix-ui/react-slot`, `cn()`), `@supabase/ssr` + `@supabase/supabase-js`,
Astro `^6.3.1`, `vitest`. Astro 6 also bundles Zod 4 via `astro/zod`.

## The four building blocks

| Need (from roadmap) | Recommended solution | Add or present? |
|---|---|---|
| Server mutation + input validation (create tournament, add/edit matches) | **Astro Actions** (`astro:actions` + `defineAction`) | Built into Astro 6 |
| One-by-one match form (home/away/kickoff) | **react-hook-form + @hookform/resolvers** wired to shadcn `Form` | Add 2 deps |
| Kickoff date/time picker | **shadcn Date Picker** (Popover + Calendar + `<input type="time">`) | `npx shadcn add` |
| Timezone-correct kickoff storage/display on Workers | **`@date-fns/tz`** + Postgres `timestamptz` | Add 1 dep (date-fns comes via Calendar) |
| Bulk-paste parse → preview → confirm | **Hand-rolled line parser + zod** (or **Papa Parse** for quoted-field robustness) | 0 deps (or add `papaparse`) |

## 1. Server layer: Astro Actions over API routes

For the create/edit mutations, **Astro Actions** fit better than `src/pages/api/**`
handlers. Stable in Astro 6; they parse `FormData`, validate against a Zod schema
before the handler runs, and generate a type-safe client callable from React
islands — removing most manual `request.formData()` / casting / branching
boilerplate. They use the **Zod 4 build bundled in Astro 6** (`import { z } from 'astro/zod'`),
so `z.email()`-style top-level validators work without a separate install.

Weigh against `AGENTS.md`:

- The hard rule "API routes must export `const prerender = false`" applies to
  `src/pages/api/**`. Actions live in `src/actions/index.ts` and sidestep that
  route. But they are **public endpoints** (`/_actions/<name>`), so the admin-role
  authorization check must run inside the handler
  (`throw new ActionError({ code: 'UNAUTHORIZED' })`). Maps cleanly to the
  existing `context.locals.user` middleware.
- `z.coerce.date()` on the datetime input and per-field error rendering are
  first-class (`isInputError()` exposes a per-field `fields` object).

If staying on plain API routes (for consistency with `src/pages/api/auth/*`) is
preferred, that is viable but heavier.

Refs: [Astro Actions docs](https://docs.astro.build/en/guides/actions/) ·
[Nerd Level Tech, 2026](https://nerdleveltech.com/astro-actions-type-safe-server-functions-without-the-boilerplate-dd)

## 2. Client form: react-hook-form + shadcn Form

2026 standard for shadcn forms: **react-hook-form + `@hookform/resolvers` (zodResolver)**
with shadcn `Form`/`FormField`/`FormMessage` wrappers that render errors
automatically.

```bash
npm install react-hook-form @hookform/resolvers
```

Compatibility: shadcn's example notes "uses zod v3, but you can replace it with
any Standard Schema library." **Zod 4 is a Standard Schema implementation** and
`@hookform/resolvers`'s `zodResolver` supports it, so the existing `zod@^4.4.3`
works without downgrading. Use `Controller`/`FormField` (not `register`) for the
date picker since it is a controlled component.

Refs: [shadcn React Hook Form](https://ui.shadcn.com/docs/forms/react-hook-form) ·
[llmbestpractices, 2026](https://llmbestpractices.com/frontend/shadcn-forms)

## 3. Kickoff date/time picker

Use the **official shadcn Date Picker** pattern — no `DatePicker` root; composed
from `Popover` + `Calendar` + `<input type="time" step="1">`. Pulls in
`react-day-picker` and `date-fns` (reused for timezone work).

```bash
npx shadcn@latest add popover calendar
```

Single packaged alternatives (copy-in, no runtime lock-in):
[shadcnui-expansions datetime-picker](https://shadcnui-expansions.typeart.cc/docs/datetime-picker)
(no extra lib, supports `react-day-picker 9`, 24h granularity) and
[time.rdsx.dev](https://time.rdsx.dev/) (ships react-hook-form + zod examples).
For the MVP, the official composed pattern is lowest-risk.

Ref: [shadcn Date Picker docs](https://ui.shadcn.com/docs/components/base/date-picker)

## 4. Timezone handling — the real Cloudflare Workers gotcha

This is the one to get right: S-02's kickoff time drives S-03's blindness lock and
S-04's scoring.

- **workerd's `Date` always uses UTC** in production, and (per
  [cloudflare/workerd PR #3865, 2025](https://github.com/cloudflare/workerd/pull/3865))
  now locally too — server-side date math is UTC, period.
- **Avoid `temporal-polyfill` on Workers**: a module-scope bug where `new Date()`
  returns epoch 0 at init broke all DST offsets after 1980
  ([temporal-polyfill #83](https://github.com/fullcalendar/temporal-polyfill/issues/83)).
  Fixed in 0.3.1, but an unnecessary footgun for an MVP.

Approach:

- Store `kickoff_time` as Postgres **`timestamptz`** (UTC at rest).
- Convert the admin's local wall-clock input → UTC and format back with
  **`@date-fns/tz`** (date-fns v4 first-class TZ): ~6 KB, tree-shakeable, **Intl-based
  so no bundled tzdata** and stays current with the runtime's IANA database. Pairs
  with the `date-fns` the Calendar already uses.

```bash
npm install @date-fns/tz
```

Alternatives: **Luxon** (excellent, Intl-based, but ~22 KB and not tree-shakeable);
**Spacetime** (bundles its own tzdata ~40 KB, can go stale); native **Temporal**
(ES2026/Stage 4, not reliably on workerd yet — revisit later, don't depend on it).
For a solo 3-week MVP, `@date-fns/tz` is the sweet spot.

Resolves the S-02 unknown ("local + assumed-server-TZ, or required UTC?"): capture
an explicit IANA zone (or default to the admin's browser zone), convert to UTC at
write time.

Refs: [Crosscheck JS timezones 2026](https://crosscheck.cloud/blogs/handling-dates-and-timezones-javascript/) ·
[PkgPulse date-fns-tz vs Luxon 2026](https://www.pkgpulse.com/guides/date-fns-tz-vs-luxon-vs-spacetime-timezone-2026)

## 5. Bulk-paste parsing (parse → preview → confirm)

Two realistic paths depending on grammar strictness:

- **Hand-rolled parser + zod (recommended for MVP).** Format is fixed and simple
  (`home, away, kickoff` per line). Split on newlines, split each line on a
  delimiter, validate the batch with `z.array(matchSchema)` + a `.refine()` that
  kickoff is in the future. Zero new deps, full control over per-line error
  messages for the preview table, runs identically on the edge. Matches the
  "parsed-preview-then-confirm" UX directly.
- **Papa Parse** if quoted fields / commas inside team names / messy CSV-TSV
  pastes must be tolerated. Universal browser+Node parser, handles
  quotes/escapes/mismatched-field edge cases, no dependencies, works on the
  Workers runtime. `csv-parser`/`neat-csv`/`fast-csv` are Node-stream-oriented
  (fast-csv deprecated) and a worse fit.

The roadmap notes the one-by-one flow is graceful-degradation fallback, so start
with the hand-rolled parser; reach for Papa Parse only if comma-in-name forces it.

Refs: [Papa Parse](https://www.papaparse.com/) ·
[JS CSV parsers 2026](https://www.filefeed.io/blog/top-5-javascript-csv-parsers) ·
[Xerobit parse CSV, 2026](https://xerobit.dev/blog/parse-csv-javascript/)

## Net new dependencies for S-02

```bash
npm install react-hook-form @hookform/resolvers @date-fns/tz
npx shadcn@latest add popover calendar form input
# optional, only if bulk-paste needs robust CSV:
npm install papaparse && npm install -D @types/papaparse
```

Already present: `zod`, React 19, Tailwind 4, `lucide-react`, shadcn pipeline,
`date-fns` (via Calendar), Astro Actions.

## Open items for `/10x-plan`

- Bulk-paste grammar: whitespace tolerance, missing seconds, delimiter choice.
- Edit-before-kickoff cutoff (`kickoff_time > now()`): enforce at DB (RLS) vs API.
- Timezone capture UX: explicit IANA zone picker vs default-to-browser-zone.

## Vendor docs (Context7)

Fetched 2026-06-01 via Context7 MCP for the "Net new dependencies" above. These
are the canonical, version-current snippets to copy from when implementing.

### react-hook-form + @hookform/resolvers (zodResolver)

Source: [`/react-hook-form/resolvers`](https://github.com/react-hook-form/resolvers)

Confirmed:

- **Zod 4 is supported** — the resolver branches on schema version
  (`isZod3Schema`) and otherwise handles Zod 4; docs import `from 'zod'` (or
  `'zod/v4'`). Our installed `zod@^4.4.3` works with `zodResolver` directly, no
  downgrade.
- **`zodResolver` validates the entire schema** on every trigger (calls
  `schema.parseAsync()` on the whole values object) — relevant for batch
  validating the bulk-paste rows.
- Use `Controller`/`FormField` (not `register`) for the controlled shadcn date
  picker.

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().int().min(18),
  email: z.string().email('Invalid email'),
});

// Types inferred from the schema
useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

// Or input/output distinction (when zod .transform/.coerce changes types)
useForm<z.input<typeof schema>, any, z.output<typeof schema>>({
  resolver: zodResolver(schema),
});
```

### @date-fns/tz — timezone-correct kickoff handling

Source: [`/date-fns/tz`](https://github.com/date-fns/tz)

`TZDate` converts an admin's local wall-clock kickoff into a UTC instant for
Postgres `timestamptz`. Constructor accepts IANA names or offsets
(`"Asia/Singapore"`, `"+08:00"`, `"-2359"`); `.withTimeZone(...)` re-projects the
same instant into another zone for display.

```typescript
import { TZDate } from "@date-fns/tz";

// Admin enters "2026-06-01 18:00" meaning 18:00 in Warsaw:
const kickoff = new TZDate(2026, 5, 1, 18, 0, "Europe/Warsaw");
kickoff.toString();
//=> 'Mon Jun 01 2026 18:00:00 GMT+0200 (Central European Summer Time)'
// The underlying timestamp is the correct UTC instant — store kickoff.toISOString()

// Re-project the same instant into another zone:
const sg = new TZDate(2022, 2, 13, "Asia/Singapore");
const ny = sg.withTimeZone("America/New_York"); // same instant, NY wall clock
```

Caveat: `TZDate.getTimezoneOffset()` returns the **inverted** sign (native `Date`
convention). Use standalone `tzOffset(zone, date)` for the actual offset
(`tzOffset === -getTimezoneOffset()`). Intl-based, no bundled tzdata — safe on the
Workers runtime.

### shadcn/ui — date+time picker

Source: [shadcn date-picker docs](https://ui.shadcn.com/docs/components/date-picker)

Official kickoff-entry pattern: `Popover` + `Calendar` + native
`<input type="time">` (no extra picker dependency). Wrap in `FormControl` inside a
`FormField` and map `field.value`/`field.onChange`; `FormMessage` renders zod
errors automatically.

```tsx
"use client"

import * as React from "react"
import { format } from "date-fns"
import { ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function DatePickerTime() {
  const [open, setOpen] = React.useState(false)
  const [date, setDate] = React.useState<Date | undefined>(undefined)

  return (
    <FieldGroup className="mx-auto max-w-xs flex-row">
      <Field>
        <FieldLabel htmlFor="date-picker">Date</FieldLabel>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" id="date-picker" className="w-32 justify-between font-normal">
              {date ? format(date, "PPP") : "Select date"}
              <ChevronDownIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar mode="single" selected={date} captionLayout="dropdown"
              defaultMonth={date} onSelect={(d) => { setDate(d); setOpen(false) }} />
          </PopoverContent>
        </Popover>
      </Field>
      <Field className="w-32">
        <FieldLabel htmlFor="time-picker">Time</FieldLabel>
        <Input type="time" id="time-picker" step="1" defaultValue="10:30:00"
          className="appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden" />
      </Field>
    </FieldGroup>
  )
}
```

Related variants in the docs: `DatePickerInput` (typed text + calendar with
`isValidDate`, good for fast keyboard entry of many matches) and a
natural-language picker via `chrono-node` (out of scope for MVP).

### papaparse (optional bulk-paste parser)

Source: [`/mholt/papaparse`](https://github.com/mholt/papaparse)

**String parsing is synchronous** — `Papa.parse(string, config)` returns the
result directly (callbacks are only for `File`/streaming). Clean fit for parse →
preview → confirm; runs in browser and Workers.

```javascript
import Papa from "papaparse";

const results = Papa.parse(pastedText, {
  header: false,        // positional "home, away, kickoff" grammar
  skipEmptyLines: true, // ignore blank lines in the paste
  // delimiter: ",",    // omit to auto-detect , / tab / ;
});

// results.data   -> array of rows (arrays, since header:false)
// results.errors -> per-row parse errors (with row index) for the preview table
// results.meta   -> { delimiter, linebreak, aborted, truncated, fields }
```

Result always has three keys: `data`, `errors`, `meta`. Hand each `data` row to
the zod `matchSchema` (with `@date-fns/tz` conversion + `kickoff > now()` refine)
for domain validation — Papa only handles delimited-text structure, not business
rules. `dynamicTyping`/`step`/`worker` not needed (small client-side pastes).
Ships no types: `npm install -D @types/papaparse`.

### Not net-new

- **Astro Actions** is built into Astro 6 (server layer / Zod-validated mutations);
  see the `## 1. Server layer` section above and
  [Astro Actions docs](https://docs.astro.build/en/guides/actions/).
