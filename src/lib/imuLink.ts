/**
 * The link between a phone on the bar and Max on the laptop.
 * The phone sends small batches of [seconds, vertical acceleration] about ten times a second over Supabase Realtime, on a
 * channel private to the signed-in account, so both devices just need to be signed in to Max. (Two tabs in the same browser
 * also reach each other directly, which is how it is tested.) The laptop turns the stream into reps with BarTracker.
 */
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase'
import { BarTracker, calibrate, dropUnrack, isLiftSet, summarize, type BarRep, type BarSet } from './imu'
import { recorder } from './record'
import { onReadings, tension } from './tindeq'
import { LineWatch, lineSaysBarStill } from './fuse'

/** Readings from the phone: [seconds, vertical m/s²] pairs, and how the phone is lying (which way is up, in its own axes). */
type Batch = { s: [number, number][]; hz?: number; g?: [number, number, number] }
const local = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('max-imu') : null
let joining: Promise<ReturnType<typeof supabase.channel>> | null = null
let joined = false
/** The code the Android app is paired with: the first part of the account's id. */
export const pairCode = async () => ((await supabase.auth.getSession()).data.session?.user.id ?? '').slice(0, 8)
/** Join the account's channel once. (Readings arrive ten times a second, so every caller must share the one join.) */
function join(onBatch?: (b: Batch) => void) {
  return (joining ??= (async () => {
    const { data } = await supabase.auth.getSession()
    const uid = data.session?.user.id ?? 'anon'
    const ch = supabase.channel(`imu:${uid}`, { config: { broadcast: { self: false, ack: false } } })
    if (onBatch) {
      ch.on('broadcast', { event: 's' }, ({ payload }) => onBatch(payload as Batch))
      // The Android app sends the same readings on its own channel, named by the pairing code.
      supabase.channel(`imubar:${uid.slice(0, 8)}`, { config: { broadcast: { self: false, ack: false } } })
        .on('broadcast', { event: 's' }, ({ payload }) => onBatch(payload as Batch)).subscribe()
    }
    ch.subscribe(status => { joined = status === 'SUBSCRIBED' })
    return ch
  })())
}

/* ---------- phone side ---------- */

/** Send a batch of readings to the laptop. */
export async function sendBatch(b: Batch) {
  local?.postMessage(b)
  const ch = await join()
  if (joined) ch.send({ type: 'broadcast', event: 's', payload: b })
}
export const linkReady = () => joined

/* ---------- laptop side ---------- */

export interface ImuState {
  listening: boolean
  /** Readings per second arriving from the phone (0: nothing coming in). */
  hz: number
  lastAt: number
  velocity: number
  /** Reps in the set under way. */
  reps: BarRep[]
  /** The last finished set, and whether a logged set has already taken it. */
  lastSet: (BarSet & { at: number; ended_ms: number; taken: boolean }) | null
  flip: boolean
  /** Log a heavy set by itself when the bar sensor sees one end. */
  autolog: boolean
  /** Which way is up in the phone's own axes (unit vector), when the phone sends it: tells how the phone is lying on the bar. */
  gravity: [number, number, number] | null
  /** The last movement that was not taken as a set (too short to be the lift: a plate change, or the bar being moved), and when. */
  ignored: { at: number; n: number; travel_m: number; why: 'short' | 'line' } | null
  /** The spotter line was worked for a set's length and the phone logged nothing: a set it did not see (clock ms, seconds). */
  unseen: { at: number; from: number; seconds: number } | null
}
const FLIP = 'max.imu.flip', AUTO = 'max.imu.autolog'
let state: ImuState = { listening: false, hz: 0, lastAt: 0, velocity: 0, reps: [], lastSet: null, gravity: null, ignored: null, unseen: null, autolog: (() => { try { return localStorage.getItem(AUTO) !== '0' } catch { return true } })(), flip: (() => { try { return localStorage.getItem(FLIP) === '1' } catch { return false } })() }
const subs = new Set<() => void>()
const set = (p: Partial<ImuState>) => { state = { ...state, ...p }; subs.forEach(f => f()) }
const repSubs = new Set<(r: BarRep, n: number) => void>()
const setSubs = new Set<(s: BarSet) => void>()
const anySetSubs = new Set<(s: BarSet & { at: number; ended_ms: number }) => void>()

