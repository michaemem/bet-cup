-- Revoke User Sessions (S-09)
-- The FR-024 session-revocation primitive for admin password resets.
--
-- The Supabase admin SDK has no "sign out all sessions by user id" call
-- (GoTrueAdminApi.signOut needs the TARGET's JWT, which the admin never holds),
-- and an admin password set via auth.admin.updateUserById is not documented to
-- revoke sessions. PostgREST does not expose the GoTrue-owned `auth` schema, so
-- revocation has to run through a public-schema SECURITY DEFINER function.
--
-- Deleting a user's auth.sessions rows is exactly what GoTrue does on logout
-- ("the sessions affected by the logout are removed from the database
-- entirely"); the auth.refresh_tokens.session_id FK cascades, so the target's
-- refresh tokens stop working. This matches the revocation bar that
-- account.changePassword already ships (refresh-token revocation; an
-- already-issued access token lives until its short expiry).
--
-- Locked down to service_role only: it is unreachable except via the server-only
-- service-role client, and participants.resetPassword guards requireAdmin before
-- ever calling it. search_path is pinned and auth.sessions is schema-qualified so
-- the definer body is unambiguous.

create function public.revoke_user_sessions(target uuid)
  returns void
  language sql
  security definer
  set search_path = ''
as $$
  delete from auth.sessions where user_id = target;
$$;

comment on function public.revoke_user_sessions(uuid) is
  'FR-024 session-revocation primitive: deletes the target user''s auth.sessions rows (cascading their refresh tokens). Callable ONLY by the service-role client from participants.resetPassword (admin password reset). Must never be granted to anon/authenticated.';

-- New functions grant EXECUTE to PUBLIC by default; strip it and re-grant only
-- to service_role.
revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
