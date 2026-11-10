import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../supabase'
import { useStore } from '../../lib/store'
import { T } from '../today/shared'
import { setupOf } from '../today/Ladder'
import type { Equipment } from '../../lib/types'

/** What was on the bar, like the Log's lb column: plates + bar + clamps (chains and bands not included). */
export function onBar(x: { weight_lb: any; setup?: any }, eq: Equipment[]) {
  if (x.weight_lb == null) return null
  const s = setupOf(x as any)
  const w = (n: string) => Number(eq.find(e => e.name === n)?.weight_lb ?? 0)
  return Number(x.weight_lb) + (s.bar ? w(s.bar) + w(s.clamp) : 0)
}
import { round } from '../../lib/load'

export type TLift = 'bench' | 'squat' | 'deadlift'
/** One session, as a row on the sheet's Tracker tab. */
export interface TrackRow {
  id?: string; notes?: string | null; excludeReason?: string | null
  d: string; lift: TLift; variant?: string | null
  set1?: number | null; set1Reps?: number | null; rpe?: number | null
  est: number | null; planned: number | null
  fatigueUsed: number | null; fatigueFit: number | null
  sets: number; volume: number
  sick: boolean; hurt: string | null; excluded: boolean
}
export interface DayVal { d: string; v: number }

const LIFTS: TLift[] = ['bench', 'squat', 'deadlift']
const NAME: Record<TLift, string> = { bench: 'Bench', squat: 'Squat', deadlift: 'Deadlift' }
const DAY = 86400000
const t = (d: string) => Date.parse(d + 'T12:00:00Z') / DAY
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Round axis ticks: three or four steps of 1, 2, 2.5 or 5 × 10^n. */
function ticks(lo: number, hi: number) {
  const raw = (hi - lo) / 3 || 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw)!
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return { out, step }
}
const fmtTick = (v: number, step: number) => (step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : v >= 10000 ? `${Math.round(v / 1000)}k` : v.toLocaleString())

