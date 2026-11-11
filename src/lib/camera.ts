/**
 * The laptop camera as a recorder. While it is on it films continuously in short overlapping pieces and keeps only the last
 * few minutes in memory. When a heavy set is logged, the pieces covering that set are uploaded and tied to the set's row
 * (observations: source 'vision', metric 'clip'). Nothing is analysed here: the clips are raw material for bar tracking.
 */
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase'
import { recordObservations } from './observations'

const KEY = 'max.cam', BUCKET = 'video'
const PIECE_S = 15, OVERLAP_MS = 600, KEEP_MS = 4 * 60_000
const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

interface Prefs { on: boolean; deviceId: string; clip_s: number }
interface Piece { from: number; to: number | null; blob: Blob | null; rec: MediaRecorder; done: Promise<void> }
export interface CamState extends Prefs {
  status: 'off' | 'starting' | 'rec' | 'error'
  error: string | null
  devices: { id: string; label: string }[]
  /** This visit: clips saved, their size, and how many are still uploading. */
  clips: number; bytes: number; uploading: number
  size: string
}
const prefs = (): Prefs => { try { return { on: false, deviceId: '', clip_s: 60, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { on: false, deviceId: '', clip_s: 60 } } }
let state: CamState = { ...prefs(), status: 'off', error: null, devices: [], clips: 0, bytes: 0, uploading: 0, size: '' }
const subs = new Set<() => void>()
const set = (p: Partial<CamState>) => {
  state = { ...state, ...p }
  try { localStorage.setItem(KEY, JSON.stringify({ on: state.on, deviceId: state.deviceId, clip_s: state.clip_s })) } catch { /* this visit only */ }
  subs.forEach(f => f())
}

let stream: MediaStream | null = null
let pieces: Piece[] = []
let timer: ReturnType<typeof setInterval> | null = null
let mime = ''

function startPiece() {
  if (!stream) return
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1_000_000 })
  const chunks: Blob[] = []
  const p: Piece = { from: Date.now(), to: null, blob: null, rec, done: Promise.resolve() }
  p.done = new Promise<void>(res => { rec.onstop = () => { p.to = Date.now(); p.blob = new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] }); res() } })
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.start()
  pieces.push(p)
  pieces = pieces.filter(x => x.to === null || x.to > Date.now() - KEEP_MS)
}
const stopPiece = (p: Piece) => { if (p.rec.state !== 'inactive') p.rec.stop(); return p.done }
/** Start the next piece, then close the one before it, so the two overlap and nothing is missed between them. */
function roll() {
  const cur = pieces.at(-1)
  startPiece()
  if (cur && cur.to === null) setTimeout(() => stopPiece(cur), OVERLAP_MS)
}

async function open() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { set({ status: 'error', error: 'This browser cannot record from a camera.' }); return }
  set({ status: 'starting', error: null })
  try {
    close()
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: state.deviceId ? { exact: state.deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
    mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) ?? ''
    const tr = stream.getVideoTracks()[0], s = tr.getSettings()
    tr.onended = () => { if (state.on) set({ status: 'error', error: 'The camera stopped. Turn it off and on again.' }) }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    startPiece()
    timer = setInterval(roll, PIECE_S * 1000)
    set({ status: 'rec', devices, size: `${s.width ?? '?'}×${s.height ?? '?'} · ${Math.round(s.frameRate ?? 0)} fps` })
  } catch (e: any) {
    const m = e?.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site in the browser\'s address bar.'
      : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'No camera found.' : e?.name === 'NotReadableError' ? 'The camera is in use by another program.' : (e?.message ?? String(e))
    close(); set({ status: 'error', error: m })
  }
}
function close() {
  if (timer) clearInterval(timer); timer = null
  for (const p of pieces) if (p.rec.state !== 'inactive') { try { p.rec.stop() } catch { /* already stopped */ } }
  pieces = []
  stream?.getTracks().forEach(t => t.stop()); stream = null
}

export const camera = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  /** The live picture, for a preview. */
  stream: () => stream,
  /** Pick up where the last visit left off (the browser remembers the camera permission). */
  resume() { if (state.on && state.status === 'off') open() },
  setOn(on: boolean) { set({ on }); if (on) open(); else { close(); set({ status: 'off', error: null }) } },
  setDevice(deviceId: string) { set({ deviceId }); if (state.on) open() },
  setClipS(clip_s: number) { if (clip_s >= 10 && clip_s <= 180) set({ clip_s }) },
  /**
   * Save the film of a set that has just been logged. `from`/`to` are when the set happened if a sensor knows; otherwise the
   * last `clip_s` seconds are kept. Best effort: a failure here never blocks logging a set.
   */
  async saveClip(set_: { session_id: string; set_id: string; set_index: number }, win?: { from: number; to: number }) {
    if (state.status !== 'rec' || !stream) return
    const now = Date.now()
    const from = Math.max(now - KEEP_MS, win?.from ?? now - state.clip_s * 1000), to = Math.min(now, win?.to ?? now)
    // Close the piece being filmed so it can be saved, and carry on in a new one.
    const cur = pieces.at(-1); startPiece(); if (cur) await stopPiece(cur)
    const mine = pieces.filter(p => p.blob && p.to !== null && p.to >= from && p.from <= to && p.blob.size > 0)
    if (!mine.length) return
    set({ uploading: state.uploading + 1 })
    try {
      const tr = stream?.getVideoTracks()[0]?.getSettings() ?? {}
      const files: { path: string; from: string; to: string; bytes: number }[] = []
      for (const p of mine) {
        const ext = p.blob!.type.includes('mp4') ? 'mp4' : 'webm'
        const path = `${set_.session_id}/set${String(set_.set_index).padStart(2, '0')}-${new Date(p.from).toISOString().replace(/[:.]/g, '-')}.${ext}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, p.blob!, { contentType: p.blob!.type, upsert: true })
        if (error) throw new Error(error.message)
        files.push({ path, from: new Date(p.from).toISOString(), to: new Date(p.to!).toISOString(), bytes: p.blob!.size })
      }
      const bytes = files.reduce((t, f) => t + f.bytes, 0)
      await recordObservations([{ session_id: set_.session_id, set_id: set_.set_id, source: 'vision', metric: 'clip', value: Math.round((to - from) / 100) / 10,
        data: { bucket: BUCKET, files, from: new Date(from).toISOString(), to: new Date(to).toISOString(), width: tr.width ?? null, height: tr.height ?? null, fps: tr.frameRate ?? null, window: win ? 'sensor' : 'last_seconds' } }])
      set({ clips: state.clips + 1, bytes: state.bytes + bytes, uploading: state.uploading - 1, error: null })
    } catch (e: any) { set({ uploading: state.uploading - 1, error: `A clip did not save: ${e?.message ?? e}` }) }
  },
}
export const useCamera = () => useSyncExternalStore(camera.subscribe, camera.get)
