import { useEffect, useState } from 'react'
import { addLibraryVoice, cachedCount, clearCache, myVoices, prefetch, recognitionAvailable, searchLibrary, speak, voice, type CueKey, type LibVoice } from '../../lib/voice'
import { useVoice } from '../../lib/useVoice'
import { useKeys } from '../../lib/keys'
import { T } from '../today/shared'

const KIND: Record<string, string> = { cloned: 'clone', professional: 'professional clone', generated: 'designed', famous: 'library', high_quality: 'library' }
const TEST = 'Rest. Two hundred eighty five. Record.'
/** Words worth saving ahead of time: the cue words, the acknowledgements, and every weight and rep count Max will say. */
const phrases = (rest: string) => {
  const lb: string[] = []
  for (let w = 45; w <= 600; w += 5) lb.push(String(w))
  for (let w = 47.5; w <= 600; w += 5) lb.push(String(Math.floor(w)) + ' and a half')
  return [...new Set([rest, 'Record', 'Stop', 'Tare', 'Done', ...Array.from({ length: 31 }, (_, i) => String(i)), ...lb].filter(Boolean))]
}

/** Config → Voice: how Max sounds, which cues it says, and the wake word for spoken commands. Kept on this laptop. */
export default function Voice() {
  const v = useVoice(), s = v.settings
  const hasKey = !!useKeys().find(k => k.id === 'elevenlabs')?.key
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [all, setAll] = useState(false)
  const [mine, setMine] = useState<LibVoice[] | null>(null)
  const [filter, setFilter] = useState('')
  const [lib, setLib] = useState<LibVoice[] | null>(null)
  const [q, setQ] = useState({ search: 'russian', gender: 'female' })
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cached, setCached] = useState(0)
  const [saving, setSaving] = useState<{ done: number; of: number } | null>(null)
  const [preview, setPreview] = useState<HTMLAudioElement | null>(null)

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    load(); window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])
  useEffect(() => { cachedCount().then(setCached) }, [s.elevenVoice, saving?.done, v.speaking])

  // English voices plus Russian ones (a Russian voice reading English has the accent); "all" shows every voice installed.
  const shown = voices.filter(x => all || x.lang.startsWith('en') || x.lang.startsWith('ru'))
    .sort((a, b) => Number(b.lang.startsWith('ru')) - Number(a.lang.startsWith('ru')) || Number(/natural|online/i.test(b.name)) - Number(/natural|online/i.test(a.name)) || a.name.localeCompare(b.name))
  const run = async (label: string, f: () => Promise<void>) => { setBusy(label); setErr(null); try { await f() } catch (e: any) { setErr(e?.message ?? String(e)) } finally { setBusy(null) } }
  const play = (url?: string) => { if (!url) return; preview?.pause(); const a = new Audio(url); setPreview(a); a.play().catch(() => {}) }
  const setCue = (k: CueKey, p: Partial<{ on: boolean; word: string }>) => voice.setSettings({ cues: { ...s.cues, [k]: { ...s.cues[k], ...p } } })
  const pick = (x: LibVoice, id = x.voice_id) => voice.setSettings({ engine: 'eleven', elevenVoice: id, elevenVoiceName: x.name })

  const libRow = (x: LibVoice, add: boolean) => (
    <tr key={x.voice_id} className={s.elevenVoice === x.voice_id ? 'sel' : ''}>
      <td className="stick">{x.name}{x.category && x.category !== 'premade' && <span className="vkind">{KIND[x.category] ?? x.category}{x.training && x.training !== 'fine_tuned' ? ` · ${x.training.replace(/_/g, ' ')}` : ''}</span>}</td>
      <td className="small muted">{[x.accent, x.gender, x.age].filter(Boolean).join(' · ')}</td>
      <td className="small muted wrapcell">{x.description?.slice(0, 110)}</td>
      <td className="nowrap">
        {x.preview_url && <button className="ghost small" onClick={() => play(x.preview_url)} data-tip="Play ElevenLabs' sample (free)." data-pos="left">▶ sample</button>}
        {add
          ? <button className="ghost small" disabled={!!busy} onClick={() => run('add', async () => { const id = await addLibraryVoice(x); pick(x, id); setMine(await myVoices()) })} data-tip="Add to your ElevenLabs voices and use it for Max." data-pos="left">Add + use</button>
          : <button className="ghost small" onClick={() => pick(x)}>{s.elevenVoice === x.voice_id ? 'In use' : 'Use'}</button>}
      </td>
    </tr>
  )

  return (
    <section className="card voicecfg">
      <h2><T tip="Max says short cues through the laptop speakers and listens through its microphone for commands that start with the wake word. Everything here is kept on this laptop." pos="right">Voice</T></h2>

      <div className="seg engine">
        <button className={s.engine === 'browser' ? 'on' : ''} onClick={() => voice.setSettings({ engine: 'browser' })}>Built-in voices (free)</button>
        <button className={s.engine === 'eleven' ? 'on' : ''} onClick={() => voice.setSettings({ engine: 'eleven' })}>ElevenLabs (paid)</button>
      </div>

      {s.engine === 'browser' ? (
        <div className="vblock">
          <div className="sensrow">
            <label className="grow">Voice
              <select value={s.browserVoice ?? ''} onChange={e => voice.setSettings({ browserVoice: e.target.value || null })}>
                <option value="">Browser default</option>
                {shown.map(x => <option key={x.name} value={x.name}>{x.name} · {x.lang}</option>)}
              </select>
            </label>
            <label className="toggle small"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> all languages</label>
          </div>
          {!voices.some(x => /natural|online/i.test(x.name)) && <p className="small muted">The natural-sounding Microsoft voices (Svetlana, Dariya, Aria…) only show in Edge.</p>}
          <div className="planfields vfields">
            <label>Speed<input type="range" min="0.6" max="1.6" step="0.05" value={s.rate} onChange={e => voice.setSettings({ rate: Number(e.target.value) })} /><span className="small muted">{s.rate.toFixed(2)}</span></label>
            <label>Pitch<input type="range" min="0.5" max="1.5" step="0.05" value={s.pitch} onChange={e => voice.setSettings({ pitch: Number(e.target.value) })} /><span className="small muted">{s.pitch.toFixed(2)}</span></label>
          </div>
        </div>
      ) : (
        <div className="vblock">
          <div className="planfields vfields">
            <label><T tip="Multilingual v2 sounds best; Flash is faster and costs half.">Model</T>
              <select value={s.elevenModel} onChange={e => voice.setSettings({ elevenModel: e.target.value })}>
                <option value="eleven_multilingual_v2">Multilingual v2</option>
                <option value="eleven_flash_v2_5">Flash v2.5</option>
              </select>
            </label>
          </div>
          <p className="small">In use: <b>{s.elevenVoiceName ?? 'none chosen'}</b></p>
          {!hasKey && <p className="small muted">Add your ElevenLabs key under <a className="linkish" href="#keys" onClick={e => { e.preventDefault(); document.getElementById('keys')?.scrollIntoView({ behavior: 'smooth' }) }}>API keys</a> to search voices and speak.</p>}
          {hasKey && (
            <>
              <div className="sensrow">
                <button className="ghost small" disabled={!!busy} onClick={() => run('mine', async () => setMine(await myVoices()))}>My voices</button>
                <span className="small muted">or search the voice library:</span>
                <input className="vsearch" value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} placeholder="russian" />
                <select className="mini inline" value={q.gender} onChange={e => setQ({ ...q, gender: e.target.value })}><option value="female">female</option><option value="male">male</option><option value="">any</option></select>
                <button className="ghost small" disabled={!!busy} onClick={() => run('lib', async () => setLib(await searchLibrary(q)))}>Search</button>
                {busy && <span className="small muted">working…</span>}
              </div>
              {mine && (() => {
                const f = filter.trim().toLowerCase()
                const match = (x: LibVoice) => !f || x.name.toLowerCase().includes(f)
                const own = mine.filter(x => x.category && x.category !== 'premade' && match(x)).sort((a, b) => a.name.localeCompare(b.name))
                const built = mine.filter(x => (!x.category || x.category === 'premade') && match(x)).sort((a, b) => a.name.localeCompare(b.name))
                return (
                  <>
                    <input className="vsearch" placeholder="filter by name" value={filter} onChange={e => setFilter(e.target.value)} />
                    <div className="tablewrap"><table className="sheet cfg vtable"><tbody>
                      <tr className="vhead"><td colSpan={4}>Your voices ({own.length})</td></tr>
                      {own.map(x => libRow(x, false))}
                      {!own.length && <tr><td colSpan={4} className="small muted">{f ? `No voice of yours matches “${filter.trim()}”.` : 'No voices of your own on this account.'} A professional clone can take hours to train before it shows up here, and the API key has to come from the same ElevenLabs account (and workspace) the voice was made in.</td></tr>}
                      {built.length > 0 && <tr className="vhead"><td colSpan={4}>ElevenLabs built-in ({built.length})</td></tr>}
                      {built.map(x => libRow(x, false))}
                    </tbody></table></div>
                  </>
                )
              })()}
              {lib && (lib.length ? <div className="tablewrap"><table className="sheet cfg vtable"><tbody>{lib.map(x => libRow(x, true))}</tbody></table></div> : <p className="small muted">No voices found.</p>)}
              <p className="small muted">
                Each phrase is bought once and saved in this browser: <b>{cached}</b> saved for this voice.{' '}
                <button className="linkish" disabled={!s.elevenVoice || !!saving} onClick={async () => { const ph = phrases(s.cues.rest.word); setSaving({ done: 0, of: ph.length }); await prefetch(ph, d => setSaving({ done: d, of: ph.length })); setSaving(null) }}
                  data-tip="Fetch the cue words, 0–30 and every weight from 45 to 600 now (about 250 short phrases), so nothing is bought mid-session." data-pos="right">{saving ? `saving ${saving.done}/${saving.of}…` : 'Save all cue words now'}</button>
                {' · '}<button className="linkish" onClick={async () => { await clearCache(); setCached(0) }}>clear saved</button>
              </p>
            </>
          )}
        </div>
      )}

      <div className="sensrow">
        <input className="vsearch wide" id="vtest" defaultValue={TEST} />
        <button className="primary small" disabled={v.speaking} onClick={() => speak((document.getElementById('vtest') as HTMLInputElement).value)}>{v.speaking ? 'Speaking…' : '▶ Audition'}</button>
      </div>
      {(err || v.error) && <p className="small err">{err ?? v.error}</p>}

      <h3>Cues Max says</h3>
      <div className="capgrid vcues">
        <span className="capkind">Rest is up</span>
        <input value={s.cues.rest.word} onChange={e => setCue('rest', { word: e.target.value })} />
        <button type="button" className={'switch' + (s.cues.rest.on ? ' on' : '')} onClick={() => setCue('rest', { on: !s.cues.rest.on })}>{s.cues.rest.on ? 'On' : 'Off'}</button>
        <span className="capkind">Next weight</span>
        <span className="small muted">says the next heavy set's weight after each set is logged</span>
        <button type="button" className={'switch' + (s.cues.next.on ? ' on' : '')} onClick={() => setCue('next', { on: !s.cues.next.on })}>{s.cues.next.on ? 'On' : 'Off'}</button>
        <span className="capkind">Confirm commands</span>
        <span className="small muted">repeats a spoken command back ("Record", "Stop", "Tare", the reps)</span>
        <button type="button" className={'switch' + (s.cues.ack.on ? ' on' : '')} onClick={() => setCue('ack', { on: !s.cues.ack.on })}>{s.cues.ack.on ? 'On' : 'Off'}</button>
      </div>

      <h3>Commands</h3>
      {!recognitionAvailable() ? <p className="small muted">This browser can't listen. Use Edge or Chrome.</p> : (
        <>
          <div className="planfields vfields">
            <label><T tip="Commands only count when they start with this word, so talk in the gym doesn't trigger anything.">Wake word</T>
              <input defaultValue={s.wake} onBlur={e => voice.setSettings({ wake: e.target.value.trim() || 'Max' })} />
            </label>
            <label className="toggle"><T tip="Same switch as the Mic button on Log.">Listening</T>
              <button type="button" className={'switch' + (s.listen ? ' on' : '')} aria-pressed={s.listen} onClick={() => voice.setSettings({ listen: !s.listen })}>{s.listen ? 'On' : 'Off'}</button>
            </label>
          </div>
          <p className="small muted">Say “{s.wake} record”, “{s.wake} stop”, “{s.wake} tare”, “{s.wake} click” (metronome), “{s.wake} next” (says the next weight), or “{s.wake} five” to log 5 reps on the next heavy set. Recognition runs through the browser's online speech service, so it needs internet.</p>
          {v.heard && <p className="small">Last heard: “{v.heard}”</p>}
        </>
      )}
    </section>
  )
}
