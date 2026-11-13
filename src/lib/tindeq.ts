import type { Pulse, Sample } from './creatine'
import { recorder } from './record'
import { helpPerRep, traceOf } from './reread'

// Tindeq Progressor Bluetooth protocol (from Tindeq's published API sample client).
const SERVICE = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57'
const DATA = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57'
const CTRL = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57'
const CMD_TARE = 100, CMD_START = 101, CMD_STOP = 102, CMD_BATTERY = 111
const RES_CMD = 0, RES_WEIGHT = 1, RES_LOW_POWER = 4
const KG_TO_LB = 2.20462

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!(navigator as any).bluetooth

/** Weight notifications: [code, length, then repeated (float32 kg, uint32 microseconds)], little endian. */
export function parseWeights(data: DataView): Sample[] {
  if (data.byteLength < 2 || data.getUint8(0) !== RES_WEIGHT) return []
  const out: Sample[] = []
  for (let i = 2; i + 8 <= data.byteLength; i += 8) out.push({ lb: data.getFloat32(i, true) * KG_TO_LB, t: data.getUint32(i + 4, true) / 1e6 })
  return out
}

export interface Tindeq { tare: () => Promise<void>; disconnect: () => void; name: string
  /** Ask for the battery voltage (the answer comes through onInfo). */
  battery: () => Promise<void> }
/** Things the Tindeq says about itself: its battery voltage, or that the battery is nearly flat. */
export type TindeqInfo = { battery_mv: number } | { low: true }

/**
 * Connects and streams force samples (lb, seconds). With no `known` device it opens the browser's picker; with one (a device
 * the browser already has permission for) it connects straight to it. If the link drops by itself, it is taken up again
 * without asking: `onLink(false)` while it is down, `onLink(true)` when readings are flowing again, and `onGone` only after
 * two minutes of failed tries or a deliberate disconnect.
 */
export async function connectTindeq(onSamples: (s: Sample[]) => void, onGone: () => void, onLink: (up: boolean) => void = () => {}, known?: any, onInfo: (i: TindeqInfo) => void = () => {}): Promise<Tindeq> {
  const bt = (navigator as any).bluetooth
  if (!bt) throw new Error('This browser has no Bluetooth access. Use Chrome or Edge on the laptop.')
  const device = known ?? await bt.requestDevice({ filters: [{ namePrefix: 'Progressor' }], optionalServices: [SERVICE] })
  let ctrl: any = null, closed = false
  const send = (cmd: number) => ctrl.writeValue(new Uint8Array([cmd]))
  const onValue = (e: any) => {
    const dv = e.target.value as DataView
    if (dv.byteLength < 1) return
    const code = dv.getUint8(0)
    if (code === RES_WEIGHT) { const s = parseWeights(dv); if (s.length) onSamples(s) }
    else if (code === RES_LOW_POWER) onInfo({ low: true })
    // The only question asked is the battery voltage, so a 4-byte answer in a battery's range is that.
    else if (code === RES_CMD && dv.byteLength >= 6) { const mv = dv.getUint32(2, true); if (mv > 2000 && mv < 5000) onInfo({ battery_mv: mv }) }
  }
  async function open() {
    const server = await device.gatt.connect()
    const service = await server.getPrimaryService(SERVICE)
    const data = await service.getCharacteristic(DATA)
    ctrl = await service.getCharacteristic(CTRL)
    data.addEventListener('characteristicvaluechanged', onValue)
    await data.startNotifications()
    // Battery is asked once, before measuring starts: a question during measuring can stop the readings.
    try { await send(CMD_BATTERY); await new Promise(r => setTimeout(r, 250)) } catch { /* older firmware: carry on */ }
    await send(CMD_START)
  }
  await open()
  device.addEventListener('gattserverdisconnected', async () => {
    if (closed) { onGone(); return }
    onLink(false)
    const until = Date.now() + 120_000
    for (let wait = 500; !closed && Date.now() < until; wait = Math.min(wait * 1.6, 5000)) {
      await new Promise(r => setTimeout(r, wait))
      try { await open(); onLink(true); return } catch { /* still out of reach: try again */ }
    }
    closed = true; onGone()
  })
  return {
    name: device.name ?? 'Progressor',
    tare: async () => { await send(CMD_STOP); await send(CMD_TARE); await send(CMD_START) },
    battery: async () => { await send(CMD_STOP); await send(CMD_BATTERY); await new Promise(r => setTimeout(r, 250)); await send(CMD_START) },
    disconnect: () => { closed = true; send(CMD_STOP).catch(() => {}).finally(() => { if (device.gatt.connected) device.gatt.disconnect(); else onGone() }) },
  }
}

