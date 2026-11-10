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
