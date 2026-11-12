/**
 * Cameras as recorders. Each camera in use films continuously in short overlapping pieces and keeps only the last few
 * minutes in memory, and measures how much is moving in its picture. A camera can be tied to a station (squat rack, bench,
 * Smith...). When a heavy set is logged, the camera that saw the most movement during that set says which station it was
 * on, and its film of the set is uploaded and tied to the set's row (observations: source 'vision', metric 'clip').
 * Nothing else is analysed here: the clips are raw material for bar tracking.
 */
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase'
import { recordObservations } from './observations'

const KEY = 'max.cam', BUCKET = 'video'
const PIECE_S = 15, OVERLAP_MS = 600, KEEP_MS = 4 * 60_000
const MOTION_MS = 300, MW = 64, MH = 36
const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

/** A camera the user has set up: whether to film with it, and the station it looks at. deviceId '' is the browser's default camera. */
export interface CamPref { deviceId: string; station: string; use: boolean; label?: string }
interface Prefs { on: boolean; cams: CamPref[]; clip_s: number }
export interface CamInfo extends CamPref {
  label: string
  status: 'off' | 'starting' | 'rec' | 'error'
  error: string | null
  size: string
  /** How much is moving in the picture right now (0 = nothing; a lifter mid-rep is usually well over 2). */
  motion: number
}
export interface CamState {
  on: boolean; clip_s: number
  /** Every camera known: the ones set up, plus any found on this laptop. */
  cams: CamInfo[]
  /** 'rec' when at least one camera is filming. */
  status: 'off' | 'starting' | 'rec' | 'error'
  error: string | null
  /** This visit: clips saved, their size, how many are still uploading, and the station the last set was seen on. */
  clips: number; bytes: number; uploading: number; lastStation: string | null
}

function loadPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    // Before cameras could be more than one, a single deviceId was kept.
    const cams: CamPref[] = Array.isArray(v.cams) ? v.cams : v.deviceId ? [{ deviceId: v.deviceId, station: '', use: true }] : []
    return { on: !!v.on, cams, clip_s: v.clip_s ?? 60 }
  } catch { return { on: false, cams: [], clip_s: 60 } }
}
const p0 = loadPrefs()
const blank = (c: CamPref, label = c.label ?? ''): CamInfo => ({ ...c, label, status: 'off', error: null, size: '', motion: 0 })
let state: CamState = { on: p0.on, clip_s: p0.clip_s, cams: p0.cams.map(c => blank(c)), status: 'off', error: null, clips: 0, bytes: 0, uploading: 0, lastStation: null }
const subs = new Set<() => void>()
const set = (p: Partial<CamState>) => {
  state = { ...state, ...p }
  const live = state.cams.filter(c => c.use)
  state.status = !state.on ? 'off' : live.some(c => c.status === 'rec') ? 'rec' : live.some(c => c.status === 'starting') ? 'starting' : live.some(c => c.status === 'error') || state.error ? 'error' : 'off'
  try { localStorage.setItem(KEY, JSON.stringify({ on: state.on, clip_s: state.clip_s, cams: state.cams.filter(c => c.use || c.station).map(({ deviceId, station, use, label }) => ({ deviceId, station, use, label })) })) } catch { /* this visit only */ }
  subs.forEach(f => f())
}
const setCam = (deviceId: string, p: Partial<CamInfo>) => set({ cams: state.cams.map(c => (c.deviceId === deviceId ? { ...c, ...p } : c)) })

interface Piece { from: number; to: number | null; blob: Blob | null; rec: MediaRecorder; done: Promise<void> }
interface Running {
  stream: MediaStream; pieces: Piece[]; roll: ReturnType<typeof setInterval>; mime: string
  video: HTMLVideoElement; ctx: CanvasRenderingContext2D | null; prev: Uint8ClampedArray | null
  sample: ReturnType<typeof setInterval>; motion: { t: number; v: number }[]
}
const running = new Map<string, Running>()

function startPiece(r: Running) {
  const rec = new MediaRecorder(r.stream, { mimeType: r.mime || undefined, videoBitsPerSecond: 1_000_000 })
  const chunks: Blob[] = []
  const p: Piece = { from: Date.now(), to: null, blob: null, rec, done: Promise.resolve() }
  p.done = new Promise<void>(res => { rec.onstop = () => { p.to = Date.now(); p.blob = new Blob(chunks, { type: (rec.mimeType || r.mime || 'video/webm').split(';')[0] }); res() } })
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.start()
  r.pieces.push(p)
  r.pieces = r.pieces.filter(x => x.to === null || x.to > Date.now() - KEEP_MS)
}
const stopPiece = (p: Piece) => { if (p.rec.state !== 'inactive') p.rec.stop(); return p.done }

