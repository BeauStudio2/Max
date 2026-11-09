import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { e1rm, expectedReps, fitFatigue, platesPerSide, round, roundTo, totals, effectiveLoad, keptFor, loadSide, choosePlates, changeText, stackText, type LoadSetup, type Kept } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { Num } from './shared'

export interface LadderPlan {
  planned_e1rm: number | null
  target_reps: number
  stop_pct: number
  fatigue_rate_used_pct: number
  step_lb: number
  rest_s: number
  chain_half: number
  chain_5_8: number
  clamp: string
  rom_in: number | null
  hang_in: number | null
}

export const BAR = 'Ohio Power Bar'
export const ELEIKO = 'Eleiko clamps (pair)'
export const ROGUE = 'Rogue aluminum clamps (pair)'
export const CHAIN_CLAMP = 'Chain clamp + carabiner (pair)'
export const CLAMPS: [string, string][] = [[ROGUE, 'Rogue'], [ELEIKO, 'Eleiko'], [CHAIN_CLAMP, 'Chain clamp']]

const geo = (p: LadderPlan) => ({ rom_in: p.rom_in, hang_in: p.hang_in })
const straightOf = (p: LadderPlan): LoadSetup => ({ bar: BAR, clamp: p.clamp || ROGUE, chain_half: 0, chain_5_8: 0, ...geo(p) })
const chained = (p: LadderPlan): LoadSetup =>
  p.chain_half || p.chain_5_8 ? { bar: BAR, clamp: CHAIN_CLAMP, chain_half: p.chain_half, chain_5_8: p.chain_5_8, ...geo(p) } : straightOf(p)

export function setupOf(r?: SetRow): LoadSetup {
  const s = r?.setup ?? {}
  const clamp = s.clamp === 'Eleiko' ? ELEIKO : s.clamp === 'chain clamp' ? CHAIN_CLAMP : s.clamp ?? ROGUE
  return { bar: s.bar ?? BAR, clamp, chain_half: Number(s.chain_half ?? 0), chain_5_8: Number(s.chain_5_8 ?? 0), rom_in: s.rom_in ?? null, hang_in: s.hang_in ?? null }
}

/** Chains hang from the chain clamp; with no chains the set goes back to the lifter's normal clamps. */
export const withClamp = (s: LoadSetup, straightClamp: string): LoadSetup =>
  ({ ...s, clamp: s.chain_half || s.chain_5_8 ? CHAIN_CLAMP : s.clamp === CHAIN_CLAMP ? straightClamp : s.clamp })

export const setupLabel = (s: LoadSetup) => {
  const parts = []
  if (s.chain_half) parts.push(`½×${s.chain_half}`)
  if (s.chain_5_8) parts.push(`⅝×${s.chain_5_8}`)
  return parts.length ? parts.join(' ') : 'straight'
}

export type Ladder = ReturnType<typeof useLadder>

/** All of the ladder's math: targets, stop line, the projected sets with plate choices. */
export function useLadder(plan: LadderPlan, sets: SetRow[]) {
  const { equipment, cfg } = useStore()
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
  const { projected, kept } = useMemo(() => {
    const ideal: { idx: number; target: number; setup: LoadSetup; weight: number }[] = []
    let idx = (logged.at(-1)?.set_index ?? 0) + 1
    let target = logged.length === 0 ? plan.planned_e1rm : lastActual !== null ? lastActual * (1 - f) : null
    if (target && !stopped) {
      while (idx <= 40 && (floor === null || target >= floor)) {
        const setup = idx === 1 ? straightOf(plan) : chained(plan)
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

  const nextIdx = (logged.at(-1)?.set_index ?? 0) + 1
  const nextTarget = nextIdx === 1 ? plan.planned_e1rm : lastActual !== null ? lastActual * (1 - f) : null
  const lastStack = logged.at(-1)?.weight_lb != null ? loadSide(logged.at(-1)!.weight_lb! / 2, kept) : null
  const fit = fitFatigue(actual)
  const straight = straightOf(plan)
  return { plan, logged, actual, targets, set1, floor, stopped, lastActual, weightFor, projected, kept, nextIdx, nextTarget, lastStack, fit, straight }
}

export function LadderPlanFields({ L, setPlan, carriedFrom, currentMax }: {
  L: Ladder; setPlan: (p: Partial<LadderPlan>) => void; carriedFrom?: string; currentMax: number | null
}) {
  const plan = L.plan
  return (
    <>
      <div className="planfields">
        <Num label="Planned max" value={plan.planned_e1rm} onSave={v => setPlan({ planned_e1rm: v })} />
        <Num label="Target reps" value={plan.target_reps} onSave={v => v && setPlan({ target_reps: v })} />
        <Num label="Stop below %" value={plan.stop_pct} onSave={v => v !== null && setPlan({ stop_pct: v })} />
        <Num label="Fatigue %/set" value={plan.fatigue_rate_used_pct} onSave={v => v !== null && setPlan({ fatigue_rate_used_pct: v })} />
        <Num label="Weight step" value={plan.step_lb} onSave={v => v && setPlan({ step_lb: v })} />
        <Num label="Rest (s)" value={plan.rest_s} onSave={v => v && setPlan({ rest_s: v })} />
        <Num label="Range of motion (in)" value={plan.rom_in} onSave={v => setPlan({ rom_in: v })} />
        <Num label="Chain hang at bottom (in)" value={plan.hang_in} onSave={v => setPlan({ hang_in: v })} />
        <label>Clamps (straight sets)
          <select value={plan.clamp} onChange={e => setPlan({ clamp: e.target.value })}>{CLAMPS.filter(c => c[0] !== CHAIN_CLAMP).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>½ chains/side, sets 2+
          <select value={plan.chain_half} onChange={e => setPlan({ chain_half: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
        </label>
        <label>⅝ chains/side, sets 2+
          <select value={plan.chain_5_8} onChange={e => setPlan({ chain_5_8: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
        </label>
      </div>
      {(L.kept.n45 > 0 || L.kept.n25 > 0) && <p className="small">Keep on all session, per side: <b>{stackText([...Array(L.kept.n45).fill(45), ...Array(L.kept.n25).fill(25)])}</b></p>}
      <p className="small muted">
        {carriedFrom ? <>Planned max and fatigue carried from {carriedFrom}. </> : null}
        {currentMax ? <>Current max {round(currentMax)}. </> : null}
        {L.fit && <>Today’s fit: fatigue {L.fit.ratePct.toFixed(2)}%/set, fresh {round(L.fit.fresh)}. </>}
        Stop line {L.floor ? round(L.floor) : '—'}.
      </p>
    </>
  )
}

