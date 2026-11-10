import { useSyncExternalStore } from 'react'

/**
 * API keys for outside services, kept only in this browser on this laptop (never sent to Max's database).
 * Known services can be tested; any other key can be added by name for later use.
 */
export interface Service { id: string; name: string; where: string; test?: (key: string) => Promise<string> }
export const SERVICES: Service[] = [
  {
    id: 'elevenlabs', name: 'ElevenLabs', where: 'elevenlabs.io → profile → API keys. Used for Max\'s voice.',
    async test(key) {
      const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } })
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`)
      const j = await r.json()
      return j.character_limit != null ? `OK · ${j.tier ?? 'plan'} · ${(j.character_limit - (j.character_count ?? 0)).toLocaleString()} characters left this month` : 'OK'
    },
  },
]

export interface KeyEntry { id: string; name: string; key: string }
const KEY = 'max.keys'
const load = (): KeyEntry[] => {
  try {
    const list: KeyEntry[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    // Carry over the ElevenLabs key from where the Voice settings used to keep it.
    const old = JSON.parse(localStorage.getItem('max.voice') ?? '{}').elevenKey
    if (old && !list.some(k => k.id === 'elevenlabs')) list.push({ id: 'elevenlabs', name: 'ElevenLabs', key: old })
    return list
  } catch { return [] }
}
let keys = load()
const subs = new Set<() => void>()
const save = (next: KeyEntry[]) => { keys = next; try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode: this visit only */ } subs.forEach(f => f()) }

export const apiKeys = {
  all: () => keys,
  get: (id: string) => keys.find(k => k.id === id)?.key ?? '',
  set(id: string, name: string, key: string) {
    const k = key.trim()
    save(k ? (keys.some(x => x.id === id) ? keys.map(x => (x.id === id ? { ...x, name, key: k } : x)) : [...keys, { id, name, key: k }]) : keys.filter(x => x.id !== id))
  },
  remove: (id: string) => save(keys.filter(x => x.id !== id)),
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
}
export const useKeys = () => useSyncExternalStore(apiKeys.subscribe, apiKeys.all)
