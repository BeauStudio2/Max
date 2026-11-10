import { useRef, useState } from 'react'
import { bluetoothAvailable, sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses, type Pulse } from '../../lib/creatine'
import { metronomeRepSeconds } from './Metronome'

/** Tempo of a recorded set: the metronome's seconds per rep (null if it was off) and the measured time from one spotted rep to the next. */
export interface Tempo { beat_s: number | null; rep_s: number | null }
export const repGap = (p: Pulse[]) => { const g = p.slice(1).map((x, i) => x.start - p[i].start).sort((a, b) => a - b); return g.length ? g[Math.floor(g.length / 2)] : null }

/**
 * The Tindeq in the spotter line, on Log: live assist, tare, and Record for a set. Connecting and its settings are in Config.
 * Stopping a recording finds each spotted rep (a pulse of assist) and hands them to the next set in the list.
 */
export default function TindeqPanel({ onCapture, minLb, minS }: { onCapture: (pulses: Pulse[], tempo: Tempo) => void; minLb: number; minS: number }) {
  const st = useSensor()
  const [last, setLast] = useState<Pulse[] | null>(null)
  const [tempo, setTempo] = useState<Tempo | null>(null)
  const beat = useRef<number | null>(null)

  function toggleRec() {
    if (!st.recording) { beat.current = metronomeRepSeconds(); setLast(null); sensor.record(); return }
    const pulses = findPulses(sensor.stop(), minLb, minS)
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
        {st.status !== 'on'
          ? <a className="linkish" href="#config" data-tip="Connect the Tindeq under Config → Sensors and machines. It stays connected when you come back here." data-pos="right">not connected · set up in Config</a>
          : <>
            <b className="tlb">{st.lb.toFixed(1)} lb</b>
            <button type="button" className="switch" onClick={() => sensor.tare()} data-tip="Zero the reading with the line just taut." data-pos="center">Tare</button>
            <button type="button" className={'switch' + (st.recording ? ' on' : '')} aria-pressed={st.recording} onClick={toggleRec}>{st.recording ? '■ Stop' : '● Record'}</button>
          </>}
      </div>
      {last && <span className="small muted">{last.length ? `${last.length} spotted reps · avg ${Math.round(last.reduce((t, p) => t + p.mean, 0) / last.length)} lb` : 'no assist pulses found'}
        {last.length > 1 && tempo?.rep_s != null && <span className="hastip" data-tip="Time from the start of one spotted rep to the start of the next (middle value), against the metronome's time per rep when it was running." data-pos="right"> · {tempo.rep_s.toFixed(1)} s/rep{tempo.beat_s ? <> vs <span className={Math.abs(tempo.rep_s - tempo.beat_s) / tempo.beat_s > 0.15 ? 'down' : 'up'}>{tempo.beat_s.toFixed(1)} s</span> beat</> : ''}</span>}</span>}
    </div>
  )
}
