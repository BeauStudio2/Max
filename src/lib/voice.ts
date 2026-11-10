/**
 * Max's voice: one-word cues spoken through the laptop speakers, and spoken commands heard through its microphone
 * ("Max record", "Max stop", "Max five"...). Settings live on this laptop only (localStorage), the ElevenLabs key included.
 *
 * Two speaking engines:
 *  - browser: the voices built into the browser and Windows (Edge has Microsoft's natural voices, e.g. Svetlana).
 *  - eleven: ElevenLabs. Each phrase is fetched once and kept in the browser's cache, so a cue like "Rest" is paid for once.
 */

export type CueKey = 'rest' | 'next' | 'ack'
export interface VoiceSettings {
  engine: 'browser' | 'eleven'
  browserVoice: string | null
  rate: number; pitch: number; volume: number
  elevenKey: string; elevenVoice: string | null; elevenVoiceName: string | null; elevenModel: string
  cues: Record<CueKey, { on: boolean; word: string }>
  listen: boolean; wake: string
}
const DEFAULTS: VoiceSettings = {
  engine: 'browser', browserVoice: null, rate: 1, pitch: 1, volume: 1,
  elevenKey: '', elevenVoice: null, elevenVoiceName: null, elevenModel: 'eleven_multilingual_v2',
  cues: { rest: { on: true, word: 'Rest' }, next: { on: true, word: '' }, ack: { on: true, word: '' } },
  listen: false, wake: 'Max',
}
const KEY = 'max.voice'
const load = (): VoiceSettings => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { ...DEFAULTS, ...v, cues: { ...DEFAULTS.cues, ...(v.cues ?? {}) } } } catch { return DEFAULTS }
}

export interface VoiceState { settings: VoiceSettings; listening: boolean; heard: string | null; error: string | null; speaking: boolean }
let state: VoiceState = { settings: load(), listening: false, heard: null, error: null, speaking: false }
const subs = new Set<() => void>()
const set = (p: Partial<VoiceState>) => { state = { ...state, ...p }; subs.forEach(f => f()) }

/* ---------- speaking ---------- */

const CACHE = 'max-voice'
const cacheUrl = (voice: string, model: string, text: string) => `https://max-voice.local/${encodeURIComponent(voice)}/${encodeURIComponent(model)}/${encodeURIComponent(text.trim().toLowerCase())}`
// What Max last said, so the microphone doesn't take Max's own words as a command (Max never says the wake word, so this is a backstop).
let lastSaid = ''
let audio: HTMLAudioElement | null = null

async function elevenAudio(text: string, s = state.settings): Promise<Blob> {
  if (!s.elevenKey || !s.elevenVoice) throw new Error('ElevenLabs needs an API key and a voice (Config → Voice).')
  const url = cacheUrl(s.elevenVoice, s.elevenModel, text)
  const cache = 'caches' in window ? await caches.open(CACHE) : null
  const hit = await cache?.match(url)
  if (hit) return hit.blob()
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${s.elevenVoice}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': s.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: s.elevenModel }),
  })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  const blob = await r.blob()
  await cache?.put(url, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }))
  return blob
}

function browserSpeak(text: string, s = state.settings): Promise<void> {
  return new Promise(res => {
    const synth = window.speechSynthesis
    if (!synth) return res()
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const v = synth.getVoices().find(x => x.name === s.browserVoice)
    if (v) { u.voice = v; u.lang = v.lang }
    u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume
    u.onend = () => res(); u.onerror = () => res()
    synth.speak(u)
  })
}

/** Speak a phrase. */
export async function speak(text: string, s = state.settings) {
  text = text.trim()
  if (!text) return
  set({ speaking: true, error: null }); lastSaid = text.toLowerCase()
  try {
    if (s.engine === 'eleven') {
      const blob = await elevenAudio(text, s)
      audio?.pause()
      audio = new Audio(URL.createObjectURL(blob)); audio.volume = s.volume
      await new Promise<void>(res => { audio!.onended = () => res(); audio!.onerror = () => res(); audio!.play().catch(() => res()) })
    } else await browserSpeak(text, s)
  } catch (e: any) {
    set({ error: e?.message ?? String(e) })
    if (s.engine === 'eleven') await browserSpeak(text, s)   // a cue still gets said if ElevenLabs is unreachable
  } finally { set({ speaking: false }) }
}

/** A cue from the session (rest is up, next set...). `text` replaces the cue word when the cue speaks a value. */
export function cue(k: CueKey, text?: string) {
  const c = state.settings.cues[k]
  if (!c?.on) return
  const say = text ?? c.word
  if (say) speak(say)
}

/** Fetch phrases ahead of time so they play instantly (and are paid for once, on ElevenLabs). */
export async function prefetch(phrases: string[], onProgress?: (done: number) => void) {
  let n = 0
  for (const p of phrases) { try { await elevenAudio(p) } catch (e: any) { set({ error: e?.message }); return n } onProgress?.(++n) }
  return n
}
export async function cachedCount() {
  if (!('caches' in window)) return 0
  const c = await caches.open(CACHE)
  const v = state.settings.elevenVoice
  return (await c.keys()).filter(r => !v || r.url.includes('/' + encodeURIComponent(v) + '/')).length
}
export async function clearCache() { if ('caches' in window) await caches.delete(CACHE) }

