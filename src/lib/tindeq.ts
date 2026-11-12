import type { Sample } from './creatine'

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
    battery: async () => { await send(CMD_BATTERY) },
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

export const sensor = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  /** After a reload: take up the Tindeq again without the picker, when the browser still has permission for it and it was in use. */
  async resume() {
    if (state.status !== 'off' || !wanted()) return
    try {
      const known = (await (navigator as any).bluetooth?.getDevices?.() ?? []).find((d: any) => (d.name ?? '').startsWith('Progressor'))
      if (known) await sensor.connect(known)
    } catch { /* not supported or out of reach: Connect still works */ }
  },
  async connect(known?: any) {
    if (state.status !== 'off') return
    set({ status: 'connecting', error: null })
    try {
      dev = await connectTindeq(samples => {
        const s = state.settings.invert ? samples.map(x => ({ ...x, lb: -x.lb })) : samples
        if (state.recording) buf.push(...s)
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
      // Battery now and every five minutes.
      const d = dev; d.battery().catch(() => {})
      if (batteryTimer) clearInterval(batteryTimer)
      batteryTimer = setInterval(() => { if (dev === d && state.status === 'on') d.battery().catch(() => {}) }, 300_000)
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
