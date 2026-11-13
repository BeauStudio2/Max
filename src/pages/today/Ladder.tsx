import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { ALL_PLATES, e1rm, expectedReps, fitFatigue, round, roundTo, totals, effectiveLoad, keptFor, keptFromStored, loadSide, choosePlates, changeText, stackText, type LoadSetup, type Kept } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { Num, T } from './shared'
import { crOf, startLevel, strengthAt, type Cr } from '../../lib/creatine'

export interface LadderPlan {
  planned_e1rm: number | null
  target_reps: number
  stop_pct: number
  fatigue_rate_used_pct: number
  /** % the estimated max falls per rep done. When unset, the per-set rate above spread over the target reps. */
  fatigue_rep_pct?: number | null
  step_lb: number
  rest_s: number
  /** Seconds allowed for each speed set done between heavy sets (added to the rest target). */
  speed_set_s?: number
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
  /** Heavy ended early by hand (or at Finish): no more heavy sets are planned. */
  heavy_ended?: { at: string; after_set: number; reason?: string } | null
  /** Set 1 weight on the bar (plates); null = calculated. */
  set1_lb: number | null
  /** This lifter's fitted creatine numbers for this lift, if any. */
  cr?: Partial<Cr>
  /** Auto spotter mode: weights, reps and rest come from the creatine model. */
  spotter: boolean
  /** S switched on or off on single sets (by set number); a set not listed follows Auto spotter (never set 1). */
  spot_rows?: Record<string, boolean>
  /** Reading a Tindeq recording of a spotter set: pull above this (lb) for at least this long (s) is one spotted rep. */
  assist_min_lb: number; assist_min_s: number
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

/** Set marked "not to max": weight and reps set by hand, left out of e1RM, fatigue and the ladder. */
export const isSubmax = (r?: SetRow | null) => !!r?.setup?.submax

/** All of the ladder's math: targets, stop line, the projected sets with plate choices. */
/** The plan's fatigue per rep, in %. */
export const perRep = (plan: { fatigue_rep_pct?: number | null; fatigue_rate_used_pct: number; target_reps: number }) =>
  plan.fatigue_rep_pct ?? plan.fatigue_rate_used_pct / Math.max(1, plan.target_reps)

export function useLadder(plan: LadderPlan, sets: SetRow[]) {
  const { equipment, cfg } = useStore()
  // Fatigue is counted per rep: a set of n reps takes (1 − fr)^n off the estimated max. A planned set is taken at the target reps.
  const fr = perRep(plan) / 100
  const after = (reps: number | null | undefined) => (1 - fr) ** (reps ?? plan.target_reps)
  const stepPlan = after(plan.target_reps)
  const logged = useMemo(() => [...sets].sort((a, b) => a.set_index - b.set_index), [sets])
  const cr = { ...crOf(cfg), ...(plan.cr ?? {}) }
  // A spotter set (every rep assisted as needed) says nothing about the max from its rep count. Its estimate comes from the Tindeq:
  // strength on the first measured rep is the bar less its assist; carried back to the start of the set along the creatine curve.
  const spotE1rm = (r: SetRow) => {
    const pulses = r.setup?.spot?.pulses as { mean: number }[] | undefined
    if (!pulses?.length || r.total_bottom_lb == null || r.total_top_lb == null) return null
    const load = (r.total_bottom_lb + r.total_top_lb) / 2
    const k = Math.max(1, (r.reps ?? pulses.length) - pulses.length + 1)
    const P0 = startLevel(r.set_index, cr), Pk = P0 * (1 - cr.cost) ** (k - 1)
    return Math.round(((load - pulses[0].mean) / strengthAt(Pk, cr)) * strengthAt(P0, cr) * 10) / 10
  }
  // A "not to max" set (rehab, technique, anything stopped short on purpose) says nothing about the max: no estimate from it.
  const actual = logged.map(r => isSubmax(r) ? null : r.setup?.spot?.mode === 'all' ? spotE1rm(r) : e1rm(r.total_bottom_lb, r.total_top_lb, r.reps, r.assisted, r.failed, cfg))
  // Target estimated max for each logged set: set 1 = planned max; after that, the last good set's actual less one fatigue step per set since.
  // A set is "low" when its reps came in under half of what its target predicted (a misload, a miss, a set cut short). A low set, like
  // a set saved without reps, doesn't steer what follows: the next sets keep aiming from the last good set.
  const targets: (number | null)[] = []
  const low: boolean[] = []
  // `cur` is the estimated max going into each set: a good set resets it to what that set measured; every set then takes its reps off it.
  let cur: number | null = plan.planned_e1rm
  logged.forEach((r, i) => {
    const target = cur
    targets.push(target)
    // A not-to-max set is logged and counts in volume, but it neither resets the estimate nor takes fatigue off it.
    if (isSubmax(r)) { low.push(false); return }
    const exp = target !== null && r.setup?.spot?.mode !== 'all' ? expectedReps(target, r.total_bottom_lb, r.total_top_lb, cfg) : null
    const isLow = r.reps !== null && exp !== null && exp >= 2 && r.reps < exp / 2
    low.push(isLow)
    if (actual[i] !== null && !isLow) cur = actual[i]
    if (cur !== null) cur *= after(r.reps)
  })
  const nextTarget0: number | null = cur
  const good = actual.filter((a, i): a is number => a !== null && !low[i])
  const set1 = good[0] ?? plan.planned_e1rm
  const floor = set1 ? (set1 * plan.stop_pct) / 100 : null
  const lastActual = good.at(-1) ?? null
  const stopped = !!plan.heavy_ended || (logged.length > 0 && floor !== null && lastActual !== null && lastActual < floor)

  // Auto spotter: rep 1 is set at a fraction of strength at the start of the set (creatine at the recovery target after set 1).
  // The target max comes from the last measured set, which was taken at that set's own starting level.
  // This lifter's fitted numbers for this lift (Profile settings) override the Config defaults.
  const basis = logged.length ? startLevel(logged.at(-1)!.set_index, cr) : 1
  const spotFor = (idx: number) => plan.spot_rows?.[idx] ?? (plan.spotter && idx > 1)
  const weightFor = (target: number, s: LoadSetup, idx = 2, spot = spotFor(idx)) => {
    const needed = spot
      ? cr.start * target * (strengthAt(startLevel(idx, cr), cr) / strengthAt(idx <= 1 ? 1 : basis, cr))
      : target / (1 + plan.target_reps / cfg.rep_divisor)
    const zero = totals(0, s, equipment)
    const extras = effectiveLoad(zero.bottom, zero.top, cfg) ?? 0
    return Math.max(0, roundTo(needed - extras, plan.step_lb))
  }

  // Projected remaining sets: ideal weights first, then the 45s/25s to keep on (from the lightest working set),
  // then each set's weight nudged one step either way if that saves plate moves.
  const { projected, kept } = useMemo(() => {
    const ideal: { idx: number; target: number; setup: LoadSetup; weight: number }[] = []
    let idx = (logged.at(-1)?.set_index ?? 0) + 1
    let target = nextTarget0
    const row = (idx: number, target: number) => {
      const setup = idx === 1 ? straightOf(plan) : chained(plan)
      // Set 1 override is what's on the bar (like the lb column); plates = that less the bar and clamps.
      const weight = idx === 1 && plan.set1_lb != null ? Math.max(0, plan.set1_lb - totals(0, setup, equipment).bottom!) : weightFor(target, setup, idx)
      return { idx, target, setup, weight }
    }
    if (target && !stopped) {
      while (idx <= 40 && (floor === null || target >= floor) && (plan.max_sets == null || idx <= plan.max_sets)) {
        const r = row(idx, target)
        if (r.weight <= 0 && idx > 1) break
        ideal.push(r)
        target *= stepPlan
        idx++
      }
    }
    // The sheet never runs out: past the stop line or the max sets there is still one open row, planned from the last good set
    // less the fatigue steps since, so another set can always be logged by hand.
    if (!ideal.length && nextTarget0 && !plan.heavy_ended) ideal.push(row((logged.at(-1)?.set_index ?? 0) + 1, nextTarget0))
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
  }, [logged, plan, nextTarget0, floor, stopped, equipment, cfg])

  const nextIdx = (logged.at(-1)?.set_index ?? 0) + 1
  const nextTarget = nextTarget0
  const lastStack = logged.at(-1)?.weight_lb != null ? loadSide(logged.at(-1)!.weight_lb! / 2, kept) : null
  // Volume, as on the sheet: bar total × reps, an assisted rep counting the bar less the assist, a failed rep nothing.
  const volume = logged.reduce((t, r) => {
    const load = effectiveLoad(r.total_bottom_lb, r.total_top_lb, cfg) ?? 0, reps = r.reps ?? 0
    const lost = r.failed ? 1 : 0, helped = r.assisted && !r.failed ? 1 : 0
    return t + load * Math.max(0, reps - lost - helped) + (load - cfg.assist_lb) * helped
  }, 0)
  const fit = fitFatigue(actual)
  // Tonight's measured fatigue per rep: the fall from the first good set to the last, spread over the reps done in between.
  const fitRep = (() => {
    const g = logged.map((r, i) => ({ r, a: actual[i], ok: actual[i] !== null && !low[i] })).filter(x => x.ok)
    if (g.length < 3) return null
    const i0 = logged.indexOf(g[0].r), i1 = logged.indexOf(g.at(-1)!.r)
    const reps = logged.slice(i0, i1).reduce((t, r) => t + (r.reps ?? 0), 0)
    return reps > 0 && g.at(-1)!.a! < g[0].a! ? (1 - (g.at(-1)!.a! / g[0].a!) ** (1 / reps)) * 100 : null
  })()
  const straight = straightOf(plan)
  return { plan, logged, actual, targets, low, set1, floor, stopped, lastActual, weightFor, projected, kept, nextIdx, nextTarget, lastStack, fit, fitRep, straight, volume, cr, spotBasis: basis }
}

export function LadderPlanFields({ L, setPlan, carriedFrom, currentMax, lifterGeometry, src = () => undefined }: {
  /** Where each field's value came from (colour code). */
  src?: (k: string) => 'def' | 'dyn' | 'user' | undefined;
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
        <Num label="Planned max" tip="Estimated 1-rep max set 1 aims at. Carries from the last healthy session of this exercise." origin={src('planned_e1rm')} value={plan.planned_e1rm} onSave={v => setPlan({ planned_e1rm: v })} />
        <Num label="Target reps" tip="Reps each set is weighted for. Weights come from target max ÷ (1 + reps/30)." origin={src('target_reps')} value={plan.target_reps} onSave={v => v && setPlan({ target_reps: v })} />
        <Num label="Stop below %" tip="The session ends when a set's estimated max falls below this % of set 1's." origin={src('stop_pct')} value={plan.stop_pct} onSave={v => v !== null && setPlan({ stop_pct: v })} />
        <Num label="Fatigue %/rep" tip="How much the estimated max falls for each rep done. After a set, the next one aims at that set's result less this % for every rep in it; planned sets count the target reps." origin={src('fatigue_rep_pct')} value={Math.round(perRep(plan) * 100) / 100} onSave={v => v !== null && v >= 0 && setPlan({ fatigue_rep_pct: v })} />
        <Num label="Max sets" placeholder="all" tip="Cap on heavy sets today, whatever the stop line says. Blank: the ladder runs to the stop line." origin={src('max_sets')} value={plan.max_sets} onSave={v => setPlan({ max_sets: v })} />
        <Num label="Rest (s)" tip="Target rest between heavy sets. The Rest timer above the table turns green when it's reached." origin={src('rest_s')} value={plan.rest_s} onSave={v => v && setPlan({ rest_s: v })} />
        <Num label="Speed set (s)" tip="When speed sets are done between heavy sets, the rest timer allows this many seconds more for each one, so there is time to do them before the next heavy set." origin={src('speed_set_s')} value={plan.speed_set_s ?? 25} onSave={v => v !== null && v >= 0 && setPlan({ speed_set_s: v })} />
        {plan.bar && <Num label="Set 1 lb" placeholder="calc" tip="Override set 1's weight on the bar. Blank works it out from the planned max and target reps." origin={src('set1_lb')} value={plan.set1_lb} onSave={v => setPlan({ set1_lb: v })} />}
        {plan.bar && (
          <label><T tip="Clamps used on sets without chains. Chain sets always use the chain clamps.">Clamps</T>
            <select className={'o-' + (src('clamp') ?? 'def')} value={plan.clamp} onChange={e => setPlan({ clamp: e.target.value })}>{CLAMPS.filter(c => c[0] !== CHAIN_CLAMP).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        {plan.bar && (
          <label><T tip="The plate that covers the span from your lightest set to your heaviest. Everything bigger stays on all session; only plates smaller than this come and go for fine steps.">Change plate</T>
            <select className={'o-' + (src('change_plate') ?? 'def')} value={plan.change_plate} onChange={e => setPlan({ change_plate: Number(e.target.value) })}>
              {on.filter(p => p > Math.min(...on)).map(p => <option key={p} value={p}>{p} lb</option>)}
              {!on.includes(plan.change_plate) && <option value={plan.change_plate}>{plan.change_plate} lb (off)</option>}
            </select>
          </label>
        )}
        <label className="toggle"><T tip="Auto spotter (S) on every set after set 1. Max sets the weight near your strength at the start of the set and the number of reps (until creatine is spent); the spotter helps on every rep as needed so all of them get done. Rest is the time to refill creatine. Off: the normal rep-target ladder.">Auto spotter</T>
          <button type="button" className={'switch' + (plan.spotter ? ' on' : '')} aria-pressed={plan.spotter} onClick={() => setPlan({ spotter: !plan.spotter })}>{plan.spotter ? 'On' : 'Off'}</button>
        </label>
        {plan.spotter && <Num label="Assist above (lb)" tip="Reading a Tindeq recording: a spotted rep is a stretch of pull above this. Raise it if small tugs get counted; lower it if light assists are missed." origin={src('assist_min_lb')} value={plan.assist_min_lb} onSave={v => v !== null && v >= 0 && setPlan({ assist_min_lb: v })} />}
        {plan.spotter && <Num label="Shortest rep (s)" tip="Reading a Tindeq recording: pulls shorter than this are ignored as blips." origin={src('assist_min_s')} value={plan.assist_min_s} onSave={v => v !== null && v >= 0 && setPlan({ assist_min_s: v })} />}
        {chainsShown && <label className="toggle"><T tip="Off: every set straight, no chains. On: sets 2+ use the chain counts set for this day on the Plan page. Any single set can be changed in its chain columns.">Chains</T>
          <button type="button" className={'switch' + (plan.chains_on ? ' on' : '')} aria-pressed={plan.chains_on} onClick={() => setPlan({ chains_on: !plan.chains_on })}>{plan.chains_on ? 'On' : 'Off'}</button>
        </label>}
      </div>
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
          {lifterGeometry?.hang_in != null ? <> and the chain off the floor at the bottom (<b>{lifterGeometry.hang_in} in</b>)</> : null} from Profile.
          {(!lifterGeometry?.rom_in || lifterGeometry?.hang_in == null) && ' Until both are set on Profile → this lift → Settings, the chain\'s fixed bottom/top weights are used.'}
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
