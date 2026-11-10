import type { Config, Equipment } from './types'

/** rom_in = bar travel bottom to top; hang_in = chain off the floor with the bar at the bottom. */
export interface LoadSetup { bar: string; clamp: string; chain_half: number; chain_5_8: number; rom_in?: number | null; hang_in?: number | null; bands?: { name: string; per_side: number }[] }

/**
 * Pounds one chain adds at the bottom and top of the lift. With total weight and length known, the chain lifts off
 * the floor linearly: weight per inch × inches hanging (hang at the bottom, hang + range of motion at the top,
 * never more than the whole chain). Without them, the measured per-side values are used.
 */
export function chainLoad(props: Record<string, any>, rom?: number | null, hang?: number | null) {
  const W = n(props.total_lb), Lc = n(props.length_in)
  if (W > 0 && Lc > 0 && rom != null && hang != null) {
    const perIn = W / Lc
    return { bottom: perIn * Math.min(Lc, Math.max(0, hang)), top: perIn * Math.min(Lc, Math.max(0, hang + rom)), perIn }
  }
  return { bottom: n(props.bottom_lb_per_side), top: n(props.top_lb_per_side), perIn: null }
}

export const LIFT_EXERCISE: Record<string, string> = { bench: 'Bench Press', squat: 'Squat', deadlift: 'Deadlift' }

const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/** Totals at the bottom (chest / hole) and top (lockout), including bar, clamps and chains hanging per side. */
export function totals(weight: number | null, s: LoadSetup, eq: Equipment[]) {
  if (weight === null || Number.isNaN(weight)) return { bottom: null, top: null }
  const bar = eq.find(e => e.name === s.bar)
  const clamp = eq.find(e => e.name === s.clamp)
  const half = chainLoad(eq.find(e => e.name === 'Chain 1/2')?.props ?? {}, s.rom_in, s.hang_in)
  const big = chainLoad(eq.find(e => e.name === 'Chain 5/8')?.props ?? {}, s.rom_in, s.hang_in)
  const base = weight + n(bar?.weight_lb) + n(clamp?.weight_lb)
  const bottom = base + 2 * (n(s.chain_half) * half.bottom + n(s.chain_5_8) * big.bottom)
  const top = base + 2 * (n(s.chain_half) * half.top + n(s.chain_5_8) * big.top)
  // Bands: lockout tension at the top; at the bottom their bottom tension (0 when set up to go slack at the chest).
  let bTop = 0, bBottom = 0
  for (const b of s.bands ?? []) {
    const p = eq.find(e => e.name === b.name)?.props ?? {}
    bTop += n(p.one_band_lockout_lb) * n(b.per_side); bBottom += n(p.bottom_lb) * n(b.per_side)
  }
  return { bottom: bottom + 2 * bBottom, top: top + 2 * bTop }
}

export function effectiveLoad(bottom: number | null, top: number | null, cfg: Config) {
  if (bottom === null) return null
  return bottom * cfg.chain_bottom_ratio + (top ?? bottom) * cfg.chain_top_ratio
}

/** Reps not counted: a failed rep is lost, an assisted rep keeps its credit (0.5 on the sheet). */
export const lostReps = (assisted: boolean, failed: boolean, cfg: Config) => (failed ? 1 : assisted ? 1 - (cfg.assisted_rep_credit ?? 0.5) : 0)

/** Same formula as the set_estimates view: Epley, less a failed rep and the uncredited part of an assisted one. */
export function e1rm(bottom: number | null, top: number | null, reps: number | null, assisted: boolean, failed: boolean, cfg: Config) {
  const load = effectiveLoad(bottom, top, cfg)
  if (load === null || reps === null) return null
  return load * (1 + (reps - lostReps(assisted, failed, cfg)) / cfg.rep_divisor)
}

/** The rep goal shown for a set: expected reps rounded down, or up when the spotter is there to finish the last one. */
export const repGoal = (exp: number, spotter = false) => (spotter ? Math.ceil(exp - 1e-9) : Math.floor(exp + 1e-9))

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
export function platesPerSide(totalPlates: number | null, on: number[] = PLATES) {
  if (totalPlates === null || totalPlates <= 0) return totalPlates === 0 ? 'empty bar' : ''
  let side = Math.round((totalPlates / 2) * 100) / 100
  const out: string[] = []
  for (const p of PLATES.filter(x => on.includes(x))) {
    const k = Math.floor(side / p + 1e-9)
    if (k > 0) { out.push(k > 1 ? `${k}×${p}` : `${p}`); side = Math.round((side - k * p) * 100) / 100 }
  }
  return out.join(' + ') + (side > 0.01 ? ` (+${side})` : '')
}

/**
 * Log-linear fit of estimated max against set number over every logged set (same as the sheet):
 * fatigue rate per set and fitted fresh strength at set 1.
 */
