-- Identity Boundary (F-01)
-- Establishes the identity foundation every downstream BetCup slice rides on:
-- profiles + user_roles tables, the user_role enum, SECURITY INVOKER role
-- helpers, the SECURITY DEFINER handle_new_user trigger that seeds profile +
-- role rows (and promotes the admin), the profiles_public read view, and the
-- strict per-operation RLS policies.

-- 1. pgcrypto (gen_random_uuid, crypt/gen_salt for the local admin seed).
create extension if not exists pgcrypto;

-- 2. Role enum.
create type public.user_role as enum ('admin', 'participant');

-- 3. profiles: one row per auth.users row. display_name is public (exposed via
--    profiles_public); legal_name is admin-only (never leaves RLS-protected
--    profiles).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  legal_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Identity row per auth.users. display_name is public (read via profiles_public); legal_name is admin-only and never exposed to non-admin reads.';
comment on column public.profiles.legal_name is
  'Admin-only. Cross-user reads are denied by RLS; non-admin code must use profiles_public which omits this column.';

-- Keep updated_at fresh on every UPDATE.
create function public.set_updated_at()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger updated_at_profiles
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- 4. user_roles: many-to-many. UNIQUE(user_id, role) lets the admin hold both
--    'participant' and 'admin' rows (FR-017: the admin is also a participant).
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.user_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create index user_roles_user_id_idx on public.user_roles (user_id);

comment on table public.user_roles is
  'Many-to-many user/role assignments. Admin holds two rows (participant + admin) per FR-017. SELECT is restricted to self+admin so participants cannot identify the admin via the data layer.';

-- 5. profiles_public: canonical non-admin read path. Runs with definer
--    privileges (security_invoker = false) so it bypasses the underlying
--    cross-user SELECT denial on profiles; it exposes only the public columns.
create view public.profiles_public
  with (security_invoker = false)
as
  select id, display_name, created_at, updated_at
  from public.profiles;

comment on view public.profiles_public is
  'Canonical non-admin read path for profiles. Exposes only public columns (no legal_name) and runs security_invoker = false to bypass the cross-user RLS denial on profiles. Downstream slices that list participants for a non-admin user MUST query this view, not profiles.';

grant select on public.profiles_public to authenticated, anon;

-- 6. Role helpers. SECURITY DEFINER (with a locked search_path) so they read
--    user_roles WITHOUT re-applying RLS. This is mandatory: these helpers are
--    called from the user_roles RLS policy itself, so a SECURITY INVOKER helper
--    would re-enter the same policy and recurse infinitely (stack depth
--    exceeded) for any non-admin caller. Each helper only ever reads rows for
--    the caller's own auth.uid() and returns a boolean / the caller's roles, so
--    bypassing RLS here leaks nothing.
create function public.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

create function public.is_participant()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'participant'
  );
$$;

create function public.current_user_roles()
  returns public.user_role[]
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select array_agg(role) from public.user_roles where user_id = auth.uid();
$$;

-- 7. handle_new_user: SECURITY DEFINER so it can write public.profiles /
--    public.user_roles from the auth.users insert context. Seeds a profile and
--    a 'participant' role for every new user, and additionally an 'admin' role
--    when the email matches app.admin_email.
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  admin_email text := current_setting('app.admin_email', true);
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      split_part(new.email, '@', 1)
    )
  );

  insert into public.user_roles (user_id, role)
  values (new.id, 'participant');

  if admin_email is not null and new.email = admin_email then
    insert into public.user_roles (user_id, role)
    values (new.id, 'admin');
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- 8. RLS.
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

-- profiles: self or admin can read; only self can update; inserts/deletes are
-- closed to clients except admin delete (S-06 wires the UI later).
create policy profiles_select on public.profiles
  for select
  to authenticated
  using (auth.uid() = id or public.is_admin());

create policy profiles_update on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy profiles_delete on public.profiles
  for delete
  to authenticated
  using (public.is_admin());

-- user_roles: self or admin can read; writes are closed to clients (only the
-- trigger and future admin paths write).
create policy user_roles_select on public.user_roles
  for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());
