import { useEffect, useRef, useState } from 'react'

const load = (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return v > 0 ? v : d } catch { return d } }
const store = (k: string, v: number) => { try { localStorage.setItem(k, String(v)) } catch { /* private mode: keep it in memory only */ } }

/**
 * A click track for rep tempo. Beats are scheduled on the audio clock (not timers), so the tempo stays exact
 * even when the page is busy. The first beat of each rep is a higher click.
 */
export default function Metronome() {
  const [on, setOn] = useState(false)
  const [bpm, setBpm] = useState(() => load('max.metro.bpm', 60))
  const [per, setPer] = useState(() => load('max.metro.per', 2))
  const ctx = useRef<AudioContext | null>(null)
  const cfg = useRef({ bpm, per }); cfg.current = { bpm, per }

  useEffect(() => {
    if (!on) return
    const ac = (ctx.current ??= new (window.AudioContext || (window as any).webkitAudioContext)())
    ac.resume()
    let next = ac.currentTime + 0.08, beat = 0
    const click = (t: number, accent: boolean) => {
      const o = ac.createOscillator(), g = ac.createGain()
      o.frequency.value = accent ? 1320 : 880
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.08)
    }
    // Look a little ahead and queue every beat due in that window.
    const id = setInterval(() => {
      while (next < ac.currentTime + 0.15) { click(next, beat % cfg.current.per === 0); beat++; next += 60 / cfg.current.bpm }
    }, 25)
    return () => clearInterval(id)
  }, [on])
  useEffect(() => () => { ctx.current?.close() }, [])

  const num = (v: string, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d }
  return (
    <div className="metro">
      <span className="small muted hastip" data-tip="Click track for rep tempo. Beats per minute, and how many beats make one rep (the first beat of each rep is the higher click)." data-pos="right">Metronome</span>
      <div className="metrorow">
        <button type="button" className={'switch' + (on ? ' on' : '')} aria-pressed={on} onClick={() => setOn(o => !o)}>{on ? '■' : '▶'}</button>
        <input inputMode="numeric" aria-label="Beats per minute" defaultValue={bpm} key={'b' + bpm} onBlur={e => { const v = num(e.target.value, 20, 240, bpm); setBpm(v); store('max.metro.bpm', v) }} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className="small muted">bpm</span>
        <input inputMode="numeric" aria-label="Beats per rep" defaultValue={per} key={'p' + per} onBlur={e => { const v = num(e.target.value, 1, 12, per); setPer(v); store('max.metro.per', v) }} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className="small muted">/rep</span>
      </div>
    </div>
  )
}
