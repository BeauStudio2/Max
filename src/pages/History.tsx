import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useStore } from '../lib/store'
import { round } from '../lib/load'
import type { Lift, SummaryRow } from '../lib/types'

const LIFTS: Lift[] = ['bench', 'squat', 'deadlift']

export default function History({ lifterId }: { lifterId: string }) {
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [lift, setLift] = useState<Lift>('bench')

  useEffect(() => {
    if (!lifterId) return
    supabase.from('session_summary').select('*').eq('lifter_id', lifterId).order('session_date', { ascending: false })
      .then(({ data }) => setRows((data as SummaryRow[]) ?? []))
  }, [lifterId])

  const forLift = rows.filter(r => r.primary_lift === lift)
  const points = forLift.filter(r => r.set1_e1rm_lb).map(r => ({ d: r.session_date, v: Number(r.set1_e1rm_lb), x: r.excluded })).reverse()
  const good = points.filter(p => !p.x)
  const current = good.at(-1)
  const best = good.reduce((m, p) => Math.max(m, p.v), 0)

  return (
    <div className="stack history">
      <section className="card">
        <div className="seg">
          {LIFTS.map(l => <button key={l} className={l === lift ? 'on' : ''} onClick={() => setLift(l)}>{l}</button>)}
        </div>
        <div className="stats">
          <div><span className="muted small">Current</span><b>{current ? round(current.v) : '—'}</b></div>
          <div><span className="muted small">Best</span><b>{best ? round(best) : '—'}</b></div>
          <div><span className="muted small">Sessions</span><b>{forLift.length}</b></div>
        </div>
        <Trend points={points} />
        <p className="small muted">Set-1 estimated max per session. Hollow points were sick or injured and are left out.</p>
      </section>

      <section className="card">
        <h2>Sessions</h2>
        {rows.length === 0 && <p className="muted">Nothing logged yet.</p>}
        <ul className="sessions">
          {rows.map(r => (
            <li key={r.session_id}>
              <button className="sessionrow" onClick={() => setOpen(open === r.session_id ? null : r.session_id)}>
                <span>{Number(r.session_date.slice(5, 7))}/{Number(r.session_date.slice(8))}</span>
                <span className="cap">{r.primary_lift}</span>
                <span>{r.set1_e1rm_lb ? <b>{round(r.set1_e1rm_lb)}</b> : <span className="muted">—</span>}</span>
                <span className="small muted">{r.sets_done} sets</span>
                <span>{r.sick && <span className="tag sick">sick</span>}{r.hurt && <span className="tag hurt">injury</span>}</span>
              </button>
              {open === r.session_id && <Detail row={r} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Detail({ row }: { row: SummaryRow }) {
  const { exercises } = useStore()
  const [sets, setSets] = useState<any[] | null>(null)
  useEffect(() => {
    supabase.from('set_estimates').select('*').eq('session_id', row.session_id).order('block').order('set_index')
      .then(({ data }) => setSets(data ?? []))
  }, [row.session_id])
  const name = (id: string) => exercises.find(e => e.id === id)?.name ?? '?'
  const groups = ['speed', 'primary', 'deadlift', 'support']
  return (
    <div className="detail">
      {row.hurt && <p className="small"><b>Injury:</b> {row.hurt}</p>}
      {row.notes && <p className="small">{row.notes}</p>}
      {(row.sleep_h || row.hrv_ms || row.resting_hr) && (
        <p className="small muted">Sleep {round(row.sleep_h, 1)} h · HRV {round(row.hrv_ms)} · RHR {round(row.resting_hr)}</p>
      )}
      {!sets ? <p className="muted small">Loading…</p> : groups.map(g => {
        const s = sets.filter(x => x.block === g)
        if (!s.length) return null
        return (
          <div key={g}>
            <p className="small cap"><b>{g === 'primary' ? 'heavy' : g}</b></p>
            {g === 'support' ? (
              <ul className="plain small">{s.map(x => (
                <li key={x.id}>{name(x.exercise_id)}: {x.start_weight_lb ?? '—'} lb{x.reps ? ` × ${x.reps}` : ''} {x.scheme ? `(${x.scheme})` : ''}{x.notes ? ` · ${x.notes}` : ''}</li>
              ))}</ul>
            ) : (
              <p className="chips">{s.map(x => (
                <span key={x.id} className="chip" title={name(x.exercise_id)}>
                  {x.weight_lb ? `${round(x.weight_lb, 1)}×` : ''}{x.reps ?? ''}{x.assisted ? 'A' : ''}{x.failed ? 'F' : ''}
                  {g !== 'speed' && x.e1rm_lb ? <em> {round(x.e1rm_lb)}</em> : null}
                </span>
              ))}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Trend({ points }: { points: { d: string; v: number; x: boolean }[] }) {
  if (points.length < 2) return <p className="muted small">The trend line appears after two sessions.</p>
  const W = 600, H = 180, P = 28
  const vs = points.map(p => p.v)
  const lo = Math.floor((Math.min(...vs) - 5) / 5) * 5, hi = Math.ceil((Math.max(...vs) + 5) / 5) * 5
  const t0 = Date.parse(points[0].d), t1 = Date.parse(points.at(-1)!.d) || t0 + 1
  const X = (d: string) => P + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - 2 * P)
  const Y = (v: number) => H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * P)
  const good = points.filter(p => !p.x)
  const path = good.map((p, i) => `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend" role="img" aria-label="Estimated max over time">
      {[lo, (lo + hi) / 2, hi].map(v => (
        <g key={v}><line x1={P} x2={W - P} y1={Y(v)} y2={Y(v)} className="grid" /><text x={2} y={Y(v) + 4} className="axis">{Math.round(v)}</text></g>
      ))}
      <path d={path} className="line" />
      {points.map(p => (
        <circle key={p.d} cx={X(p.d)} cy={Y(p.v)} r={5} className={p.x ? 'dot hollow' : 'dot'}><title>{p.d}: {Math.round(p.v)}</title></circle>
      ))}
      <text x={P} y={H - 6} className="axis">{points[0].d.slice(5)}</text>
      <text x={W - P} y={H - 6} className="axis" textAnchor="end">{points.at(-1)!.d.slice(5)}</text>
    </svg>
  )
}
