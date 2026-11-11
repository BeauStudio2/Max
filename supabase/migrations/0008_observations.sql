-- Raw measurements from any sensor, one row per reading or per rep, so new instruments (force, bar speed, video) can be
-- stored and mined without changing the sets table. `metric` names what was measured; `value` is the number; `data` holds the rest.
create table public.observations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  set_id uuid references public.sets(id) on delete cascade,
  rep_index integer,
  source text not null,          -- 'timer', 'tindeq', 'inertiometer', 'vision', 'manual', ...
  metric text not null,          -- 'assist_lb', 'rep_duration_s', 'bar_speed_mps', 'rest_s', ...
  value numeric,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index observations_set_idx on public.observations (set_id);
create index observations_session_metric_idx on public.observations (session_id, metric);
alter table public.observations enable row level security;
create policy observations_rw on public.observations for all to authenticated
  using ((select private.is_coach()) or private.owns_session(session_id))
  with check ((select private.is_coach()) or private.owns_session(session_id));