/* ---------- one shared connection for the whole app (set up in Config, used on Log) ---------- */

export interface SensorSettings { invert: boolean }
const DEFAULTS: SensorSettings = { invert: false }
const KEY = 'max.tindeq'
const loadSettings = (): SensorSettings => { try { return { invert: !!JSON.parse(localStorage.getItem(KEY) ?? '{}').invert } } catch { return DEFAULTS } }

export interface SensorState { status: 'off' | 'connecting' | 'on'; name: string | null; lb: number; error: string | null; recording: boolean; settings: SensorSettings
  /** Clock time of the last reading, and readings per second: a connection that sends nothing shows up as 0. */
  lastAt: number; hz: number
  /** Battery voltage (V) when the Tindeq last said, and what has happened to the connection lately (newest first). */
  battery_v: number | null; log: LinkEvent[] }
export interface LinkEvent { at: string; what: 'connected' | 'dropped' | 'back' | 'gave up' | 'disconnected' | 'low battery'; hidden?: boolean; after_s?: number; battery_v?: number | null }
const LOG = 'max.tindeq.log'
const loadLog = (): LinkEvent[] => { try { return JSON.parse(localStorage.getItem(LOG) ?? '[]') } catch { return [] } }
let state: SensorState = { status: 'off', name: null, lb: 0, error: null, recording: false, settings: loadSettings(), lastAt: 0, hz: 0, battery_v: null, log: loadLog() }
let count = 0, countFrom = 0
let dev: Tindeq | null = null
let buf: Sample[] = []
let lastPaint = 0
const subs = new Set<() => void>()
const streams = new Set<(s: Sample[]) => void>()
const set = (patch: Partial<SensorState>) => { state = { ...state, ...patch }; subs.forEach(f => f()) }

// Whether the Tindeq is meant to be connected (kept across reloads), so it can be taken up again without asking.
const WANT = 'max.tindeq.on'
const wanted = () => { try { return localStorage.getItem(WANT) === '1' } catch { return false } }
const want = (on: boolean) => { try { localStorage.setItem(WANT, on ? '1' : '0') } catch { /* this visit only */ } }

// A short history of the connection, kept on this laptop and copied to Max's settings, so drops can be looked into afterwards.
let upSince = 0, droppedAt = 0
function note(what: LinkEvent['what']) {
  const now = Date.now()
  const e: LinkEvent = { at: new Date(now).toISOString(), what, hidden: typeof document !== 'undefined' ? document.hidden : undefined, battery_v: state.battery_v,
    ...(what === 'dropped' && upSince ? { after_s: Math.round((now - upSince) / 1000) } : what === 'back' && droppedAt ? { after_s: Math.round((now - droppedAt) / 1000) } : {}) }
  if (what === 'connected' || what === 'back') upSince = now
  if (what === 'dropped') droppedAt = now
  const log = [e, ...state.log].slice(0, 40)
  try { localStorage.setItem(LOG, JSON.stringify(log)) } catch { /* this visit only */ }
  set({ log })
  import('../supabase').then(({ supabase }) => supabase.from('settings').upsert({ key: 'tindeq_log', value: log }).then(() => {})).catch(() => {})
}
let batteryTimer: ReturnType<typeof setInterval> | null = null

/** Every reading as it arrives, as [clock time in ms, lb]. */
const stampedSubs = new Set<(r: [number, number][]) => void>()
export function onReadings(f: (r: [number, number][]) => void) { stampedSubs.add(f); return () => { stampedSubs.delete(f) } }
/** The last ten minutes of readings: [clock time in ms, lb]. */
const ring: [number, number][] = [], RING_MS = 600_000
/** Line tension between two clock times (ms): the readings, for working out the help on each rep of a set. Null when none were taken then. */
export function tension(fromMs: number, toMs: number): [number, number][] | null {
  const out = ring.filter(x => x[0] >= fromMs && x[0] <= toMs)
  return out.length ? out : null
}
/** The spotter line's help on each rep of a set just done (see helpPerRep), from the readings in memory. */
export function assistPerRep(reps: [number, number][]) { return helpPerRep(ring, reps) }
/** The line's tension over the last so-many seconds as an even 20-a-second line: kept with a set that was typed in, so its help can be read later. */
export function tensionLately(seconds: number) { const to = Date.now(), from = to - seconds * 1000; return ring.some(x => x[0] >= from) ? traceOf(ring, from, to) : null }

