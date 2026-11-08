-- Keep the permission helpers out of the public API schema (Supabase advisor 0029).
-- Policies reference the functions by identity, so moving the schema keeps them working.
create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.is_coach() set schema private;
alter function public.owns_lifter(uuid) set schema private;
alter function public.owns_session(uuid) set schema private;
alter function public.owns_set(uuid) set schema private;
alter function public.handle_new_user() set schema private;
alter function private.is_coach() set search_path = public;
alter function private.owns_lifter(uuid) set search_path = public;
alter function private.owns_session(uuid) set search_path = public;
alter function private.owns_set(uuid) set search_path = public;
alter function private.handle_new_user() set search_path = public;
