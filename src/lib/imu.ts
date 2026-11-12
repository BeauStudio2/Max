/**
 * Bar motion from a phone on the bar. Input is vertical acceleration (m/s², up positive, gravity removed) with the phone's
 * own timestamps; output is each lift's reps with how fast and how far the bar moved up.
 *
 * Acceleration summed into velocity drifts, and over a long set the drift is far bigger than the lifting. So reps are read
 * from the shape of the motion, not from the bar coming to rest:
 *   1. The slow drift is taken out of the velocity (its own 4-second average is subtracted), which leaves the down-and-up of
 *      each rep. Every stretch of upward travel is a candidate rep.
 *   2. Each candidate is then measured again on its own, from the top of the rep before it to its own top. The bar is still at
 *      both tops and at the same height, which pins down the drift inside that one rep. A real rep comes out near full travel;
 *      a wobble, or the unrack, comes out near zero.
 * A hit (the bar going into the hooks) ends the movement just before it.
 */
export interface ImuSample { t: number; a: number }                       // seconds, m/s²
export interface BarRep { mean_mps: number; peak_mps: number; rom_m: number; dur_s: number; at: number
  /** How far the bar travelled down just before this rep went up (m): a real rep starts with a descent, the unrack doesn't. */
  down_m?: number
  /** Travel as the sensor read it, before it was set to the lifter's known range of motion. */
  raw_rom_m?: number }
export interface BarSet { reps: BarRep[]; started: number; ended: number
  /** The set began with the bar being lifted off the hooks, which was left out of the reps. */
  unrack?: boolean
  /** When the set was declared over, on the same clock as `ended` (the last rep): the gap between them is how long ago the lifting stopped. */
  closed?: number }

export interface ImuOptions {
  /** The bar counts as at rest when acceleration stays inside ± this (m/s²)... */
  still_a: number
  /** ...for this long (s). A movement (unrack to rack, or one run of reps) ends then. */
  still_s: number
  /** A rep has to travel up at least this far (m), and at least a quarter as far as the set's typical rep. */
  min_rom_m: number
  /** A set is over when no rep has finished for this long (s). */
  set_gap_s: number
  /** Swinging past this (m/s²) both up and down within 0.15 s is a hit (hooks, clang), not lifting. */
  impact_a: number
  /** The drift is taken as the velocity's own average over this long (s). */
  drift_s: number
}
export const IMU_DEFAULTS: ImuOptions = { still_a: 0.45, still_s: 2.5, min_rom_m: 0.08, set_gap_s: 6, impact_a: 10, drift_s: 4 }

/**
 * The reps in one movement. `t` in seconds, `a` in m/s² with the resting offset already taken off. `closeFirst`: the movement
 * starts at the top (bench, squat), so the first rep also returns to where it began; false for a lift from the floor.
 */
