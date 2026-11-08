"""Reference data for Max: lifters, equipment, Garmin history and the weekly plan templates.
Values come from the Beau-Max sheet (Config, Garmin, Weekly plan tabs) as of 11/07/26."""
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from sheet_import import q, jq

lifters = [
    ('Beau', 216.0, {'stop_pct': {'bench': 70, 'squat': 70}, 'target_reps': {'bench': 5, 'squat': 15},
                     'deadlift_best_conventional_lb': 600, 'band_anchor_gap_in': 19, 'rest_s': 100}),
    ('Mallen', 190.0, {'stop_pct': {'bench': 80, 'squat': 80}, 'target_reps': {'bench': 5, 'squat': 5},
                       'squat_planned_e1rm_lb': 275, 'band_anchor_gap_in': 19, 'safeties_offset_in': -2}),
    ('Wyatt', None, {}), ('Clark', None, {}),
]
bands = [  # name, rogue #, rogue rating, one band lockout lb (unverified), note
    ('Orange', 0, 9, 24, 'old setup'), ('Red (thin)', 1, 18, 48.5, 'old setup'), ('Blue', 2, 30, 67.5, 'old setup'),
    ('Green', 3, 40, 89, 'crane scale 11/06: 200 lb total with 22 lb bar, anchor 2 in lower'),
    ('Black', 4, 65, 177.5, 'old setup'), ('Purple', 5, 95, 190, 'placeholder 2x Rogue rating'),
    ('Red (wide)', 6, 115, 230, 'placeholder 2x Rogue rating'), ('Silver', 7, 225, 450, 'placeholder 2x Rogue rating')]
equipment = [
    ('bar', 'Ohio Power Bar', 45, {}, 'Regulation bar, used for all heavy work'),
    ('bar', 'Light 1-inch bar', 22, {}, 'Banded speed bench'),
    ('trap_bar', 'Trap bar', 65, {'counterweight_lb': 20, 'balanced_lb': 85, 'handle_height_in': 14, 'handle_spacing_in': 36},
     'Balanced with two 10s = 85 lb. Handles fixed at 14 in (wrench to change).'),
    ('clamp', 'Eleiko clamps (pair)', 11, {'each_kg': 2.5}, None),
    ('clamp', 'Chain clamp + carabiner (pair)', 3.5, {}, 'Counted only on straight sets; chain weights already include it'),
    ('chain', 'Chain 1/2', None, {'bottom_lb_per_side': 3.5, 'top_lb_per_side': 7}, 'Bench range 18.5 in'),
    ('chain', 'Chain 5/8', None, {'bottom_lb_per_side': 7.5, 'top_lb_per_side': 15}, 'Bench range 18.5 in'),
    ('other', 'Dip horn', 10, {}, None),
    ('sensor', 'Tindeq Progressor (500 kg)', None, {'capacity_kg': 500, 'rate_hz': 80, 'ble_service': '7e4e1701-1ea6-40c9-9dcc-13d34ffead57'}, None),
    ('sensor', 'Crane scale (500 kg)', None, {'capacity_kg': 500}, 'Professional crane scale used for band tests'),
    ('spotter', 'Auto spotter', None, {'motor': 'FrightProps MOT1 wiper motor, 35/50 RPM at 12 V, 6 N·m rated, 20 N·m stall',
                                      'sprocket_diameter_cm': 7, 'pace_mps': {'low_12v': 0.13, 'high_12v': 0.18},
                                      'counterweight_lb': None, 'line': 'bar-band-Tindeq-cable-pulley-take-up weight & chain-sprocket-counterweight'},
     'Speed-governed: assists only when the bar falls below the counterweight pace. In build.'),
]
garmin = [r.split(',') for r in """2026-10-25,9008,74,17,3.98
2026-10-26,11977,68,24,5.78
2026-10-27,5073,71,20,5.72
2026-10-28,12428,74,25,5.12
2026-10-29,12270,75,19,5.22
2026-10-30,7841,75,19,6.62
2026-10-31,9433,75,18,6.28
2026-11-01,4896,77,12,3.5
2026-11-02,6904,76,16,5.67
2026-11-03,10804,74,19,5.98
2026-11-04,7869,73,23,5.48
2026-11-05,6497,73,21,4.25
2026-11-06,11495,74,22,5.05""".split('\n')]

def day(wd, name, heavy, speed, support, logic, extra=None):
    spec = {'heavy': heavy, 'speed': speed, 'support': support, 'logic': logic,
            'order': ['speed', 'heavy', 'support'], 'support_logging': 'start weight + reps at start only'}
    if extra: spec.update(extra)
    return (wd, name, spec)

