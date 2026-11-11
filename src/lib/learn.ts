/**
 * How Max learns a lifter. Every number she plans with is a belief: a value and how sure she is of it (sd).
 * Each session she (1) scores her own predictions, (2) measures what the session can tell her about each belief,
 * (3) blends that into the belief in proportion to how sure each side is, so early sessions move a number a lot and
 * later ones only refine it, and (4) decides how much of the next workout to spend on deliberate test sets ("probes"):
 * a lot while a belief is vague, one a session once everything is settled, more again if her predictions start missing.
 *
 * New beliefs, probes and sensors plug in here: a belief names the sources it needs (the timer today; force, bar speed
 * or video later), and raw readings from any sensor go to the `observations` table (lib/observations.ts).
 */
export interface Belief { value: number; sd: number; n: number; at?: string }
export type Source = 'timer' | 'tindeq' | 'inertiometer' | 'vision'
export type ProbeKind = 'rest'

export interface BeliefDef {
  key: string; label: string; unit: string
  /** Shown value, e.g. "0.75%" or "45 s". */
  fmt: (v: number) => string
  /** Sensible range; a measurement outside it is never used. */
  range: [number, number]
  /** Starting point when nothing is known. */
  init: Belief
  /** Sensors a session needs for this belief to be measured at all. */
  needs: Source[]
  /** Deliberate variations that sharpen it. Empty: it is learned from ordinary sets. */
  probes: ProbeKind[]
  /** Settled once sd is under this share of the value: past that, knowing it better no longer changes the weight on the bar. */
  settled: number
  tip: string
}

export const BELIEFS: BeliefDef[] = [
  { key: 'fatigue_rep_pct', label: 'Fatigue per rep', unit: '%', fmt: v => `${v.toFixed(2)}%`, range: [0.05, 3], init: { value: 0.5, sd: 0.3, n: 0 },
    needs: [], probes: [], settled: 0.12, tip: 'How much the estimated max falls for each rep done. Learned from every session\'s sets; Max plans each next set with it.' },
  { key: 'recovery_half_s', label: 'Recovery half-time', unit: 's', fmt: v => `${Math.round(v)} s`, range: [5, 300], init: { value: 45, sd: 60, n: 0 },
    needs: ['timer'], probes: ['rest'], settled: 0.15, tip: 'How long strength takes to come half way back after a set to failure. Learned from sets whose rests were deliberately made short or long.' },
]
export const beliefDef = (key: string) => BELIEFS.find(b => b.key === key)!

/** A session's reading of one belief. */
export interface Measurement { value: number; sd: number }

/** Blend what Max believed with what the session measured, each weighted by how sure it is. */
export function blend(prior: Belief, m: Measurement, at?: string): Belief {
  const wp = 1 / prior.sd ** 2, wm = 1 / m.sd ** 2
  return { value: (prior.value * wp + m.value * wm) / (wp + wm), sd: Math.sqrt(1 / (wp + wm)), n: prior.n + 1, at }
}

export interface LearnEntry {
  session: string; date: string; lift: string; key: string
  before: Belief; measured: Measurement; after: Belief
  /** Why the measurement was not used, if it wasn't. */
  flag?: string
  /** Sick or hurt that day. */
  off?: boolean
  undone?: boolean; accepted?: boolean; at: string
}

/**
 * One session's update to one belief.
 *  - Outside the sensible range: never used.
 *  - On a sick or hurt day: used when it is in line with healthy sessions, flagged (kept, shown, not used) when it is very
 *    different. "Very different" is more than twice the usual session-to-session spread of healthy measurements, or more
 *    than 25% until there are three healthy sessions to judge the spread by.
 */
