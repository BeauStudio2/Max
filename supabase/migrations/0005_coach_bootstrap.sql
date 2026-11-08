-- Beau's account becomes coach and is linked to the Beau lifter the moment it signs up.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          case when lower(new.email) = 'beau@beaustudio.com' then 'coach' else 'lifter' end)
  on conflict (id) do nothing;
  if lower(new.email) = 'beau@beaustudio.com' then
    update public.lifters set user_id = new.id where name = 'Beau' and user_id is null;
  end if;
  return new;
end $$;

-- Speed exercises picked up the support group by mistake when seeded from the templates.
update public.exercises set muscle_group = null where category = 'speed' and muscle_group not in ('chest');