SPEED_BENCH = {'lift': 'bench', 'items': [
    {'name': 'Smith throw', 'sets': 8, 'rule': 'Up to 7 reps; a rep counts only if the bar hits the bell (38 in); set ends at first miss', 'load_lb': 70},
    {'name': 'Banded bench', 'sets': 8, 'reps': 3, 'rule': 'Light 22 lb bar, bands doubled, anchor 19 in below safeties; stop when the top slows',
     'band': 'Blue (test)', 'bands_per_side': 1}]}
SPEED_SQUAT = {'lift': 'squat', 'items': [
    {'name': 'Squat jump, band resisted', 'sets': 5, 'reps': 5, 'rule': 'Alternate with assisted (contrast pair)'},
    {'name': 'Squat jump, band assisted', 'sets': 5, 'reps': 5}]}
templates = [
    day(1, 'Mon: heavy squat + speed bench + quads', {'lift': 'squat', 'ladder': True, 'target_reps': 15}, SPEED_BENCH,
        {'group': 'Quads', 'items': [{'name': 'Leg extension', 'scheme': 'RTR', 'start_lb': 200, 'step_lb': 10, 'drops': 16},
                                     {'name': 'Strap lean-back squat', 'scheme': 'F + DS×2', 'drops': 2}]},
        'Very intense quad work builds the knee drive the deadlift goal needs. Two exercises is a full day after the ladder.'),
    day(2, 'Tue: heavy bench + speed squat + back', {'lift': 'bench', 'ladder': True, 'target_reps': 5}, SPEED_SQUAT,
        {'group': 'Back', 'items': [{'name': 'Barbell row', 'scheme': '15 to TF + ST×2', 'drops': 2},
                                    {'name': 'Pull-up', 'scheme': 'F + RP×2 (15 s)', 'drops': 2},
                                    {'name': 'Lat pulldown', 'scheme': 'F + DS×2', 'drops': 2},
                                    {'name': 'Curl', 'scheme': 'F + DS×2', 'drops': 2}]},
        'Main back day on a lighter bench day; four days before deadlift.'),
    day(3, 'Wed: heavy squat + speed bench + glutes & hamstrings', {'lift': 'squat', 'ladder': True, 'target_reps': 15}, SPEED_BENCH,
        {'group': 'Glutes & hamstrings', 'items': [{'name': 'Reverse hyperextension (machine)', 'scheme': 'F + DS×2', 'drops': 2},
                                                  {'name': 'Leg curl', 'scheme': 'RTR', 'start_lb': 80, 'step_lb': 10, 'drops': 4},
                                                  {'name': 'GHD glute-ham raise', 'scheme': 'F + DS×2', 'drops': 2},
                                                  {'name': 'Flywheel harness jump squat', 'scheme': '1×F', 'note': 'eccentric overload, end of session'}]},
        'Hip extension and knee flexion squats miss; three days before deadlift.'),
    day(4, 'Thu: heavy bench + speed squat + triceps', {'lift': 'bench', 'ladder': True, 'target_reps': 5}, SPEED_SQUAT,
        {'group': 'Triceps', 'items': [{'name': 'Weighted dip', 'scheme': 'F + DS×2', 'step_lb': 10, 'drops': 2},
                                       {'name': 'JM press (Smith)', 'scheme': 'RTR', 'step_lb': 10, 'drops': 7},
                                       {'name': 'Overhead triceps extension', 'scheme': 'RTR', 'step_lb': 10},
                                       {'name': 'Chest-supported row', 'scheme': '15 to TF + ST×2', 'drops': 2}]},
        'Lockout strength with the most recovery before Sunday; second row 48 h after Tuesday.'),
    day(5, 'Fri: heavy squat + speed bench + chest', {'lift': 'squat', 'ladder': True, 'target_reps': 15}, SPEED_BENCH,
        {'group': 'Chest', 'items': [{'name': 'Incline DB press', 'scheme': 'RTR', 'step_lb': 5, 'drops': 7},
                                     {'name': 'Smith sliding-handle press', 'scheme': 'F + DS×2', 'drops': 2},
                                     {'name': 'Dumbbell fly', 'scheme': 'F + DS×2', 'drops': 2}]},
        'Stretch, squeeze and upper chest 48 h before Sunday; no back or hinge work before deadlift.'),
    day(6, 'Sat: deadlift cycle + traps', {'lift': 'deadlift', 'cycle': 'deadlift_6wk'}, None,
        {'group': 'Traps', 'items': [{'name': 'Shrugs', 'scheme': 'F + DS×2', 'drops': 2},
                                     {'name': 'Flywheel harness jump squat', 'scheme': '1×F'}]},
        'Only deadlift day; top single first. Shrugs finish the traps with a week to recover.',
        {'deadlift_cycle': [
            {'week': 1, 'pull': 'Trap bar, 14 in handles, stand on 4 in block, straps', 'top': 'RPE 8', 'backoff': '3×3 @ 55% on 8 in block', 'flywheel_sets': 4},
            {'week': 2, 'pull': 'Trap bar, same setup', 'top': 'RPE 9, beat week 1', 'backoff': '3×3 @ 60%', 'flywheel_sets': 4},
            {'week': 3, 'pull': 'Conventional deficit (stand on a 45)', 'top': 'RPE 8', 'backoff': '3×1 @ 90%', 'flywheel_sets': 4},
            {'week': 4, 'pull': 'Conventional paused 2 in off floor', 'top': 'RPE 8-9', 'backoff': '3×1 @ 90%', 'flywheel_sets': 3},
            {'week': 5, 'pull': 'Conventional, position practice', 'top': 'singles @ 85% of best', 'backoff': None, 'flywheel_sets': 2},
            {'week': 6, 'pull': 'MAX: straight conventional', 'top': 'opener 92%, 2nd 97%, 3rd PR', 'backoff': None, 'flywheel_sets': 0}]}),
    day(0, 'Sun: heavy bench + speed squat + shoulders', {'lift': 'bench', 'ladder': True, 'target_reps': 5}, SPEED_SQUAT,
        {'group': 'Shoulders', 'items': [{'name': 'Smith sliding-handle overhead press', 'scheme': 'F + DS×2', 'drops': 2},
                                         {'name': 'DB lateral raise', 'scheme': 'RTR', 'step_lb': 5, 'drops': 4},
                                         {'name': 'Flywheel lateral raise', 'scheme': 'F + DS×2', 'drops': 2},
                                         {'name': 'Rear-delt fly (DB + lateral band)', 'scheme': 'F + DS×2', 'drops': 2}]},
        'Front, side and rear delts after a day with no pressing; Monday bench is speed only.'),
]

