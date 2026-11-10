import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { ALL_PLATES, e1rm, expectedReps, fitFatigue, round, roundTo, totals, effectiveLoad, keptFor, keptFromStored, loadSide, choosePlates, changeText, stackText, type LoadSetup, type Kept } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { Num, T } from './shared'

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
  /** From the exercise: its bar (null = no bar, lb is the load itself) and whether chains can hang. */
  bar: string | null
  chains_ok: boolean
  load?: string
  /** A fixed-weight implement for no-bar lifts (e.g. dip horn); its weight counts in the load. */
  implement?: string | null
  /** Plates allowed this session (sheet's "plates on" row). */
  plates_on: number[]
  /** Chains switched on for sets 2+ this session. */
  chains_on: boolean
  /** The plate that makes up the span from the lightest set to the heaviest (10s by default). */
  change_plate: number
  /** Most heavy sets to do today; null = as many as the ladder plans. */
  max_sets: number | null
  /** Set 1 weight on the bar (plates); null = calculated. */
  set1_lb: number | null
  /** Spotter in use: rep goals round up instead of down. */
  spotter: boolean
}

export const BAR = 'Ohio Power Bar'
export const ELEIKO = 'Eleiko clamps (pair)'
export const ROGUE = 'Rogue aluminum clamps (pair)'
export const CHAIN_CLAMP = 'Chain clamps (pair)'
export const CLAMPS: [string, string][] = [[ROGUE, 'Rogue'], [ELEIKO, 'Eleiko'], [CHAIN_CLAMP, 'Chain clamp']]

const geo = (p: LadderPlan) => ({ rom_in: p.rom_in, hang_in: p.hang_in })
const straightOf = (p: LadderPlan): LoadSetup =>
  p.bar ? { bar: p.bar, clamp: p.clamp || ROGUE, chain_half: 0, chain_5_8: 0, ...geo(p) } : { bar: p.implement ?? '', clamp: '', chain_half: 0, chain_5_8: 0 }
const chained = (p: LadderPlan): LoadSetup =>
  p.bar && p.chains_ok && p.chains_on && (p.chain_half || p.chain_5_8)
    ? { bar: p.bar, clamp: CHAIN_CLAMP, chain_half: p.chain_half, chain_5_8: p.chain_5_8, ...geo(p) } : straightOf(p)

export function setupOf(r?: SetRow): LoadSetup {
  const s = r?.setup ?? {}
  const clamp = s.clamp === 'Eleiko' ? ELEIKO : s.clamp === 'chain clamp' ? CHAIN_CLAMP : s.clamp ?? ROGUE
  return { bar: s.bar === undefined ? BAR : s.bar ?? '', clamp: s.bar === '' || s.bar === null ? (s.clamp ?? '') : clamp, chain_half: Number(s.chain_half ?? 0), chain_5_8: Number(s.chain_5_8 ?? 0), rom_in: s.rom_in ?? null, hang_in: s.hang_in ?? null, bands: Array.isArray(s.bands) ? s.bands : [] }
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
  const actual = logged.map(r => e1rm(r.total_bottom_lb, r.total_top_lb, r.reps, r.assisted, r.failed, cfg))
  // Target estimated max for each logged set: set 1 = planned max; after that, the previous set's actual less one set of fatigue.
  const targets: (number | null)[] = logged.map((r, i) => {
    // A set saved without reps has no result: the next set aims from the last set that has one (or the planned max).
    const prev = actual.slice(0, i).filter((a): a is number => a !== null).at(-1)
    return prev === undefined ? plan.planned_e1rm : prev * (1 - f)
  })
  const set1 = actual.find(a => a !== null) ?? plan.planned_e1rm
  const floor = set1 ? (set1 * plan.stop_pct) / 100 : null
  const lastActual = actual.filter((a): a is number => a !== null).at(-1) ?? null
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
    let target = lastActual !== null ? lastActual * (1 - f) : plan.planned_e1rm
    if (target && !stopped) {
      while (idx <= 40 && (floor === null || target >= floor) && (plan.max_sets == null || idx <= plan.max_sets)) {
        const setup = idx === 1 ? straightOf(plan) : chained(plan)
        // Set 1 override is what's on the bar (like the lb column); plates = that less the bar and clamps.
        const weight = idx === 1 && plan.set1_lb != null ? Math.max(0, plan.set1_lb - totals(0, setup, equipment).bottom!) : weightFor(target, setup)
        if (weight <= 0 && idx > 1) break
        ideal.push({ idx, target, setup, weight })
        target *= 1 - f
        idx++
      }
    }
    const working = [...logged.map(r => r.weight_lb ?? 0), ...ideal.map(p => p.weight)].filter(w => w > 0)
    const on = plan.plates_on?.length ? plan.plates_on : ALL_PLATES
    const change = on.includes(plan.change_plate) ? plan.change_plate : ([...on].sort((x, y) => x - y).find(p => p >= plan.change_plate) ?? 10)
    // Once a set is logged the kept stack is fixed for the session (it's what's physically on the bar).
    const locked = keptFromStored(logged.find(r => r.setup?.kept)?.setup?.kept, change, on)
    const kept: Kept = locked ?? keptFor(working.length ? Math.min(...working) : 0, on, change)
    const lastLogged = logged.at(-1)
    let prev: number[] | null = Array.isArray(lastLogged?.setup?.stack) ? lastLogged!.setup.stack : lastLogged?.weight_lb != null ? loadSide(lastLogged.weight_lb / 2, kept) : null
    if (!plan.bar) return { projected: ideal.map(p => ({ ...p, stack: null as number[] | null, change: '' })), kept }
    const out = ideal.map(p => {
      // An overridden set 1 stays exactly as entered.
      const c = p.idx === 1 && plan.set1_lb != null ? { weight: p.weight, stack: loadSide(p.weight / 2, kept) } : choosePlates(p.weight, plan.step_lb, kept, prev)
      const weight = c?.weight ?? p.weight
      const stack = c?.stack ?? null
      const change = stack ? changeText(prev, stack) : ''
      if (stack) prev = stack
      return { ...p, weight, stack, change }
    })
    return { projected: out, kept }
  }, [logged, plan, lastActual, floor, stopped, equipment, cfg])

  const nextIdx = (logged.at(-1)?.set_index ?? 0) + 1
  const nextTarget = lastActual !== null ? lastActual * (1 - f) : plan.planned_e1rm
  const lastStack = logged.at(-1)?.weight_lb != null ? loadSide(logged.at(-1)!.weight_lb! / 2, kept) : null
  // Volume, as on the sheet: bar total × reps, an assisted rep counting the bar less the assist, a failed rep nothing.
  const volume = logged.reduce((t, r) => {
    const load = effectiveLoad(r.total_bottom_lb, r.total_top_lb, cfg) ?? 0, reps = r.reps ?? 0
    const lost = r.failed ? 1 : 0, helped = r.assisted && !r.failed ? 1 : 0
    return t + load * Math.max(0, reps - lost - helped) + (load - cfg.assist_lb) * helped
  }, 0)
  const fit = fitFatigue(actual)
  const straight = straightOf(plan)
  return { plan, logged, actual, targets, set1, floor, stopped, lastActual, weightFor, projected, kept, nextIdx, nextTarget, lastStack, fit, straight, volume }
}