/** How much the picture changed since the last look: the average change in brightness over a small copy of the frame. */
function sampleMotion(deviceId: string, r: Running) {
  if (!r.ctx || r.video.readyState < 2) return
  r.ctx.drawImage(r.video, 0, 0, MW, MH)
  const d = r.ctx.getImageData(0, 0, MW, MH).data
  let sum = 0
  if (r.prev) for (let i = 1; i < d.length; i += 4) sum += Math.abs(d[i] - r.prev[i])
  const v = r.prev ? sum / (MW * MH) : 0
  r.prev = d
  const now = Date.now()
  r.motion.push({ t: now, v })
  while (r.motion.length && r.motion[0].t < now - KEEP_MS) r.motion.shift()
  // The readout is refreshed about once a second, not on every look.
  if (r.motion.length % 3 === 0) setCam(deviceId, { motion: Math.round(v * 10) / 10 })
}

const errText = (e: any) => e?.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site in the browser\'s address bar.'
  : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'This camera was not found. Is it plugged in?' : e?.name === 'NotReadableError' ? 'The camera is in use by another program.' : (e?.message ?? String(e))

async function open(deviceId: string, retry = true) {
  if (running.has(deviceId)) return
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setCam(deviceId, { status: 'error', error: 'This browser cannot record from a camera.' }); return }
  setCam(deviceId, { status: 'starting', error: null })
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
    const tr = stream.getVideoTracks()[0], s = tr.getSettings()
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream; video.play().catch(() => {})
    const canvas = document.createElement('canvas'); canvas.width = MW; canvas.height = MH
    const r: Running = { stream, pieces: [], mime: MIMES.find(m => MediaRecorder.isTypeSupported(m)) ?? '', video, ctx: canvas.getContext('2d', { willReadFrequently: true }), prev: null, motion: [],
      roll: setInterval(() => { const cur = r.pieces.at(-1); startPiece(r); if (cur && cur.to === null) setTimeout(() => stopPiece(cur), OVERLAP_MS) }, PIECE_S * 1000),
      sample: setInterval(() => sampleMotion(deviceId, r), MOTION_MS) }
    running.set(deviceId, r)
    tr.onended = () => { close(deviceId); setCam(deviceId, { status: 'error', error: 'The camera stopped. Turn it off and on again.' }) }
    startPiece(r)
    setCam(deviceId, { status: 'rec', label: tr.label || state.cams.find(c => c.deviceId === deviceId)?.label || 'Camera', size: `${s.width ?? '?'}×${s.height ?? '?'} · ${Math.round(s.frameRate ?? 0)} fps` })
    await listDevices()
  } catch (e: any) {
    close(deviceId)
    // The browser can hand out a new id for the same camera: find it again by name and carry its station over.
    if (retry && deviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      const me = state.cams.find(c => c.deviceId === deviceId)
      try { const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); s.getTracks().forEach(t => t.stop()) } catch { /* no access: reported below */ }
      const found = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId)
      const same = me?.label ? found.find(d => d.label === me.label && !state.cams.some(c => c.deviceId === d.deviceId && c.use)) : undefined
      if (me && same) {
        set({ cams: state.cams.filter(c => c.deviceId !== same.deviceId).map(c => (c.deviceId === deviceId ? { ...c, deviceId: same.deviceId } : c)) })
        return open(same.deviceId, false)
      }
    }
    setCam(deviceId, { status: 'error', error: errText(e) })
  }
}
function close(deviceId: string) {
  const r = running.get(deviceId)
  if (!r) return
  clearInterval(r.roll); clearInterval(r.sample)
  for (const p of r.pieces) if (p.rec.state !== 'inactive') { try { p.rec.stop() } catch { /* already stopped */ } }
  r.stream.getTracks().forEach(t => t.stop()); r.video.srcObject = null
  running.delete(deviceId)
}

/** The cameras this laptop has (names show only once camera access has been allowed). */
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const found = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId)
  const cams = [...state.cams]
  found.forEach((d, i) => {
    const k = cams.findIndex(c => c.deviceId === d.deviceId)
    if (k >= 0) cams[k] = { ...cams[k], label: d.label || cams[k].label || `Camera ${i + 1}` }
    else cams.push(blank({ deviceId: d.deviceId, station: '', use: false }, d.label || `Camera ${i + 1}`))
  })
  set({ cams })
}
/** Start or stop cameras so that exactly the ones marked "use" are filming (the default camera when none is chosen). */
function sync() {
  if (!state.on) { for (const id of [...running.keys()]) close(id); set({ cams: state.cams.map(c => ({ ...c, status: 'off' as const, error: null, motion: 0 })), error: null }); return }
  if (!state.cams.some(c => c.use)) set({ cams: [...state.cams.filter(c => c.deviceId !== ''), blank({ deviceId: '', station: state.cams.find(c => c.deviceId === '')?.station ?? '', use: true }, 'Default camera')] })
  const want = new Set(state.cams.filter(c => c.use).map(c => c.deviceId))
  for (const id of [...running.keys()]) if (!want.has(id)) { close(id); setCam(id, { status: 'off', motion: 0 }) }
  for (const id of want) open(id)
}

