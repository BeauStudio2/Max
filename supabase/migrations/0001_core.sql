-- Max v1 core schema
-- Raw facts are stored; estimates (e1RM, fatigue, projections) are computed in views/app.

create extension if not exists pgcrypto;

-- People ---------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'lifter' check (role in ('coach','lifter')),
  created_at timestamptz not null default now()
);

create table public.lifters (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  user_id uuid unique references auth.users(id) on delete set null,
  bodyweight_lb numeric,
  settings jsonb not null default '{}'::jsonb,   -- stop %, fatigue seeds, safety heights, etc.
  created_at timestamptz not null default now()
);

-- Equipment ------------------------------------------------------------
create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  kind text not null,          -- bar, clamp, chain, band, trap_bar, counterweight, plate, other
  name text not null unique,
  weight_lb numeric,           -- static weight where it applies
  props jsonb not null default '{}'::jsonb,
  notes text,
  verified boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.band_measurements (
  id uuid primary key default gen_random_uuid(),
  band_id uuid not null references public.equipment(id) on delete cascade,
  measured_on date not null default current_date,
  setup text not null default 'straight',   -- straight | bench_doubled | other
  stretch_in numeric not null,
  force_lb numeric not null,
  tare_lb numeric default 0,
  notes text
);

-- Exercises & programming -----------------------------------------------
create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null default 'support',  -- primary | speed | support | deadlift
  muscle_group text,
  notes text
);

create table public.day_templates (
  id uuid primary key default gen_random_uuid(),
  lifter_id uuid references public.lifters(id) on delete cascade,  -- null = shared plan
  weekday int check (weekday between 0 and 6),                    -- 0 = Sunday
  name text not null,
  version int not null default 1,
  active_from date not null default current_date,
  spec jsonb not null,          -- blocks: speed / primary / support, each with exercises and rules
  notes text,
  created_at timestamptz not null default now()
);

-- Sessions, sets, reps -------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  lifter_id uuid not null references public.lifters(id) on delete cascade,
  session_date date not null,
  template_id uuid references public.day_templates(id) on delete set null,
  primary_lift text check (primary_lift in ('bench','squat','deadlift')),
  started_at timestamptz,
  ended_at timestamptz,
  sick boolean not null default false,
  hurt text,                    -- free-text description; non-empty = hurt
  bodyweight_lb numeric,
  planned jsonb not null default '{}'::jsonb,  -- planned_e1rm, fatigue_rate_used, stop_pct, setup labels
  notes text,
  source text not null default 'app',         -- app | sheet_import
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (lifter_id, session_date, primary_lift)
);

create table public.sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id),
  block text not null default 'primary',      -- speed | primary | support | deadlift
  set_index int not null,
  weight_lb numeric,             -- plate/bar load excluding chains/bands (as entered)
  total_bottom_lb numeric,       -- total load at bottom incl. bar, clamps, chains
  total_top_lb numeric,          -- total load at top
  reps int,
  assisted boolean not null default false,
  failed boolean not null default false,
  rpe numeric,
  rest_s numeric,
  scheme text,                   -- support shorthand: RTR, F + DS×2 ...
  start_weight_lb numeric,
  step_lb numeric,
  drops int,
  setup jsonb not null default '{}'::jsonb,   -- clamp, chains, bands, bell string, etc.
  notes text,
  created_at timestamptz not null default now(),
  unique (session_id, block, exercise_id, set_index)
);

create table public.reps (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.sets(id) on delete cascade,
  rep_index int not null,
  t_start timestamptz,
  peak_force_lb numeric,
  mean_force_lb numeric,
  assist_lb numeric,
  velocity_mps numeric,
  extra jsonb not null default '{}'::jsonb,
  unique (set_id, rep_index)
);

-- Daily wearable data --------------------------------------------------
create table public.garmin_daily (
  lifter_id uuid not null references public.lifters(id) on delete cascade,
  day date not null,
  resting_hr numeric,
  hrv_ms numeric,
  sleep_h numeric,
  steps int,
  metrics jsonb not null default '{}'::jsonb,
  primary key (lifter_id, day)
);

-- Settings (global config: rep divisor, chain ratios, etc.) ------------
create table public.settings (
  key text primary key,
  value jsonb not null,
  notes text
);

create index on public.sessions (lifter_id, session_date);
create index on public.sets (session_id);
create index on public.reps (set_id);
create index on public.band_measurements (band_id);
create index on public.sets (exercise_id);
create index on public.day_templates (lifter_id);
create index on public.sessions (template_id);
create index on public.lifters (user_id);