export function readReps(t: number[], a: number[], o: ImuOptions = IMU_DEFAULTS, closeFirst = true): BarRep[] {
  const n = t.length
  if (n < 8) return []
  const v = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) v[i] = v[i - 1] + ((a[i] + a[i - 1]) / 2) * (t[i] - t[i - 1])
  // 1. Velocity with its slow drift removed: minus its average over drift_s around each moment.
  const pre = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i]
  const vh = new Array<number>(n)
  let lo = 0, hi = 0
  for (let i = 0; i < n; i++) {
    while (t[i] - t[lo] > o.drift_s / 2) lo++
    while (hi < n - 1 && t[hi + 1] - t[i] <= o.drift_s / 2) hi++
    vh[i] = v[i] - (pre[hi + 1] - pre[lo]) / (hi + 1 - lo)
  }
  const cand: [number, number][] = []
  let i0 = -1, rom = 0
  for (let i = 1; i < n; i++) {
    const up = vh[i] > 0.03
    if (up && i0 < 0) { i0 = i - 1; rom = 0 }
    if (i0 >= 0) {
      if (up) rom += ((vh[i] + vh[i - 1]) / 2) * (t[i] - t[i - 1])
      if (!up || i === n - 1) { const i1 = up ? i : i - 1; if (rom >= 0.05 && t[i1] - t[i0] >= 0.2) cand.push([i0, i1]); i0 = -1 }
    }
  }
  // 2. Measure each candidate again from the top before it to its own top.
  const out: BarRep[] = []
  let start = 0
  for (let c = 0; c < cand.length; c++) {
    const end = cand[c][1], m = end - start
    if (m < 3) continue
    const T = t[end] - t[start]
    const sv = new Array<number>(m + 1), sx = new Array<number>(m + 1)
    sv[0] = 0; sx[0] = 0
    for (let k = 1; k <= m; k++) { sv[k] = v[start + k] - v[start]; sx[k] = sx[k - 1] + ((sv[k] + sv[k - 1]) / 2) * (t[start + k] - t[start + k - 1]) }
    // Drift inside the stretch: still at both ends, and (when it starts at a top) back at the same height.
    const closed = closeFirst || c > 0
    const q2 = closed ? ((sv[m] * T) / 2 - sx[m]) * 6 / T ** 3 : 0
    const q1 = closed ? (sv[m] - q2 * T * T) / T : sv[m] / T
    let x = 0, xMin = 0, kb = 0, prev = 0
    const cv = new Array<number>(m + 1); cv[0] = 0
    for (let k = 1; k <= m; k++) {
      const tau = t[start + k] - t[start]
      cv[k] = sv[k] - (q1 * tau + q2 * tau * tau)
      x += ((cv[k] + prev) / 2) * (t[start + k] - t[start + k - 1]); prev = cv[k]
      if (x < xMin) { xMin = x; kb = k }
    }
    let peak = 0
    for (let k = kb; k <= m; k++) if (cv[k] > peak) peak = cv[k]
    const up = x - xMin, dur = t[end] - t[start + kb]
    if (dur > 0) out.push({ mean_mps: up / dur, peak_mps: peak, rom_m: up, dur_s: dur, at: t[end], down_m: -xMin })
    start = end
  }
  // A rep travels a fair share of what the set's real reps do; anything much shorter is a wobble or the unrack.
  const big = out.map(r => r.rom_m).filter(x => x >= 0.15).sort((p, q) => p - q)
  const need = Math.max(o.min_rom_m, big.length ? 0.25 * big[Math.floor(big.length / 2)] : 0)
  return out.filter(r => r.rom_m >= need && r.dur_s >= 0.15 && r.dur_s <= 6 && r.rom_m <= 1.3)
}

export class BarTracker {
  private o: ImuOptions
  private t: number[] = []; private a: number[] = []           // the movement in progress (offset already taken off a)
  private moving = false
  private quietSince: number | null = null
  private last: ImuSample | null = null
  private live: BarRep[] = []                 // reps read so far in the movement in progress
  private liveAt = -Infinity
  private set: BarRep[] = []                  // reps of finished movements in the current set
  private setStart = 0
  private lastRepAt = -Infinity
  private topStart = true
  /** The sensor's resting offset, learned whenever the bar is at rest, and taken off every reading. */
  private bias = 0
  /** The last few readings, to spot a hit. */
  private recent: ImuSample[] = []
  /** The bar was hit and is ringing: nothing is read until it is calm again. */
  private settling = false
  /** The last rest-time's worth of readings, to recognise rest at a new level. */
  private win: ImuSample[] = []
  /** Latest velocity (m/s), for a live readout (it forgets over a couple of seconds, so it can't drift away). */
  velocity = 0

  constructor(private on: { rep?: (r: BarRep, n: number) => void; set?: (s: BarSet) => void }, opts: Partial<ImuOptions> = {}) { this.o = { ...IMU_DEFAULTS, ...opts } }

  /** Reps counted so far in the set under way. */
  get reps(): BarRep[] { return [...this.set, ...this.live] }
  /** How long the bar must go without a rep before the set is over (s). */
  setGap(s: number) { this.o = { ...this.o, set_gap_s: s } }
  /** Whether the lift starts at the top (bench, squat) or from the floor (deadlift). */
  setTopStart(on: boolean) { this.topStart = on }