/** The lifter's range of motion for the lift on screen (m), if known: speeds are scaled to it. */
let rom: number | null = null
/** The lift on screen starts at the top (bench, squat), so the bar goes down before each rep; false for lifts from the floor. */
let topStart = true
const seen: number[] = []
/** The spotter line is on this bar (the next heavy set is a spotter set), so the Tindeq can vouch for what the phone reports. */
let lineOnBar = false
/** The phone reported these reps: did the line, taut the whole time, not move at all? Then the bar did not either. */
function lineStill(s: BarSet): boolean {
  const end = Date.now() - ((s.closed ?? s.ended) - s.reps[s.reps.length - 1].at) * 1000
  const start = end - (s.reps[s.reps.length - 1].at - (s.reps[0].at - s.reps[0].dur_s)) * 1000
  const line = tension(start - 500, end + 500)
  return !!line && lineSaysBarStill(line)
}
// The other way round: the line was worked for a set's length. If the phone logged no set over that stretch, say so.
const watch = new LineWatch(e => {
  if (!lineOnBar || !state.listening || !state.autolog || Date.now() - state.lastAt > 5000) return
  setTimeout(() => {
    const within = (ms: number | undefined | null) => ms != null && ms >= e.from - 6000 && ms <= e.to + 12000
    if (within(state.lastSet?.ended_ms) || within(state.ignored?.at) || state.reps.length) return
    set({ unseen: { at: Date.now(), from: e.from, seconds: Math.round((e.to - e.from) / 1000) } })
  }, 9000)
})
onReadings(rs => { for (const [ms, lb] of rs) watch.push(ms, lb) })
const isLift = (reps: BarRep[]) => isLiftSet(reps, seen, rom)
const clean = (reps: BarRep[]) => calibrate(dropUnrack(reps, rom, topStart).reps, rom)
const tracker = new BarTracker({
  rep: (r, n) => { set({ reps: clean(tracker.reps) }); repSubs.forEach(f => f(r, n)) },
  set: s0 => { const u = dropUnrack(s0.reps, rom, topStart), s = { ...s0, reps: calibrate(u.reps, rom), unrack: u.unrack }; if (!s.reps.length) { set({ reps: [] }); return } if (!isLift(s.reps)) { set({ reps: [], ignored: { at: Date.now(), n: s.reps.length, travel_m: Math.max(...s.reps.map(r => r.raw_rom_m ?? r.rom_m)), why: 'short' } }); return } if (lineOnBar && lineStill(s)) { set({ reps: [], ignored: { at: Date.now(), n: s.reps.length, travel_m: Math.max(...s.reps.map(r => r.raw_rom_m ?? r.rom_m)), why: 'line' } }); return } seen.push(...s.reps.map(r => r.raw_rom_m ?? r.rom_m)); if (seen.length > 60) seen.splice(0, seen.length - 60); set({ reps: [], lastSet: { ...s, at: Date.now(), ended_ms: Date.now() - Math.max(0, ((s.closed ?? s.ended) - s.ended) * 1000), taken: false } }); anySetSubs.forEach(f => f(state.lastSet!)); if (state.autolog && !anySetSubs.size) setSubs.forEach(f => f(s)) },
})
let count = 0, countFrom = 0, lastPaint = 0
// The last few minutes of raw readings, kept so a set's own stretch can be saved with it (for checking and improving the rep reading).
const rawT: number[] = [], rawA: number[] = []
let wallOffset = 0   // seconds to add to a phone timestamp to get wall-clock seconds
const RAW_KEEP_S = 300
function ingest(b: Batch) {
  const now = Date.now()
  for (const [t, a] of b.s) { tracker.push({ t, a: state.flip ? -a : a }); rawT.push(t); rawA.push(state.flip ? -a : a) }
  if (b.s.length) {
    const lastT = b.s[b.s.length - 1][0]
    wallOffset = now / 1000 - lastT
    recorder.add('imu', b.s.map(([t, a]) => [Math.round((t + wallOffset) * 1000), state.flip ? -a : a]))
    while (rawT.length && rawT[0] < lastT - RAW_KEEP_S) { rawT.shift(); rawA.shift() }
  }
  count += b.s.length
  if (now - countFrom >= 1000) { const hz = Math.round((count * 1000) / Math.max(1, now - countFrom)); count = 0; countFrom = now; set({ hz }) }
  if (now - lastPaint > 100) { lastPaint = now; const g = b.g; const m = g ? Math.hypot(g[0], g[1], g[2]) : 0; set({ lastAt: now, velocity: tracker.velocity, reps: clean(tracker.reps), ...(g && m > 0 ? { gravity: [g[0] / m, g[1] / m, g[2] / m] as [number, number, number] } : {}) }) }
}