export const sensor = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  /** After a reload: take up the Tindeq again without the picker, when the browser still has permission for it and it was in use. */
  async resume() {
    if (state.status !== 'off' || !wanted()) return
    const bt = (navigator as any).bluetooth
    if (!bt?.getDevices) { set({ error: 'A reload drops the Tindeq, and this browser cannot pick it up again by itself. Press Connect.' }); return }
    // A reload always drops the Bluetooth link. The Tindeq needs a few seconds to notice and show itself again, so keep trying for a minute.
    for (let i = 0; i < 20 && state.status === 'off' && wanted(); i++) {
      try {
        const known = (await bt.getDevices()).find((d: any) => (d.name ?? '').startsWith('Progressor'))
        if (!known) { set({ error: 'A reload drops the Tindeq, and the browser has not kept permission for it. Press Connect.' }); return }
        set({ error: `The reload dropped the Tindeq. Picking it up again… (try ${i + 1})` })
        await sensor.connect(known)
        if ((state.status as string) === 'on') { set({ error: null }); return }
      } catch { /* out of reach this time */ }
      await new Promise(r => setTimeout(r, 3000))
    }
    if (state.status === 'off' && wanted()) set({ error: 'The reload dropped the Tindeq and it could not be picked up again. Press its button if its light is off, then Connect.' })
  },
  async connect(known?: any) {
    if (state.status !== 'off') return
    set({ status: 'connecting', error: null })
    try {
      dev = await connectTindeq(samples => {
        const s = state.settings.invert ? samples.map(x => ({ ...x, lb: -x.lb })) : samples
        if (state.recording) buf.push(...s)
        // Every reading with its clock time: the last ten minutes stay in memory (a set's stretch is cut out when it is logged),
        // and everything goes to the workout's recording.
        const now0 = Date.now(), tEnd = s.at(-1)!.t
        const stamped = s.map(x => [Math.round(now0 - (tEnd - x.t) * 1000), x.lb] as [number, number])
        ring.push(...stamped); while (ring.length && ring[0][0] < now0 - RING_MS) ring.shift()
        recorder.add('tindeq', stamped)
        stampedSubs.forEach(f => f(stamped))
        streams.forEach(f => f(s))
        // The sensor sends ~80 readings a second; repaint the live number about 10 times a second.
        const now = Date.now()
        count += s.length
        if (now - countFrom >= 1000) { const hz = Math.round(count * 1000 / Math.max(1, now - countFrom)); count = 0; countFrom = now; set({ hz }) }
        if (now - lastPaint > 100) { lastPaint = now; set({ lb: s.at(-1)!.lb, lastAt: now }) }
      }, () => { dev = null; if (batteryTimer) clearInterval(batteryTimer); note(wanted() ? 'gave up' : 'disconnected'); set({ status: 'off', name: null, recording: false, error: wanted() ? 'The Tindeq dropped out and could not be reached again. It switches itself off after 10 minutes without a connection: press its button, then Connect.' : null }) },
        up => { note(up ? 'back' : 'dropped'); set(up ? { status: 'on', error: null, hz: 0 } : { status: 'connecting', error: 'The Tindeq dropped out. Reconnecting…' }) }, known,
        i => { if ('low' in i) { if (state.log[0]?.what !== 'low battery') note('low battery'); set({ error: 'The Tindeq says its battery is nearly flat: it will switch off soon. Charge it.' }) } else set({ battery_v: Math.round(i.battery_mv / 10) / 100 }) })
      countFrom = Date.now(); count = 0
      want(true)
      set({ status: 'on', name: dev.name, lastAt: 0, hz: 0 })
      note('connected')
    } catch (e: any) {
      // Closing the browser's device picker is not an error.
      set({ status: 'off', error: known || e?.name === 'NotFoundError' ? null : e?.message ?? 'Could not connect' })
    }
  },
  disconnect() { want(false); dev?.disconnect() },
  /** Every reading as it arrives (direction already applied); returns the unsubscribe. */
  onSamples: (f: (s: Sample[]) => void) => { streams.add(f); return () => { streams.delete(f) } },
  async tare() { await dev?.tare() },
  record() { buf = []; set({ recording: true }) },
  /** Ends the recording and returns its samples (seconds, lb of assist). */
  stop(): Sample[] { set({ recording: false }); return buf },
  setSettings(patch: Partial<SensorSettings>) {
    const settings = { ...state.settings, ...patch }
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode: this visit only */ }
    set({ settings })
  },
}