  push(s: ImuSample) {
    const prev = this.last
    if (prev && s.t <= prev.t + 1e-6) return                                          // a repeated or out-of-order reading
    this.last = s
    if (!prev || s.t - prev.t > 0.5) { this.reset(); return }                         // first reading, or a gap in the stream
    const dt = s.t - prev.t
    // The resting offset can jump while the bar is in use (the phone is knocked or turns on the bar during a plate change).
    // Readings that have held steady for the whole rest time ARE rest, whatever level they sit at: take that level as the new offset.
    // Without this the bar would look "moving" for ever after such a jump, and no later set would close.
    this.win.push(s); while (this.win.length && this.win[0].t < s.t - this.o.still_s) this.win.shift()
    if (this.win.length > 8 && s.t - this.win[0].t >= this.o.still_s * 0.9) {
      let mn = Infinity, mx = -Infinity
      for (const w of this.win) { if (w.a < mn) mn = w.a; if (w.a > mx) mx = w.a }
      const mid = (mn + mx) / 2
      if (mx - mn < this.o.still_a && Math.abs(mid - this.bias) >= this.o.still_a / 2) { this.bias = mid; this.quietSince = this.win[0].t; this.settling = false; this.recent = [] }
    }
    const x = s.a - this.bias
    const quiet = Math.abs(x) < this.o.still_a
    if (quiet) { if (this.quietSince === null) this.quietSince = prev.t } else this.quietSince = null
    const rested = this.quietSince !== null && s.t - this.quietSince >= this.o.still_s

    // A hit: within a moment the reading swings hard both ways, which no lift does (a bounce off the chest only pushes up).
    this.recent.push(s); while (this.recent.length && this.recent[0].t < s.t - 0.15) this.recent.shift()
    if (this.settling) {
      if (this.quietSince !== null && s.t - this.quietSince >= 0.35) { this.settling = false; this.recent = [] }
      this.endSetIfDue(s.t)
      return
    }
    let hi = -Infinity, lo = Infinity
    for (const r of this.recent) { const y = r.a - this.bias; if (y > hi) hi = y; if (y < lo) lo = y }
    if (hi > this.o.impact_a && lo < -this.o.impact_a) {
      if (this.moving) {
        const t0 = this.recent[0].t
        while (this.t.length > 2 && this.t[this.t.length - 1] >= t0) { this.t.pop(); this.a.pop() }
        this.endMovement()
      }
      this.settling = true; this.quietSince = null; this.velocity = 0
      return
    }

    if (!this.moving) {
      this.velocity = 0
      if (quiet) this.bias += (s.a - this.bias) * Math.min(1, dt / 1.5)        // at rest: track the offset
      else { this.moving = true; this.t = [prev.t]; this.a = [0]; this.live = []; this.liveAt = -Infinity; if (!this.set.length) this.setStart = prev.t }
    }
    if (this.moving) {
      this.t.push(s.t); this.a.push(x)
      this.velocity = (this.velocity + x * dt) * Math.exp(-dt / 2)
      // Reps as they happen: read the movement so far a few times a second. Only reps finished a moment ago count (the newest
      // stretch may still be going up), and the count never goes back down while the movement lasts.
      if (s.t - this.liveAt >= 0.25) {
        this.liveAt = s.t
        const now = readReps(this.t, this.a, this.o, this.topStart).filter(r => r.at <= s.t - 0.5)
        if (now.length > this.live.length) {
          const from = this.live.length
          this.live = now
          for (let k = from; k < now.length; k++) { this.lastRepAt = now[k].at; this.on.rep?.(now[k], this.set.length + k + 1) }
        }
      }
      if (rested) this.endMovement()
    }
    this.endSetIfDue(s.t)
  }

  /** The bar has come to rest (or been racked): read the whole movement once more and keep its reps. */
  private endMovement() {
    const reps = this.t.length > 8 ? readReps(this.t, this.a, this.o, this.topStart) : []
    if (reps.length) this.lastRepAt = Math.max(this.lastRepAt, reps[reps.length - 1].at)
    for (let k = this.live.length; k < reps.length; k++) this.on.rep?.(reps[k], this.set.length + k + 1)
    this.set.push(...reps)
    this.live = []; this.moving = false; this.velocity = 0; this.t = []; this.a = []
  }
  private endSetIfDue(t: number) { if (!this.moving && this.set.length && t - this.lastRepAt >= this.o.set_gap_s) this.endSet(t) }
  private endSet(t: number) {
    const s = { reps: this.set, started: this.setStart, ended: this.lastRepAt, closed: t }
    this.set = []; this.lastRepAt = -Infinity
    if (s.reps.length) this.on.set?.(s)
  }
  /** End the set now (for example on "Max stop"). */
  flush() { if (this.moving) this.endMovement(); if (this.set.length) this.endSet(this.last?.t ?? 0) }
  private reset() { this.win = []; this.moving = false; this.quietSince = null; this.live = []; this.t = []; this.a = []; this.velocity = 0; this.recent = []; this.settling = false }
}