export const imu = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  /** Start listening for a phone (safe to call more than once). */
  listen() {
    if (state.listening) return
    set({ listening: true }); countFrom = Date.now()
    if (local) local.onmessage = e => ingest(e.data as Batch)
    join(ingest)
  },
  onRep: (f: (r: BarRep, n: number) => void) => { repSubs.add(f); return () => { repSubs.delete(f) } },
  /** (A different range of motion means a different lift or lifter: what counted as a full rep before no longer applies.) */
  setRom(m: number | null) { const next = m && m > 0.05 ? m : null; if (next !== rom) seen.length = 0; rom = next },
  setTopStart(on: boolean) { topStart = on; tracker.setTopStart(on) },
  /** Whether the spotter line is on the bar being lifted (so the Tindeq can check the phone, and the phone the Tindeq). */
  setLineOnBar(on: boolean) { lineOnBar = on },
  /** Seconds without a rep that end a set: longer for lifts with long pauses between reps. */
  setGap(s: number) { tracker.setGap(s) },
  /** Called when a set ends, while logging sets by itself is on. */
  onSet: (f: (s: BarSet) => void) => { setSubs.add(f); return () => { setSubs.delete(f) } },
  /** Every set the sensor sees, whatever the Auto switch says (the Test screen). While anything listens here, Log is not sent sets. */
  onAnySet: (f: (s: BarSet & { at: number; ended_ms: number }) => void) => { anySetSubs.add(f); return () => { anySetSubs.delete(f) } },
  setAutolog(autolog: boolean) { try { localStorage.setItem(AUTO, autolog ? '1' : '0') } catch { /* this visit only */ } set({ autolog }) },
  /** End the set now instead of waiting for the bar to sit still. */
  endSet() { tracker.flush() },
  /** The last finished set, once, for the heavy set being logged (only if it finished in the last few minutes). */
  take(): (BarSet & { at: number; ended_ms: number }) | null {
    tracker.flush()
    const s = state.lastSet
    if (!s || s.taken || Date.now() - s.at > 4 * 60_000) return null
    set({ lastSet: { ...s, taken: true } })
    return s
  },
  /** The raw readings from the last `seconds`, for saving with a set: start time, and [seconds from start, m/s²] pairs. */
  raw(seconds: number): { from: string; n: number; t: number[]; a: number[] } | null {
    if (!rawT.length) return null
    const end = rawT[rawT.length - 1]; let i = rawT.length - 1
    while (i > 0 && rawT[i - 1] >= end - seconds) i--
    const t0 = rawT[i], r3 = (x: number) => Math.round(x * 1000) / 1000
    if (Date.now() / 1000 - (end + wallOffset) > seconds) return null          // nothing recent
    return { from: new Date((t0 + wallOffset) * 1000).toISOString(), n: rawT.length - i, t: rawT.slice(i).map(x => r3(x - t0)), a: rawA.slice(i).map(r3) }
  },
  setFlip(flip: boolean) { try { localStorage.setItem(FLIP, flip ? '1' : '0') } catch { /* this visit only */ } set({ flip }) },
}
export const useImu = () => useSyncExternalStore(imu.subscribe, imu.get)
export { summarize }