export function fitFatigue(e1rms: (number | null)[]) {
  const pts = e1rms.map((v, i) => [i + 1, v] as const).filter(([, v]) => v && v > 0) as [number, number][]
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

/** What stays on the bar all session (per side, inner to outer), the plate size that makes up the span between sets, and the plates allowed. */
export interface Kept { base: number[]; change: number; on?: number[] }
/** Older sessions stored kept plates as 45/25 counts. */
export const keptFromStored = (k: any, change = 10, on?: number[]): Kept | null =>
  !k ? null : Array.isArray(k.base) ? { base: k.base, change: k.change ?? change, on } : { base: [...Array(k.n45 ?? 0).fill(45), ...Array(k.n25 ?? 0).fill(25)], change, on }
/** Plates owned per side, beyond the 45s. */
export const OWNED = { 25: 4, 10: 9, 5: 2, 2.5: 2, 1.25: 2 } as const
export const ALL_PLATES = [45, 25, 10, 5, 2.5, 1.25]

/** Fewest plates (from these sizes and counts) that make exactly `rem` lb, largest first. Null if none. */
function solveSide(rem: number, avail: [number, number][]): number[] | null {
  const target = Math.round(rem * 4)
  if (target === 0) return []
  let best: number[] | null = null
  const go = (i: number, left: number, acc: number[]) => {
    if (left === 0) { if (!best || acc.length < best.length) best = [...acc]; return }
    if (i >= avail.length || (best && acc.length >= best.length)) return
    const [p, n] = avail[i], u = Math.round(p * 4)
    for (let k = Math.min(n, Math.floor(left / u)); k >= 0; k--) go(i + 1, left - k * u, [...acc, ...Array(k).fill(p)])
  }
  go(0, target, [])
  return best
}

const ownedOf = (p: number) => (p === 45 ? Infinity : (OWNED as Record<number, number>)[p] ?? 0)
const r2 = (x: number) => Math.round(x * 100) / 100

/**
 * One side of the bar, inner to outer: the kept stack, then change plates for the span above the lightest set,
 * then smaller plates on the outside for the fine steps. Only plates switched on. Null when they can't make it.
 */
export function loadSide(perSide: number, kept: Kept): number[] | null {
  const on = (kept.on ?? ALL_PLATES).filter(p => ALL_PLATES.includes(p))
  const used = (st: number[], p: number) => st.filter(x => x === p).length
  const fine = on.filter(p => p < kept.change)
  const tryFrom = (inner: number[]): number[] | null => {
    const rem = r2(perSide - inner.reduce((t, x) => t + x, 0))
    if (rem < -0.01) return null
    const c = kept.change
    const cLeft = on.includes(c) ? ownedOf(c) - used(inner, c) : 0
    for (let k = Math.min(cLeft, Math.floor(rem / c + 1e-9)); k >= 0; k--) {
      const f = solveSide(r2(rem - k * c), fine.map(p => [p, ownedOf(p) - used(inner, p)] as [number, number]))
      if (f) return [...inner, ...Array(k).fill(c), ...f]
    }
    return null
  }
  // Kept stack + change plates + fine plates. If the span is more than the change plates can cover, big plates go on outside the kept ones.
  let inner = [...kept.base]
  const big = on.filter(p => p > kept.change).sort((a, b) => b - a)
  for (let guard = 0; guard < 12; guard++) {
    const got = tryFrom(inner)
    if (got) return got
    const add = big.find(p => used(inner, p) < ownedOf(p) && r2(perSide - inner.reduce((t, x) => t + x, 0) - p) >= -0.01)
    if (!add) break
    inner = [...inner, add]
  }
  // Lighter than the kept stack (e.g. a weight typed by hand): build it from scratch, largest plates first.
  return solveSide(perSide, on.slice().sort((a, b) => b - a).map(p => [p, p === 45 ? 20 : ownedOf(p)] as [number, number]))
}

/**
 * What stays on the bar all session: the lightest working set built from the biggest plates switched on,
 * down to the change plate. Every heavier set adds change plates; only plates smaller than the change plate come and go.
 */
export function keptFor(lightestPlates: number, on: number[] = ALL_PLATES, change = 10): Kept {
  let side = Math.max(0, lightestPlates / 2)
  const base: number[] = []
  for (const p of on.filter(x => x >= change).sort((a, b) => b - a)) {
    let k = 0
    while (side >= p - 1e-9 && k < ownedOf(p)) { base.push(p); side = r2(side - p); k++ }
  }
  return { base, change, on }
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
  // Ideal or one step either side; if the plates switched on can't make any of those, widen up to four steps.
  for (const reach of [1, 2, 3, 4]) {
    const cands = [ideal, ...Array.from({ length: reach }, (_, i) => [ideal - (i + 1) * step, ideal + (i + 1) * step]).flat()].filter(w => w >= 0)
    let best: { weight: number; stack: number[]; moves: number } | null = null
    for (const w of cands) {
      const stack = loadSide(w / 2, kept)
      if (!stack) continue
      const moves = prev ? plateMoves(prev, stack) : 0
      if (!best || moves < best.moves) best = { weight: w, stack, moves }
    }
    if (best) return best
  }
  return null
}
