# Manual verification — tournament-and-matches (S-02)

Runbook for the manual / integration checks that can't run in CI (they need a
live local Supabase stack and a browser session). Phase 1 (1.1–1.8) is verified
automatically by the RLS integration test + `db:reset`/`db:types`; this doc
covers the remaining UI and Action-layer checks (2.7–2.8, 3.4–3.7, 4.5–4.8).

## Results log

| Check | Status | Notes |
| ----- | ------ | ----- |
| 3.4 Tournament create → edit (singleton) | PASS | |
| 3.5 Add match; correct local kickoff in list | PASS | |
| 3.6 Future match editable; past-kickoff locked | PASS | |
| 3.7 Non-admin redirected from `/admin` | PASS | |
| 2.7 Action as non-admin → `UNAUTHORIZED` | PASS | 401 `{code:"UNAUTHORIZED", message:"Admin access required"}` with valid input. (First run sent invalid input missing `timeZone` → `AstroActionInputError`/400, which never reached the guard.) |
| 2.8 Wall-clock kickoff round-trips to correct UTC | PASS | Warsaw 20:00 stored as 18:00Z (UTC+2 DST). |
| 4.5 Clean list previews valid; Confirm saves all | PASS | |
| 4.6 Malformed line flagged; inline fix enables Confirm | PASS | |
| 4.7 Past-kickoff rows warned but saveable | PASS | |
| 4.8 Delimiter-flexible paste parses correctly | PASS (by design) | Supported delimiters are `,` / tab / `;` / `|` (plan §501). Spaces are intentionally NOT a delimiter — the kickoff field contains a space (`YYYY-MM-DD HH:mm`), so space-splitting is ambiguous. The parser correctly errors a space-"delimited" row. |

---

## 0. One-time setup

**a. Node 22 + stack up**

```bash
nvm use 22   # or: export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
cd /home/mimazu/projects/braveai-prj
npx supabase status   # API http://127.0.0.1:54321, Studio http://127.0.0.1:54323
```

**b. Local keys** (shared defaults — stable across restarts):

- Publishable (= anon): `<PUBLISHABLE_KEY>` — from `npx supabase status` (`anon key`)
- Secret (= service_role): `<SECRET_KEY>` — from `npx supabase status` (`service_role key`)

> Local-only defaults printed by `npx supabase status`; not committed here.
> Substitute the real local values in the commands below.

**c. Dev server env.** Cloudflare `workerd` reads `.dev.vars`. Confirm:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<PUBLISHABLE_KEY>
```

**d. Create a non-admin (participant) user** (public signup is disabled, so use the
admin API with the Secret key; `handle_new_user` auto-assigns the `participant`
role because the email ≠ `ADMIN_EMAIL`):

```bash
curl -s -X POST "http://127.0.0.1:54321/auth/v1/admin/users" \
  -H "apikey: <SECRET_KEY>" \
  -H "Authorization: Bearer <SECRET_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"email":"player@betcup.local","password":"local-only","email_confirm":true}'