/** What a set's reps say at a glance: first-rep and last-rep speed, and how much speed was lost across the set. */
export function summarize(reps: BarRep[]) {
  if (!reps.length) return null
  const first = reps[0].mean_mps, last = reps[reps.length - 1].mean_mps, best = Math.max(...reps.map(r => r.mean_mps))
  return { n: reps.length, first_mps: first, last_mps: last, best_mps: best, loss_pct: best > 0 ? (1 - last / best) * 100 : 0, rom_m: reps.reduce((t, r) => t + r.rom_m, 0) / reps.length }
}

/**
 * Scale reps to the lifter's known range of motion. The time a rep takes is measured well; the distance, summed from
 * acceleration, is not (it can read 20% out). So a full rep's speed is the known distance over its measured time.
 * A rep that travelled well short of the others (a partial or failed rep) keeps its share of the distance.
 */
export function calibrate(reps: BarRep[], rom_m: number | null): BarRep[] {
  if (!rom_m || !reps.length) return reps
  const raw = reps.map(r => r.raw_rom_m ?? r.rom_m), mid = [...raw].sort((a, b) => a - b)[Math.floor(raw.length / 2)]
  return reps.map((r, i) => {
    const rom = raw[i] >= 0.7 * mid ? rom_m : rom_m * (raw[i] / mid), k = rom / raw[i]
    return { ...r, raw_rom_m: raw[i], rom_m: rom, mean_mps: rom / r.dur_s, peak_mps: (r.peak_mps * k) / ((r.raw_rom_m ? r.rom_m / r.raw_rom_m : 1)) }
  })
}

/**
 * Leave out the unrack. On a lift that starts at the top (bench, squat), every real rep goes down before it comes up; lifting
 * the bar off the hooks is the one upward move with no descent before it. So the first upward move of a set is the unrack
 * when the bar hadn't gone down first (less than 15% of a rep's travel). Failing that, a first move that travelled less than
 * half as far as a real rep is also taken as the unrack. Lifts from the floor (deadlift) start with a real rep and are left alone.
 */
export function dropUnrack(reps: BarRep[], rom_m: number | null, topStart = true): { reps: BarRep[]; unrack: boolean } {
  if (!reps.length || !topStart) return { reps, unrack: false }
  const rest = reps.slice(1).map(r => r.rom_m).sort((a, b) => a - b)
  const full = rom_m ?? (rest.length ? rest[Math.floor(rest.length / 2)] : null)
  const r0 = reps[0]
  const noDescent = r0.down_m !== undefined && r0.down_m < Math.max(0.04, 0.15 * (full ?? 0.4))
  const short = full !== null && (r0.raw_rom_m ?? r0.rom_m) < 0.5 * full
  return noDescent || short ? { reps: reps.slice(1), unrack: true } : { reps, unrack: false }
}

/**
 * Is this the lift, or the bar just being handled (plates changed, bar shifted in the hooks)? A real rep travels the lift's
 * range; handling moves the bar a little. The yardstick is how far this session's accepted reps have read on the sensor (it
 * reads the same lift consistently, though not always the true distance); before any, the lifter's range of motion.
 * Measured 11/12: real reps 0.35-0.53 m on the sensor, plate changes 0.10-0.29 m.
 */
export function isLiftSet(reps: BarRep[], seenRoms: number[], romM: number | null): boolean {
  if (!reps.length) return false
  const raw = reps.map(r => r.raw_rom_m ?? r.rom_m)
  const mid = seenRoms.length >= 3 ? [...seenRoms].sort((a, b) => a - b)[Math.floor(seenRoms.length / 2)] : null
  const need = mid !== null ? 0.75 * mid : romM ? 0.5 * romM : 0
  const full = raw.filter(x => x >= need).length
  return full >= Math.max(1, Math.ceil(raw.length / 2))
}
