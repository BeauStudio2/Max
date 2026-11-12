/**
 * Bar motion from a phone on the bar. Input is vertical acceleration (m/s², up positive, gravity removed) with the phone's
 * own timestamps; output is each lift's reps with how fast and how far the bar moved up.
 *
 * Acceleration is summed into velocity, which drifts, so the bar being still is the anchor: a "movement" runs from still to
 * still, its velocity is straightened so it starts and ends at zero, and reps are read from that. While a movement is still
 * going on, reps are reported straight away from the unstraightened velocity (good enough to count and call out), then
 * replaced by the corrected ones when the bar comes to rest.
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
  /** The bar counts as still when acceleration stays inside ± this (m/s²)... */
  still_a: number
  /** ...for this long (s), while it is also barely moving (a slow grind has almost no acceleration but is not still)... */
  still_s: number
  /** ...or stays that quiet for this long whatever the speed estimate says (it drifts). */
  still_max_s: number
  /** A rep has to travel up at least this far (m). */
  min_rom_m: number
  /** A set is over when no rep has finished for this long (s). */
  set_gap_s: number
  /** Swinging past this (m/s²) both up and down within 0.15 s is a hit (hooks, clang), not lifting. */
  impact_a: number
}
export const IMU_DEFAULTS: ImuOptions = { still_a: 0.45, still_s: 0.35, still_max_s: 4, min_rom_m: 0.12, set_gap_s: 6, impact_a: 10 }

/** Reps in a stretch of velocity: each run of upward travel that goes far enough. */
function repsIn(t: number[], v: number[], minRom: number): BarRep[] {
  const out: BarRep[] = []
  let i0 = -1, rom = 0, peak = 0, down = 0, downAt = 0
  const close = (i1: number) => {
    const dur = t[i1] - t[i0]
    // A run too short to be a rep doesn't use up the descent before it.
    // Not a rep: too short, or a slow drift (many seconds long, barely moving, or further than a bar can travel).
    if (rom >= minRom && dur >= 0.15 && dur <= 6 && rom <= 1.1 && peak >= 0.12) { out.push({ mean_mps: rom / dur, peak_mps: peak, rom_m: rom, dur_s: dur, at: t[i1], down_m: downAt }); down = 0 }
    else down = downAt
    i0 = -1
  }
  for (let i = 1; i < t.length; i++) {
    const up = v[i] > 0.03
    if (up && i0 < 0) { i0 = i - 1; rom = 0; peak = 0; downAt = down }
    if (i0 >= 0) {
      if (up) { rom += ((v[i] + v[i - 1]) / 2) * (t[i] - t[i - 1]); peak = Math.max(peak, v[i]) }
      else close(i - 1)
    }
    if (v[i] < -0.03) down += (-(v[i] + v[i - 1]) / 2) * (t[i] - t[i - 1])
  }
  if (i0 >= 0) close(t.length - 1)
  return out
}

export class BarTracker {
  private o: ImuOptions
  private t: number[] = []; private a: number[] = []; private v: number[] = []     // the movement in progress
  private moving = false
  private stillSince: number | null = null
  private last: ImuSample | null = null
  private live: BarRep[] = []                 // reps seen so far in the movement in progress (uncorrected)
  private set: BarRep[] = []                  // corrected reps of finished movements in the current set
  private setStart = 0
  private lastRepAt = -Infinity
  /** The sensor's resting offset, learned whenever the bar is still, and taken off every reading. */
  private bias = 0
  /** The last few readings, to spot a hit. */
  private recent: ImuSample[] = []
  /** The bar was hit and is ringing: nothing is read until it is calm again. */
  private settling = false
  /** Latest velocity (m/s), for a live readout. */
  velocity = 0

  constructor(private on: { rep?: (r: BarRep, n: number) => void; set?: (s: BarSet) => void }, opts: Partial<ImuOptions> = {}) { this.o = { ...IMU_DEFAULTS, ...opts } }

  /** Reps counted so far in the set under way (corrected ones plus any in the movement still going). */
  get reps(): BarRep[] { return [...this.set, ...this.live] }

