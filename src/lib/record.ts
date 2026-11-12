import { supabase } from '../supabase'

/**
 * The workout's recording: every reading from the phone on the bar and from the Tindeq, with its clock time, saved as it
 * comes in. Whatever Max made of a set at the time, the readings are here to be read again later.
 *
 * Readings are saved in half-minute pieces to the table raw_chunks: source ('imu' | 'tindeq'), the piece's start and end,
 * and its readings as two lists: `t` (ms after the start) and `v` (imu: m/s² × 1000; tindeq: lb × 100), whole numbers.
 * It records only while something asked for it (a workout running on Log, or testing on Config), so a phone left
 * sending overnight fills nothing.
 */
type Source = 'imu' | 'tindeq'
const SCALE: Record<Source, number> = { imu: 1000, tindeq: 100 }
const PIECE_MS = 30_000
const bufs: Record<Source, [number, number][]> = { imu: [], tindeq: [] }
const wanted = new Set<string>()
let who: { lifter_id?: string | null; session_id?: string | null; label?: string } = {}
let timer: ReturnType<typeof setInterval> | null = null
let saved = 0, failed = 0, lastError: string | null = null
const subs = new Set<() => void>()

async function flush(src: Source) {
  const b = bufs[src]
  if (!b.length) return
  bufs[src] = []
  const t0 = b[0][0], k = SCALE[src]
  const row = { source: src, from_at: new Date(t0).toISOString(), to_at: new Date(b[b.length - 1][0]).toISOString(), n: b.length,
    lifter_id: who.lifter_id ?? null, session_id: who.session_id ?? null, label: who.label ?? null,
    data: JSON.stringify({ t: b.map(x => x[0] - t0), v: b.map(x => Math.round(x[1] * k)) }) }
  try {
    const { error } = await supabase.from('raw_chunks').insert(row)
    if (error) throw new Error(error.message)
    saved++; lastError = null
  } catch (e: any) {
    // Not saved: put the readings back at the front so the next try carries them (up to ten minutes' worth).
    failed++; lastError = e?.message ?? String(e)
    const back = [...b, ...bufs[src]]
    bufs[src] = back.length > 80_000 ? back.slice(back.length - 80_000) : back
  }
  subs.forEach(f => f())
}
const flushAll = () => { void flush('imu'); void flush('tindeq') }

export const recorder = {
  /** Readings as [clock ms, value]. Dropped unless recording is on. */
  add(src: Source, readings: [number, number][]) { if (wanted.size) bufs[src].push(...readings) },
  /** Ask for recording (a workout is running, or the Test screen is testing), or stop asking. It runs while anyone asks. */
  want(key: string, on: boolean) {
    if (on) wanted.add(key); else wanted.delete(key)
    if (wanted.size && !timer) timer = setInterval(flushAll, PIECE_MS)
    if (!wanted.size && timer) { clearInterval(timer); timer = null; flushAll() }
    subs.forEach(f => f())
  },
  /** Whose workout this is, written on each piece. */
  tag(t: { lifter_id?: string | null; session_id?: string | null; label?: string }) { who = t },
  /** Save what is waiting now (a set was just logged, or the page is closing). */
  flush: flushAll,
  status: () => ({ on: wanted.size > 0, saved, failed, lastError, waiting: bufs.imu.length + bufs.tindeq.length }),
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAll)
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll() })
}