export const camera = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  /** The live picture from a camera (the first one filming when none is named), for a preview. */
  stream: (deviceId?: string) => (deviceId !== undefined ? running.get(deviceId)?.stream : [...running.values()][0]?.stream) ?? null,
  /** Pick up where the last visit left off (the browser remembers the camera permission). */
  resume() { if (state.on && !running.size && state.status === 'off') sync() },
  setOn(on: boolean) { set({ on }); sync() },
  /** Look for cameras: asks for camera access if it hasn't been given, then lists what is plugged in. */
  async find() {
    try { if (!running.size) { const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); s.getTracks().forEach(t => t.stop()) } set({ error: null }) }
    catch (e: any) { set({ error: errText(e) }) }
    await listDevices()
  },
  /** Film with this camera or not, and the station it looks at. */
  setCam(deviceId: string, p: { use?: boolean; station?: string }) {
    let cams = state.cams.map(c => (c.deviceId === deviceId ? { ...c, ...p } : c))
    // Choosing a named camera retires the stand-in "default camera" entry.
    if (p.use && deviceId !== '') cams = cams.filter(c => c.deviceId !== '' || !c.use).map(c => (c.deviceId === '' ? { ...c, use: false } : c))
    set({ cams }); if (state.on) sync()
  },
  setClipS(clip_s: number) { if (clip_s >= 10 && clip_s <= 180) set({ clip_s }) },
  /** Average movement each filming camera saw between two moments. */
  motionIn(from: number, to: number) {
    return [...running.entries()].map(([deviceId, r]) => {
      const m = r.motion.filter(x => x.t >= from && x.t <= to)
      const info = state.cams.find(c => c.deviceId === deviceId)
      return { deviceId, station: info?.station ?? '', label: info?.label ?? '', motion: m.length ? Math.round((m.reduce((t, x) => t + x.v, 0) / m.length) * 100) / 100 : 0 }
    }).sort((a, b) => b.motion - a.motion)
  },
  /**
   * Upload the film of a stretch of time, from the camera that saw the most movement during it. `prefix` is the folder and
   * start of the file name. Returns that camera's station and what was saved (null when nothing was). `from`/`to` are when
   * it happened if a sensor knows; otherwise the last `clip_s` seconds are used.
   */
  async clip(prefix: string, win?: { from: number; to: number }): Promise<{ station: string | null; data: Record<string, any> | null; seconds: number }> {
    if (!running.size) return { station: null, data: null, seconds: 0 }
    const now = Date.now()
    const from = Math.max(now - KEEP_MS, win?.from ?? now - state.clip_s * 1000), to = Math.min(now, win?.to ?? now)
    const seen = camera.motionIn(from, to)
    const pick = seen[0], r = running.get(pick.deviceId)!
    const station = pick.station || null
    const seconds = Math.round((to - from) / 100) / 10
    set({ lastStation: station })
    // Close the piece being filmed so it can be saved, and carry on in a new one.
    const cur = r.pieces.at(-1); startPiece(r); if (cur) await stopPiece(cur)
    const mine = r.pieces.filter(p => p.blob && p.to !== null && p.to >= from && p.from <= to && p.blob.size > 0)
    if (!mine.length) return { station, data: null, seconds }
    set({ uploading: state.uploading + 1 })
    try {
      const tr = r.stream.getVideoTracks()[0]?.getSettings() ?? {}
      const slug = station ? '-' + station.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''
      const files: { path: string; from: string; to: string; bytes: number }[] = []
      for (const p of mine) {
        const ext = p.blob!.type.includes('mp4') ? 'mp4' : 'webm'
        const path = `${prefix}${slug}-${new Date(p.from).toISOString().replace(/[:.]/g, '-')}.${ext}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, p.blob!, { contentType: p.blob!.type, upsert: true })
        if (error) throw new Error(error.message)
        files.push({ path, from: new Date(p.from).toISOString(), to: new Date(p.to!).toISOString(), bytes: p.blob!.size })
      }
      const bytes = files.reduce((t, f) => t + f.bytes, 0)
      set({ clips: state.clips + 1, bytes: state.bytes + bytes, uploading: state.uploading - 1, error: null })
      return { station, seconds, data: { bucket: BUCKET, files, from: new Date(from).toISOString(), to: new Date(to).toISOString(), width: tr.width ?? null, height: tr.height ?? null, fps: tr.frameRate ?? null, window: win ? 'sensor' : 'last_seconds',
        station, camera: pick.label, cameras: seen.map(({ station, label, motion }) => ({ station, label, motion })) } }
    } catch (e: any) { set({ uploading: state.uploading - 1, error: `A clip did not save: ${e?.message ?? e}` }); return { station, data: null, seconds } }
  },
  /** Save the film of a heavy set that has just been logged and tie it to the set's row. Returns the station. Best effort: a failure here never blocks logging a set. */
  async saveClip(set_: { session_id: string; set_id: string; set_index: number }, win?: { from: number; to: number }): Promise<string | null> {
    const c = await camera.clip(`${set_.session_id}/set${String(set_.set_index).padStart(2, '0')}`, win)
    if (c.data) await recordObservations([{ session_id: set_.session_id, set_id: set_.set_id, source: 'vision', metric: 'clip', value: c.seconds, data: c.data }])
    return c.station
  },
}
export const useCamera = () => useSyncExternalStore(camera.subscribe, camera.get)