export function learnOne(def: BeliefDef, prior: Belief, m: Measurement, off: boolean, healthy: number[]): { after: Belief; flag?: string } {
  if (m.value < def.range[0] || m.value > def.range[1]) return { after: prior, flag: `outside ${def.fmt(def.range[0])}–${def.fmt(def.range[1])}` }
  if (off) {
    let tol = 0.25 * prior.value
    if (healthy.length >= 3) { const mean = healthy.reduce((t, x) => t + x, 0) / healthy.length; tol = 2 * Math.sqrt(healthy.reduce((t, x) => t + (x - mean) ** 2, 0) / (healthy.length - 1)) }
    if (Math.abs(m.value - prior.value) > Math.max(tol, 1e-9)) return { after: prior, flag: 'sick or hurt, and very different from healthy sessions' }
  }
  return { after: blend(prior, m, new Date().toISOString()) }
}

/** Three flagged sessions in a row pointing the same way are probably the new normal: offer them for acceptance. */
export function pendingShift(log: LearnEntry[], lift: string, key: string): LearnEntry[] | null {
  const mine = log.filter(e => e.lift === lift && e.key === key && !e.undone)   // newest first
  const run: LearnEntry[] = []
  for (const e of mine) { if (e.flag && e.off && !e.accepted) run.push(e); else break }
  if (run.length < 3) return null
  const up = run.every(e => e.measured.value > e.before.value), down = run.every(e => e.measured.value < e.before.value)
  return up || down ? run.slice(0, 3) : null
}

/* ---------- measuring a session ---------- */

export interface SetObs { idx: number; load: number | null; reps: number | null; e1rm: number | null; low: boolean; rest_s: number | null; spot: boolean; pred_reps: number | null }

/** Fatigue per rep (%): the fall from the first good set to the last, spread over the reps done in between. */
export function measureFatigue(sets: SetObs[]): Measurement | null {
  const g = sets.filter(s => !s.spot && !s.low && s.e1rm !== null)
  if (g.length < 4) return null
  const i0 = sets.indexOf(g[0]), i1 = sets.indexOf(g.at(-1)!)
  const reps = sets.slice(i0, i1).reduce((t, s) => t + (s.reps ?? 0), 0)
  if (reps <= 0 || g.at(-1)!.e1rm! >= g[0].e1rm!) return null
  const value = (1 - (g.at(-1)!.e1rm! / g[0].e1rm!) ** (1 / reps)) * 100
  // A rep either way on each end set moves the estimate about 3%: fewer reps in between, less sure.
  return { value, sd: Math.max(0.05, (6 / reps) * 1) }
}

/**
 * Recovery half-time (s) and fatigue per rep (%), fitted together. After a set to failure, strength at that moment equals the
 * weight just lifted; it then climbs back toward the fresh level (which itself falls with every rep done) along one half-time.
 * Needs rests that differ, or there is nothing to tell a fast recovery from a slow one. Fitting both at once keeps a short
 * rest from being mistaken for fatigue.
 */
export function measureRecovery(sets: SetObs[]): { recovery: Measurement; fatigue: Measurement } | null {
  const g = sets.filter(s => !s.spot && s.e1rm !== null && s.load !== null && s.reps !== null)
  const pairs: { prevLoad: number; rest: number; cum: number; s: number }[] = []
  let cum = 0
  for (let i = 0; i < g.length; i++) {
    if (i > 0 && g[i].rest_s && g[i].rest_s! > 5 && g[i].idx === g[i - 1].idx + 1 && !g[i].low && !g[i - 1].low) pairs.push({ prevLoad: g[i - 1].load!, rest: g[i].rest_s!, cum, s: g[i].e1rm! })
    cum += g[i].reps!
  }
  if (pairs.length < 5) return null
  const rests = pairs.map(p => p.rest).sort((a, b) => a - b)
  if (rests.at(-1)! < 2 * rests[0]) return null                     // no spread of rests: nothing to learn
  const sse = (tau: number, fr: number, F0: number) => pairs.reduce((t, p) => { const F = F0 * (1 - fr) ** p.cum; return t + (p.s - (F - (F - Math.min(p.prevLoad, F)) * 2 ** (-p.rest / tau))) ** 2 }, 0)
  const taus = [5, 8, 12, 16, 20, 25, 30, 36, 43, 50, 60, 70, 82, 95, 110, 130, 150, 175, 200, 240, 300]
  const s0 = Math.max(...g.map(x => x.e1rm!))
  const all: { tau: number; fr: number; e: number }[] = []
  for (const tau of taus) for (let fr = 0.0005; fr <= 0.0251; fr += 0.0005) { let b = Infinity; for (let F0 = s0 * 0.9; F0 <= s0 * 1.3; F0 += s0 * 0.01) b = Math.min(b, sse(tau, fr, F0)); all.push({ tau, fr, e: b }) }
  const min = all.reduce((a, b) => (b.e < a.e ? b : a))
  // Values that fit nearly as well mark out how sure this reading is.
  const ok = all.filter(b => b.e <= min.e * (1 + 4 / Math.max(1, pairs.length - 3)) + 1e-9)
  const span = (v: number[]) => Math.max(...v) - Math.min(...v)
  return { recovery: { value: min.tau, sd: Math.max(10, span(ok.map(b => b.tau)) / 2) }, fatigue: { value: min.fr * 100, sd: Math.max(0.05, span(ok.map(b => b.fr * 100)) / 2) } }
}

