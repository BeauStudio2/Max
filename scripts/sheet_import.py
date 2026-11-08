"""Build SQL that loads the Google Sheet history into the Max database.

Input: JSON grids (tab name -> list of rows of formatted cell strings) exported from the
Beau-Max and Mallen-Max sheets, plus Config and Garmin values. Output: one SQL file.
Only facts are imported (loads, reps, flags, notes); estimates are recomputed by the database.
"""
import json, re, sys
from datetime import datetime

def q(v):
    if v is None or v == '':
        return 'null'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"

def num(s):
    if s is None: return None
    s = str(s).replace(',', '').replace('%', '').strip()
    try: return float(s)
    except ValueError: return None

def boolv(s): return str(s).strip().upper() == 'TRUE'

def jq(d): return q(json.dumps(d, ensure_ascii=False)) + '::jsonb'

def label_map(rows):
    m = {}
    for r in rows:
        if r and r[0] and r[0] not in m:
            m[r[0]] = r[1] if len(r) > 1 else ''
    return m

SUPPORT_TITLES = {'LEG ACCESSORIES', 'UPPER PULLS', 'PRESSING ACCESSORIES'}

def parse_tab(tab, rows):
    lab = label_map(rows)
    out = {'tab': tab, 'sets': [], 'support': [], 'speed': []}
    # ladder
    hdr = next((i for i, r in enumerate(rows) if len(r) > 11 and r[1] == 'weight' and r[9] == 'reps'), None)
    lift = None
    if hdr is not None:
        name = rows[hdr][0]
        lift = 'squat' if name == 'Squat' else 'bench'
        i = hdr + 1
        while i < len(rows) and rows[i] and rows[i][0].startswith('set '):
            r = rows[i] + [''] * 20
            if r[9] != '':
                clamp = r[2]
                out['sets'].append(dict(
                    idx=int(r[0].split()[1]), weight=num(r[1]), bottom=num(r[7]), top=num(r[8]),
                    reps=int(num(r[9])), assisted=boolv(r[10]), failed=boolv(r[11]),
                    setup={'clamp': ('Eleiko' if clamp == 'TRUE' else clamp) or None,
                           'chain_half': num(r[3]), 'chain_5_8': num(r[4])}))
            i += 1
    # support blocks
    i = 0
    while i < len(rows):
        a = rows[i][0] if rows[i] else ''
        if a in SUPPORT_TITLES or a.endswith('(support)'):
            group = a.replace(' (support)', '')
            j = i + 1
            while j < len(rows) and rows[j] and rows[j][0]:
                r = rows[j] + [''] * 10
                if not r[0].startswith('Key:') and r[0] != 'exercise':
                    reps = num(r[5])
                    if r[2] or r[5]:  # logged: a start weight or reps (notes alone are plan text)
                        out['support'].append(dict(group=group, name=r[0], scheme=r[1], start=num(r[2]),
                                                   step=num(r[3]), drops=num(r[4]),
                                                   reps=int(reps) if reps is not None else None,
                                                   notes=r[7] or None))
                j += 1
            i = j
        else:
            i += 1
    # speed blocks: a description row, then a 'set' header row, then 'set NN' rows
    for i, r in enumerate(rows):
        a = r[0] if r else ''
        kind = None
        if a.startswith('Smith throws'): kind = 'Smith throw'
        elif a.startswith('Banded bench'): kind = 'Banded bench'
        if not kind or i + 1 >= len(rows) or not rows[i + 1] or rows[i + 1][0] != 'set':
            continue
        head = rows[i + 1]
        j = i + 2
        while j < len(rows) and rows[j] and rows[j][0].startswith('set '):
            rr = rows[j] + [''] * len(head)
            vals = {head[k]: rr[k] for k in range(1, len(head)) if head[k] and rr[k] != ''}
            band = vals.get('band (Rogue color)') or vals.get('band')
            logged = num(vals.get('bell reps (of 7)') or vals.get('reps')) is not None and (kind != 'Banded bench' or band)
            if vals and logged:  # a prefilled target rep count with no band is a plan, not a log
                load = num(vals.get('load (lb)'))
                reps = num(vals.get('bell reps (of 7)') or vals.get('reps'))
                out['speed'].append(dict(kind=kind, idx=int(rr[0].split()[1]), weight=load,
                                         reps=int(reps) if reps is not None else None, setup=vals))
            j += 1
    hurt = lab.get('hurt (describe what/where; blank = not hurt)', '') or None
    sick = boolv(lab.get('sick (check if sick)', 'FALSE'))
    if 'hurt / sick (exclude from projections)' in lab and boolv(lab['hurt / sick (exclude from projections)']) and not hurt and not sick:
        hurt = 'flagged hurt/sick in the sheet (not split)'
    planned = {k2: num(lab.get(k1)) for k1, k2 in [
        ('planned e1RM', 'planned_e1rm'), ('fatigue rate used', 'fatigue_rate_used_pct'),
        ('stop below % of set 1 e1RM', 'stop_pct')] if num(lab.get(k1)) is not None}
    extra = {k2: lab.get(k1) for k1, k2 in [
        ('workout start time', 'start_time_text'), ('workout end time', 'end_time_text'),
        ('fatigue rate (fit)', 'sheet_fatigue_fit'), ('fitted fresh strength (sets 1-10)', 'sheet_fitted_fresh')]
        if lab.get(k1)}
    extra['sheet_tab'] = tab
    out.update(lift=lift, date=datetime.strptime(lab.get('date') or tab, '%m/%d/%y').date().isoformat(),
               sick=sick, hurt=hurt, notes=lab.get('notes') or None,
               bodyweight=num(lab.get('bodyweight (lb)')), planned=planned, extra=extra)
    return out

