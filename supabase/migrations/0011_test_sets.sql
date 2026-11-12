-- Sets done on the Test screen (Config): sensor checks and calibration, kept apart from training.
-- Nothing here is read by planning or learning. Each row keeps what the sensors saw and what was really done.
create table if not exists public.test_sets (
  id uuid primary key default gen_random_uuid(),
  lifter_id uuid not null references public.lifters(id) on delete cascade,
  lift text not null check (lift in ('bench', 'squat', 'deadlift')),
  weight_lb numeric,
  spotter boolean not null default false,
  sensor_reps int,
  true_reps int,
  reps jsonb,
  raw jsonb,
  tindeq jsonb,
  clip jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists test_sets_lifter_idx on public.test_sets (lifter_id, created_at desc);
alter table public.test_sets enable row level security;
create policy test_sets_read on public.test_sets for select to authenticated using (true);
create policy test_sets_add on public.test_sets for insert to authenticated with check (true);
create policy test_sets_change on public.test_sets for update to authenticated using (true) with check (true);
create policy test_sets_remove on public.test_sets for delete to authenticated using ((select private.is_coach()));