export function LadderPlanFields({ L, setPlan, carriedFrom, currentMax, lifterGeometry }: {
  L: Ladder; setPlan: (p: Partial<LadderPlan>) => void; carriedFrom?: string; currentMax: number | null
  /** Range of motion and leader-line hang for this lift, from Profile. */
  lifterGeometry?: { rom_in?: number | null; hang_in?: number | null }
}) {
  const plan = L.plan
  const on = plan.plates_on?.length ? plan.plates_on : ALL_PLATES
  const chainsShown = plan.bar && plan.chains_ok
  return (
    <>
      <div className="planfields">
        <Num label="Planned max" tip="Estimated 1-rep max set 1 aims at. Carries from the last healthy session of this exercise." value={plan.planned_e1rm} onSave={v => setPlan({ planned_e1rm: v })} />
        <Num label="Target reps" tip="Reps each set is weighted for. Weights come from target max ÷ (1 + reps/30)." value={plan.target_reps} onSave={v => v && setPlan({ target_reps: v })} />
        <Num label="Stop below %" tip="The session ends when a set's estimated max falls below this % of set 1's." value={plan.stop_pct} onSave={v => v !== null && setPlan({ stop_pct: v })} />
        <Num label="Fatigue %/set" tip="How much the estimated max drops each set. Each planned set targets the last set's actual less this %." value={plan.fatigue_rate_used_pct} onSave={v => v !== null && setPlan({ fatigue_rate_used_pct: v })} />
        <Num label="Max sets (blank = all)" tip="Cap on heavy sets today, whatever the stop line says. Blank: the ladder runs to the stop line." value={plan.max_sets} onSave={v => setPlan({ max_sets: v })} />
        <Num label="Rest (s)" tip="Target rest between heavy sets. The Rest timer above the table turns green when it's reached." value={plan.rest_s} onSave={v => v && setPlan({ rest_s: v })} />
        {plan.bar && <Num label="Set 1 lb (blank = calc)" tip="Override set 1's weight on the bar. Blank works it out from the planned max and target reps." value={plan.set1_lb} onSave={v => setPlan({ set1_lb: v })} />}
        {plan.bar && (
          <label><T tip="Clamps used on sets without chains. Chain sets always use the chain clamps.">Clamps (straight sets)</T>
            <select value={plan.clamp} onChange={e => setPlan({ clamp: e.target.value })}>{CLAMPS.filter(c => c[0] !== CHAIN_CLAMP).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        {plan.bar && (
          <label><T tip="The plate that covers the span from your lightest set to your heaviest. Everything bigger stays on all session; only plates smaller than this come and go for fine steps.">Change plate</T>
            <select value={plan.change_plate} onChange={e => setPlan({ change_plate: Number(e.target.value) })}>
              {on.filter(p => p > Math.min(...on)).map(p => <option key={p} value={p}>{p} lb</option>)}
              {!on.includes(plan.change_plate) && <option value={plan.change_plate}>{plan.change_plate} lb (off)</option>}
            </select>
          </label>
        )}
        <label className="toggle"><T tip="Rep goals round down normally; with a spotter on hand they round up, since the last rep can be helped.">Spotter</T>
          <button type="button" className={'switch' + (plan.spotter ? ' on' : '')} aria-pressed={plan.spotter} onClick={() => setPlan({ spotter: !plan.spotter })}>{plan.spotter ? 'On · goals round up' : 'Off · goals round down'}</button>
        </label>
        {chainsShown && <label className="toggle"><T tip="Off: every set straight, no chains. On: sets 2+ use the chains below.">Chains</T>
          <button type="button" className={'switch' + (plan.chains_on ? ' on' : '')} aria-pressed={plan.chains_on} onClick={() => setPlan({ chains_on: !plan.chains_on })}>{plan.chains_on ? 'On' : 'Off'}</button>
        </label>}
        {chainsShown && plan.chains_on && <>
          <label><T tip="Number of ½ in chains per side on sets 2 and up.">½ chains/side, sets 2+</T>
            <select value={plan.chain_half} onChange={e => setPlan({ chain_half: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
          </label>
          <label><T tip="Number of ⅝ in chains per side on sets 2 and up.">⅝ chains/side, sets 2+</T>
            <select value={plan.chain_5_8} onChange={e => setPlan({ chain_5_8: Number(e.target.value) })}>{[0, 1, 2].map(v => <option key={v}>{v}</option>)}</select>
          </label>
        </>}
      </div>
      {plan.bar && <PlatesOn value={plan.plates_on} onChange={v => setPlan({ plates_on: v })} />}
      {plan.bar && L.kept.base.length > 0 && (
        <p className="small">
          <T tip="Built from the lightest working set with the biggest plates that are on. Locked once set 1 is logged.">Keep on all session</T>, per side: <b>{stackText(L.kept.base)}</b>
          {' · '}span in <b>{L.kept.change}s</b>{on.some(p => p < L.kept.change) ? <>, fine steps in {on.filter(p => p < L.kept.change).join(' / ')}</> : null}
          {' · '}weight step {plan.step_lb} lb
        </p>
      )}
      {chainsShown && plan.chains_on && (plan.chain_half || plan.chain_5_8) ? (
        <p className="small muted">
          Chain load uses your range of motion{lifterGeometry?.rom_in ? <> (<b>{lifterGeometry.rom_in} in</b>)</> : ' (not set)'}
          {lifterGeometry?.hang_in ? <> and leader-line hang (<b>{lifterGeometry.hang_in} in</b>)</> : null} from Profile.
          {!lifterGeometry?.rom_in && ' Set it on Profile → this lift → Settings; until then the chain\'s fixed bottom/top weights are used.'}
        </p>
      ) : null}
      <p className="small muted">
        {carriedFrom ? <>Planned max and fatigue carried from {carriedFrom}. </> : null}
        {currentMax ? <>Current max {round(currentMax)}. </> : null}
        {L.fit && <>Today’s fit: fatigue {L.fit.ratePct.toFixed(2)}%/set, fresh {round(L.fit.fresh)}. </>}
        Stop line {L.floor ? round(L.floor) : '—'}.
      </p>
    </>
  )
}


/** The sheet's "plates on" row: tap a plate to allow or prohibit it. */
export function PlatesOn({ value, onChange }: { value: number[] | undefined; onChange: (v: number[]) => void }) {
  const on = value?.length ? value : ALL_PLATES
  const flip = (p: number) => {
    const next = on.includes(p) ? on.filter(x => x !== p) : [...on, p].sort((a, b) => b - a)
    if (next.length) onChange(next)
  }
  return (
    <div className="plates-on"><span className="small muted"><T tip="Tap a plate to allow or block it. Planned weights only use plates that are on.">Plates on</T></span>
      {ALL_PLATES.map(p => <button key={p} type="button" className={'plate' + (on.includes(p) ? ' on' : '')} aria-pressed={on.includes(p)} data-tip={on.includes(p) ? `${p} lb plates allowed. Tap to block.` : `${p} lb plates blocked. Tap to allow.`} data-pos="center" onClick={() => flip(p)}>{p}</button>)}
    </div>
  )
}
