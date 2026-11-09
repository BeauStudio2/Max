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

/* ---------- Plate planning (sheet rule from 11/02: 45s and 25s stay on, run the rest down with 10s and small plates) ---------- */

export interface Kept { n45: number; n25: number }
/** Plates owned per side, beyond the 45s. */
export const OWNED = { 25: 4, 10: 9, 5: 2, 2.5: 2, 1.25: 2 } as const

/** One side of the bar, inner to outer. Null when the owned plates can't make it with these kept plates. */
export function loadSide(perSide: number, kept: Kept): number[] | null {
  let rem = Math.round((perSide - 45 * kept.n45 - 25 * kept.n25) * 100) / 100
  if (rem < -0.01) return null
  const stack: number[] = [...Array(kept.n45).fill(45), ...Array(kept.n25).fill(25)]
  // More than the 10s and small plates can make: add 45s outside the kept plates.
  const smallMax = 10 * OWNED[10] + 5 * OWNED[5] + 2.5 * OWNED[2.5] + 1.25 * OWNED[1.25]
  while (rem > smallMax + 0.01) { stack.push(45); rem = Math.round((rem - 45) * 100) / 100 }
  for (const p of [10, 5, 2.5, 1.25] as const) {
    const k = Math.min(OWNED[p], Math.floor(rem / p + 1e-9))
    for (let i = 0; i < k; i++) stack.push(p)
    rem = Math.round((rem - k * p) * 100) / 100
  }
  return rem > 0.01 ? null : stack
}

/** Which 45s and 25s to keep on all session: as many as fit the lightest working set. */
export function keptFor(lightestPlates: number): Kept {
  const side = Math.max(0, lightestPlates / 2)
  const n45 = Math.floor(side / 45 + 1e-9)
  const n25 = Math.min(OWNED[25], Math.floor((side - 45 * n45) / 25 + 1e-9))
  return { n45, n25 }
}

/** Plate moves per side to go from one stack to the next (plates come off the outside first). */
export function plateMoves(a: number[], b: number[]) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.length - i + (b.length - i)
}

export function changeText(a: number[] | null, b: number[]) {
  if (!a) return ''
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const off = a.slice(i), on = b.slice(i)
  if (!off.length && !on.length) return 'no change'
  const fmtList = (l: number[]) => stackText(l)
  return [off.length ? `off ${fmtList(off)}` : '', on.length ? `on ${fmtList(on)}` : ''].filter(Boolean).join(' · ')
}

export function stackText(stack: number[]) {
  const counts = new Map<number, number>()
  for (const p of stack) counts.set(p, (counts.get(p) ?? 0) + 1)
  return [...counts.entries()].sort((x, y) => y[0] - x[0]).map(([p, k]) => (k > 1 ? `${k}×${p}` : `${p}`)).join(' + ') || 'empty bar'
}

/** Ideal weight or one step either side, whichever needs the fewest plate moves from the last set (ties go to the ideal). */
export function choosePlates(ideal: number, step: number, kept: Kept, prev: number[] | null) {
  const cands = [ideal, ideal - step, ideal + step].filter(w => w >= 0)
  let best: { weight: number; stack: number[]; moves: number } | null = null
  for (const w of cands) {
    const stack = loadSide(w / 2, kept)
    if (!stack) continue
    const moves = prev ? plateMoves(prev, stack) : 0
    if (!best || moves < best.moves) best = { weight: w, stack, moves }
  }
  return best
}
