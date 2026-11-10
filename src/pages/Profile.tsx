import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useStore } from '../lib/store'
import { LifterSettings } from './Config'
import { e1rmFromRpe, fitFatigue, localDate, round } from '../lib/load'

interface Metric { metric: string; label: string; unit: string; grp: string; sort: number; derived: boolean }
interface Point { d: string; v: number; x?: boolean; id?: string; src?: string }

const GROUPS = ['Strength', 'Body', 'Measurements', 'Skinfolds', 'Recovery', 'Energy system']
const DAY = 86400000

export default function Profile({ lifterId }: { lifterId: string }) {
  const { lifters } = useStore()
  const lifter = lifters.find(l => l.id === lifterId)
  const [catalog, setCatalog] = useState<Metric[]>([])
  const [series, setSeries] = useState<Record<string, Point[]>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setErr(null)
    const [cat, bm, ss, gd] = await Promise.all([
      supabase.from('metric_catalog').select('*').order('sort'),
      supabase.from('body_metrics').select('*').eq('lifter_id', lifterId).order('measured_on'),
      supabase.from('sessions').select('id, session_date, primary_lift, sick, hurt, bodyweight_lb').eq('lifter_id', lifterId).order('session_date'),
      supabase.from('garmin_daily').select('*').eq('lifter_id', lifterId).order('day'),
    ])
    const e = [cat, bm, ss, gd].find(r => r.error)?.error
    if (e) { setErr(e.message); return }
    const sessions = ss.data ?? []
    const ids = sessions.map(s => s.id)
    const est = ids.length
      ? (await supabase.from('set_estimates').select('session_id, block, set_index, weight_lb, reps, rpe, e1rm_lb, setup').in('session_id', ids).in('block', ['primary', 'deadlift']).order('set_index')).data ?? []
      : []

    const out: Record<string, Point[]> = {}
    const push = (k: string, p: Point) => (out[k] ??= []).push(p)
    // Entered values (bodyweight, measurements, skinfolds, energy test results). Fatigue and maxes are worked out from sessions below.
    for (const r of bm.data ?? []) if (!/^(fatigue|e1rm)_/.test(r.metric)) push(r.metric, { d: r.measured_on, v: Number(r.value), id: r.id, src: r.source })
    for (const s of sessions) {
      const x = !!s.sick || !!s.hurt
      const mine = est.filter(r => r.session_id === s.id)
      if (s.bodyweight_lb && !(out.bodyweight ?? []).some(p => p.d === s.session_date)) push('bodyweight', { d: s.session_date, v: Number(s.bodyweight_lb), src: 'session' })
      if (s.primary_lift === 'deadlift') {
        const tops = mine.filter(r => String(r.setup?.step ?? '').startsWith('top') && r.weight_lb && r.reps)
        const best = tops.map(r => e1rmFromRpe(Number(r.weight_lb), r.reps, r.rpe === null ? null : Number(r.rpe))).sort((a, b) => b - a)[0]
        if (best) push('e1rm_deadlift', { d: s.session_date, v: best, x })
        continue
      }
      const lift = s.primary_lift
      const prim = mine.filter(r => r.block === 'primary').map(r => (r.e1rm_lb === null ? null : Number(r.e1rm_lb)))
      if (prim[0]) push(`e1rm_${lift}`, { d: s.session_date, v: prim[0], x })
      const fit = fitFatigue(prim)
      if (fit && fit.ratePct > 0) push(`fatigue_${lift}`, { d: s.session_date, v: fit.ratePct, x })
    }
    for (const g of gd.data ?? []) {
      if (g.resting_hr) push('resting_hr', { d: g.day, v: Number(g.resting_hr) })
      if (g.hrv_ms) push('hrv', { d: g.day, v: Number(g.hrv_ms) })
      if (g.sleep_h) push('sleep_h', { d: g.day, v: Number(g.sleep_h) })
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.d.localeCompare(b.d))
    setCatalog((cat.data as Metric[]) ?? [])
    setSeries(out)
  }
  useEffect(() => { if (lifterId) load() }, [lifterId])

  const byGroup = useMemo(() => GROUPS.map(g => ({ g, items: catalog.filter(m => m.grp === g) })), [catalog])

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{lifter?.name ?? 'Profile'}</h2>
          <button className="primary inline" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add measurements'}</button>
        </div>
        <p className="small muted">Every value is kept by date. The newest is the current value; tap any one for its history and projection.</p>
        {adding && <AddForm lifterId={lifterId} catalog={catalog.filter(m => !m.derived)} onSaved={() => { setAdding(false); load() }} />}
      </section>
      {err && <p className="err">{err}</p>}
      {byGroup.map(({ g, items }) => {
        const shown = items.filter(m => !m.derived || (series[m.metric]?.length ?? 0) > 0)
        if (!shown.length) return null
        return (
          <section className="card" key={g}>
            <h2>{g}</h2>
            <div className="tiles">
              {shown.map(m => (
                <Tile key={m.metric} m={m} pts={series[m.metric] ?? []} open={open === m.metric} onToggle={() => setOpen(open === m.metric ? null : m.metric)} />
              ))}
            </div>
            {open && shown.some(m => m.metric === open) && (
              <Detail m={shown.find(m => m.metric === open)!} pts={series[open] ?? []} lifterId={lifterId} onChange={load} />
            )}
          </section>
        )
      })}
      <LifterSettings lifterId={lifterId} />
    </div>
  )
}

function current(pts: Point[]) {
  const valid = pts.filter(p => !p.x)
  return valid.at(-1) ?? pts.at(-1) ?? null
}

function Tile({ m, pts, open, onToggle }: { m: Metric; pts: Point[]; open: boolean; onToggle: () => void }) {
  const c = current(pts)
  const valid = pts.filter(p => !p.x)
  const prev = valid.length > 1 ? valid[valid.length - 2] : null
  const delta = c && prev ? c.v - prev.v : null
  const dp = m.unit === 'lb' || m.unit === 'bpm' || m.unit === 'ms' ? 0 : m.unit === '%/set' ? 2 : 1
  return (
    <button className={'tile' + (open ? ' on' : '')} onClick={onToggle}>
      <span className="small muted">{m.label}</span>
      <b>{c ? round(c.v, dp) : '—'} <small className="muted">{c ? m.unit : ''}</small></b>
      <span className="sub2">{c ? `${c.d.slice(5).replace('-', '/')}` : 'not logged'}{delta !== null && Math.abs(delta) > 1e-9 ? ` · ${delta > 0 ? '+' : ''}${round(delta, dp)}` : ''}</span>
    </button>
  )
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
    if (!confirm('Delete this entry?')) return
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
            {p.id && !m.derived && <button className="x" onClick={() => del(p.id!)} aria-label="Delete entry">×</button>}
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