out = ['-- generated by scripts/reference_data.py', 'begin;']
out.append('insert into public.lifters (name, bodyweight_lb, settings) values\n' + ',\n'.join(
    f'  ({q(n)}, {q(bw)}, {jq(s)})' for n, bw, s in lifters) + '\non conflict (name) do update set settings = excluded.settings;')
eq = [(k, n, w, p, note, True) for k, n, w, p, note in equipment]
eq += [('band', f'Rogue band {n}', None, {'rogue_number': num, 'rogue_rating_lb_at_100pct': r, 'one_band_lockout_lb': lb,
         'setup': 'doubled over, 19 in anchor gap, 18 in stretch'}, f'UNVERIFIED: {note}; re-test with the crane scale', False)
       for n, num, r, lb, note in bands]
out.append('insert into public.equipment (kind, name, weight_lb, props, notes, verified) values\n' + ',\n'.join(
    f'  ({q(k)}, {q(n)}, {q(w)}, {jq(p)}, {q(note)}, {str(v).lower()})' for k, n, w, p, note, v in eq) +
    '\non conflict (name) do update set props = excluded.props, notes = excluded.notes, verified = excluded.verified, weight_lb = excluded.weight_lb;')
out.append('insert into public.garmin_daily (lifter_id, day, steps, resting_hr, hrv_ms, sleep_h)\nselect l.id, v.d::date, v.st::int, v.rhr::numeric, v.hrv::numeric, v.sl::numeric from public.lifters l cross join (values\n' +
           ',\n'.join(f"  ({q(d)}, {s}, {r}, {h}, {sl})" for d, s, r, h, sl in garmin) +
           ") as v(d, st, rhr, hrv, sl) where l.name = 'Beau'\non conflict (lifter_id, day) do update set steps = excluded.steps, resting_hr = excluded.resting_hr, hrv_ms = excluded.hrv_ms, sleep_h = excluded.sleep_h;")
names = {it['name'] for _, _, s in templates for blk in ('speed', 'support') if s.get(blk) for it in s[blk]['items']}
out.append('insert into public.exercises (name, category) values\n' + ',\n'.join(f"  ({q(n)}, 'support')" for n in sorted(names)) + '\non conflict (name) do nothing;')
out.append("update public.exercises set category = 'speed' where name in ('Smith throw','Banded bench','Squat jump, band resisted','Squat jump, band assisted');")
out.append('delete from public.day_templates where lifter_id is null and version = 1;')
out.append('insert into public.day_templates (lifter_id, weekday, name, version, active_from, spec) values\n' + ',\n'.join(
    f"  (null, {wd}, {q(n)}, 1, '2026-11-09', {jq(s)})" for wd, n, s in templates) + ';')
out.append('commit;')
print('\n'.join(out))
