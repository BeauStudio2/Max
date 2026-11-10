import type { Config } from './types'

/**
 * Auto-spotter planning model. A creatine level P (1 = full, 0 = spent) drives short-term strength:
 * each maximal rep uses a fraction of what's left, rest refills it exponentially, and strength falls
 * by `share` when it is fully spent. All numbers are default assumptions (Config) until measured.
 */
export interface Cr { half_s: number; start: number; end: number; target: number; share: number; cost: number }

export const crOf = (cfg: Config): Cr => {
  const c = cfg as any
  return { half_s: c.cr_half_s ?? 30, start: c.cr_start ?? 0.95, end: c.cr_end ?? 0.25, target: c.cr_target ?? 0.95, share: c.cr_share ?? 0.3, cost: c.cr_rep_cost ?? 0.11 }
}

/** Strength as a fraction of fully-recovered strength at creatine level P. */
export const strengthAt = (P: number, cr: Cr) => 1 - cr.share * (1 - P)

/** Creatine level at the start of set `idx`: full for set 1, the recovery target after that. */
export const startLevel = (idx: number, cr: Cr) => (idx <= 1 ? 1 : cr.target)

/** One set at `load` (effective lb) for a lifter whose strength at the set's first rep is `strength0`. */
export function predictSet(load: number, strength0: number, P0: number, cr: Cr) {
  const full = strength0 / strengthAt(P0, cr)
  let P = P0, unaided = 0, spotted = 0
  const assist: number[] = []
  while (P > cr.end && unaided + spotted < 40) {
    const a = Math.max(0, load - full * strengthAt(P, cr))
    if (a < 0.5 && spotted === 0) unaided++
    else { spotted++; assist.push(a) }
    P *= 1 - cr.cost
  }
  return { unaided, spotted, assist, endLevel: P }
}

/** Creatine level at the end of a logged set: from the last measured assist when there is one, else from the rep count. */
export function endLevel(o: { load: number; totalReps: number; lastAssist?: number | null; P0: number }, cr: Cr) {
  if (o.lastAssist != null && o.lastAssist > 0 && o.load > 0) {
    // Strength on the last rep against strength on rep 1 (the bar was set at `start` of it).
    const drop = 1 - (o.load - o.lastAssist) / (o.load / cr.start)
    return Math.min(1, Math.max(0, o.P0 - drop / cr.share))
  }
  return o.P0 * (1 - cr.cost) ** o.totalReps
}

/** Seconds of rest for creatine to climb from `Pend` back to the target. */
export const restFor = (Pend: number, cr: Cr) => (Pend >= cr.target ? 0 : cr.half_s * Math.log2((1 - Pend) / (1 - cr.target)))
export const levelAfter = (Pend: number, seconds: number, cr: Cr) => 1 - (1 - Pend) * 2 ** (-seconds / cr.half_s)

/* ---------- reading a force trace (Tindeq in the spotter line) ---------- */

export interface Sample { t: number; lb: number }
export interface Pulse { start: number; dur: number; mean: number; peak: number }

/** Each stretch of assist above the threshold is one spotted rep. Short dropouts are bridged; blips are ignored. */
export function findPulses(samples: Sample[], threshold = 3, minDur = 0.25, bridge = 0.2): Pulse[] {
  const out: Pulse[] = []
  let cur: Sample[] = [], lastAbove = -Infinity
  const close = () => {
    if (cur.length > 1) {
      const dur = cur.at(-1)!.t - cur[0].t
      if (dur >= minDur) out.push({ start: cur[0].t, dur, mean: cur.reduce((s, x) => s + x.lb, 0) / cur.length, peak: Math.max(...cur.map(x => x.lb)) })
    }
    cur = []
  }
  for (const s of samples) {
    if (s.lb >= threshold) { cur.push(s); lastAbove = s.t }
    else if (cur.length && s.t - lastAbove > bridge) close()
  }
  close()
  return out
}
