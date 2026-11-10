-- An assisted rep counts as part of a rep (settings.assisted_rep_credit, 0.5 like the sheet); a failed rep counts nothing.
create or replace view public.set_estimates with (security_invoker = true) as
with cfg as (
  select (select value::text::numeric from settings where key = 'rep_divisor') as div,
         (select value::text::numeric from settings where key = 'chain_bottom_ratio') as rb,
         (select value::text::numeric from settings where key = 'chain_top_ratio') as rt,
         coalesce((select value::text::numeric from settings where key = 'assisted_rep_credit'), 0) as credit
)
select t.id, t.session_id, t.exercise_id, t.block, t.set_index, t.weight_lb, t.total_bottom_lb, t.total_top_lb, t.reps,
  t.assisted, t.failed, t.rpe, t.rest_s, t.scheme, t.start_weight_lb, t.step_lb, t.drops, t.setup, t.notes, t.created_at,
  coalesce(t.total_bottom_lb, t.weight_lb) * cfg.rb + coalesce(t.total_top_lb, t.total_bottom_lb, t.weight_lb) * cfg.rt as effective_load_lb,
  case when t.reps is null then null::numeric
    else (coalesce(t.total_bottom_lb, t.weight_lb) * cfg.rb + coalesce(t.total_top_lb, t.total_bottom_lb, t.weight_lb) * cfg.rt)
      * (1 + (t.reps - case when t.failed then 1 when t.assisted then 1 - cfg.credit else 0 end)::numeric / cfg.div)
  end as e1rm_lb
from sets t cross join cfg;
