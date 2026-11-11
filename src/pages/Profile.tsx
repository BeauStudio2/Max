import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useStore } from '../lib/store'
import { BandEditor, CellText, type BandPick } from './today/Sheet'
import { DelBtn, T } from './today/shared'
import { BELIEFS, beliefDef, blend, pendingShift, probeBudget, type Belief, type LearnEntry } from '../lib/learn'
import { crOf, fmtCr, LEARN_RATE, type CrLogEntry } from '../lib/creatine'
import { e1rmFromRpe, fitFatigue, localDate, round } from '../lib/load'
import Tracker, { onBar, type TrackRow, type TLift } from './profile/Tracker'

interface Metric { metric: string; label: string; unit: string; grp: string; sort: number; derived: boolean }
interface Point { d: string; v: number; x?: boolean; id?: string; src?: string }

const DAY = 86400000

export default function Profile({ lifterId, onPick }: { lifterId: string; onPick?: (id: string) => void }) {
  const { lifters, exercises, equipment, isCoach, reload: reloadStore } = useStore()
  const [newName, setNewName] = useState<string | null>(null)
  async function addProfile() {
    const name = (newName ?? '').trim()
    if (!name) return
    if (lifters.some(l => l.name.toLowerCase() === name.toLowerCase())) { setErr(`There is already a profile called ${name}.`); return }
    const { data, error } = await supabase.from('lifters').insert({ name }).select('id').single()
    if (error) { setErr(error.message); return }
    setErr(null); setNewName(null); await reloadStore(); if (data?.id) onPick?.(data.id)
  }
  const lifter = lifters.find(l => l.id === lifterId)
  const [catalog, setCatalog] = useState<Metric[]>([])
  const [series, setSeries] = useState<Record<string, Point[]>>({})
  const [track, setTrack] = useState<TrackRow[]>([])
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setErr(null)
    const [cat, bm, ss, gd] = await Promise.all([
      supabase.from('metric_catalog').select('*').order('sort'),
      supabase.from('body_metrics').select('*').eq('lifter_id', lifterId).order('measured_on'),
      supabase.from('sessions').select('id, session_date, primary_lift, sick, hurt, exclude_reason, bodyweight_lb, planned, notes').eq('lifter_id', lifterId).order('session_date'),
      supabase.from('garmin_daily').select('*').eq('lifter_id', lifterId).order('day'),
    ])
    const e = [cat, bm, ss, gd].find(r => r.error)?.error
    if (e) { setErr(e.message); return }
    const sessions = ss.data ?? []
    const ids = sessions.map(s => s.id)
    const est = ids.length
      ? (await supabase.from('set_estimates').select('session_id, exercise_id, block, set_index, weight_lb, reps, rpe, e1rm_lb, effective_load_lb, assisted, failed, setup').in('session_id', ids).in('block', ['primary', 'deadlift']).order('set_index')).data ?? []
      : []

    const out: Record<string, Point[]> = {}
    const trows: TrackRow[] = []
    const assistLb = 7.5
    // Volume as on the sheet: load × reps, an assisted rep at the load less the assist, a failed rep nothing.
    const volOf = (r: any) => {
      const load = Number(r.effective_load_lb ?? r.weight_lb ?? 0), reps = r.reps ?? 0
      const helped = r.assisted && !r.failed ? 1 : 0, lost = r.failed ? 1 : 0
      return load * Math.max(0, reps - lost - helped) + Math.max(0, load - assistLb) * helped
    }
    const push = (k: string, p: Point) => (out[k] ??= []).push(p)
    // Entered values (bodyweight, measurements, skinfolds, energy test results). Fatigue and maxes are worked out from sessions below.
    for (const r of bm.data ?? []) if (!/^(fatigue|e1rm)_/.test(r.metric)) push(r.metric, { d: r.measured_on, v: Number(r.value), id: r.id, src: r.source })
    for (const s of sessions) {
      const x = !!s.sick || !!s.hurt?.trim() || !!s.exclude_reason?.trim()
      const mine = est.filter(r => r.session_id === s.id)
      if (s.bodyweight_lb && !(out.bodyweight ?? []).some(p => p.d === s.session_date)) push('bodyweight', { d: s.session_date, v: Number(s.bodyweight_lb), src: 'session' })
      if (s.primary_lift === 'deadlift') {
        const dlId = exercises.find(e => e.name === 'Deadlift')?.id
        const tops = mine.filter(r => String(r.setup?.step ?? '').startsWith('top') && r.weight_lb && r.reps && (!dlId || r.exercise_id === dlId))
        const best = tops.map(r => e1rmFromRpe(Number(r.weight_lb), r.reps, r.rpe === null ? null : Number(r.rpe))).sort((a, b) => b - a)[0]
        if (best) push('e1rm_deadlift', { d: s.session_date, v: best, x })
        const top = tops.sort((a, b) => Number(b.weight_lb) - Number(a.weight_lb))[0]
        const pulls = mine.filter(r => r.block === 'deadlift' && r.weight_lb && r.reps)
        trows.push({ id: s.id, notes: s.notes, excludeReason: s.exclude_reason?.trim() || null, d: s.session_date, lift: 'deadlift', variant: s.planned?.heavy_exercise ?? null, set1: top ? Number(top.weight_lb) : null, set1Reps: top?.reps ?? null, rpe: top?.rpe ?? null,
          est: best ?? null, planned: s.planned?.planned_top_lb ?? null, fatigueUsed: null, fatigueFit: null, sets: pulls.length,
          volume: pulls.reduce((t, r) => t + Number(r.weight_lb) * (r.reps ?? 0), 0), sick: !!s.sick, hurt: s.hurt?.trim() || null, excluded: x })
        continue
      }
      const lift = s.primary_lift
      // Only the lift's own exercise counts toward its max and fatigue; substitutes keep their own history.
      const mainId = exercises.find(e => e.name === (lift === 'bench' ? 'Bench Press' : 'Squat'))?.id
      const prim = mine.filter(r => r.block === 'primary' && (!mainId || r.exercise_id === mainId)).map(r => (r.e1rm_lb === null ? null : Number(r.e1rm_lb)))
      if (prim[0]) push(`e1rm_${lift}`, { d: s.session_date, v: prim[0], x })
      const fit = fitFatigue(prim)
      if (fit && fit.ratePct > 0) push(`fatigue_${lift}`, { d: s.session_date, v: fit.ratePct, x })
      if (lift === 'bench' || lift === 'squat') {
        const main = mine.filter(r => r.block === 'primary' && (!mainId || r.exercise_id === mainId))
        const first = main[0]
        trows.push({ id: s.id, notes: s.notes, excludeReason: s.exclude_reason?.trim() || null, d: s.session_date, lift, variant: s.planned?.heavy_exercise && s.planned.heavy_exercise !== (lift === 'bench' ? 'Bench Press' : 'Squat') ? s.planned.heavy_exercise : null,
          set1: first ? onBar(first, equipment) : null, set1Reps: first?.reps ?? null, rpe: null,
          est: prim[0] ?? null, planned: s.planned?.planned_e1rm ?? null, fatigueUsed: s.planned?.fatigue_rate_used_pct ?? null,
          fatigueFit: fit && fit.ratePct > 0 ? fit.ratePct : null, sets: main.filter(r => r.reps !== null).length,
          volume: main.reduce((t, r) => t + volOf(r), 0), sick: !!s.sick, hurt: s.hurt?.trim() || null, excluded: x })
      }
    }
    for (const g of gd.data ?? []) {
      if (g.resting_hr) push('resting_hr', { d: g.day, v: Number(g.resting_hr) })
      if (g.hrv_ms) push('hrv', { d: g.day, v: Number(g.hrv_ms) })
      if (g.sleep_h) push('sleep_h', { d: g.day, v: Number(g.sleep_h) })
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.d.localeCompare(b.d))
    setCatalog((cat.data as Metric[]) ?? [])
    setSeries(out)
    setTrack(trows)
  }
  useEffect(() => { if (lifterId) load() }, [lifterId])

  const metric = (k: string) => catalog.find(m => m.metric === k)
  const listFor = (grp: string) => catalog.filter(m => m.grp === grp && !m.derived && (series[m.metric]?.length ?? 0) > 0)
  const recovery = catalog.filter(m => m.grp === 'Recovery' && (series[m.metric]?.length ?? 0) > 0)
  const energy = catalog.filter(m => m.grp === 'Energy system' && (series[m.metric]?.length ?? 0) > 0)
  const valid = (k: string) => current(series[k] ?? [])
  const st = lifter?.settings ?? {}
  const dlEst = valid('e1rm_deadlift')

  return (
    <div className="stack profile2">
      <section className="card phead">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{lifter?.name ?? 'Profile'}</h2>
          <div className="row" style={{ gap: 8 }}>
            {isCoach && newName === null && <button className="ghost inline" onClick={() => setNewName('')} data-tip="Add another person to train. They start with the default plan and settings; link their sign-in under Config." data-pos="left">+ Add profile</button>}
            <button className="primary inline" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add measurements'}</button>
          </div>
        </div>
        {newName !== null && (
          <form className="row newprofile" style={{ gap: 8, marginTop: 8 }} onSubmit={e => { e.preventDefault(); addProfile() }}>
            <input autoFocus placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} />
            <button className="primary inline" type="submit" disabled={!newName.trim()}>Add</button>
            <button className="ghost inline" type="button" onClick={() => setNewName(null)}>Cancel</button>
          </form>
        )}
        <div className="keystats">
          <Stat label="Bench" value={valid('e1rm_bench')?.v ?? st.planned_e1rm?.bench} note={valid('e1rm_bench') ? 'est. max' : 'planned'} />
          <Stat label="Squat" value={valid('e1rm_squat')?.v ?? st.planned_e1rm?.squat} note={valid('e1rm_squat') ? 'est. max' : 'planned'} />
          <Stat label="Deadlift" value={dlEst?.v ?? st.deadlift_best_conventional_lb} note={dlEst ? 'est. max' : 'best'} />
          <Stat label="Bodyweight" value={valid('bodyweight')?.v ?? lifter?.bodyweight_lb} unit="lb" />
          <Stat label="Body fat" value={valid('body_fat_pct')?.v} unit="%" dp={1} />
        </div>
        {adding && <AddForm lifterId={lifterId} catalog={catalog.filter(m => !m.derived)} onSaved={() => { setAdding(false); load() }} />}
      </section>
      {err && <p className="err">{err}</p>}

      <Tracker rows={track} rhr={series.resting_hr ?? []} hrv={series.hrv ?? []} sleep={series.sleep_h ?? []} bodyweight={series.bodyweight ?? []}
        fallback={{ bench: { planned: st.planned_e1rm?.bench }, squat: { planned: st.planned_e1rm?.squat }, deadlift: { planned: st.deadlift_planned_top_lb, best: st.deadlift_best_conventional_lb } }} />

      <section className="card">
        <h2>Strength</h2>
        <div className="lifts">
          {(['bench', 'squat', 'deadlift'] as const).map(lift => (
            <LiftCard key={lift} lift={lift} lifterId={lifterId} series={series} metric={metric} reload={load} />
          ))}
        </div>
      </section>

      <Learning lifterId={lifterId} />
      <CreatineModel lifterId={lifterId} />
      <SpeedBands lifterId={lifterId} />

      <MetricSection title="Body" items={catalog.filter(m => m.grp === 'Body' && !m.derived)} series={series} lifterId={lifterId} reload={load}
        empty="Tap + Add measurements to log bodyweight and body fat." />
      {listFor('Measurements').length > 0 && <MetricSection title="Measurements" items={listFor('Measurements')} series={series} lifterId={lifterId} reload={load} />}
      {listFor('Skinfolds').length > 0 && <MetricSection title="Skinfolds" items={listFor('Skinfolds')} series={series} lifterId={lifterId} reload={load} />}
      {recovery.length > 0 && <MetricSection title="Recovery" items={recovery} series={series} lifterId={lifterId} reload={load} />}
      {energy.length > 0 && <MetricSection title="Energy system" items={energy} series={series} lifterId={lifterId} reload={load} />}
    </div>
  )
}

