import { useEffect, useState } from 'react'
import { e1rmFromRpe, platesPerSide, round, roundTo } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { Num, T, type Api } from './shared'
import { PlatesOn } from './Ladder'

export interface DeadliftPlan { planned_top_lb: number | null; bar_lb: number; rest_s?: number; plates_on?: number[] }

interface Row { step: string; idx: number; pct: number | null; weight: number | null; reps: number; rpe?: boolean; ex: 'Deadlift' | 'Flywheel deadlift'; setup?: string }

export type DeadliftCtl = ReturnType<typeof useDeadlift>
export type PullRowDef = Row

/** The Saturday plan as rows: warm-ups from the planned top, top singles, back-offs off the best single, flywheel sets. */
export function useDeadlift({ week, cycle, plan, sets, api, exerciseName, resetKey = '' }: {
  resetKey?: string; week: number | null; cycle?: any[]; plan: DeadliftPlan; sets: SetRow[]; api: Api; exerciseName: string
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
    rows.push({ step: `back-off ${i}`, idx: 8 + i, pct: Number(bo[3]), weight: boBase ? roundTo((boBase * Number(bo[3])) / 100, 5) : null, reps: Number(bo[2]), rpe: true, ex: 'Deadlift', setup: wk?.backoff_setup || undefined })
  for (let i = 1; i <= (wk?.flywheel_sets ?? 0); i++)
    rows.push({ step: `flywheel ${i}`, idx: i, pct: null, weight: null, reps: 6, ex: 'Flywheel deadlift' })
  const extra = sets.filter(s => s.setup?.step?.startsWith('extra')).sort((a, b) => a.set_index - b.set_index)
  for (const x of extra) rows.push({ step: x.setup.step, idx: x.set_index, pct: null, weight: x.weight_lb, reps: x.reps ?? 1, rpe: true, ex: 'Deadlift' })
  const [added, setAdded] = useState(0)
  useEffect(() => setAdded(0), [resetKey])
  for (let i = 1; i <= added; i++) {
    const step = `extra ${extra.length + i}`
    if (!rows.some(r => r.step === step)) rows.push({ step, idx: 20 + extra.length + i, pct: null, weight: bestTop?.weight_lb ?? top, reps: 1, rpe: true, ex: 'Deadlift' })
  }
  const withSets = rows.map(r => ({ row: r, existing: byStep(r.step) }))
  return { wk, week, top, todayMax, rows: withSets, plan, main: exerciseName, addPull: () => setAdded(n => n + 1), api }
}

export function DeadliftPlanFields({ D, setPlan, best }: { D: DeadliftCtl; setPlan: (p: Partial<DeadliftPlan>) => void; best?: number }) {
  return (
    <>
      {D.wk && <p className="small"><b>Week {D.week} of 6: {D.wk.pull}</b>{D.wk.setup ? ` · ${D.wk.setup}` : ''} · top: {D.wk.top}{D.wk.backoff ? ` · back-off ${D.wk.backoff}` : ''}</p>}
      <div className="planfields">
        <Num label="Planned top lb" tip="Expected best single today. Warm-ups are percentages of it; back-offs use the best single once logged." value={D.top} onSave={v => setPlan({ planned_top_lb: v })} />
        <label><T tip="Bar weight. Plates per side are worked out from the total less the bar.">Bar</T>
          <select value={D.plan.bar_lb} onChange={e => setPlan({ bar_lb: Number(e.target.value) })}>
            <option value={85}>Trap bar, balanced (85)</option><option value={65}>Trap bar, bare (65)</option><option value={45}>Ohio Power Bar (45)</option>
          </select>
        </label>
        <Num label="Rest (s)" tip="Target rest between pulls." value={D.plan.rest_s ?? 180} onSave={v => v && setPlan({ rest_s: v })} />
      </div>
      <PlatesOn value={D.plan.plates_on} onChange={v => setPlan({ plates_on: v })} />
      <p className="small muted">
        {best ? <>Best conventional {best} (85% {roundTo(best * 0.85, 5)} · 92% {roundTo(best * 0.92, 5)} · 97% {roundTo(best * 0.97, 5)}). </> : null}
        {D.todayMax ? <>Today’s estimate <b>{round(D.todayMax)}</b> from the best top single and its RPE. </> : null}
        Weights are totals including the bar.
      </p>
    </>
  )
}

export const pullLabel = (r: Row) => r.step[0].toUpperCase() + r.step.slice(1) + (r.pct ? ` · ${r.pct}%` : '')

/** One pull: weight (or flywheel inertia), reps and RPE. Logs on the button in the Now card; saves as you go when editing. */
export function PullForm({ row, existing, D, mode = 'now', extraSetup }: { row: Row; existing?: SetRow; D: DeadliftCtl; mode?: 'now' | 'edit'; extraSetup?: () => Record<string, any> }) {
  const fly = row.ex === 'Flywheel deadlift'
  const bar = D.plan.bar_lb
  const [w, setW] = useState('')
  const [reps, setReps] = useState('')
  const [rpe, setRpe] = useState('')
  useEffect(() => {
    setW(existing?.weight_lb?.toString() ?? (fly ? existing?.setup?.inertia ?? '' : row.weight?.toString() ?? ''))
    setReps(existing?.reps?.toString() ?? (mode === 'now' ? '' : '')); setRpe(existing?.rpe?.toString() ?? '')
  }, [existing?.id, row.weight])

  async function save(nextReps = reps) {
    const weight = !fly && w ? Number(w) : null
    const patch: Partial<SetRow> = {
      weight_lb: weight, total_bottom_lb: weight, total_top_lb: weight,
      reps: nextReps ? Number(nextReps) : null, rpe: rpe ? Number(rpe) : null,
      setup: { ...(existing?.setup ?? {}), step: row.step, bar_lb: bar, ...(fly ? { inertia: w || null } : {}), ...(existing ? {} : extraSetup?.() ?? {}) },
    }
    if (existing?.id) await D.api.updateSet(existing.id, patch)
    else if (patch.reps !== null) await D.api.addSet({
      exercise_id: D.api.exId(row.ex === 'Deadlift' ? D.main : row.ex)!, block: 'deadlift', set_index: row.idx, assisted: false, failed: false, ...patch,
    } as any)
  }
  const blur = () => { if (mode === 'edit') save() }
  return (
    <div>
      <div className="row wrap">
        <label className="narrow">{fly ? 'Inertia' : 'Total lb'}<input inputMode={fly ? 'text' : 'decimal'} value={w} onChange={e => setW(e.target.value)} onBlur={blur} /></label>
        <label className="narrow">Reps<input inputMode="numeric" value={reps} placeholder={String(row.reps)} onChange={e => setReps(e.target.value)} onBlur={blur} /></label>
        {row.rpe && <label className="narrow">RPE<input inputMode="decimal" value={rpe} onChange={e => setRpe(e.target.value)} onBlur={blur} /></label>}
      </div>
      {!fly && <p className="small muted">Per side: <b>{platesPerSide(w ? Number(w) - bar : null) || '—'}</b> · goal {row.reps} rep{row.reps > 1 ? 's' : ''}</p>}
      {mode === 'now'
        ? <button className="primary" onClick={() => { const r = reps || String(row.reps); setReps(r); save(r) }}>Log {row.step}{reps ? '' : ` (${row.reps} rep${row.reps > 1 ? 's' : ''})`}</button>
        : existing && <button className="ghost small" onClick={() => D.api.deleteSet(existing.id!)}>Delete</button>}
    </div>
  )
}

const short = (step: string) => step.replace('warm-up ', 'Warm ').replace('top single ', 'Top ').replace('back-off ', 'Back ').replace('flywheel ', 'Fly ').replace('extra ', 'Extra ')
