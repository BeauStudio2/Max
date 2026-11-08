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
