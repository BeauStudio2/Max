import { useEffect, useState } from 'react'
import { e1rmFromRpe, platesPerSide, round, roundTo } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { ExercisePicker, Num, type Api } from './shared'

export interface DeadliftPlan { planned_top_lb: number | null; bar_lb: number }

interface Row { step: string; idx: number; pct: number | null; weight: number | null; reps: number; rpe?: boolean; ex: 'Deadlift' | 'Flywheel deadlift' }

export default function Deadlift({ week, cycle, plan, setPlan, sets, api, best, exerciseName, onExercise }: {
  exerciseName: string; onExercise: (n: string) => void;
  week: number | null; cycle?: any[]; plan: DeadliftPlan; setPlan: (p: Partial<DeadliftPlan>) => void; sets: SetRow[]; api: Api; best?: number
}) {
  const wk = week && cycle ? cycle.find(c => c.week === week) : null
  const top = plan.planned_top_lb
  const byStep = (step: string) => sets.find(s => s.setup?.step === step)
  const tops = ['top single 1', 'top single 2', 'top single 3'].map(byStep).filter(Boolean) as SetRow[]
  const bestTop = tops.reduce<SetRow | null>((m, s) => (!m || (s.weight_lb ?? 0) > (m.weight_lb ?? 0) ? s : m), null)
  const todayMax = bestTop?.weight_lb ? e1rmFromRpe(bestTop.weight_lb, bestTop.reps ?? 1, bestTop.rpe ?? null) : null

  const bo = /(\d+)×(\d+) @ (\d+)%/.exec(wk?.backoff ?? '')
  const boBase = bestTop?.weight_lb ?? top
  const rows: Row[] = []
  const warm: [number, number][] = [[40, 5], [55, 3], [70, 2], [80, 1], [90, 1]]
  warm.forEach(([p, r], i) => rows.push({ step: `warm-up ${i + 1}`, idx: i + 1, pct: p, weight: top ? roundTo((top * p) / 100, 5) : null, reps: r, ex: 'Deadlift' }))
  ;[1, 2, 3].forEach(i => rows.push({ step: `top single ${i}`, idx: 5 + i, pct: null, weight: i === 1 && top ? top : null, reps: 1, rpe: true, ex: 'Deadlift' }))
  if (bo) for (let i = 1; i <= Number(bo[1]); i++)
    rows.push({ step: `back-off ${i}`, idx: 8 + i, pct: Number(bo[3]), weight: boBase ? roundTo((boBase * Number(bo[3])) / 100, 5) : null, reps: Number(bo[2]), rpe: true, ex: 'Deadlift' })
  for (let i = 1; i <= (wk?.flywheel_sets ?? 0); i++)
    rows.push({ step: `flywheel ${i}`, idx: i, pct: null, weight: null, reps: 6, ex: 'Flywheel deadlift' })
  const extra = sets.filter(s => s.setup?.step?.startsWith('extra')).sort((a, b) => a.set_index - b.set_index)
  const maxIdx = Math.max(20, ...sets.filter(s => api.exId(exerciseName) === s.exercise_id).map(s => s.set_index))

  return (
    <section className="card">
      <h2>Deadlift{week ? ` · cycle week ${week} of 6` : ''}</h2>
      <ExercisePicker value={exerciseName} onChange={onExercise} className="exrow" />
      {wk && <p className="small"><b>{wk.pull}</b> · top: {wk.top}{wk.backoff ? ` · back-off ${wk.backoff}` : ''}</p>}
      <div className="planfields">
        <Num label="Planned top lb" value={top} onSave={v => setPlan({ planned_top_lb: v })} />
        <label>Bar
          <select value={plan.bar_lb} onChange={e => setPlan({ bar_lb: Number(e.target.value) })}>
            <option value={85}>Trap bar, balanced (85)</option><option value={65}>Trap bar, bare (65)</option><option value={45}>Ohio Power Bar (45)</option>
          </select>
        </label>
      </div>
      <p className="small muted">
        {best ? <>Best conventional {best} (85% {roundTo(best * 0.85, 5)} · 92% {roundTo(best * 0.92, 5)} · 97% {roundTo(best * 0.97, 5)}). </> : null}
        {todayMax ? <>Today’s estimate <b>{round(todayMax)}</b> from the best top single and its RPE.</> : 'Weights are totals including the bar.'}
      </p>
      <div className="tablewrap">
        <table className="sets dl">
          <thead><tr><th></th><th>lb · per side</th><th>Reps</th><th>RPE</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => <PullRow key={r.step} main={exerciseName} row={r} existing={sets.find(s => s.setup?.step === r.step)} bar={plan.bar_lb} api={api} />)}
            {extra.map(s => <PullRow key={s.id} main={exerciseName} row={{ step: s.setup.step, idx: s.set_index, pct: null, weight: s.weight_lb, reps: s.reps ?? 1, rpe: true, ex: 'Deadlift' }} existing={s} bar={plan.bar_lb} api={api} />)}
          </tbody>
        </table>
      </div>
      <button className="ghost" onClick={() => api.addSet({
        exercise_id: api.exId(exerciseName)!, block: 'deadlift', set_index: maxIdx + 1, weight_lb: null, total_bottom_lb: null, total_top_lb: null,
        reps: null, assisted: false, failed: false, setup: { step: `extra ${extra.length + 1}`, bar_lb: plan.bar_lb },
      })}>+ Add pull</button>
    </section>
  )
}