/* ---------- ElevenLabs voice library ---------- */

export interface LibVoice { voice_id: string; name: string; public_owner_id?: string; accent?: string; gender?: string; age?: string; description?: string; preview_url?: string; mine?: boolean }
const xi = () => ({ 'xi-api-key': state.settings.elevenKey })
export async function myVoices(): Promise<LibVoice[]> {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: xi() })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return ((await r.json()).voices ?? []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, accent: v.labels?.accent, gender: v.labels?.gender, description: v.labels?.description ?? v.description, preview_url: v.preview_url, mine: true }))
}
export async function searchLibrary(q: { search?: string; accent?: string; gender?: string }): Promise<LibVoice[]> {
  const p = new URLSearchParams({ page_size: '30' })
  if (q.search) p.set('search', q.search)
  if (q.accent) p.set('accent', q.accent)
  if (q.gender) p.set('gender', q.gender)
  const r = await fetch('https://api.elevenlabs.io/v1/shared-voices?' + p, { headers: xi() })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return (await r.json()).voices ?? []
}
/** Library voices have to be added to your ElevenLabs account before they can speak. */
export async function addLibraryVoice(v: LibVoice): Promise<string> {
  const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${v.public_owner_id}/${v.voice_id}`, {
    method: 'POST', headers: { ...xi(), 'Content-Type': 'application/json' }, body: JSON.stringify({ new_name: v.name }),
  })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return (await r.json()).voice_id
}

/* ---------- listening ---------- */

export type Command = { kind: 'record' | 'stop' | 'tare' | 'click' | 'next' } | { kind: 'reps'; n: number }
const handlers = new Set<(c: Command) => void>()
/** Pages register for spoken commands; returns the unsubscribe. */
export const onCommand = (f: (c: Command) => void) => { handlers.add(f); return () => { handlers.delete(f) } }

const NUM: Record<string, number> = { zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const WORDS: Record<string, Command['kind']> = { record: 'record', go: 'record', start: 'record', stop: 'stop', done: 'stop', tare: 'tare', tear: 'tare', zero: 'tare', click: 'click', metronome: 'click', next: 'next' }

/** "max record" → record; "max 5" / "max five" → 5 reps. Only words after the wake word count. Exported for testing. */
export function parseCommand(transcript: string, wake = state.settings.wake): Command | null {
  const w = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const wk = wake.toLowerCase()
  // Recognisers often hear "max" as "macs"/"mac"/"maks".
  const isWake = (x: string) => x === wk || (wk === 'max' && ['macs', 'mac', 'maks', 'maxx', 'maxi'].includes(x))
  const i = w.findIndex(isWake)
  if (i < 0 || i === w.length - 1) return null
  const a = w[i + 1]
  if (/^\d+$/.test(a)) return { kind: 'reps', n: Number(a) }
  if (a in NUM && a !== 'zero') return { kind: 'reps', n: NUM[a] }
  if (a === 'zero' && w[i + 2] === 'reps') return { kind: 'reps', n: 0 }
  const k = WORDS[a]
  return k ? { kind: k } as Command : null
}

let rec: any = null
export const recognitionAvailable = () => typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

function startListening() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) { set({ error: 'This browser cannot listen. Use Edge or Chrome.' }); return }
  if (rec) return
  rec = new SR()
  rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = false
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue
      const t: string = e.results[i][0].transcript
      if (state.speaking && t.trim().toLowerCase() === lastSaid) continue   // Max hearing itself
      const c = parseCommand(t)
      set({ heard: t.trim() + (c ? '' : ' (no command)') })
      if (c) handlers.forEach(h => h(c))
    }
  }
  rec.onerror = (e: any) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { set({ error: 'Microphone blocked. Allow it for this site in the address bar.' }); stopListening(true) } }
  // The recogniser stops by itself after a pause; keep it going while listening is on.
  rec.onend = () => { if (state.settings.listen && rec) { try { rec.start() } catch { /* already starting */ } } else { rec = null; set({ listening: false }) } }
  try { rec.start(); set({ listening: true, error: null }) } catch (e: any) { set({ error: e?.message }) }
}
function stopListening(off = false) {
  const r = rec; rec = null
  try { r?.stop() } catch { /* not running */ }
  set({ listening: false }); if (off) voice.setSettings({ listen: false })
}

export const voice = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  setSettings(p: Partial<VoiceSettings>) {
    const settings = { ...state.settings, ...p }
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* private mode: this visit only */ }
    set({ settings })
    if ('listen' in p) (p.listen ? startListening() : stopListening())
  },
  /** Call once from a click (browsers only open the microphone after the page has been used). */
  resume() { if (state.settings.listen && !rec) startListening() },
}