function Stat({ label, value, unit = 'lb', note, dp = 0 }: { label: string; value?: number | null; unit?: string; note?: string; dp?: number }) {
  return (
    <div className="stat">
      <span className="small muted">{label}</span>
      <b>{value != null ? round(Number(value), dp) : '—'}<small> {value != null ? unit : ''}</small></b>
      {note && value != null && <span className="sub2">{note}</span>}
    </div>
  )
}

/** One card per lift: its trend, its fatigue, and its settings, all in one place. */
function LiftCard({ lift, lifterId, series, metric, reload }: {
  lift: 'bench' | 'squat' | 'deadlift'; lifterId: string; series: Record<string, Point[]>; metric: (k: string) => Metric | undefined; reload: () => void
}) {
  const { lifters, isCoach, reload: reloadStore } = useStore()
  const l = lifters.find(x => x.id === lifterId)
  const [view, setView] = useState<'none' | 'history' | 'settings'>('none')
  const pts = series[`e1rm_${lift}`] ?? []
  const fat = series[`fatigue_${lift}`] ?? []
  const cur = current(pts), curF = current(fat)
  const good = pts.filter(p => !p.x)
  const best = good.reduce((m, p) => Math.max(m, p.v), 0)
  const healthyF = fat.filter(p => !p.x)
  const baseF = healthyF.length ? healthyF.reduce((t, p) => t + p.v, 0) / healthyF.length : null
  const tr = trend(pts)
  const st = l?.settings ?? {}

  async function save(path: string, raw: string) {
    if (!l) return
    const v = raw.trim() === '' ? null : Number(raw)
    const keys = path.split('.')
    const next = structuredClone(st)
    let c: any = next
    for (const k of keys.slice(0, -1)) c = c[k] = typeof c[k] === 'object' && c[k] ? c[k] : {}
    if (v === null) delete c[keys.at(-1)!]; else c[keys.at(-1)!] = v
    const { error } = await supabase.from('lifters').update({ settings: next }).eq('id', l.id)
    if (error) alert(error.message); else reloadStore()
  }
  const field = (label: string, path: string) => {
    const v = path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), st)
    return (
      <label key={path}>{label}
        {isCoach ? <CellText value={v == null ? '' : String(v)} narrow numeric onSave={x => save(path, x)} /> : <span className="roval">{v ?? '—'}</span>}
      </label>
    )
  }
  const fields = lift === 'deadlift'
    ? [field('Best conventional (lb)', 'deadlift_best_conventional_lb'), field('Week-1 top single (lb)', 'deadlift_planned_top_lb')]
    : [field('Planned max', `planned_e1rm.${lift}`),
       field('Fatigue %/rep', `fatigue_rep_pct.${lift}`), field('Range of motion (in)', `chain_geometry.${lift}.rom_in`), field('Leader-line hang (in, blank = none)', `chain_geometry.${lift}.hang_in`)]

  return (
    <div className="liftcard">
      <div className="lifthead">
        <h3 className="cap">{lift}</h3>
        <Spark pts={pts} />
      </div>
      <div className="liftnums">
        <div><span className="small muted">Est. max</span><b>{cur ? round(cur.v) : '—'}</b>{cur && <span className="sub2">{fmtDate(cur.d)}</span>}</div>
        <div><span className="small muted">Best</span><b>{best ? round(best) : '—'}</b></div>
        <div><span className="small muted">Trend</span><b className={tr ? (tr.perWeek >= 0 ? 'up' : 'down') : ''}>{tr ? `${tr.perWeek >= 0 ? '+' : ''}${round(tr.perWeek, 1)}` : '—'}</b>{tr && <span className="sub2">lb / week</span>}</div>
        {lift !== 'deadlift' && <div><span className="small muted">Fatigue</span><b>{curF ? `${curF.v.toFixed(1)}%` : '—'}</b>{baseF !== null && <span className="sub2">healthy avg {baseF.toFixed(1)}%</span>}</div>}
      </div>
      <div className="seg small">
        <button className={view === 'history' ? 'on' : ''} onClick={() => setView(view === 'history' ? 'none' : 'history')}>History</button>
        <button className={view === 'settings' ? 'on' : ''} onClick={() => setView(view === 'settings' ? 'none' : 'settings')}>Settings</button>
      </div>
      {view === 'history' && metric(`e1rm_${lift}`) && <Detail m={metric(`e1rm_${lift}`)!} pts={pts} lifterId={lifterId} onChange={reload} />}
      {view === 'history' && lift !== 'deadlift' && fat.length > 1 && metric(`fatigue_${lift}`) && <Detail m={metric(`fatigue_${lift}`)!} pts={fat} lifterId={lifterId} onChange={reload} />}
      {view === 'settings' && (
        <div className="liftsettings">
          <div className="planfields">{fields}</div>
          <p className="small muted">This lifter's starting values. After a session, the next one carries its results forward. Reps, stop %, rest and chains are set on the Plan page.{isCoach ? '' : ' The coach edits these.'}</p>
        </div>
      )}
    </div>
  )
}