/** How far Max's rep predictions were off, on average (reps), over the sets she predicted. */
export function predictionMiss(sets: SetObs[]): { miss: number; n: number } | null {
  const p = sets.filter(s => !s.spot && s.pred_reps !== null && s.reps !== null)
  return p.length ? { miss: p.reduce((t, s) => t + Math.abs(s.reps! - s.pred_reps!), 0) / p.length, n: p.length } : null
}

/* ---------- how much to test ---------- */

export interface Budget { share: number; count: number | null; why: string }
/**
 * The share of sets after set 1 that may be test sets. Vague beliefs: up to half. All settled: one test a session, to
 * check nothing has moved. Predictions missing by more than a rep and a half lately: back up to at least 30%.
 */
export function probeBudget(beliefs: Record<string, Belief>, recentMiss: number | null, available: Source[] = ['timer']): Budget {
  const open = BELIEFS.filter(d => d.probes.length && d.needs.every(n => available.includes(n)))
    .map(d => ({ d, b: beliefs[d.key] ?? d.init })).map(x => ({ ...x, rel: x.b.sd / Math.max(1e-9, x.b.value) }))
    .filter(x => x.rel > x.d.settled).sort((a, b) => b.rel - a.rel)
  const drift = recentMiss !== null && recentMiss > 1.5
  if (!open.length) return drift ? { share: 0.3, count: null, why: `predictions have been off by ${recentMiss!.toFixed(1)} reps` } : { share: 0, count: 1, why: 'everything is settled: one check a session' }
  const share = Math.min(0.5, Math.max(drift ? 0.3 : 0.1, open[0].rel))
  return { share, count: null, why: `${open[0].d.label.toLowerCase()} is still vague (${open[0].d.fmt(open[0].b.value)} ± ${open[0].d.fmt(open[0].b.sd)})` }
}

export interface Probe { kind: ProbeKind; variant: 'short' | 'long'; rest_s: number }
const rng = (seed: string) => { let a = 2166136261; for (const c of seed) { a ^= c.charCodeAt(0); a = Math.imul(a, 16777619) }
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
/**
 * Which sets get a test rest before them, for this lifter and day (the same answer every time it's asked). Short and long
 * rests are mixed in random order through the session so rest length isn't tangled up with how tired the lifter already is.
 */
export function planProbes(seed: string, budget: Budget, restS: number, maxIdx = 30): Record<number, Probe> {
  const r = rng(seed), out: Record<number, Probe> = {}
  const mk = (): Probe => { const short = r() < 0.5; return { kind: 'rest', variant: short ? 'short' : 'long', rest_s: short ? Math.max(30, Math.round(restS * 0.4 / 5) * 5) : Math.round(restS * 2 / 5) * 5 } }
  if (budget.count) { for (let k = 0; k < budget.count; k++) out[2 + Math.floor(r() * 5)] = mk(); return out }
  for (let idx = 2; idx <= maxIdx; idx++) if (r() < budget.share) out[idx] = mk()
  return out
}
