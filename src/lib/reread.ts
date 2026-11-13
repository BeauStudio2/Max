/**
 * Reading a workout again from its recording (raw_chunks): the same reader the live sensor uses, run over the saved
 * readings, so a set Max missed or misread at the time can still be found. Nothing here touches the network.
 */
import { BarTracker, calibrate, dropUnrack, isLiftSet, type BarRep } from './imu'
import type { Pulse } from './creatine'

export type Reading = [number, number]   // [clock time in ms, value]

/**
 * The spotter line's help on each rep. The tension in the line IS the help (it pulls up on the bar), so there is no
 * threshold and no zero to learn: each rep gets the average tension while the bar was going up, and its peak.
 * `reps` are [start, end] clock times (ms) of each rep's way up; `readings` are the Tindeq's. Null when it sent nothing then.
 */
export function helpPerRep(readings: Reading[], reps: [number, number][]): { pulses: Pulse[]; mean_lb: number; peak_lb: number; trace: { from: string; hz: number; lb: number[] } } | null {
  if (!reps.length) return null
  const from = reps[0][0] - 3000, to = reps[reps.length - 1][1] + 2000
  const all = readings.filter(x => x[0] >= from && x[0] <= to)
  if (all.length < 10) return null
  const r1 = (x: number) => Math.round(x * 10) / 10
  const pulses: Pulse[] = reps.map(([a, b]) => {
    const w = all.filter(x => x[0] >= a && x[0] <= b)
    const mean = w.length ? w.reduce((t, x) => t + x[1], 0) / w.length : 0, peak = w.length ? Math.max(...w.map(x => x[1])) : 0
    return { start: r1((a - from) / 1000), dur: r1((b - a) / 1000), mean: r1(Math.max(0, mean)), peak: r1(Math.max(0, peak)) }
  })
  return { pulses, mean_lb: r1(pulses.reduce((t, x) => t + x.mean, 0) / pulses.length), peak_lb: Math.max(...pulses.map(x => x.peak)), trace: traceOf(all, from, to) }
}
/** Readings as an even 20-a-second line between two clock times (gaps hold the last value). */
export function traceOf(readings: Reading[], from: number, to: number): { from: string; hz: number; lb: number[] } {
  const lb: number[] = []
  let i = 0
  for (let t = from; t < to; t += 50) {
    let sum = 0, n = 0
    while (i < readings.length && readings[i][0] < t) i++
    for (let j = i; j < readings.length && readings[j][0] < t + 50; j++) { sum += readings[j][1]; n++ }
    lb.push(n ? Math.round((sum / n) * 10) / 10 : lb.length ? lb[lb.length - 1] : 0)
  }
  return { from: new Date(from).toISOString(), hz: 20, lb }
}

export interface FoundSet {
  /** Clock times (ms) of the first rep's start and the last rep's end. */
  from: number; to: number
  reps: BarRep[]
  /** Help on each rep (lb) when the Tindeq was recording, and the set's average. */
  help: number[] | null; help_lb: number | null
  /** A movement too short to be the lift (a plate change, the bar being shifted): found, but not a set. */
  ignored: boolean
  unrack: boolean
}
export interface RereadOptions { rom_m: number | null; topStart: boolean; set_gap_s: number }

/**
 * Every set in a stretch of recording. `imu` is the phone's readings ([clock ms, m/s² along the vertical]) in time order,
 * `tindeq` the line tension ([clock ms, lb]). The stretch should be one lifter on one lift (the range of motion and the
 * way a set starts differ between them).
 */
export function readRecording(imu: Reading[], tindeq: Reading[], o: RereadOptions): FoundSet[] {
  const out: FoundSet[] = [], seen: number[] = []
  if (!imu.length) return out
  const t0 = imu[0][0]
  const wall = (t: number) => t0 + t * 1000
  const tr = new BarTracker({
    set: s0 => {
      const u = dropUnrack(s0.reps, o.rom_m, o.topStart), reps = calibrate(u.reps, o.rom_m)
      if (!reps.length) return
      const real = isLiftSet(reps, seen, o.rom_m)
      if (real) { seen.push(...reps.map(r => r.raw_rom_m ?? r.rom_m)); if (seen.length > 60) seen.splice(0, seen.length - 60) }
      const spans = reps.map(r => [wall(r.at - r.dur_s), wall(r.at)] as [number, number])
      const h = real ? helpPerRep(tindeq, spans) : null
      out.push({ from: spans[0][0], to: spans[spans.length - 1][1], reps, help: h ? h.pulses.map(p => p.mean) : null, help_lb: h ? h.mean_lb : null, ignored: !real, unrack: u.unrack })
    },
  })
  tr.setTopStart(o.topStart); tr.setGap(o.set_gap_s)
  let last = -Infinity
  for (const [ms, a] of imu) {
    const t = (ms - t0) / 1000
    if (t <= last) continue                // pieces can overlap by a reading when one was saved twice
    // A hole in the recording (the phone stopped sending): whatever was under way ends there.
    if (t - last > 2 && last > -Infinity) tr.flush()
    tr.push({ t, a }); last = t
  }
  tr.flush()
  return out
}

/** One saved piece of recording back into readings. */
export function unpack(piece: { source: string; from_at: string; data: string }): Reading[] {
  const d = JSON.parse(piece.data) as { t: number[]; v: number[] }, t0 = new Date(piece.from_at).getTime(), k = piece.source === 'imu' ? 1000 : 100
  return d.t.map((t, i) => [t0 + t, d.v[i] / k] as Reading)
}
