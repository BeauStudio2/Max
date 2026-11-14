-- Plans are named, individually designed days: no weekdays (the log picks the plan per session).
-- Exercise names go root first ("Deadlift - trap bar - banded") so variations sort next to each other.
-- Wyatt's power clean day uses the new non-cycle deadlift (top set of max reps).
-- Apply after the app version that picks plans in the log is deployed.

begin;

-- 1. Exercise renames, carried into every JSON that names exercises ---------------------------------
create temp table ren (old text primary key, new text not null) on commit drop;
insert into ren values
  ('Banded bench',                             'Bench Press - banded'),
  ('Smith throw',                              'Bench Press - Smith throw'),
  ('Flywheel deadlift',                        'Deadlift - flywheel'),
  ('Trap bar pull, banded',                    'Deadlift - trap bar - banded'),
  ('Strap lean-back squat',                    'Squat - strap lean-back'),
  ('Squat jump, band assisted',                'Squat jump - band assisted'),
  ('Squat jump, band resisted',                'Squat jump - band resisted'),
  ('Squat jump, free',                         'Squat jump - free'),
  ('Flywheel harness jump squat',              'Squat jump - flywheel harness'),
  ('Broad jump, band resisted',                'Broad jump - band resisted'),
  ('Broad jump, free',                         'Broad jump - free'),
  ('Leg raise, hanging',                       'Leg raise - hanging'),
  ('Leg raise, lying',                         'Leg raise - lying'),
  ('Barbell row',                              'Row - barbell'),
  ('Cable row',                                'Row - cable'),
  ('Chest-supported row',                      'Row - chest-supported'),
  ('Cable curl',                               'Curl - cable'),
  ('DB lateral raise',                         'Lateral raise - dumbbell'),
  ('Flywheel lateral raise',                   'Lateral raise - flywheel'),
  ('DB overhead press',                        'Overhead press - dumbbell'),
  ('Smith sliding-handle overhead press',      'Overhead press - Smith sliding-handle'),
  ('Incline DB press',                         'Chest press - incline dumbbell'),
  ('Smith sliding-handle press',               'Chest press - Smith sliding-handle'),
  ('Dumbbell fly',                             'Fly - dumbbell'),
  ('Rear-delt fly (DB + lateral band)',        'Fly - rear delt, dumbbell + lateral band'),
  ('JM press (Smith)',                         'JM press - Smith'),
  ('Overhead triceps extension',               'Triceps extension - overhead'),
  ('Weighted dip',                             'Dip - weighted'),
  ('Barbell hip thrust',                       'Hip thrust - barbell'),
  ('Reverse hyperextension (machine)',         'Reverse hyperextension - machine'),
  ('GHD glute-ham raise',                      'Glute-ham raise - GHD'),
  ('GHD sit-up',                               'Sit-up - GHD'),
  ('Decline crunch',                           'Crunch - decline'),
  ('Knee-locked sissy squat (plate at chest)', 'Sissy squat - knee-locked, plate at chest');

update public.exercises e set name = r.new from ren r where e.name = r.old;

-- Names appear as JSON strings (values and keys) in plans, lifter settings, session plans and set setups.
-- Only whole quoted strings are replaced, so a name inside a longer note is left alone.
do $$
declare r record; o text; n text;
begin
  for r in select * from ren loop
    o := to_json(r.old)::text; n := to_json(r.new)::text;
    update public.day_templates set spec = replace(spec::text, o, n)::jsonb where strpos(spec::text, o) > 0;
    update public.lifters set settings = replace(settings::text, o, n)::jsonb where strpos(settings::text, o) > 0;
    update public.sessions set planned = replace(planned::text, o, n)::jsonb where strpos(planned::text, o) > 0;
    update public.sessions set extra = replace(extra::text, o, n)::jsonb where strpos(extra::text, o) > 0;
    update public.sets set setup = replace(setup::text, o, n)::jsonb where strpos(setup::text, o) > 0;
    update public.observations set data = replace(data::text, o, n)::jsonb where strpos(data::text, o) > 0;
    update public.settings set value = replace(value::text, o, n)::jsonb where strpos(value::text, o) > 0;
  end loop;
end $$;

-- 2. Plans lose their weekdays and the day prefix in their names --------------------------------------
update public.day_templates set weekday = null;
update public.day_templates
   set name = upper(left(regexp_replace(name, '^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^:]*:\s*', ''), 1))
           || substr(regexp_replace(name, '^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^:]*:\s*', ''), 2)
 where lifter_id is null;

-- 3. Wyatt's power clean day: deadlift as a top set of max reps, banded trap bar back-offs, no cycle ----
update public.day_templates
   set name = 'Wyatt: power clean + deadlift + flywheel',
       spec = (spec - 'deadlift_cycle' - 'variant_of' - 'variant_label')
              || jsonb_build_object('heavy', jsonb_build_object(
                   'lift', 'deadlift', 'scheme', 'max_reps', 'rest_s', 180,
                   'backoff', '3×3 @ 60%',
                   'backoff_exercise', 'Deadlift - trap bar - banded',
                   'backoff_setup', 'max speed; bands add ~20–30% at lockout; end the set if a rep slows',
                   'flywheel_sets', 3)),
       notes = 'Wyatt only. spec.blocks is the full routine (jump pairings per lift); heavy/speed/support are what the app runs.'
 where id = '54c1e579-24e1-426a-8f87-3fed8e0d8fe0';

commit;
