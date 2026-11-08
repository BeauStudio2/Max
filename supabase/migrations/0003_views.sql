-- Derived numbers. Formulas mirror the sheet: Epley with a configurable divisor,
-- chain load counted as a bottom/top blend, an assisted or failed last rep excluded.

insert into public.settings (key, value, notes) values
  ('rep_divisor', '30', 'Epley divisor: e1RM = load x (1 + reps / divisor)'),
  ('chain_bottom_ratio', '0.5', 'Share of the bottom load counted when chains are on'),
  ('chain_top_ratio', '0.5', 'Share of the top load counted when chains are on'),
  ('assist_lb', '7.5', 'Assist credited on an assisted rep (pre-spotter)')
on conflict (key) do nothing;

create or replace view public.set_estimates with (security_invoker = true) as
with cfg as (
  select
    (select value::text::numeric from public.settings where key = 'rep_divisor') as div,
    (select value::text::numeric from public.settings where key = 'chain_bottom_ratio') as rb,
    (select value::text::numeric from public.settings where key = 'chain_top_ratio') as rt
)
select
  t.*,
  coalesce(t.total_bottom_lb, t.weight_lb) * cfg.rb
    + coalesce(t.total_top_lb, t.total_bottom_lb, t.weight_lb) * cfg.rt as effective_load_lb,
  case when t.reps is null then null
       else (coalesce(t.total_bottom_lb, t.weight_lb) * cfg.rb
             + coalesce(t.total_top_lb, t.total_bottom_lb, t.weight_lb) * cfg.rt)
            * (1 + (t.reps - case when t.assisted or t.failed then 1 else 0 end) / cfg.div)
  end as e1rm_lb
from public.sets t cross join cfg;

create or replace view public.session_summary with (security_invoker = true) as
select
  s.id as session_id, s.lifter_id, l.name as lifter, s.session_date, s.primary_lift,
  s.sick, s.hurt, (s.sick or coalesce(length(trim(s.hurt)), 0) > 0) as excluded,
  s.bodyweight_lb, s.planned, s.notes,
  p1.weight_lb as set1_weight_lb, p1.reps as set1_reps, p1.e1rm_lb as set1_e1rm_lb,
  (select count(*) from public.sets t where t.session_id = s.id and t.block = 'primary' and t.reps is not null) as sets_done,
  (select sum(coalesce(t.total_bottom_lb, t.weight_lb) * t.reps) from public.sets t
     where t.session_id = s.id and t.block = 'primary' and t.reps is not null) as volume_lb,
  g.resting_hr, g.hrv_ms, g.sleep_h
from public.sessions s
join public.lifters l on l.id = s.lifter_id
left join public.set_estimates p1 on p1.session_id = s.id and p1.block = 'primary' and p1.set_index = 1
left join public.garmin_daily g on g.lifter_id = s.lifter_id and g.day = s.session_date;
