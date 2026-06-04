-- Participant Username (S-01)
-- Adds the login handle that admin-created participants sign in with. username
-- is a first-class, case-insensitively-unique column on profiles so the admin
-- participant list renders it under F-01's existing RLS (no service-role read)
-- and login can map <username> -> <username>@betcup.local (the synthetic auth
-- email the seeded admin already matches).
--
-- Additive on top of F-01 (20260528232000_identity_boundary.sql): a new column
-- (nullable -> backfilled -> NOT NULL), a unique lowercased index, and a
-- handle_new_user replace that ALSO writes username. The display_name + role
-- logic, SECURITY DEFINER, and `set search_path = public` are preserved exactly;
-- the on_auth_user_created trigger already points at the function (not recreated).

-- 1. Add the column (nullable for the backfill window).
alter table public.profiles add column username text;

-- 2. Backfill existing rows (the seeded admin) from the auth email local-part.
update public.profiles p
set username = lower(split_part(u.email, '@', 1))
from auth.users u
where u.id = p.id and p.username is null;

-- 3. Case-insensitive uniqueness on the login handle.
create unique index profiles_username_lower_idx on public.profiles (lower(username));

-- 4. Now safe to require it: every existing row was backfilled above.
alter table public.profiles alter column username set not null;

comment on column public.profiles.username is
  'Login handle (lowercased). Maps to the synthetic auth email <username>@betcup.local. Unique case-insensitively.';

-- 5. Teach handle_new_user to populate username. Body is identical to the F-01
--    version (SECURITY DEFINER, set search_path = public, same display_name +
--    role logic) plus the username write into the profiles insert. lower(...)
--    wraps the WHOLE coalesce so a mixed-case user_metadata.username from the
--    Studio "Add user" path is stored lowercased too, keeping the stored value
--    consistent with the case-insensitive login mapping and the unique index.
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  admin_email text := current_setting('app.admin_email', true);
begin
  insert into public.profiles (id, display_name, username)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      split_part(new.email, '@', 1)
    ),
    lower(coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      split_part(new.email, '@', 1)
    ))
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