def session_sql(lifter, s):
    lift = s['lift'] or 'bench'
    lines = [f"with s as (insert into public.sessions (lifter_id, session_date, primary_lift, sick, hurt, bodyweight_lb, planned, notes, source, extra)",
             f"  select id, {q(s['date'])}, {q(lift)}, {str(s['sick']).lower()}, {q(s['hurt'])}, {q(s['bodyweight'])}, {jq(s['planned'])}, {q(s['notes'])}, 'sheet_import', {jq(s['extra'])}",
             f"  from public.lifters where name = {q(lifter)}",
             f"  on conflict (lifter_id, session_date, primary_lift) do update set sick = excluded.sick, hurt = excluded.hurt, notes = excluded.notes, planned = excluded.planned, extra = excluded.extra",
             "  returning id)"]
    vals = []
    ex_primary = 'Bench Press' if lift == 'bench' else 'Squat'
    for t in s['sets']:
        vals.append(f"({q(ex_primary)}, 'primary', {t['idx']}, {q(t['weight'])}, {q(t['bottom'])}, {q(t['top'])}, {t['reps']}, {str(t['assisted']).lower()}, {str(t['failed']).lower()}, null, null, null, null, {jq({k: v for k, v in t['setup'].items() if v is not None})}, null)")
    for n, t in enumerate(s['support'], 1):
        vals.append(f"({q(t['name'])}, 'support', 1, null, null, null, {q(t['reps'])}, false, false, {q(t['scheme'])}, {q(t['start'])}, {q(t['step'])}, {q(int(t['drops']) if t['drops'] is not None else None)}, {jq({'group': t['group']})}, {q(t['notes'])})")
    for t in s['speed']:
        vals.append(f"({q(t['kind'])}, 'speed', {t['idx']}, {q(t['weight'])}, null, null, {q(t['reps'])}, false, false, null, null, null, null, {jq(t['setup'])}, null)")
    if not vals:
        return '\n'.join(lines) + '\nselect 1 from s;\n'
    lines.append("insert into public.sets (session_id, exercise_id, block, set_index, weight_lb, total_bottom_lb, total_top_lb, reps, assisted, failed, scheme, start_weight_lb, step_lb, drops, setup, notes)")
    lines.append("select s.id, e.id, v.block, v.idx::int, v.w::numeric, v.b::numeric, v.t::numeric, v.r::int, v.a::boolean, v.f::boolean, v.sc::text, v.sw::numeric, v.st::numeric, v.dr::int, v.su::jsonb, v.n::text from s cross join (values")
    lines.append(',\n'.join('  ' + v for v in vals))
    lines.append(") as v(ex, block, idx, w, b, t, r, a, f, sc, sw, st, dr, su, n) join public.exercises e on e.name = v.ex")
    lines.append("on conflict (session_id, block, exercise_id, set_index) do nothing;")
    return '\n'.join(lines) + '\n'

if __name__ == '__main__':
    beau = json.load(open(sys.argv[1])); mallen = json.load(open(sys.argv[2]))
    sessions = [('Beau', parse_tab(t, r)) for t, r in beau.items()]
    sessions += [('Mallen', parse_tab(t, r)) for t, r in mallen.items()]
    keep = [(l, s) for l, s in sessions if s['sets'] or s['support'] or s['speed'] or s['sick'] or s['hurt']]
    ex = {('Bench Press', 'primary', 'chest'), ('Squat', 'primary', 'legs'), ('Deadlift', 'deadlift', 'posterior chain'),
          ('Smith throw', 'speed', 'chest'), ('Banded bench', 'speed', 'chest')}
    for _, s in keep:
        for t in s['support']:
            ex.add((t['name'], 'support', t['group'].lower()))
    sql = ["-- generated by scripts/sheet_import.py", "begin;"]
    sql.append("insert into public.exercises (name, category, muscle_group) values\n" +
               ',\n'.join(f"  ({q(n)}, {q(c)}, {q(g)})" for n, c, g in sorted(ex)) + "\non conflict (name) do nothing;")
    for l, s in keep:
        sql.append(f"-- {l} {s['tab']} ({len(s['sets'])} ladder sets, {len(s['support'])} support, {len(s['speed'])} speed)")
        sql.append(session_sql(l, s))
    sql.append("commit;")
    print('\n'.join(sql))
    print(f"-- sessions: {len(keep)}", file=sys.stderr)
