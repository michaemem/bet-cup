-- Revoke unauthenticated read access to profiles_public.
-- F-01 impl-review F1: granting SELECT to `anon` exposed every user's
-- id + display_name via PostgREST (/rest/v1/profiles_public), independent
-- of the default-deny HTTP middleware. BetCup is private by default
-- (PRD ## Access Control); display names are not public metadata.
-- The original grant lives in 20260528232000_identity_boundary.sql:73.
revoke select on public.profiles_public from anon;
