import type { Config, Equipment } from './types'

export interface LoadSetup { bar: string; clamp: string; chain_half: number; chain_5_8: number }

export const LIFT_EXERCISE: Record<string, string> = { bench: 'Bench Press', squat: 'Squat', deadlift: 'Deadlift' }

const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/** Totals at the bottom (chest / hole) and top (lockout), including bar, clamps and chains hanging per side. */
export function totals(weight: number | null, s: LoadSetup, eq: Equipment[]) {
  if (weight === null || Number.isNaN(weight)) return { bottom: null, top: null }
  const bar = eq.find(e => e.name === s.bar)
  const clamp = eq.find(e => e.name === s.clamp)
  const half = eq.find(e => e.name === 'Chain 1/2')?.props ?? {}
  const big = eq.find(e => e.name === 'Chain 5/8')?.props ?? {}
  const base = weight + n(bar?.weight_lb) + n(clamp?.weight_lb)
  const bottom = base + 2 * (n(s.chain_half) * n(half.bottom_lb_per_side) + n(s.chain_5_8) * n(big.bottom_lb_per_side))
  const top = base + 2 * (n(s.chain_half) * n(half.top_lb_per_side) + n(s.chain_5_8) * n(big.top_lb_per_side))
  return { bottom, top }
}

export function effectiveLoad(bottom: number | null, top: number | null, cfg: Config) {
  if (bottom === null) return null
  return bottom * cfg.chain_bottom_ratio + (top ?? bottom) * cfg.chain_top_ratio
}

/** Same formula as the set_estimates view: Epley with an assisted or failed rep not counted. */
export function e1rm(bottom: number | null, top: number | null, reps: number | null, assistedOrFailed: boolean, cfg: Config) {
  const load = effectiveLoad(bottom, top, cfg)
  if (load === null || reps === null) return null
  return load * (1 + (reps - (assistedOrFailed ? 1 : 0)) / cfg.rep_divisor)
}

/** Plate weight that makes `targetReps` land on `targetE1rm`, given the bar, clamps and chains. */
export function weightFor(targetE1rm: number, targetReps: number, s: LoadSetup, eq: Equipment[], cfg: Config, step = 2.5) {
  const neededLoad = targetE1rm / (1 + targetReps / cfg.rep_divisor)
  const zero = totals(0, s, eq)
  const extras = (zero.bottom ?? 0) * cfg.chain_bottom_ratio + (zero.top ?? 0) * cfg.chain_top_ratio
  const w = neededLoad - extras
  return Math.max(0, Math.floor(w / step) * step)
}

export const round = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(d)

export function localDate(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return z.toISOString().slice(0, 10)
}

export function weekdayOf(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Reps the model expects at this load when the set's target estimated max is `target`. */
export function expectedReps(target: number, bottom: number | null, top: number | null, cfg: Config) {
  const load = effectiveLoad(bottom, top, cfg)
  if (!load) return null
  return cfg.rep_divisor * (target / load - 1)
}

const PLATES = [45, 25, 10, 5, 2.5, 1.25]
/** Plates per side for a total plate weight (both sides), largest first. */
export function platesPerSide(totalPlates: number | null) {
  if (totalPlates === null || totalPlates <= 0) return totalPlates === 0 ? 'empty bar' : ''
  let side = Math.round((totalPlates / 2) * 100) / 100
  const out: string[] = []
  for (const p of PLATES) {
    const k = Math.floor(side / p + 1e-9)
    if (k > 0) { out.push(k > 1 ? `${k}×${p}` : `${p}`); side = Math.round((side - k * p) * 100) / 100 }
  }
  return out.join(' + ') + (side > 0.01 ? ` (+${side})` : '')
}

/** Log-linear fit of estimated max against set number: fatigue rate per set and fresh strength. */
export function fitFatigue(e1rms: (number | null)[]) {
  const pts = e1rms.map((v, i) => [i + 1, v] as const).filter(([, v]) => v && v > 0).slice(0, 10) as [number, number][]
  if (pts.length < 3) return null
  const n = pts.length
  const xs = pts.map(p => p[0]), ys = pts.map(p => Math.log(p[1]))
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  const a = my - b * mx
  return { ratePct: (1 - Math.exp(b)) * 100, fresh: Math.exp(a + b) }
}

/** Deadlift estimated max from a single and its RPE (same rule as the sheet's Tracker). */
export function e1rmFromRpe(weight: number, reps: number, rpe: number | null) {
  if (rpe !== null && reps === 1) return weight / (1 - 0.039 * (10 - rpe))
  return weight * (1 + reps / 30)
}

export const roundTo = (v: number, step: number) => Math.round(v / step) * step