function PullRow({ row, existing, bar, api, main }: { main: string; row: Row; existing?: SetRow; bar: number; api: Api }) {
  const fly = row.ex === 'Flywheel deadlift'
  const [w, setW] = useState('')
  const [reps, setReps] = useState('')
  const [rpe, setRpe] = useState('')
  useEffect(() => {
    setW(existing?.weight_lb?.toString() ?? (fly ? existing?.setup?.inertia ?? '' : row.weight?.toString() ?? ''))
    setReps(existing?.reps?.toString() ?? ''); setRpe(existing?.rpe?.toString() ?? '')
  }, [existing?.id, row.weight])
  const done = !!existing && existing.reps !== null

  async function save(nextReps = reps, nextRpe = rpe, nextW = w) {
    const weight = !fly && nextW ? Number(nextW) : null
    const patch: Partial<SetRow> = {
      weight_lb: weight, total_bottom_lb: weight, total_top_lb: weight,
      reps: nextReps ? Number(nextReps) : null, rpe: nextRpe ? Number(nextRpe) : null,
      setup: { ...(existing?.setup ?? {}), step: row.step, bar_lb: bar, ...(fly ? { inertia: nextW || null } : {}) },
    }
    if (existing?.id) await api.updateSet(existing.id, patch)
    else if (patch.reps !== null) await api.addSet({
      exercise_id: api.exId(row.ex === 'Deadlift' ? main : row.ex)!, block: 'deadlift', set_index: row.idx, assisted: false, failed: false, ...patch,
    } as any)
  }

  return (
    <tr className={done ? 'donerow' : ''}>
      <td className="small nowrap">{short(row.step)}{row.pct ? <div className="sub2">{row.pct}%</div> : null}</td>
      <td><input className="cell" inputMode={fly ? 'text' : 'decimal'} placeholder={fly ? 'inertia' : ''} value={w} onChange={e => setW(e.target.value)} onBlur={() => existing && save()} />
        <div className="sub2 wrap">{fly ? `goal ${row.reps}` : `${platesPerSide(w ? Number(w) - bar : null)} · goal ${row.reps}`}</div></td>
      <td><input className="cell tiny" inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} onBlur={() => save()} /></td>
      <td>{row.rpe ? <input className="cell tiny" inputMode="decimal" value={rpe} onChange={e => setRpe(e.target.value)} onBlur={() => existing && save()} /> : null}</td>
      <td>{existing ? <button className="x" onClick={() => api.deleteSet(existing.id!)} aria-label="Delete">×</button>
        : <button className="tick" onClick={() => { const r = reps || String(row.reps); setReps(r); save(r) }} aria-label="Log as planned">✓</button>}</td>
    </tr>
  )
}

const short = (step: string) => step.replace('warm-up ', 'Warm ').replace('top single ', 'Top ').replace('back-off ', 'Back ').replace('flywheel ', 'Fly ').replace('extra ', 'Extra ')
