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

/* ---------- fitting the model to logged spotter sets ---------- */

export interface SpotSet {
  idx: number; load: number; e1rm: number | null; unaided: number; spotted: number
  /** Assist per spotted rep (lb), from the Tindeq; empty when the set was typed by hand. */
  assists: number[]; rest_s: number | null
}
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null }

/**
 * What the session's spotter sets say about two model numbers.
 * Strength on a spotted rep is the bar less the assist, so a Tindeq trace is a rep-by-rep strength curve:
 *  - fresh strength: set 1 starts with creatine full, so its curve fixes it (later sets: less the slow per-set fatigue);
 *  - rep cost: how fast the creatine level falls rep to rep within a set;
 *  - recovery half-time: the level a set ended at against the level the next one started at, over the rest between.
 * Sets typed by hand (no trace) fall back to their e1RM for the starting level and the rep count for the ending one.
 * The strength share of creatine stays at its setting (it can't be separated from this data).
 */
export function fitSession(sets: SpotSet[], cr: Cr, slowFatigue: number) {
  const S = [...sets].sort((a, b) => a.idx - b.idx)
  if (!S.length) return { cost: null, costN: 0, half_s: null, halfN: 0 }
  const curve = (s: SpotSet) => s.assists.map((a, j) => ({ k: s.unaided + j + 1, str: s.load - a }))
  // Fresh strength as of set 1.
  const s1 = S.find(s => s.idx === 1 && s.assists.length >= 2)
  let F1: number
  if (s1) {
    const pts = curve(s1); let best = Infinity; F1 = 0
    for (let q = 0.6; q <= 0.99; q += 0.002) {
      const g = pts.map(p => 1 - cr.share + cr.share * q ** (p.k - 1))
      const F = pts.reduce((t, p, i) => t + p.str * g[i], 0) / g.reduce((t, x) => t + x * x, 0)
      const sse = pts.reduce((t, p, i) => t + (p.str - F * g[i]) ** 2, 0)
      if (sse < best) { best = sse; F1 = F }
    }
  } else {
    const s0 = S[0]
    F1 = (s0.e1rm ?? s0.load / cr.start) / strengthAt(startLevel(s0.idx, cr), cr) / (1 - slowFatigue) ** (s0.idx - 1)
  }
  const fresh = (s: SpotSet) => F1 * (1 - slowFatigue) ** (s.idx - 1)
  const levels = (s: SpotSet) => curve(s).map(p => ({ k: p.k, P: 1 - (1 - p.str / fresh(s)) / cr.share })).filter(p => p.P > 0.02 && p.P < 1)
  // Rep cost: slope of ln(level) against rep number, one estimate per traced set.
  const costs: number[] = []
  for (const s of S) {
    const L = levels(s); if (L.length < 2) continue
    const mk = L.reduce((t, p) => t + p.k, 0) / L.length, ml = L.reduce((t, p) => t + Math.log(p.P), 0) / L.length
    const den = L.reduce((t, p) => t + (p.k - mk) ** 2, 0)
    if (den > 0) { const c = 1 - Math.exp(L.reduce((t, p) => t + (p.k - mk) * (Math.log(p.P) - ml), 0) / den); if (c > 0.01 && c < 0.5) costs.push(c) }
  }
  const cost = median(costs), q = 1 - (cost ?? cr.cost)
  // Level at the first and last rep of each set.
  const ends = new Map<number, { P0: number | null; Pend: number | null }>()
  for (const s of S) {
    const L = levels(s)
    const P0 = s.idx === 1 ? 1 : L.length ? Math.min(1, median(L.map(p => p.P / q ** (p.k - 1)))!) : s.e1rm ? 1 - (1 - s.e1rm / fresh(s)) / cr.share : null
    const Pend = L.length ? L.at(-1)!.P : P0 !== null ? P0 * q ** (s.unaided + s.spotted) : null
    ends.set(s.idx, { P0, Pend })
  }
  const halves: number[] = []
  for (const s of S) {
    const a = ends.get(s.idx - 1), b = ends.get(s.idx)
    if (!a || !b || !s.rest_s || a.Pend === null || b.P0 === null) continue
    if (b.P0 > a.Pend + 0.05 && b.P0 < 0.995) { const h = s.rest_s / Math.log2((1 - a.Pend) / (1 - b.P0)); if (h > 5 && h < 300) halves.push(h) }
  }
  return { cost, costN: costs.length, half_s: median(halves), halfN: halves.length }
}