/** Last three valid fitted fatigue rates, averaged (the sheet's "fatigue rate, last 3 valid"). */
function last3(rows: TrackRow[]) {
  const v = rows.filter(r => !r.excluded && r.fatigueFit !== null).slice(-3).map(r => r.fatigueFit!)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

export default function Tracker({ rows, rhr, hrv, sleep, bodyweight, fallback }: {
  rows: TrackRow[]; rhr: DayVal[]; hrv: DayVal[]; sleep: DayVal[]; bodyweight: DayVal[]
  fallback: Partial<Record<TLift, { planned?: number | null; best?: number | null }>>
}) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const [range, setRange] = useState<'30' | '90' | 'all'>('90')
  const [open, setOpen] = useState<string | null>(null)

  const all = [...rows.map(r => r.d), ...rhr.map(p => p.d), ...hrv.map(p => p.d), ...sleep.map(p => p.d)].sort()
  const end = all.length ? Math.max(t(all.at(-1)!), t(new Date().toISOString().slice(0, 10))) : t(new Date().toISOString().slice(0, 10))
  const firstData = all.length ? t(all[0]) : end - 30
  const start = range === 'all' ? firstData : Math.max(firstData, end - Number(range))
  const inR = (d: string) => t(d) >= start - 0.5 && t(d) <= end + 0.5
  const vis = rows.filter(r => inR(r.d))
  const L = 44, R = 12
  const X = (day: number) => L + ((day - start) / Math.max(1, end - start)) * (W - L - R)
  const dayAt = (px: number) => Math.round(start + ((px - L) / (W - L - R)) * (end - start))

  // Sick / injured / excluded days, shaded behind every panel so dips line up with their cause.
  const bad = vis.filter(r => r.excluded)

  const summary = LIFTS.map(lift => {
    const mine = rows.filter(r => r.lift === lift)
    const valid = mine.filter(r => !r.excluded && r.est)
    const today = new Date().toISOString().slice(0, 10)
    const next = mine.find(r => r.d >= today && r.planned) ?? [...mine].reverse().find(r => r.planned)
    return { lift, current: valid.at(-1)?.est ?? fallback[lift]?.best ?? null, next: next?.planned ?? fallback[lift]?.planned ?? null, fatigue: last3(mine) }
  })

  const hovDay = hover
  const near = <T extends { d: string }>(pts: T[]) => (hovDay === null ? undefined : pts.find(p => Math.abs(t(p.d) - hovDay) < 0.5))
  const readout = hovDay === null ? null : (() => {
    const d = new Date(hovDay * DAY).toISOString().slice(0, 10)
    const sess = rows.filter(r => r.d === d)
    const g = [near(rhr) && `RHR ${near(rhr)!.v}`, near(hrv) && `HRV ${near(hrv)!.v}`, near(sleep) && `sleep ${near(sleep)!.v.toFixed(1)} h`, near(bodyweight) && `${near(bodyweight)!.v} lb bw`].filter(Boolean)
    return { d, sess, g }
  })()

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const px = e.clientX - box.left
    setHover(px < L || px > W - R ? null : dayAt(px))
  }

  const xTicks = useMemo(() => {
    const span = end - start, every = span > 120 ? 30 : span > 45 ? 14 : span > 21 ? 7 : 3
    const out: number[] = []
    for (let d = Math.ceil(start / every) * every; d <= end; d += every) out.push(d)
    return out
  }, [start, end])

  const Frame = ({ h, lo, hi, children, label, unit }: { h: number; lo: number; hi: number; children: (Y: (v: number) => number) => React.ReactNode; label: string; unit?: string }) => {
    const T = 8, B = 6
    const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (h - T - B)
    const tk = ticks(lo, hi)
    return (
      <div className="tpanel">
        <div className="tlabel">{label}{unit ? <span className="muted"> · {unit}</span> : null}</div>
        <svg width={W} height={h} role="img" aria-label={label}>
          {bad.map(r => <rect key={r.d + r.lift} x={X(t(r.d)) - Math.max(3, (W - L - R) / Math.max(1, end - start) / 2)} width={Math.max(6, (W - L - R) / Math.max(1, end - start))} y={T} height={h - T - B} className={'tbad' + (r.sick ? ' sick' : '')} />)}
          {tk.out.map(v => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className="tgrid" /><text x={L - 6} y={Y(v) + 4} className="taxis" textAnchor="end">{fmtTick(v, tk.step)}</text></g>)}
          {children(Y)}
          {hovDay !== null && <line x1={X(hovDay)} x2={X(hovDay)} y1={T} y2={h - B} className="tcross" />}
        </svg>
      </div>
    )
  }

  const extent = (vals: number[], padFrac = 0.12, floor0 = false) => {
    if (!vals.length) return [0, 1]
    let lo = Math.min(...vals), hi = Math.max(...vals)
    const pad = (hi - lo) * padFrac || Math.max(1, hi * 0.05)
    lo = floor0 ? 0 : lo - pad; hi = hi + pad
    return [lo, hi]
  }
  const path = (pts: { d: string; v: number }[], Y: (v: number) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(t(p.d)).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')
  const stepPath = (pts: { d: string; v: number }[], Y: (v: number) => number) =>
    pts.map((p, i) => (i ? `H${X(t(p.d)).toFixed(1)}V${Y(p.v).toFixed(1)}` : `M${X(t(p.d)).toFixed(1)},${Y(p.v).toFixed(1)}`)).join('')

  const liftsShown = LIFTS.filter(l => vis.some(r => r.lift === l && (r.est || r.planned)))
  const volMax = Math.max(1, ...vis.map(r => r.volume))
  const fat = vis.filter(r => r.fatigueFit !== null || r.fatigueUsed !== null)
  const fatVals = fat.flatMap(r => [r.fatigueFit, r.fatigueUsed].filter((v): v is number => v !== null))
  const barW = Math.max(4, Math.min(14, ((W - L - R) / Math.max(1, end - start)) * 0.6))

  return (
    <section className="card tracker">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>Tracker</h2>
        <div className="seg" role="group" aria-label="Time range">
          {(['30', '90', 'all'] as const).map(k => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{k === 'all' ? 'All' : `${k} d`}</button>)}
        </div>
      </div>

      <table className="tsum">
        <tbody>
          <tr><th />{summary.map(s => <th key={s.lift}><span className={'key ' + s.lift} />{NAME[s.lift]}</th>)}</tr>
          <tr><td>Current max</td>{summary.map(s => <td key={s.lift}><b>{s.current ? round(s.current) : '—'}</b></td>)}</tr>
          <tr><td>Next planned max</td>{summary.map(s => <td key={s.lift}>{s.next ? round(s.next) : '—'}</td>)}</tr>
          <tr><td>Fatigue, last 3 valid</td>{summary.map(s => <td key={s.lift}>{s.fatigue !== null ? `${s.fatigue.toFixed(1)}%` : '—'}</td>)}</tr>
        </tbody>
      </table>

      <div className="treadout small" aria-live="polite">
        {readout ? <>
          <b>{md(readout.d)}</b>
          {readout.sess.map(r => <span key={r.lift}><span className={'key ' + r.lift} />{NAME[r.lift]} {r.est ? `est ${round(r.est)}` : ''}{r.planned ? ` / plan ${round(r.planned)}` : ''}{r.volume ? ` · ${Math.round(r.volume).toLocaleString()} lb vol` : ''}{r.fatigueFit !== null ? ` · ${r.fatigueFit.toFixed(1)}%/set` : ''}{r.excluded ? ` · ${r.sick ? 'sick' : r.hurt ? 'injury' : 'excluded'}` : ''}</span>)}
          {readout.g.length ? <span>{readout.g.join(' · ')}</span> : null}
          {!readout.sess.length && !readout.g.length && <span className="muted">no data</span>}
        </> : <span className="muted">Hover or drag across a graph to read a day. Shaded days are sick, injured or excluded.</span>}
      </div>

      <div ref={ref} className="tcharts" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {liftsShown.map(lift => {
          const mine = vis.filter(r => r.lift === lift)
          const est = mine.filter(r => r.est).map(r => ({ d: r.d, v: r.est!, x: r.excluded }))
          const plan = mine.filter(r => r.planned).map(r => ({ d: r.d, v: r.planned! }))
          const [lo, hi] = extent([...est.map(p => p.v), ...plan.map(p => p.v)], 0.25)
          const good = est.filter(p => !p.x)
          const h = near(est)
          return (
            <Frame key={lift} h={96} lo={lo} hi={hi} label={`${NAME[lift]} max`} unit="lb">
              {Y => <>
                {plan.length > 0 && <path d={stepPath(plan, Y)} className={'tplan ' + lift} />}
                {good.length > 1 && <path d={path(good, Y)} className={'tline ' + lift} />}
                {est.map(p => <circle key={p.d} cx={X(t(p.d))} cy={Y(p.v)} r={p.x ? 3.5 : 4} className={'tdot ' + lift + (p.x ? ' hollow' : '')}><title>{md(p.d)}: {round(p.v)}{p.x ? ' (excluded)' : ''}</title></circle>)}
                {h && <circle cx={X(t(h.d))} cy={Y(h.v)} r={6.5} className={'tdot ring ' + lift} />}
              </>}
            </Frame>
          )
        })}

        <Frame h={84} lo={0} hi={volMax * 1.1} label="Volume per session" unit="lb × reps">
          {Y => vis.filter(r => r.volume > 0).map(r => {
            const off = r.lift === 'bench' ? -barW / 2 : r.lift === 'squat' ? barW / 2 : 0
            const x = X(t(r.d)) - barW / 2 + (vis.filter(o => o.d === r.d && o.volume > 0).length > 1 ? off : 0)
            const y = Y(r.volume), base = Y(0)
            return <path key={r.d + r.lift} className={'tbar ' + r.lift + (r.excluded ? ' faded' : '')}
              d={`M${x},${base}V${y + 3}Q${x},${y} ${x + 3},${y}H${x + barW - 3}Q${x + barW},${y} ${x + barW},${y + 3}V${base}Z`}><title>{md(r.d)} {NAME[r.lift]}: {Math.round(r.volume).toLocaleString()}</title></path>
          })}
        </Frame>

        {fat.length > 0 && (() => { const [lo, hi] = extent(fatVals, 0.15); return (
          <Frame h={84} lo={Math.max(0, lo)} hi={hi} label="Fatigue rate" unit="% per set · dot = fitted, dash = used">
            {Y => LIFTS.map(lift => {
              const used = fat.filter(r => r.lift === lift && r.fatigueUsed !== null).map(r => ({ d: r.d, v: r.fatigueUsed! }))
              const fit = fat.filter(r => r.lift === lift && r.fatigueFit !== null).map(r => ({ d: r.d, v: r.fatigueFit!, x: r.excluded }))
              return <g key={lift}>
                {used.length > 0 && <path d={stepPath(used, Y)} className={'tplan ' + lift} />}
                {fit.map(p => <circle key={p.d} cx={X(t(p.d))} cy={Y(p.v)} r={4} className={'tdot ' + lift + (p.x ? ' hollow' : '')}><title>{md(p.d)} {NAME[lift]}: {p.v.toFixed(2)}%{p.x ? ' (excluded)' : ''}</title></circle>)}
              </g>
            })}
          </Frame>) })()}

        {([['Resting HR', 'bpm', rhr, 0], ['HRV', 'ms', hrv, 0], ['Sleep', 'h', sleep, 1], ['Bodyweight', 'lb', bodyweight, 1]] as const).map(([label, unit, ptsAll]) => {
          const pts = (ptsAll as DayVal[]).filter(p => inR(p.d))
          if (pts.length < 2) return null
          const [lo, hi] = extent(pts.map(p => p.v), 0.2)
          const h = near(pts)
          return (
            <Frame key={label} h={64} lo={lo} hi={hi} label={label} unit={unit}>
              {Y => <>
                <path d={path(pts, Y)} className="tline neutral" />
                {pts.length < 40 && pts.map(p => <circle key={p.d} cx={X(t(p.d))} cy={Y(p.v)} r={2.5} className="tdot neutral" />)}
                {h && <circle cx={X(t(h.d))} cy={Y(h.v)} r={5} className="tdot ring neutral" />}
              </>}
            </Frame>
          )
        })}

        <svg width={W} height={18} className="txaxis" aria-hidden>
          {xTicks.map(d => <text key={d} x={X(d)} y={13} className="taxis" textAnchor="middle">{md(new Date(d * DAY).toISOString().slice(0, 10))}</text>)}
        </svg>
      </div>

      <div className="tlegend small">
        {LIFTS.filter(l => rows.some(r => r.lift === l)).map(l => <span key={l}><span className={'key ' + l} />{NAME[l]}</span>)}
        <span><svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" className="tplan legend" /></svg>planned / used</span>
        <span><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" className="tdot hollow legend" /></svg>excluded</span>
      </div>

      <h3 className="tsess"><T tip="Every session, newest first. Tap one to see its sets.">Sessions</T></h3>
      {rows.length === 0 && <p className="muted small">Nothing logged yet.</p>}
      <div className="tablewrap"><table className="sheet cfg ttable">
        <thead><tr><th className="stick">Date</th><th>Lift</th><th className="num">Set 1</th><th className="num">Est max</th><th className="num t-opt">Planned</th>
          <th className="num t-opt">Fatigue used</th><th className="num t-opt">Fit</th><th className="num">Sets</th><th className="num t-opt">Volume</th><th>Status</th></tr></thead>
        <tbody>{[...rows].reverse().map(r => {
          const k = r.id ?? r.d + r.lift
          const isOpen = open === k
          return (
            <Fragment key={k}>
              <tr className={'srow' + (r.excluded ? ' muted' : '') + (isOpen ? ' open' : '')} onClick={() => setOpen(isOpen ? null : k)} tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') setOpen(isOpen ? null : k) }} aria-expanded={isOpen}>
                <td className="stick">{md(r.d)} <span className="muted">{isOpen ? '▴' : '▾'}</span></td>
                <td><span className={'key ' + r.lift} />{NAME[r.lift]}{r.variant ? <div className="sub2">{r.variant}</div> : null}</td>
                <td className="num">{r.set1 ? `${Math.round(r.set1 * 10) / 10} × ${r.set1Reps ?? ''}${r.rpe ? ` @${r.rpe}` : ''}` : ''}</td>
                <td className="num"><b>{r.est ? round(r.est) : ''}</b></td><td className="num t-opt">{r.planned ? round(r.planned) : ''}</td>
                <td className="num t-opt">{r.fatigueUsed !== null ? `${r.fatigueUsed}%` : ''}</td><td className="num t-opt">{r.fatigueFit !== null ? `${r.fatigueFit.toFixed(1)}%` : ''}</td>
                <td className="num">{r.sets || ''}</td><td className="num t-opt">{r.volume ? Math.round(r.volume).toLocaleString() : ''}</td>
                <td>{r.sick && <span className="tag sick">sick</span>}{r.hurt && <span className="tag hurt">injury</span>}{r.excludeReason && <span className="tag hurt">excluded</span>}</td>
              </tr>
              {isOpen && <tr className="sdetail"><td colSpan={10}><SessionSets r={r} rhr={rhr} hrv={hrv} sleep={sleep} /></td></tr>}
            </Fragment>
          )
        })}</tbody>
      </table></div>
    </section>
  )
}