```

Re-running yields `email_exists` (fine).

**e. Start the dev server**

```bash
npm run dev   # http://localhost:4321 (note the port the CLI prints; may be 4322)
```

**Accounts:**

- Admin: `admin@betcup.local` / `local-only`
- Participant: `player@betcup.local` / `local-only`

---

## Phase 3 — UI (do first; creates the data the others use)

### 3.4 — Tournament create → edit (singleton)

1. Sign in as **admin** at `/auth/signin`.
2. Go to `/admin`. Heading reads **"Create tournament"**.
3. Enter name `Euro 2028`, time zone `Europe/Warsaw`, submit.

**Expected:** After reload the heading is **"Edit tournament"** with fields
pre-filled; the Add a match / Bulk paste / Matches sections appear. Submitting
again **updates** the same row (Studio → `tournaments` has exactly 1 row).

### 3.5 — Add a match; correct local kickoff in list

1. In **Add a match**, enter `Poland` vs `Germany`.
2. Pick a **future** kickoff, e.g. `2026-07-01 20:00`. Submit.

**Expected:** Matches list shows `Poland vs Germany` at **`2026-07-01 20:00`**
(same wall-clock, in the Warsaw zone). Also the visible half of 2.8.

### 3.6 — Future editable; past-kickoff locked

1. Click **Edit** on the future match, change away team to `Spain`, save → list shows `Poland vs Spain`.
2. Seed a past match (Studio → SQL editor):

```sql
insert into public.matches (tournament_id, home_team, away_team, kickoff_time)
select id, 'Italy', 'France', now() - interval '1 day' from public.tournaments limit 1;
```

3. Reload `/admin`.

**Expected:** `Italy vs France` shows **"Locked"** (no Edit); the future row still shows **Edit**.

### 3.7 — Non-admin redirected from `/admin`

1. Sign out; sign in as **participant**; navigate to `/admin`.

**Expected:** Immediate redirect to **`/dashboard`**, which shows no admin link
(the link renders only for admins).

---

## Phase 2 — Server mutation layer

### 2.7 — Action as non-admin → `UNAUTHORIZED`  (RE-TEST with valid input)

`matchInputSchema` requires `homeTeam`, `awayTeam`, `kickoffLocal`, **and
`timeZone`**. Astro validates input *before* the handler, so omitting a field
yields `AstroActionInputError` (400) and never reaches the admin guard. Send
**valid** input as the participant so validation passes and the guard fires.

While signed in as the **participant**, run in the DevTools console:

```js
const res = await fetch('/_actions/matches.add', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    homeTeam: 'X',
    awayTeam: 'Y',
    kickoffLocal: '2026-07-01 20:00',
    timeZone: 'Europe/Warsaw',
  }),
});
console.log(res.status, await res.json());
```

**Expected:** an error payload with **`code: "UNAUTHORIZED"`** (message "Admin
access required"). No match inserted (confirm in Studio). The RLS policy is the
bypass-proof backstop behind this app-layer guard.

### 2.8 — Wall-clock kickoff round-trips to correct UTC  (PENDING)

You entered `2026-07-01 20:00` in **Europe/Warsaw** (UTC+2 in July, DST). In
Studio → SQL editor:

```sql
select home_team, away_team, kickoff_time
from public.matches order by kickoff_time;
```

**Expected:** stored `kickoff_time` is **`2026-07-01 18:00:00+00`** (20:00 − 2h),
while `/admin` renders it back as **`2026-07-01 20:00`**. Spot-check a winter
date too: `2026-12-01 20:00` → stored **`19:00:00+00`** (UTC+1).

---

## Phase 4 — Bulk-paste import

Sign in as **admin** → `/admin` → **Bulk paste fixtures**.
Row format: `home, away, YYYY-MM-DD HH:mm`. Delimiters: `,` / tab / `;` / `|`.

### 4.8 — Delimiter-flexible paste

Paste a block mixing **supported** delimiters:

```
Brazil, Argentina, 2026-07-10 18:00
England	Portugal	2026-07-11 21:00
Netherlands; Croatia; 2026-07-12 16:30
Spain | Italy | 2026-07-13 20:00
```

**Expected:** all 4 rows parse into separate home/away/kickoff columns.

> Spaces are NOT a delimiter (the kickoff contains a space, making space-splitting
> ambiguous). A space-"delimited" row like `A   B   2026-07-12 16:30` correctly
> shows `Expected: home, away, kickoff` — that is intended behavior, not a bug.

### 4.5 — Clean list previews valid; Confirm saves all

With the valid rows showing no errors, click **Confirm**.

**Expected:** all inserted in one batch; Matches list includes them at their
Warsaw-local kickoff times.

### 4.6 — Malformed line flagged; inline fix enables Confirm

```
Spain, Italy, 2026-07-15 20:00
Germany,, 2026-07-16 20:00
```

**Expected:** row 2 flagged invalid and Confirm blocked; fix it inline
(`Germany, France, 2026-07-16 20:00`) → error clears, Confirm enables, both save.

### 4.7 — Past-kickoff rows warned but saveable

```
Japan, Korea, 2020-01-01 18:00
```

**Expected:** a past-kickoff **warning** (not a hard error); the row stays
selectable and Confirm still saves it (the lock only blocks later *edits*).
