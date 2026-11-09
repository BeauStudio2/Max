import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { LIFT_EXERCISE, e1rm, expectedReps, fitFatigue, platesPerSide, round, roundTo, totals, effectiveLoad, keptFor, loadSide, choosePlates, changeText, stackText, type LoadSetup, type Kept } from '../../lib/load'
import type { Lift, SetRow } from '../../lib/types'
import { Num, fmt, useClock, type Api } from './shared'

export interface LadderPlan {
  planned_e1rm: number | null
  target_reps: number
  stop_pct: number
  fatigue_rate_used_pct: number
  step_lb: number
  rest_s: number
  chain_half: number
  chain_5_8: number
}

const BAR = 'Ohio Power Bar'
const ELEIKO = 'Eleiko clamps (pair)'
const CHAIN_CLAMP = 'Chain clamp + carabiner (pair)'

const straight: LoadSetup = { bar: BAR, clamp: ELEIKO, chain_half: 0, chain_5_8: 0 }
const chained = (p: LadderPlan): LoadSetup =>
  p.chain_half || p.chain_5_8 ? { bar: BAR, clamp: CHAIN_CLAMP, chain_half: p.chain_half, chain_5_8: p.chain_5_8 } : straight

export function setupOf(r?: SetRow): LoadSetup {
  const s = r?.setup ?? {}
  const clamp = s.clamp === 'Eleiko' ? ELEIKO : s.clamp === 'chain clamp' ? CHAIN_CLAMP : s.clamp ?? ELEIKO
  return { bar: s.bar ?? BAR, clamp, chain_half: Number(s.chain_half ?? 0), chain_5_8: Number(s.chain_5_8 ?? 0) }
}

/** Chains hang from the chain clamp; with no chains the set goes back to Eleiko clamps. */
const withClamp = (s: LoadSetup): LoadSetup => ({ ...s, clamp: s.chain_half || s.chain_5_8 ? CHAIN_CLAMP : ELEIKO })

export const setupLabel = (s: LoadSetup) => {
  const parts = []
  if (s.chain_half) parts.push(`½×${s.chain_half}`)
  if (s.chain_5_8) parts.push(`⅝×${s.chain_5_8}`)
  return parts.length ? parts.join(' ') : s.clamp === ELEIKO ? 'straight' : 'no chains'
}