  push(s: ImuSample) {
    // (s may be replaced below while the bar rings after a hit)
    const prev = this.last
    if (prev && s.t <= prev.t + 1e-6) return                                          // a repeated or out-of-order reading
    this.last = s
    if (!prev || s.t - prev.t > 0.5) { this.reset(); return }                         // first reading, or a gap in the stream
    // Racking the bar: the hit is far harder than any lifting, and summing its ringing would wreck the speeds of the whole set.
    // Its readings (and the ringing just after) are left out; the bar coming to rest in the hooks then straightens the movement.
    // A hit (the bar going into the hooks, or clanging): within a moment the reading swings hard both ways, which no lift does
    // (a bounce off the chest only pushes up). The movement is closed just before the hit, where the bar was about still, and
    // readings are then ignored until the bar has settled.
    this.recent.push(s); if (this.recent.length > 15) this.recent.shift()
    if (this.settling) {
      const calm = Math.abs(s.a - this.bias) < this.o.still_a
      if (calm) { if (this.stillSince === null) this.stillSince = s.t } else this.stillSince = null
      if (this.stillSince !== null && s.t - this.stillSince >= this.o.still_s) { this.settling = false; this.stillSince = null }
      if (this.set.length && s.t - this.lastRepAt >= this.o.set_gap_s) this.endSet(s.t)
      return
    }
    let hi = -Infinity, lo = Infinity
    for (const r of this.recent) { const x = r.a - this.bias; if (x > hi) hi = x; if (x < lo) lo = x }
    if (hi > this.o.impact_a && lo < -this.o.impact_a) {
      if (this.moving) {
        const t0 = this.recent[0].t
        while (this.t.length > 2 && this.t[this.t.length - 1] >= t0) { this.t.pop(); this.a.pop(); this.v.pop() }
        this.endMovement()
      }
      this.settling = true; this.stillSince = null; this.velocity = 0; this.recent = []
      return
    }
    const dt = s.t - prev.t
    const quiet = Math.abs(s.a - this.bias) < this.o.still_a
    if (quiet) { if (this.stillSince === null) this.stillSince = prev.t } else this.stillSince = null
    const quietFor = this.stillSince === null ? 0 : s.t - this.stillSince
    const still = (quietFor >= this.o.still_s && Math.abs(this.velocity) < 0.07) || quietFor >= this.o.still_max_s

    if (!this.moving) {
      this.velocity = 0
      if (quiet) this.bias += (s.a - this.bias) * Math.min(1, dt / 1.5)        // resting: track the offset
      if (!quiet) { this.moving = true; this.t = [prev.t]; this.a = [0]; this.v = [0]; this.live = []; if (!this.set.length) this.setStart = prev.t }
    }
    if (this.moving) {
      const v = this.v[this.v.length - 1] + ((s.a + prev.a) / 2 - this.bias) * dt
      this.t.push(s.t); this.a.push(s.a); this.v.push(v); this.velocity = v
      // Reps as they happen, from the velocity so far.
      const now = repsIn(this.t, this.v, this.o.min_rom_m)
      const done = now.length && this.v[this.v.length - 1] <= 0.03 ? now.length : now.length - 1   // the last run may still be going up
      while (this.live.length < done) { const r = now[this.live.length]; this.live.push(r); this.lastRepAt = r.at; this.on.rep?.(r, this.set.length + this.live.length) }
      if (still) this.endMovement()
    }
    if (!this.moving && this.set.length && s.t - this.lastRepAt >= this.o.set_gap_s) this.endSet(s.t)
  }

  /** The bar has come to rest: straighten the movement's velocity so it ends at zero, and keep its corrected reps. */
  private endMovement() {
    const n = this.t.length, T = this.t[n - 1] - this.t[0]
    const drift = this.v[n - 1]
    const v = this.v.map((x, i) => x - drift * ((this.t[i] - this.t[0]) / Math.max(1e-6, T)))
    const reps = repsIn(this.t, v, this.o.min_rom_m)
    // A rep the live count missed (or over-counted) is settled here; announce any extra ones.
    for (let k = this.live.length; k < reps.length; k++) { this.lastRepAt = reps[k].at; this.on.rep?.(reps[k], this.set.length + k + 1) }
    this.set.push(...reps)
    this.live = []; this.moving = false; this.velocity = 0; this.t = []; this.a = []; this.v = []
  }
  private endSet(t: number) {
    const s = { reps: this.set, started: this.setStart, ended: this.lastRepAt, closed: t }
    this.set = []; this.lastRepAt = -Infinity
    if (s.reps.length) this.on.set?.(s)
  }
  /** How long the bar must go without a rep before the set is over (s). */
  setGap(s: number) { this.o = { ...this.o, set_gap_s: s } }
  /** End the set now (for example on "Max stop"). */
  flush() { if (this.moving) this.endMovement(); if (this.set.length) this.endSet(this.last?.t ?? 0) }
  private reset() { this.moving = false; this.stillSince = null; this.live = []; this.t = []; this.a = []; this.v = []; this.velocity = 0 }
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
