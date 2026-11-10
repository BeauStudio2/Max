import { apiKeys } from './keys'
import { supabase } from '../supabase'

/**
 * Max's voice: one-word cues spoken through the laptop speakers, and spoken commands heard through its microphone
 * ("Max record", "Max stop", "Max five"...). Settings live on this laptop only (localStorage), the ElevenLabs key included.
 *
 * Two speaking engines:
 *  - browser: the voices built into the browser and Windows (Edge has Microsoft's natural voices, e.g. Svetlana).
 *  - eleven: ElevenLabs. Each phrase is fetched once and kept in the browser's cache, so a cue like "Rest" is paid for once.
 */

/** warn: rest nearly up · lift: rest up · over: a minute over · rack: end the set · next: weight and rep goal · plates: plates and chains · ack: repeat a command back. */
export type CueKey = 'warn' | 'lift' | 'over' | 'rack' | 'next' | 'plates' | 'ack'
export interface VoiceSettings {
  engine: 'browser' | 'eleven'
  browserVoice: string | null
  rate: number; pitch: number; volume: number
  elevenVoice: string | null; elevenVoiceName: string | null; elevenModel: string
  cues: Record<CueKey, { on: boolean; word: string }>
  listen: boolean; wake: string
}
const DEFAULTS: VoiceSettings = {
  engine: 'browser', browserVoice: null, rate: 1, pitch: 1, volume: 1,
  elevenVoice: null, elevenVoiceName: null, elevenModel: 'eleven_multilingual_v2',
  cues: { warn: { on: true, word: 'Ten seconds' }, lift: { on: true, word: 'Lift' }, over: { on: true, word: 'Overtime' }, rack: { on: true, word: 'Rack' },
    next: { on: true, word: '' }, plates: { on: true, word: '' }, ack: { on: true, word: '' } },
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

/* Where a phrase's audio comes from, in order: this browser's cache (instant, works offline) → Max's shared store in Supabase
   (recorded once, used by every browser and laptop) → ElevenLabs (paid; the result is saved to both). */
const BUCKET = 'voice'
const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blank'
const storePath = (voiceId: string, model: string, text: string) => `${voiceId}/${model}/${slug(text)}.mp3`

async function fromStore(path: string): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  return error || !data || data.size < 100 ? null : data
}
async function toStore(path: string, blob: Blob) {
  await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'audio/mpeg', upsert: true })
}
async function fromEleven(text: string, s: VoiceSettings): Promise<Blob> {
  const key = apiKeys.get('elevenlabs')
  if (!key) throw new Error('This phrase isn\'t recorded yet, and there\'s no ElevenLabs key on this laptop to record it (Config → API keys).')
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${s.elevenVoice}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: s.elevenModel }),
  })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.blob()
}

async function elevenAudio(text: string, s = state.settings, stored?: Set<string>): Promise<Blob> {
  if (!s.elevenVoice) throw new Error('Choose an ElevenLabs voice (Config → Voice).')
  const url = cacheUrl(s.elevenVoice, s.elevenModel, text), path = storePath(s.elevenVoice, s.elevenModel, text)
  const cache = 'caches' in window ? await caches.open(CACHE) : null
  const hit = await cache?.match(url)
  if (hit) {
    // Recorded on this laptop before the shared store existed: share it now.
    const blob = await hit.blob()
    if (stored && !stored.has(path)) await toStore(path, blob)
    return blob
  }
  let blob = !stored || stored.has(path) ? await fromStore(path) : null
  if (!blob) { blob = await fromEleven(text, s); await toStore(path, blob) }
  await cache?.put(url, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }))
  return blob
}

/** Phrases already recorded in the shared store for the chosen voice and model. */
async function storedPaths(s = state.settings): Promise<Set<string>> {
  if (!s.elevenVoice) return new Set()
  const dir = `${s.elevenVoice}/${s.elevenModel}`
  const out = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(dir, { limit: 1000, offset })
    if (error || !data?.length) break
    data.forEach(f => out.add(`${dir}/${f.name}`))
    if (data.length < 1000) break
  }
  return out
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

// Each new utterance cuts off the one before (a newer cue matters more).
let gen = 0

/** Speak one or more short phrases in turn. Recorded voices play each phrase as its own clip, so every piece can be recorded ahead of time. */
export async function speak(text: string | string[], s = state.settings) {
  const parts = (Array.isArray(text) ? text : [text]).map(x => x.trim()).filter(Boolean)
  if (!parts.length) return
  const my = ++gen
  set({ speaking: true, error: null }); lastSaid = parts.join(' ').toLowerCase()
  try {
    if (s.engine === 'eleven') {
      audio?.pause()
      for (const p of parts) {
        const blob = await elevenAudio(p, s)
        if (my !== gen) return
        audio = new Audio(URL.createObjectURL(blob)); audio.volume = s.volume
        await new Promise<void>(res => { audio!.onended = () => res(); audio!.onerror = () => res(); audio!.play().catch(() => res()) })
        if (my !== gen) return
      }
    } else await browserSpeak(parts.join(', '), s)
  } catch (e: any) {
    set({ error: e?.message ?? String(e) })
    if (s.engine === 'eleven' && my === gen) await browserSpeak(parts.join(', '), s)   // a cue still gets said if ElevenLabs is unreachable
  } finally { if (my === gen) set({ speaking: false }) }
}

