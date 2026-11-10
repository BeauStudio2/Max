import type { Sample } from './creatine'

// Tindeq Progressor Bluetooth protocol (from Tindeq's published API sample client).
const SERVICE = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57'
const DATA = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57'
const CTRL = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57'
const CMD_TARE = 100, CMD_START = 101, CMD_STOP = 102
const RES_WEIGHT = 1
const KG_TO_LB = 2.20462

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!(navigator as any).bluetooth

/** Weight notifications: [code, length, then repeated (float32 kg, uint32 microseconds)], little endian. */
export function parseWeights(data: DataView): Sample[] {
  if (data.byteLength < 2 || data.getUint8(0) !== RES_WEIGHT) return []
  const out: Sample[] = []
  for (let i = 2; i + 8 <= data.byteLength; i += 8) out.push({ lb: data.getFloat32(i, true) * KG_TO_LB, t: data.getUint32(i + 4, true) / 1e6 })
  return out
}

export interface Tindeq { tare: () => Promise<void>; disconnect: () => void; name: string }

/** Opens the browser's device picker, connects, and streams force samples (lb, seconds) until disconnected. */
export async function connectTindeq(onSamples: (s: Sample[]) => void, onDisconnect: () => void): Promise<Tindeq> {
  const bt = (navigator as any).bluetooth
  if (!bt) throw new Error('This browser has no Bluetooth access. Use Chrome or Edge on the laptop.')
  const device = await bt.requestDevice({ filters: [{ namePrefix: 'Progressor' }], optionalServices: [SERVICE] })
  const server = await device.gatt.connect()
  const service = await server.getPrimaryService(SERVICE)
  const data = await service.getCharacteristic(DATA)
  const ctrl = await service.getCharacteristic(CTRL)
  data.addEventListener('characteristicvaluechanged', (e: any) => { const s = parseWeights(e.target.value as DataView); if (s.length) onSamples(s) })
  await data.startNotifications()
  device.addEventListener('gattserverdisconnected', onDisconnect)
  const send = (cmd: number) => ctrl.writeValue(new Uint8Array([cmd]))
  await send(CMD_START)
  return {
    name: device.name ?? 'Progressor',
    tare: async () => { await send(CMD_STOP); await send(CMD_TARE); await send(CMD_START) },
    disconnect: () => { send(CMD_STOP).catch(() => {}).finally(() => device.gatt.disconnect()) },
  }
}

/* ---------- one shared connection for the whole app (set up in Config, used on Log) ---------- */

export interface SensorSettings { invert: boolean }
const DEFAULTS: SensorSettings = { invert: false }
const KEY = 'max.tindeq'
const loadSettings = (): SensorSettings => { try { return { invert: !!JSON.parse(localStorage.getItem(KEY) ?? '{}').invert } } catch { return DEFAULTS } }

export interface SensorState { status: 'off' | 'connecting' | 'on'; name: string | null; lb: number; error: string | null; recording: boolean; settings: SensorSettings
  /** Clock time of the last reading, and readings per second: a connection that sends nothing shows up as 0. */
  lastAt: number; hz: number }
let state: SensorState = { status: 'off', name: null, lb: 0, error: null, recording: false, settings: loadSettings(), lastAt: 0, hz: 0 }
let count = 0, countFrom = 0
let dev: Tindeq | null = null
let buf: Sample[] = []
let lastPaint = 0
const subs = new Set<() => void>()
const streams = new Set<(s: Sample[]) => void>()
const set = (patch: Partial<SensorState>) => { state = { ...state, ...patch }; subs.forEach(f => f()) }

export const sensor = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  async connect() {
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
      }, () => { dev = null; set({ status: 'off', name: null, recording: false }) })
      countFrom = Date.now(); count = 0
      set({ status: 'on', name: dev.name, lastAt: 0, hz: 0 })
    } catch (e: any) {
      // Closing the browser's device picker is not an error.
      set({ status: 'off', error: e?.name === 'NotFoundError' ? null : e?.message ?? 'Could not connect' })
    }
  },
  disconnect() { dev?.disconnect() },
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