function RestField({ lifterId }: { lifterId: string }) {
  const { lifters, isCoach, reload } = useStore()
  const l = lifters.find(x => x.id === lifterId)
  if (!l) return null
  return (
    <p className="small restline">Rest between heavy sets:{' '}
      {isCoach ? <CellText value={l.settings?.rest_s == null ? '' : String(l.settings.rest_s)} narrow numeric
        onSave={async v => { await supabase.from('lifters').update({ settings: { ...l.settings, rest_s: v === '' ? undefined : Number(v) } }).eq('id', l.id); reload() }} />
        : <b>{l.settings?.rest_s ?? 100}</b>} s
    </p>
  )
}

/** A list of measures: current value, change, date and a small trend line per row; tap a row for its chart and history. */
function MetricSection({ title, items, series, lifterId, reload, empty }: {
  title: string; items: Metric[]; series: Record<string, Point[]>; lifterId: string; reload: () => void; empty?: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  const any = items.some(m => (series[m.metric]?.length ?? 0) > 0)
  return (
    <section className="card">
      <h2>{title}</h2>
      {!any && empty && <p className="small muted">{empty}</p>}
      <ul className="mlist">
        {items.map(m => {
          const pts = series[m.metric] ?? []
          const c = current(pts)
          const valid = pts.filter(p => !p.x)
          const prev = valid.length > 1 ? valid[valid.length - 2] : null
          const delta = c && prev ? c.v - prev.v : null
          const dp = m.unit === 'lb' || m.unit === 'bpm' || m.unit === 'ms' ? 0 : m.unit === '%/set' ? 2 : 1
          const isOpen = open === m.metric
          return (
            <li key={m.metric}>
              <button className={'mrow' + (isOpen ? ' on' : '')} onClick={() => setOpen(isOpen ? null : m.metric)}>
                <span className="mlabel">{m.label}</span>
                <span className="mval">{c ? <>{round(c.v, dp)} <small className="muted">{m.unit}</small></> : <span className="muted">—</span>}</span>
                <span className={'mdelta ' + (delta ? (delta > 0 ? 'up' : 'down') : '')}>{delta ? `${delta > 0 ? '+' : ''}${round(delta, dp)}` : ''}</span>
                <span className="mdate small muted">{c ? fmtDate(c.d) : ''}</span>
                <Spark pts={pts} />
                <span className="muted small">{isOpen ? '▴' : '▾'}</span>
              </button>
              {isOpen && <Detail m={m} pts={pts} lifterId={lifterId} onChange={reload} />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const fmtDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

function Spark({ pts }: { pts: Point[] }) {
  const v = pts.filter(p => !p.x).slice(-12)
  if (v.length < 2) return <span className="spark" />
  const W = 72, H = 22
  const lo = Math.min(...v.map(p => p.v)), hi = Math.max(...v.map(p => p.v))
  const path = v.map((p, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - ((p.v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join('')
  return <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true"><path d={path} /></svg>
}

function current(pts: Point[]) {
  const valid = pts.filter(p => !p.x)
  return valid.at(-1) ?? pts.at(-1) ?? null
}

/** Straight-line fit over the most recent valid points, for the projection. */
function trend(pts: Point[]) {
  const v = pts.filter(p => !p.x).slice(-8)
  // Needs three points spread over at least a week, or a couple of close days make a wild slope.
  if (v.length < 3 || Date.parse(v.at(-1)!.d) - Date.parse(v[0].d) < 7 * DAY) return null
  const xs = v.map(p => Date.parse(p.d) / DAY), ys = v.map(p => p.v)
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  if (!den) return null
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den
  return { at: (day: number) => my + b * (day - mx), perWeek: b * 7, from: xs[0] }
}

function Detail({ m, pts, lifterId, onChange }: { m: Metric; pts: Point[]; lifterId: string; onChange: () => void }) {
  const tr = trend(pts)
  const today = Date.parse(localDate()) / DAY
  const dp = m.unit === '%/set' ? 2 : 1
  const [d, setD] = useState(localDate())
  const [v, setV] = useState('')
  async function add() {
    if (!v) return
    const { error } = await supabase.from('body_metrics').insert({ lifter_id: lifterId, measured_on: d, metric: m.metric, value: Number(v), unit: m.unit, source: 'app' })
    if (error) alert(error.message); else { setV(''); onChange() }
  }
  async function del(id: string) {
    const { error } = await supabase.from('body_metrics').delete().eq('id', id)
    if (error) alert(error.message); else onChange()
  }
  return (
    <div className="detailbox">
      <h3>{m.label}</h3>
      <Chart pts={pts} tr={tr} unit={m.unit} />
      {tr && <p className="small">Trend {tr.perWeek >= 0 ? '+' : ''}{round(tr.perWeek, dp)} {m.unit}/week · projected {round(tr.at(today + 28), dp)} {m.unit} in 4 weeks.</p>}
      {!tr && <p className="small muted">A projection appears once there are three entries{m.derived ? ' not marked sick or injured' : ''} spread over at least a week.</p>}
      {!m.derived && (
        <div className="row wrap">
          <label className="grow">Date<input type="date" value={d} onChange={e => setD(e.target.value)} /></label>
          <label className="narrow">{m.unit}<input inputMode="decimal" value={v} onChange={e => setV(e.target.value)} /></label>
          <button className="primary inline" onClick={add} disabled={!v}>Add</button>
        </div>
      )}
      <ul className="plain small entries">
        {[...pts].reverse().map((p, i) => (
          <li key={p.id ?? p.d + i}>
            {p.d} · <b>{round(p.v, dp)}</b> {m.unit}{p.x ? ' · sick/injury' : ''}{p.src && p.src !== 'app' ? <span className="muted"> · {p.src.replace('_', ' ')}</span> : null}
            {p.id && !m.derived && <DelBtn tip="Delete this entry" onConfirm={() => del(p.id!)} />}
          </li>
        ))}
      </ul>
      {m.derived && <p className="small muted">Worked out from logged sessions{m.grp === 'Recovery' ? ' and Garmin' : ''}; nothing to enter.</p>}
    </div>
  )
}

function Chart({ pts, tr, unit }: { pts: Point[]; tr: ReturnType<typeof trend>; unit: string }) {
  if (pts.length < 2) return <p className="muted small">The graph appears after two entries.</p>
  const W = 600, H = 200, P = 34
  const t0 = Date.parse(pts[0].d) / DAY
  const tEnd = Math.max(Date.parse(pts.at(-1)!.d) / DAY, tr ? Date.parse(localDate()) / DAY + 28 : 0)
  const projEnd = tr ? tr.at(tEnd) : null
  const vs = [...pts.map(p => p.v), ...(projEnd !== null ? [projEnd] : [])]
  const pad = (Math.max(...vs) - Math.min(...vs)) * 0.1 || 1
  const lo = Math.min(...vs) - pad, hi = Math.max(...vs) + pad
  const X = (day: number) => P + ((day - t0) / Math.max(1, tEnd - t0)) * (W - 2 * P)
  const Y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)
  const good = pts.filter(p => !p.x)
  const line = good.map((p, i) => `${i ? 'L' : 'M'}${X(Date.parse(p.d) / DAY).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')
  const lastGood = good.at(-1)
  const dec = Math.abs(hi - lo) < 10 ? 1 : 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend" role="img" aria-label={`History in ${unit}`}>
      {[lo, (lo + hi) / 2, hi].map(v => (
        <g key={v}><line x1={P} x2={W - P} y1={Y(v)} y2={Y(v)} className="grid" /><text x={2} y={Y(v) + 4} className="axis">{v.toFixed(dec)}</text></g>
      ))}
      <path d={line} className="line" />
      {tr && lastGood && projEnd !== null && (
        <path d={`M${X(Date.parse(lastGood.d) / DAY)},${Y(tr.at(Date.parse(lastGood.d) / DAY))}L${X(tEnd)},${Y(projEnd)}`} className="proj" />
      )}
      {pts.map((p, i) => (
        <circle key={p.d + i} cx={X(Date.parse(p.d) / DAY)} cy={Y(p.v)} r={4.5} className={p.x ? 'dot hollow' : 'dot'}><title>{p.d}: {p.v.toFixed(2)}</title></circle>
      ))}
      <text x={P} y={H - 8} className="axis">{pts[0].d.slice(5)}</text>
      <text x={W - P} y={H - 8} className="axis" textAnchor="end">{new Date(tEnd * DAY).toISOString().slice(5, 10)}</text>
    </svg>
  )
}

function AddForm({ lifterId, catalog, onSaved }: { lifterId: string; catalog: Metric[]; onSaved: () => void }) {
  const [d, setD] = useState(localDate())
  const [vals, setVals] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  async function save() {
    const rows = Object.entries(vals).filter(([, v]) => v.trim() !== '' && !Number.isNaN(Number(v)))
      .map(([metric, v]) => ({ lifter_id: lifterId, measured_on: d, metric, value: Number(v), unit: catalog.find(m => m.metric === metric)?.unit, source: 'app' }))
    if (!rows.length) return
    setBusy(true)
    const { error } = await supabase.from('body_metrics').insert(rows)
    setBusy(false)
    if (error) alert(error.message); else onSaved()
  }
  const groups = [...new Set(catalog.map(m => m.grp))]
  return (
    <div className="addform">
      <label>Date<input type="date" value={d} onChange={e => setD(e.target.value)} /></label>
      {groups.map(g => (
        <div key={g}>
          <p className="small"><b>{g}</b> <span className="muted">(leave blank if not measured)</span></p>
          <div className="planfields">
            {catalog.filter(m => m.grp === g).map(m => (
              <label key={m.metric}>{m.label} ({m.unit})
                <input inputMode="decimal" value={vals[m.metric] ?? ''} onChange={e => setVals({ ...vals, [m.metric]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
      ))}
      <button className="primary" onClick={save} disabled={busy}>Save</button>
    </div>
  )
}

/** Bands this lifter last used on each speed exercise. Log starts each new session with them; changing bands on Log updates them here. */
function SpeedBands({ lifterId }: { lifterId: string }) {
  const { lifters, reload, equipment } = useStore()
  const bandOpts = equipment.filter(e => e.kind === 'band').map(e => ({ id: e.id ?? e.name, name: e.name }))
  const lifter = lifters.find(l => l.id === lifterId)
  const st = lifter?.settings ?? {}
  const sb: Record<string, BandPick[]> = st.speed_bands ?? {}
  const names = Object.keys(sb).sort()
  const save = async (next: Record<string, BandPick[]>) => { await supabase.from('lifters').update({ settings: { ...st, speed_bands: next } }).eq('id', lifterId); await reload() }
  return (
    <section className="card">
      <h2><T tip="The bands last used on each speed exercise. New sessions start with these; change them here or on Log." pos="right">Speed work bands</T></h2>
      {!names.length ? <p className="small muted">None yet. Bands used on a speed exercise (band-assisted or resisted jumps, banded bench) are saved here when the set is logged.</p> : (
        <div className="capgrid sbands">
          {names.map(nm => (
            <Fragment key={nm}>
              <span className="capname">{nm}</span>
              <BandEditor bands={sb[nm]} options={bandOpts} onChange={bb => save({ ...sb, [nm]: bb })} />
              <DelBtn tip="Forget the bands for this exercise" onConfirm={() => { const { [nm]: _, ...rest } = sb; save(rest) }} />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The creatine numbers Max plans spotter sets with, per lift, and how each session moved them.
 * Undo puts a lift back to where it was before that session (latest first), and that session is never applied again.
 */
function CreatineModel({ lifterId }: { lifterId: string }) {
  const { lifters, reload, cfg } = useStore()
  const lifter = lifters.find(l => l.id === lifterId)
  const st = lifter?.settings ?? {}
  const log: CrLogEntry[] = st.creatine_log ?? []
  const def = crOf(cfg)
  const lifts = ['bench', 'squat']
  const latest = (lift: string) => log.find(e => e.lift === lift && !e.undone && !(e.after.half_s === e.before.half_s && e.after.cost === e.before.cost))
  async function undo(e: CrLogEntry) {
    const creatine = { ...(st.creatine ?? {}), [e.lift]: { ...(st.creatine?.[e.lift] ?? {}), half_s: e.before.half_s, cost: e.before.cost } }
    const creatine_log = log.map(x => (x === e ? { ...x, undone: true } : x))
    await supabase.from('lifters').update({ settings: { ...st, creatine, creatine_log } }).eq('id', lifterId)
    await reload()
  }
  return (
    <section className="card crmodel">
      <h2><T tip={`What Max plans spotter sets with: how long creatine takes to half refill, and how much each rep uses. After a session with two spotter sets read by the Tindeq and one measured rest, each number moves ${LEARN_RATE * 100}% of the way toward what the session measured. A reading under half or over double the current number, or outside a sensible range, is ignored and listed here.`} pos="right">Creatine model</T></h2>
      <div className="crnow">
        {lifts.map(l => { const c = { ...def, ...(st.creatine?.[l] ?? {}) }; const own = !!st.creatine?.[l]; return (
          <div key={l}><span className="cap">{l}</span> half-time <b>{fmtCr('half_s', c.half_s)}</b> · per rep <b>{fmtCr('cost', c.cost)}</b> {!own && <span className="small muted">(defaults)</span>}</div>
        ) })}
      </div>
      {log.length > 0 && (
        <div className="tablewrap"><table className="sheet cfg crlog">
          <thead><tr><th className="stick">Session</th><th>Lift</th><th>Half-time</th><th>Per rep</th><th>Note</th><th /></tr></thead>
          <tbody>
            {log.map(e => (
              <tr key={e.session + e.lift} className={e.undone ? 'undone' : ''}>
                <td className="stick">{e.date}</td><td className="cap">{e.lift}</td>
                <td>{fmtCr('half_s', e.before.half_s)} → <b>{fmtCr('half_s', e.after.half_s)}</b>{e.fitted.half_s !== null && <span className="small muted"> (measured {fmtCr('half_s', e.fitted.half_s)})</span>}</td>
                <td>{fmtCr('cost', e.before.cost)} → <b>{fmtCr('cost', e.after.cost)}</b>{e.fitted.cost !== null && <span className="small muted"> (measured {fmtCr('cost', e.fitted.cost)})</span>}</td>
                <td className="small">{e.undone ? <span className="muted">undone</span> : e.rejected.length ? <span className="err">ignored: {e.rejected.join('; ')}</span> : ''}</td>
                <td>{latest(e.lift) === e && <button className="ghost small" onClick={() => undo(e)} data-tip={`Put ${e.lift} back to ${fmtCr('half_s', e.before.half_s)} and ${fmtCr('cost', e.before.cost)}; this session won't be applied again.`} data-pos="left">Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {!log.length && <p className="small muted">No updates yet. They start once a session has two spotter sets read by the Tindeq.</p>}
    </section>
  )
}

/**
 * What Max believes about this lifter and how sure she is, per lift, with each session's effect on it.
 * A reading taken on a sick or hurt day that is very different from healthy sessions is listed but not used; three of those
 * in a row pointing the same way can be accepted as the new normal. The latest change to each number can be undone.
 */
function Learning({ lifterId }: { lifterId: string }) {
  const { lifters, reload } = useStore()
  const lifter = lifters.find(l => l.id === lifterId)
  const st = lifter?.settings ?? {}
  const log: LearnEntry[] = st.belief_log ?? []
  const lifts = ['bench', 'squat']
  const save = async (patch: Record<string, any>) => { await supabase.from('lifters').update({ settings: { ...st, ...patch } }).eq('id', lifterId); await reload() }
  const setBelief = (lift: string, key: string, b: Belief) => ({
    beliefs: { ...(st.beliefs ?? {}), [lift]: { ...(st.beliefs?.[lift] ?? {}), [key]: b } },
    ...(key === 'fatigue_rep_pct' ? { fatigue_rep_pct: { ...(st.fatigue_rep_pct ?? {}), [lift]: Math.round(b.value * 1000) / 1000 } } : {}),
  })
  const latest = (lift: string, key: string) => log.find(e => e.lift === lift && e.key === key && !e.undone && !e.flag)
  const undo = (e: LearnEntry) => save({ ...setBelief(e.lift, e.key, e.before), belief_log: log.map(x => (x === e ? { ...x, undone: true } : x)) })
  // Accepting a run of flagged sessions blends each of them in, oldest first, as if they had counted.
  const accept = (run: LearnEntry[]) => {
    const def = beliefDef(run[0].key)
    let b: Belief = st.beliefs?.[run[0].lift]?.[run[0].key] ?? def.init
    for (const e of [...run].reverse()) b = blend(b, e.measured, new Date().toISOString())
    return save({ ...setBelief(run[0].lift, run[0].key, b), belief_log: log.map(x => (run.includes(x) ? { ...x, accepted: true, after: b } : x)) })
  }
  return (
    <section className="card learning">
      <h2><T tip="Every number Max plans with is a belief: a value and how sure she is. After each finished session she scores her predictions, measures what the session shows, and blends it in: big moves while she's unsure, small refinements once she's confident. While a number is vague she spends more sets testing it; once settled, about one test a session." pos="right">What Max is learning</T></h2>
      {lifts.map(lift => {
        const bl: Record<string, Belief> = st.beliefs?.[lift] ?? {}
        const pm = (st.pred_miss?.[lift] ?? []) as { date: string; miss: number; n: number }[]
        const recent = pm.length ? pm.slice(0, 3).reduce((t, x) => t + x.miss, 0) / Math.min(3, pm.length) : null
        const budget = probeBudget({ ...Object.fromEntries(BELIEFS.map(d => [d.key, d.init])), ...bl }, recent)
        return (
          <div key={lift} className="learnlift">
            <h3 className="cap">{lift}</h3>
            <div className="learngrid">
              {BELIEFS.map(d => {
                const b = bl[d.key], shift = pendingShift(log, lift, d.key)
                const settled = !!b && b.sd / Math.max(1e-9, b.value) <= d.settled
                return (
                  <Fragment key={d.key}>
                    <span><T tip={d.tip} pos="right">{d.label}</T></span>
                    <span>{b ? <><b>{d.fmt(b.value)}</b> <span className="muted">± {d.fmt(b.sd)}</span></> : <span className="muted">not measured yet (starting from {d.fmt(d.init.value)})</span>}</span>
                    <span className={'small ' + (settled ? 'up' : 'muted')}>{b ? `${settled ? 'settled' : 'learning'} · ${b.n} session${b.n === 1 ? '' : 's'}` : d.probes.length ? 'needs test sets' : 'needs a full session'}</span>
                    <span>{shift && <button className="ghost small" onClick={() => accept(shift)} data-tip={`The last three sick or hurt sessions all measured ${shift[0].measured.value > shift[0].before.value ? 'higher' : 'lower'} (${shift.map(e => d.fmt(e.measured.value)).reverse().join(', ')}). Accept that as the new normal.`} data-pos="left">Accept new normal</button>}</span>
                  </Fragment>
                )
              })}
            </div>
            <p className="small muted">Test sets next session: {budget.count ? `${budget.count}` : `up to ${Math.round(budget.share * 100)}% of sets`} ({budget.why}).
              {pm.length > 0 && <> Predictions: off by {pm[0].miss.toFixed(1)} reps over {pm[0].n} sets on {pm[0].date}{pm.length > 1 ? `; ${pm.slice(1, 4).map(x => x.miss.toFixed(1)).join(', ')} before that` : ''}.</>}</p>
          </div>
        )
      })}
      {log.length > 0 && (
        <div className="tablewrap"><table className="sheet cfg crlog">
          <thead><tr><th className="stick">Session</th><th>Lift</th><th>What</th><th>Before → after</th><th>Measured</th><th>Note</th><th /></tr></thead>
          <tbody>
            {log.slice(0, 40).map(e => { const d = beliefDef(e.key); return (
              <tr key={e.session + e.lift + e.key} className={e.undone ? 'undone' : ''}>
                <td className="stick">{e.date}</td><td className="cap">{e.lift}</td><td>{d.label}</td>
                <td>{d.fmt(e.before.value)} → <b>{d.fmt(e.after.value)}</b> <span className="small muted">± {d.fmt(e.after.sd)}</span></td>
                <td>{d.fmt(e.measured.value)} <span className="small muted">± {d.fmt(e.measured.sd)}</span></td>
                <td className="small">{e.undone ? <span className="muted">undone</span> : e.accepted ? <span className="up">accepted as new normal</span> : e.flag ? <span className="err">not used: {e.flag}</span> : e.off ? <span className="muted">sick or hurt, in line: used</span> : ''}</td>
                <td>{latest(e.lift, e.key) === e && <button className="ghost small" onClick={() => undo(e)} data-tip={`Put ${d.label.toLowerCase()} back to ${d.fmt(e.before.value)}; this session won't be applied again.`} data-pos="left">Undo</button>}</td>
              </tr>
            ) })}
          </tbody>
        </table></div>
      )}
    </section>
  )
}
