-- Row-level security: coach sees and edits everything; a lifter sees and edits their own training data.

create or replace function public.is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'coach');
$$;

create or replace function public.owns_lifter(l uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lifters where id = l and user_id = auth.uid());
$$;

create or replace function public.owns_session(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sessions ss join public.lifters li on li.id = ss.lifter_id
                 where ss.id = s and li.user_id = auth.uid());
$$;

create or replace function public.owns_set(st uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sets t join public.sessions ss on ss.id = t.session_id
                 join public.lifters li on li.id = ss.lifter_id
                 where t.id = st and li.user_id = auth.uid());
$$;

revoke execute on function public.is_coach() from anon, public;
revoke execute on function public.owns_lifter(uuid) from anon, public;
revoke execute on function public.owns_session(uuid) from anon, public;
revoke execute on function public.owns_set(uuid) from anon, public;
grant execute on function public.is_coach() to authenticated;
grant execute on function public.owns_lifter(uuid) to authenticated;
grant execute on function public.owns_session(uuid) to authenticated;
grant execute on function public.owns_set(uuid) to authenticated;

-- New sign-ups get a profile (role lifter). The coach role and lifter link are granted by hand.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from anon, public, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.lifters enable row level security;
alter table public.equipment enable row level security;
alter table public.band_measurements enable row level security;
alter table public.exercises enable row level security;
alter table public.day_templates enable row level security;
alter table public.sessions enable row level security;
alter table public.sets enable row level security;
alter table public.reps enable row level security;
alter table public.garmin_daily enable row level security;
alter table public.settings enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_coach()));
create policy profiles_coach_write on public.profiles for update to authenticated
  using ((select public.is_coach())) with check ((select public.is_coach()));

create policy lifters_read on public.lifters for select to authenticated
  using ((select public.is_coach()) or user_id = (select auth.uid()));
create policy lifters_coach_ins on public.lifters for insert to authenticated with check ((select public.is_coach()));
create policy lifters_coach_upd on public.lifters for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy lifters_coach_del on public.lifters for delete to authenticated using ((select public.is_coach()));

-- Shared reference tables: everyone signed in reads, coach writes.
create policy equipment_read on public.equipment for select to authenticated using (true);
create policy equipment_ins on public.equipment for insert to authenticated with check ((select public.is_coach()));
create policy equipment_upd on public.equipment for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy equipment_del on public.equipment for delete to authenticated using ((select public.is_coach()));

create policy bands_read on public.band_measurements for select to authenticated using (true);
create policy bands_ins on public.band_measurements for insert to authenticated with check ((select public.is_coach()));
create policy bands_upd on public.band_measurements for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy bands_del on public.band_measurements for delete to authenticated using ((select public.is_coach()));

create policy exercises_read on public.exercises for select to authenticated using (true);
create policy exercises_ins on public.exercises for insert to authenticated with check ((select public.is_coach()));
create policy exercises_upd on public.exercises for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy exercises_del on public.exercises for delete to authenticated using ((select public.is_coach()));

create policy settings_read on public.settings for select to authenticated using (true);
create policy settings_ins on public.settings for insert to authenticated with check ((select public.is_coach()));
create policy settings_upd on public.settings for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy settings_del on public.settings for delete to authenticated using ((select public.is_coach()));

create policy templates_read on public.day_templates for select to authenticated
  using (lifter_id is null or (select public.is_coach()) or public.owns_lifter(lifter_id));
create policy templates_ins on public.day_templates for insert to authenticated with check ((select public.is_coach()));
create policy templates_upd on public.day_templates for update to authenticated using ((select public.is_coach())) with check ((select public.is_coach()));
create policy templates_del on public.day_templates for delete to authenticated using ((select public.is_coach()));

-- Training data: the coach, or the lifter it belongs to.
create policy sessions_rw on public.sessions for all to authenticated
  using ((select public.is_coach()) or public.owns_lifter(lifter_id))
  with check ((select public.is_coach()) or public.owns_lifter(lifter_id));
create policy sets_rw on public.sets for all to authenticated
  using ((select public.is_coach()) or public.owns_session(session_id))
  with check ((select public.is_coach()) or public.owns_session(session_id));
create policy reps_rw on public.reps for all to authenticated
  using ((select public.is_coach()) or public.owns_set(set_id))
  with check ((select public.is_coach()) or public.owns_set(set_id));
create policy garmin_rw on public.garmin_daily for all to authenticated
  using ((select public.is_coach()) or public.owns_lifter(lifter_id))
  with check ((select public.is_coach()) or public.owns_lifter(lifter_id));
