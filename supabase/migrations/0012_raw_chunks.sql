-- The workout's recording: every reading from the phone on the bar and the Tindeq, in half-minute pieces, with clock times.
-- Nothing in planning or learning reads this. It is the record a set can be read again from, whatever was logged at the time.
create table if not exists public.raw_chunks (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('imu', 'tindeq')),
  from_at timestamptz not null,
  to_at timestamptz not null,
  n int not null,
  lifter_id uuid references public.lifters(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  label text,
  -- JSON text: {"t": [ms after from_at], "v": [imu: m/s² × 1000 | tindeq: lb × 100]}
  data text not null,
  created_at timestamptz not null default now()
);
create index if not exists raw_chunks_time_idx on public.raw_chunks (from_at);
alter table public.raw_chunks enable row level security;
create policy raw_chunks_read on public.raw_chunks for select to authenticated using (true);
create policy raw_chunks_add on public.raw_chunks for insert to authenticated with check (true);
create policy raw_chunks_remove on public.raw_chunks for delete to authenticated using ((select private.is_coach()));