/** A cue from the session. `text` replaces the cue word when the cue speaks values (the next weight, the plates). */
export function cue(k: CueKey, text?: string | string[]) {
  const c = state.settings.cues[k]
  if (!c?.on) return
  const say = text ?? c.word
  if (say && say.length) speak(say)
}
export const cueWord = (k: CueKey) => state.settings.cues[k]?.word ?? ''

/* Words for numbers, so every spoken value is one of a fixed set of recorded phrases. */
export const sayLb = (lb: number) => { const w = Math.round(lb * 4) / 4, f = w - Math.floor(w); return String(Math.floor(w)) + (f === 0.5 ? ' and a half' : f === 0.25 ? ' and a quarter' : f === 0.75 ? ' and three quarters' : '') }
export const saySeconds = (sec: number) => { const s = Math.max(0, Math.round(sec)); return String(s <= 30 ? s : Math.round(s / 5) * 5) }
/** Everything Max can say, for recording ahead of time. */
export function allPhrases() {
  const c = state.settings.cues
  const words = [c.warn.word, c.lift.word, c.over.word, c.rack.word, 'Go', 'Record', 'Stop', 'Tare', 'Done', 'Each side', 'Chains', 'No chains', 'half', 'five eighths', 'seconds']
  const nums = Array.from({ length: 31 }, (_, i) => String(i))
  for (let n = 35; n <= 600; n += 5) nums.push(String(n))
  const halves: string[] = []
  for (let w = 45; w < 600; w += 2.5) if (w % 1) halves.push(sayLb(w))
  return [...new Set([...words, ...nums, '1 and a quarter', '2 and a half', ...halves].filter(Boolean))]
}

/** Fetch phrases ahead of time so they play instantly (and are paid for once, on ElevenLabs). */
/** Record phrases ahead of time: anything not in the shared store is bought from ElevenLabs once and stored; all of it is also kept in this browser. */
export async function prefetch(phrases: string[], onProgress?: (done: number) => void) {
  const stored = await storedPaths()
  let n = 0
  for (const p of phrases) { try { await elevenAudio(p, state.settings, stored) } catch (e: any) { set({ error: e?.message }); return n } onProgress?.(++n) }
  return n
}
/** How many phrases the chosen voice has: in the shared store, and in this browser. */
export async function recordedCounts() {
  const v = state.settings.elevenVoice
  const shared = (await storedPaths()).size
  let local = 0
  if ('caches' in window && v) local = (await (await caches.open(CACHE)).keys()).filter(r => r.url.includes('/' + encodeURIComponent(v) + '/')).length
  return { shared, local }
}
export const cachedCount = async () => (await recordedCounts()).local
export async function clearCache() { if ('caches' in window) await caches.delete(CACHE) }

/* ---------- ElevenLabs voice library ---------- */

export interface LibVoice { voice_id: string; name: string; public_owner_id?: string; accent?: string; gender?: string; age?: string; description?: string; preview_url?: string; mine?: boolean
  /** ElevenLabs' kind of voice: premade (built in), cloned, generated, professional (a professional clone; may still be training). */
  category?: string; training?: string }
const xi = () => ({ 'xi-api-key': apiKeys.get('elevenlabs') })
export async function myVoices(): Promise<LibVoice[]> {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: xi() })
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return ((await r.json()).voices ?? []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, accent: v.labels?.accent, gender: v.labels?.gender, description: v.labels?.description ?? v.description, preview_url: v.preview_url, mine: true,
    category: v.category, training: v.category === 'professional' ? v.fine_tuning?.state?.[Object.keys(v.fine_tuning?.state ?? {})[0]] ?? v.fine_tuning?.finetuning_state : undefined }))
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

export type Command = { kind: 'go' | 'stop' | 'pain' | 'tare' | 'click' | 'next' | 'plates' | 'time' } | { kind: 'reps'; n: number }
const handlers = new Set<(c: Command) => void>()
/** Pages register for spoken commands; returns the unsubscribe. */
export const onCommand = (f: (c: Command) => void) => { handlers.add(f); return () => { handlers.delete(f) } }

const NUM: Record<string, number> = { zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const WORDS: Record<string, Command['kind']> = { go: 'go', record: 'go', start: 'go', stop: 'stop', done: 'stop', pain: 'pain', tare: 'tare', tear: 'tare', zero: 'tare', click: 'click', metronome: 'click', next: 'next', plates: 'plates', plate: 'plates', time: 'time' }

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