/** One session's sets (heavy, speed, deadlift, support), its notes and that day's recovery numbers. */
function SessionSets({ r, rhr, hrv, sleep }: { r: TrackRow; rhr: DayVal[]; hrv: DayVal[]; sleep: DayVal[] }) {
  const { exercises, equipment } = useStore()
  const [sets, setSets] = useState<any[] | null>(null)
  useEffect(() => {
    if (!r.id) { setSets([]); return }
    supabase.from('set_estimates').select('*').eq('session_id', r.id).order('block').order('set_index').then(({ data }) => setSets(data ?? []))
  }, [r.id])
  const name = (id: string) => exercises.find(e => e.id === id)?.name ?? '?'
  const day = (pts: DayVal[]) => pts.find(p => p.d === r.d)?.v
  const g = [day(sleep) && `sleep ${day(sleep)!.toFixed(1)} h`, day(hrv) && `HRV ${day(hrv)}`, day(rhr) && `RHR ${day(rhr)}`].filter(Boolean)
  const blocks: [string, string][] = [['primary', 'Heavy'], ['deadlift', 'Deadlift'], ['speed', 'Speed'], ['support', 'Support']]
  return (
    <div className="detail">
      {r.hurt && <p className="small"><b>Injury:</b> {r.hurt}</p>}
      {r.excludeReason && <p className="small"><b>Excluded:</b> {r.excludeReason}</p>}
      {r.notes && <p className="small">{r.notes}</p>}
      {g.length > 0 && <p className="small muted">{g.join(' · ')}</p>}
      {!sets ? <p className="muted small">Loading…</p> : !sets.length ? <p className="muted small">No sets logged.</p> : blocks.map(([b, label]) => {
        const s = sets.filter(x => x.block === b)
        if (!s.length) return null
        return (
          <div key={b}>
            <p className="small"><b>{label}</b></p>
            {b === 'support' ? (
              <ul className="plain small">{s.map(x => (
                <li key={x.id}>{name(x.exercise_id)}: {x.start_weight_lb ?? '—'} lb{x.reps ? ` × ${x.reps}` : ''}{x.scheme ? ` (${x.scheme})` : ''}{x.notes ? ` · ${x.notes}` : ''}</li>
              ))}</ul>
            ) : (
              <p className="chips">{s.map(x => (
                <span key={x.id} className="chip" title={name(x.exercise_id)}>
                  {x.weight_lb != null ? `${Math.round((b === 'primary' ? onBar(x, equipment)! : Number(x.weight_lb)) * 10) / 10}×` : ''}{x.reps ?? ''}{x.assisted ? 'A' : ''}{x.failed ? 'F' : ''}{x.rpe ? ` @${x.rpe}` : ''}
                  {b !== 'speed' && x.e1rm_lb ? <em> {round(Number(x.e1rm_lb))}</em> : null}
                </span>
              ))}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
