import { useEffect, useRef, useState } from 'react'
import { bluetoothAvailable, connectTindeq, type Tindeq } from '../../lib/tindeq'
import { findPulses, type Pulse, type Sample } from '../../lib/creatine'
import { metronomeRepSeconds } from './Metronome'

/** Tempo of a recorded set: the metronome's seconds per rep (null if it was off) and the measured time from one spotted rep to the next. */
export interface Tempo { beat_s: number | null; rep_s: number | null }
const repGap = (p: Pulse[]) => { const g = p.slice(1).map((x, i) => x.start - p[i].start).sort((a, b) => a - b); return g.length ? g[Math.floor(g.length / 2)] : null }

/**
 * The Tindeq in the spotter line: live assist force, tare, and Record for a set.
 * Stopping a recording finds each spotted rep (a pulse of assist) and hands them to the next set in the list.
 */
export default function TindeqPanel({ onCapture }: { onCapture: (pulses: Pulse[], tempo: Tempo) => void }) {
  const dev = useRef<Tindeq | null>(null)
  const buf = useRef<Sample[]>([])
  const recording = useRef(false)
  const [state, setState] = useState<'off' | 'connecting' | 'on'>('off')
  const [rec, setRec] = useState(false)
  const [lb, setLb] = useState(0)
  const [last, setLast] = useState<Pulse[] | null>(null)
  const [tempo, setTempo] = useState<Tempo | null>(null)
  const beat = useRef<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => () => dev.current?.disconnect(), [])

  async function connect() {
    setErr(null); setState('connecting')
    try {
      dev.current = await connectTindeq(
        s => { setLb(s.at(-1)!.lb); if (recording.current) buf.current.push(...s) },
        () => { dev.current = null; setState('off'); setRec(false); recording.current = false },
      )
      setState('on')
    } catch (e: any) { setState('off'); if (e?.name !== 'NotFoundError') setErr(e?.message ?? 'Could not connect') }
  }
  function toggleRec() {
    if (!rec) { buf.current = []; recording.current = true; beat.current = metronomeRepSeconds(); setRec(true); setLast(null); return }
    recording.current = false; setRec(false)
    const pulses = findPulses(buf.current)
    // The metronome may be switched on after Record is pressed; take whichever reading has it running.
    const t: Tempo = { beat_s: beat.current ?? metronomeRepSeconds(), rep_s: repGap(pulses) }
    setLast(pulses); setTempo(t); onCapture(pulses, t)
  }

  if (!bluetoothAvailable()) return (
    <div className="tindeq"><span className="small muted hastip" data-tip="Live assist readings need Bluetooth in the browser: Chrome or Edge on a laptop or Android. Spotted reps and assist can still be typed by hand." data-pos="right">Tindeq: no Bluetooth here</span></div>
  )
  return (
    <div className="tindeq">
      <span className="small muted hastip" data-tip="Tindeq in the spotter line. Tare with the line just taut, press Record before the set and Stop after: each pulse of assist is counted as a spotted rep and fills the next set." data-pos="right">Tindeq</span>
      <div className="metrorow">
        {state !== 'on'
          ? <button type="button" className="switch" onClick={connect} disabled={state === 'connecting'}>{state === 'connecting' ? 'Connecting…' : 'Connect'}</button>
          : <>
            <b className="tlb">{lb.toFixed(1)} lb</b>
            <button type="button" className="switch" onClick={() => dev.current?.tare()} data-tip="Zero the reading with the line just taut." data-pos="center">Tare</button>
            <button type="button" className={'switch' + (rec ? ' on' : '')} aria-pressed={rec} onClick={toggleRec}>{rec ? '■ Stop' : '● Record'}</button>
            <button type="button" className="switch" onClick={() => dev.current?.disconnect()} aria-label="Disconnect Tindeq" data-tip="Disconnect" data-pos="right">×</button>
          </>}
      </div>
      {last && <span className="small muted">{last.length ? `${last.length} spotted reps · avg ${Math.round(last.reduce((t, p) => t + p.mean, 0) / last.length)} lb` : 'no assist pulses found'}
        {last.length > 1 && tempo?.rep_s != null && <span className="hastip" data-tip="Time from the start of one spotted rep to the start of the next (middle value), against the metronome's time per rep when it was running." data-pos="right"> · {tempo.rep_s.toFixed(1)} s/rep{tempo.beat_s ? <> vs <span className={Math.abs(tempo.rep_s - tempo.beat_s) / tempo.beat_s > 0.15 ? 'down' : 'up'}>{tempo.beat_s.toFixed(1)} s</span> beat</> : ''}</span>}</span>}
      {err && <span className="small err">{err}</span>}
    </div>
  )
}
