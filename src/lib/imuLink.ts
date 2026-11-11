/**
 * The link between a phone on the bar and Max on the laptop.
 * The phone sends small batches of [seconds, vertical acceleration] about ten times a second over Supabase Realtime, on a
 * channel private to the signed-in account, so both devices just need to be signed in to Max. (Two tabs in the same browser
 * also reach each other directly, which is how it is tested.) The laptop turns the stream into reps with BarTracker.
 */
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase'
import { BarTracker, calibrate, summarize, type BarRep, type BarSet } from './imu'

type Batch = { s: [number, number][]; hz?: number }
const local = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('max-imu') : null
let joining: Promise<ReturnType<typeof supabase.channel>> | null = null
let joined = false
/** Join the account's channel once. (Readings arrive ten times a second, so every caller must share the one join.) */
function join(onBatch?: (b: Batch) => void) {
  return (joining ??= (async () => {
    const { data } = await supabase.auth.getSession()
    const ch = supabase.channel(`imu:${data.session?.user.id ?? 'anon'}`, { config: { broadcast: { self: false, ack: false } } })
    if (onBatch) ch.on('broadcast', { event: 's' }, ({ payload }) => onBatch(payload as Batch))
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
  lastSet: (BarSet & { at: number; taken: boolean }) | null
  flip: boolean
  /** Log a heavy set by itself when the bar sensor sees one end. */
  autolog: boolean
}
const FLIP = 'max.imu.flip', AUTO = 'max.imu.autolog'
let state: ImuState = { listening: false, hz: 0, lastAt: 0, velocity: 0, reps: [], lastSet: null, autolog: (() => { try { return localStorage.getItem(AUTO) !== '0' } catch { return true } })(), flip: (() => { try { return localStorage.getItem(FLIP) === '1' } catch { return false } })() }
const subs = new Set<() => void>()
const set = (p: Partial<ImuState>) => { state = { ...state, ...p }; subs.forEach(f => f()) }
const repSubs = new Set<(r: BarRep, n: number) => void>()
const setSubs = new Set<(s: BarSet) => void>()

/** The lifter's range of motion for the lift on screen (m), if known: speeds are scaled to it. */
let rom: number | null = null
const tracker = new BarTracker({
  rep: (r, n) => { set({ reps: calibrate(tracker.reps, rom) }); repSubs.forEach(f => f(r, n)) },
  set: s0 => { const s = { ...s0, reps: calibrate(s0.reps, rom) }; set({ reps: [], lastSet: { ...s, at: Date.now(), taken: false } }); if (state.autolog) setSubs.forEach(f => f(s)) },
})
let count = 0, countFrom = 0, lastPaint = 0
function ingest(b: Batch) {
  const now = Date.now()
  for (const [t, a] of b.s) tracker.push({ t, a: state.flip ? -a : a })
  count += b.s.length
  if (now - countFrom >= 1000) { const hz = Math.round((count * 1000) / Math.max(1, now - countFrom)); count = 0; countFrom = now; set({ hz }) }
  if (now - lastPaint > 100) { lastPaint = now; set({ lastAt: now, velocity: tracker.velocity, reps: calibrate(tracker.reps, rom) }) }
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
  setRom(m: number | null) { rom = m && m > 0.05 ? m : null },
  /** Called when a set ends, while logging sets by itself is on. */
  onSet: (f: (s: BarSet) => void) => { setSubs.add(f); return () => { setSubs.delete(f) } },
  setAutolog(autolog: boolean) { try { localStorage.setItem(AUTO, autolog ? '1' : '0') } catch { /* this visit only */ } set({ autolog }) },
  /** End the set now instead of waiting for the bar to sit still. */
  endSet() { tracker.flush() },
  /** The last finished set, once, for the heavy set being logged (only if it finished in the last few minutes). */
  take(): (BarSet & { at: number }) | null {
    tracker.flush()
    const s = state.lastSet
    if (!s || s.taken || Date.now() - s.at > 4 * 60_000) return null
    set({ lastSet: { ...s, taken: true } })
    return s
  },
  setFlip(flip: boolean) { try { localStorage.setItem(FLIP, flip ? '1' : '0') } catch { /* this visit only */ } set({ flip }) },
}
export const useImu = () => useSyncExternalStore(imu.subscribe, imu.get)
export { summarize }