export default function Ladder({ lift, plan, setPlan, sets, api, currentMax, carriedFrom }: {
  carriedFrom?: string; lift: Lift; plan: LadderPlan; setPlan: (p: Partial<LadderPlan>) => void; sets: SetRow[]; api: Api; currentMax: number | null
}) {
  const { equipment, cfg } = useStore()
  const exerciseId = api.exId(LIFT_EXERCISE[lift])
  const f = plan.fatigue_rate_used_pct / 100
  const logged = useMemo(() => [...sets].sort((a, b) => a.set_index - b.set_index), [sets])
  const actual = logged.map(r => e1rm(r.total_bottom_lb, r.total_top_lb, r.reps, r.assisted || r.failed, cfg))

  // Target estimated max for each logged set: set 1 = planned max; after that, the previous set's actual less one set of fatigue.
  const targets: (number | null)[] = logged.map((r, i) => {
    if (r.set_index === 1 || i === 0) return plan.planned_e1rm
    const prev = actual[i - 1]
    return prev !== null ? prev * (1 - f) : null
  })
  const set1 = actual[0] ?? plan.planned_e1rm
  const floor = set1 ? (set1 * plan.stop_pct) / 100 : null
  const lastActual = actual.at(-1) ?? null
  const stopped = logged.length > 0 && floor !== null && lastActual !== null && lastActual < floor

  const weightFor = (target: number, s: LoadSetup) => {
    const needed = target / (1 + plan.target_reps / cfg.rep_divisor)
    const zero = totals(0, s, equipment)
    const extras = effectiveLoad(zero.bottom, zero.top, cfg) ?? 0
    return Math.max(0, roundTo(needed - extras, plan.step_lb))
  }

  // Projected remaining sets: ideal weights first, then the 45s/25s to keep on (from the lightest working set),
  // then each set's weight nudged one step either way if that saves plate moves.
  const plan2 = useMemo(() => {
    const ideal: { idx: number; target: number; setup: LoadSetup; weight: number }[] = []
    let idx = (logged.at(-1)?.set_index ?? 0) + 1
    let target = logged.length === 0 ? plan.planned_e1rm : lastActual !== null ? lastActual * (1 - f) : null
    if (target && !stopped) {
      while (idx <= 40 && (floor === null || target >= floor)) {
        const setup = idx === 1 ? straight : chained(plan)
        const weight = weightFor(target, setup)
        if (weight <= 0 && idx > 1) break
        ideal.push({ idx, target, setup, weight })
        target *= 1 - f
        idx++
      }
    }
    const working = [...logged.map(r => r.weight_lb ?? 0), ...ideal.map(p => p.weight)].filter(w => w > 0)
    const kept: Kept = keptFor(working.length ? Math.min(...working) : 0)
    let prev: number[] | null = logged.at(-1)?.weight_lb != null ? loadSide(logged.at(-1)!.weight_lb! / 2, kept) : null
    const out = ideal.map(p => {
      const c = choosePlates(p.weight, plan.step_lb, kept, prev)
      const weight = c?.weight ?? p.weight
      const stack = c?.stack ?? null
      const change = stack ? changeText(prev, stack) : ''
      if (stack) prev = stack
      return { ...p, weight, stack, change }
    })
    return { projected: out, kept }
  }, [logged, plan, lastActual, floor, stopped, equipment, cfg])
  const projected = plan2.projected
  const kept = plan2.kept

  const next = projected[0]
  const nextIdx = (logged.at(-1)?.set_index ?? 0) + 1
  const [setup, setSetup] = useState<LoadSetup>(next?.setup ?? (nextIdx === 1 ? straight : chained(plan)))
  const [weight, setWeight] = useState(next ? String(next.weight) : '')
  const [reps, setReps] = useState('')
  const [assisted, setAssisted] = useState(false)
  const [failed, setFailed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const formKey = `${nextIdx}|${next?.weight}|${setupLabel(next?.setup ?? straight)}`
  useEffect(() => {
    setSetup(next?.setup ?? (nextIdx === 1 ? straight : chained(plan)))
    setWeight(next ? String(next.weight) : '')
  }, [formKey])

  const nextTarget = nextIdx === 1 ? plan.planned_e1rm : lastActual !== null ? lastActual * (1 - f) : null
  const t = totals(weight === '' ? null : Number(weight), setup, equipment)
  const lastStack = logged.at(-1)?.weight_lb != null ? loadSide(logged.at(-1)!.weight_lb! / 2, kept) : null
  const changeSetup = (ns: LoadSetup) => {
    setSetup(ns)
    if (nextTarget) { const ideal = weightFor(nextTarget, ns); setWeight(String(choosePlates(ideal, plan.step_lb, kept, lastStack)?.weight ?? ideal)) }
  }
  const formStack = weight === '' ? null : loadSide(Number(weight) / 2, kept)
  const expNext = nextTarget ? expectedReps(nextTarget, t.bottom, t.top, cfg) : null
  const preview = e1rm(t.bottom, t.top, reps === '' ? null : Number(reps), assisted || failed, cfg)
  const fit = fitFatigue(actual)
  const clock = useClock(logged.at(-1)?.created_at)

  async function log() {
    if (!exerciseId || weight === '' || reps === '') return
    const last = logged.at(-1)
    const rest = last?.created_at ? Math.round((Date.now() - Date.parse(last.created_at)) / 1000) : null
    await api.addSet({
      exercise_id: exerciseId, block: 'primary', set_index: nextIdx,
      weight_lb: Number(weight), total_bottom_lb: t.bottom, total_top_lb: t.top, reps: Number(reps),
      assisted, failed, rest_s: rest,
      setup: { bar: setup.bar, clamp: setup.clamp, chain_half: setup.chain_half, chain_5_8: setup.chain_5_8, target_e1rm: nextTarget },
    })
    setReps(''); setAssisted(false); setFailed(false)
  }

  const shown = showAll ? projected.slice(1) : projected.slice(1, 5)

  return (
    <section className="card">
      <h2>Heavy · {lift}</h2>

      <div className="planfields">
        <Num label="Planned max" value={plan.planned_e1rm} onSave={v => setPlan({ planned_e1rm: v })} />
        <Num label="Target reps" value={plan.target_reps} onSave={v => v && setPlan({ target_reps: v })} />
        <Num label="Stop below %" value={plan.stop_pct} onSave={v => v !== null && setPlan({ stop_pct: v })} />
        <Num label="Fatigue %/set" value={plan.fatigue_rate_used_pct} onSave={v => v !== null && setPlan({ fatigue_rate_used_pct: v })} />
        <Num label="Weight step" value={plan.step_lb} onSave={v => v && setPlan({ step_lb: v })} />
        <Num label="Rest (s)" value={plan.rest_s} onSave={v => v && setPlan({ rest_s: v })} />
        <label>½ chains/side, sets 2+
          <select value={plan.chain_half} onChange={e => setPlan({ chain_half: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
        </label>
        <label>⅝ chains/side, sets 2+
          <select value={plan.chain_5_8} onChange={e => setPlan({ chain_5_8: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
        </label>
      </div>
      {(kept.n45 > 0 || kept.n25 > 0) && <p className="small">Keep on all session, per side: <b>{stackText([...Array(kept.n45).fill(45), ...Array(kept.n25).fill(25)])}</b></p>}
      <p className="small muted">
        {carriedFrom ? <>Planned max and fatigue carried from {carriedFrom}. </> : null}
        {currentMax ? <>Current max {round(currentMax)}. </> : null}
        {fit && <>Today’s fit: fatigue {fit.ratePct.toFixed(2)}%/set, fresh {round(fit.fresh)}. </>}
        Stop line {floor ? round(floor) : '—'}.
      </p>

      {logged.length > 0 && (
        <div className="tablewrap">
          <table className="sets">
            <thead><tr><th>#</th><th>Plates · total</th><th>Reps</th><th>Exp</th><th>e1RM</th><th></th></tr></thead>
            <tbody>
              {logged.map((r, i) => {
                const exp = targets[i] ? expectedReps(targets[i]!, r.total_bottom_lb, r.total_top_lb, cfg) : null
                const diff = exp !== null && r.reps !== null ? r.reps - (r.assisted || r.failed ? 1 : 0) - exp : null
                const below = floor !== null && actual[i] !== null && actual[i]! < floor
                return (
                  <tr key={r.id} className={below ? 'below' : ''}>
                    <td>{r.set_index}</td>
                    <td>
                      <Num className="cell" value={r.weight_lb} onSave={v => {
                        const tt = totals(v, setupOf(r), equipment)
                        api.updateSet(r.id!, { weight_lb: v, total_bottom_lb: tt.bottom, total_top_lb: tt.top })
                      }} />
                      <div className="sub2">{round(r.total_bottom_lb, 1)}{r.total_top_lb !== r.total_bottom_lb ? `→${round(r.total_top_lb, 1)}` : ''} · <button className="linkish" onClick={() => setEditing(editing === r.id ? null : r.id!)}>{setupLabel(setupOf(r))} ✎</button></div>
                      {editing === r.id && <SetupEdit setup={setupOf(r)} onChange={ns => {
                        const tt = totals(r.weight_lb, ns, equipment)
                        api.updateSet(r.id!, { setup: { ...r.setup, bar: ns.bar, clamp: ns.clamp, chain_half: ns.chain_half, chain_5_8: ns.chain_5_8 }, total_bottom_lb: tt.bottom, total_top_lb: tt.top })
                      }} />}
                    </td>
                    <td className="nowrap">
                      <Num className="cell tiny" value={r.reps} onSave={v => api.updateSet(r.id!, { reps: v })} />
                      <button className={'flag' + (r.assisted ? ' on' : '')} onClick={() => api.updateSet(r.id!, { assisted: !r.assisted })} title="Assisted">A</button>
                      <button className={'flag' + (r.failed ? ' on' : '')} onClick={() => api.updateSet(r.id!, { failed: !r.failed })} title="Failed">F</button>
                    </td>
                    <td className="small">{exp !== null ? exp.toFixed(1) : ''}{diff !== null ? <div className={diff >= 0 ? 'up' : 'down'}>{diff >= 0 ? '+' : ''}{diff.toFixed(1)}</div> : null}</td>
                    <td><b>{round(actual[i])}</b><div className="sub2">{actual[i] && actual[0] ? round((actual[i]! / actual[0]) * 100) + '%' : ''}{r.rest_s ? ` · ${fmt(r.rest_s)}` : ''}</div></td>
                    <td><button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {stopped && <p className="warn">Last set fell below {plan.stop_pct}% of set 1. Ladder done. You can still log more sets below.</p>}

      <div className="next">
        <div className="row between">
          <b>Set {nextIdx}</b>
          {logged.length > 0 && <span className={'clock' + (clock >= plan.rest_s ? ' ready' : '')}>{fmt(clock)} <span className="small muted">/ {fmt(plan.rest_s)}</span></span>}
        </div>
        <div className="row wrap">
          <label className="narrow">Plates lb<input inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} /></label>
          <label className="narrow">Reps<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)}
            placeholder={expNext !== null ? expNext.toFixed(1) : String(plan.target_reps)} /></label>
          <label className="check"><input type="checkbox" checked={assisted} onChange={e => setAssisted(e.target.checked)} /> Assisted</label>
          <label className="check"><input type="checkbox" checked={failed} onChange={e => setFailed(e.target.checked)} /> Failed</label>
        </div>
        <div className="row wrap">
          <label className="grow">Clamps
            <select value={setup.clamp} onChange={e => changeSetup({ ...setup, clamp: e.target.value })}>
              <option value={ELEIKO}>Eleiko</option><option value={CHAIN_CLAMP}>Chain clamp</option>
            </select>
          </label>
          <label className="narrow">½ chains/side
            <select value={setup.chain_half} onChange={e => changeSetup(withClamp({ ...setup, chain_half: Number(e.target.value) }))}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
          </label>
          <label className="narrow">⅝ chains/side
            <select value={setup.chain_5_8} onChange={e => changeSetup(withClamp({ ...setup, chain_5_8: Number(e.target.value) }))}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
          </label>
        </div>
        <div className="loadout">
          <div className="wide"><span className="muted small">Per side{formStack && lastStack ? ` · ${changeText(lastStack, formStack)}` : ''}</span>
            <b>{formStack ? stackText(formStack) : platesPerSide(weight === '' ? null : Number(weight)) || '—'}</b></div>
          <div><span className="muted small">Total</span><b>{round(t.bottom, 1)}{t.top !== t.bottom ? ` → ${round(t.top, 1)}` : ''}</b></div>
          <div><span className="muted small">Expect</span><b>{expNext !== null ? `${expNext.toFixed(1)} reps` : '—'}</b></div>
          <div><span className="muted small">This set</span><b>{preview !== null ? round(preview) : '—'}</b></div>
        </div>
        {!plan.planned_e1rm && nextIdx === 1 && <p className="small warn">Enter a planned max above to get set 1 weight.</p>}
        <button className="primary" onClick={log} disabled={!exerciseId || weight === '' || reps === ''}>Log set {nextIdx}</button>
      </div>

      {projected.length > 1 && (
        <div className="planned">
          <p className="small muted">Planned after this ({projected.length - 1} more sets to the stop line, re-planned after every set):</p>
          <table className="sets plannedrows">
            <thead><tr><th>#</th><th>Plates</th><th>Per side · change</th><th>Total</th></tr></thead>
            <tbody>
              {shown.map(p => {
                const tt = totals(p.weight, p.setup, equipment)
                return (
                  <tr key={p.idx}>
                    <td>{p.idx}</td><td>{p.weight}</td><td className="small">{p.stack ? stackText(p.stack) : platesPerSide(p.weight)}{p.change ? <div className="sub2">{p.change}</div> : null}</td>
                    <td className="small">{round(tt.bottom, 1)}{tt.top !== tt.bottom ? `→${round(tt.top, 1)}` : ''}<div className="sub2">{setupLabel(p.setup)}</div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {projected.length > 5 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${projected.length - 1}`}</button>}
        </div>
      )}
    </section>
  )
}

function SetupEdit({ setup, onChange }: { setup: LoadSetup; onChange: (s: LoadSetup) => void }) {
  return (
    <div className="setupedit">
      <select value={setup.clamp} onChange={e => onChange({ ...setup, clamp: e.target.value })} aria-label="Clamps">
        <option value={ELEIKO}>Eleiko</option><option value={CHAIN_CLAMP}>Chain clamp</option>
      </select>
      <select value={setup.chain_half} onChange={e => onChange(withClamp({ ...setup, chain_half: Number(e.target.value) }))} aria-label="Half-inch chains per side">
        {[0, 1, 2].map(v => <option key={v} value={v}>½×{v}</option>)}
      </select>
      <select value={setup.chain_5_8} onChange={e => onChange(withClamp({ ...setup, chain_5_8: Number(e.target.value) }))} aria-label="Five-eighths chains per side">
        {[0, 1, 2].map(v => <option key={v} value={v}>⅝×{v}</option>)}
      </select>
    </div>
  )
}
