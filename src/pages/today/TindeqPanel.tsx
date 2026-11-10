import { useEffect, useRef, useState } from 'react'
import { bluetoothAvailable, connectTindeq, type Tindeq } from '../../lib/tindeq'
import { findPulses, type Pulse, type Sample } from '../../lib/creatine'

/**
 * The Tindeq in the spotter line: live assist force, tare, and Record for a set.
 * Stopping a recording finds each spotted rep (a pulse of assist) and hands them to the next set in the list.
 */
export default function TindeqPanel({ onCapture }: { onCapture: (pulses: Pulse[]) => void }) {
  const dev = useRef<Tindeq | null>(null)
  const buf = useRef<Sample[]>([])
  const recording = useRef(false)
  const [state, setState] = useState<'off' | 'connecting' | 'on'>('off')
  const [rec, setRec] = useState(false)
  const [lb, setLb] = useState(0)
  const [last, setLast] = useState<Pulse[] | null>(null)
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
    if (!rec) { buf.current = []; recording.current = true; setRec(true); setLast(null); return }
    recording.current = false; setRec(false)
    const pulses = findPulses(buf.current)
    setLast(pulses); onCapture(pulses)
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
      {last && <span className="small muted">{last.length ? `${last.length} spotted reps · avg ${Math.round(last.reduce((t, p) => t + p.mean, 0) / last.length)} lb · ${(last.reduce((t, p) => t + p.dur, 0) / last.length).toFixed(1)} s each` : 'no assist pulses found'}</span>}
      {err && <span className="small err">{err}</span>}
    </div>
  )
}
