import { useEffect, useRef, useState } from 'react'
import { useClock } from './shared'
import { bluetoothAvailable, sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses, type Pulse, type Sample } from '../../lib/creatine'
import { cue, onCommand } from '../../lib/voice'
import { metronomeRepSeconds } from './Metronome'
import { live } from './live'

/** Tempo of a recorded set: the metronome's seconds per rep (null if it was off) and the measured time from one spotted rep to the next. */
export interface Tempo { beat_s: number | null; rep_s: number | null
  /** Clock time the set started ("Max go", Record, or its first assisted rep), and when its last spotted rep ended. */
  rec_at?: string; ended_at?: string }
export const repGap = (p: Pulse[]) => { const g = p.slice(1).map((x, i) => x.start - p[i].start).sort((a, b) => a - b); return g.length ? g[Math.floor(g.length / 2)] : null }

/** Seconds of slack line after the last assisted rep before a set counts as over. */
const END_AFTER_S = 5
/** Seconds of readings kept from before a set starts, so its first assisted rep is caught whole. */
const PRE_S = 3

/**
 * The Tindeq in the spotter line, on Log. It listens all workout:
 *  - a set starts on "Max go" (or Record), or on its first assisted rep if nobody said so;
 *  - "Rack" is said when an assisted rep needs more help than the creatine model allows;
 *  - the set ends by itself a few seconds after the last assisted rep, or on "Max stop" / "Max pain" (or Stop).
 * Each finished set's assisted reps fill the next heavy set's row. Connecting is in Config.
 */
export default function TindeqPanel({ onCapture, minLb, minS, auto }: { onCapture: (pulses: Pulse[], tempo: Tempo) => void; minLb: number; minS: number; auto: boolean }) {
  useEffect(() => { sensor.resume() }, [])
  const st = useSensor()
  // Connected but silent for 2 s: say so, so a set is never "recorded" with nothing coming in.
  useClock(st.status === 'on' ? new Date(0).toISOString() : null)
  const stale = st.status === 'on' && Date.now() - (st.lastAt || 0) > 2000
  const [armed, setArmed] = useState(false)
  const [last, setLast] = useState<Pulse[] | null>(null)
  const [tempo, setTempo] = useState<Tempo | null>(null)
  const fresh = () => ({ armed: false, startMs: 0, buf: [] as Sample[], pre: [] as Sample[], beat: null as number | null,
    open: false, sum: 0, n: 0, pStart: 0, lastAbove: -Infinity, pulses: 0, racked: false })
  const W = useRef(fresh())

  function arm(startMs: number) {
    const pre = W.current.pre
    W.current = { ...fresh(), armed: true, startMs, buf: [...pre], beat: metronomeRepSeconds() }
    setArmed(true); setLast(null)
  }
  function finish() {
    const w = W.current
    if (!w.armed) return
    const samples = w.buf, lastT = samples.at(-1)?.t, now = Date.now()
    const pulses = findPulses(samples, minLb, minS)
    W.current = fresh(); setArmed(false)
    // The last rep ended this long before the newest reading, so rest is counted from then.
    const lp = pulses.at(-1)
    const endedMs = lp && lastT != null ? now - Math.max(0, lastT - (lp.start + lp.dur)) * 1000 : now
    const t: Tempo = { beat_s: w.beat ?? metronomeRepSeconds(), rep_s: repGap(pulses), rec_at: new Date(w.startMs).toISOString(), ended_at: new Date(endedMs).toISOString() }
    setLast(pulses); setTempo(t); onCapture(pulses, t)
  }
  const fn = useRef({ arm, finish, auto, minLb, minS }); fn.current = { arm, finish, auto, minLb, minS }

  // Every reading: keep a short lead-in, start a set on its first assisted rep, watch each rep's assist, end the set after the slack.
  useEffect(() => sensor.onSamples(s => {
    const { arm, finish, auto, minLb, minS } = fn.current
    const w0 = W.current
    if (!w0.armed) { w0.pre.push(...s); const cut = s.at(-1)!.t - PRE_S; w0.pre = w0.pre.filter(x => x.t >= cut) }
    else w0.buf.push(...s)
    for (const x of s) {
      const w = W.current
      if (x.lb >= minLb) {
        if (!w.armed && auto) { arm(Date.now() - (s.at(-1)!.t - x.t) * 1000); continue }
        if (!w.open) { w.open = true; w.sum = 0; w.n = 0; w.pStart = x.t }
        w.sum += x.lb; w.n++; w.lastAbove = x.t
      } else if (w.open && x.t - w.lastAbove > 0.2) {
        w.open = false
        if (w.armed && w.lastAbove - w.pStart >= minS) {
          w.pulses++
          // Every rep of a spotter set is assisted, so each pulse is a rep: "Rack" once Max's rep count is done.
          const at = live.next?.rackAt, rack = live.next?.rackLb
          if (!w.racked && ((at != null && w.pulses >= at) || (rack != null && w.sum / w.n >= rack))) { w.racked = true; cue('rack') }
        }
      }
    }
    const w = W.current
    if (w.armed && auto && w.pulses > 0 && !w.open && s.at(-1)!.t - w.lastAbove >= END_AFTER_S) finish()
  }), [])

  // Spoken: "Max go", "Max stop", "Max pain", "Max tare"; reps said while a set is open close it first.
  useEffect(() => onCommand(c => {
    if (sensor.get().status !== 'on') return
    const { arm, finish } = fn.current, w = W.current
    if (c.kind === 'tare') { sensor.tare(); cue('ack', 'Tare') }
    else if (c.kind === 'go') { arm(Date.now()); cue('ack', 'Go') }
    else if (c.kind === 'stop' && w.armed) { finish(); cue('ack', 'Stop') }
    else if (c.kind === 'pain') { finish(); cue('rack') }
    else if (c.kind === 'reps' && w.armed) finish()
  }), [])

  if (!bluetoothAvailable()) return (
    <div className="tindeq"><span className="small muted hastip" data-tip="Live assist readings need Bluetooth in the browser: Chrome or Edge on a laptop or Android. Spotted reps and assist can still be typed by hand." data-pos="right">Tindeq: no Bluetooth here</span></div>
  )
  return (
    <div className="tindeq">
      <span className="small muted hastip" data-tip={`The Tindeq listens all workout. A set starts on "Max go" or its first assisted rep, and ends by itself ${END_AFTER_S} s after the last one (or "Max stop"). Its pulls are saved with the next heavy set; with S on they also fill that set's spotted reps and assist. Record / Stop do the same by hand.`} data-pos="right">Tindeq{auto && st.status === 'on' ? (armed ? ' · set on' : ' · listening') : ''}</span>
      <div className="metrorow">
        {st.status !== 'on'
          ? <><button type="button" className="switch" disabled={st.status === 'connecting'} onClick={() => sensor.connect()} data-tip="Wake the Tindeq (press its button) and close the Tindeq phone app first, then pick it in the list. Reloading the page drops the connection." data-pos="right">{st.status === 'connecting' ? 'Connecting…' : 'Connect'}</button>
              {st.error && <span className="small err">{st.error}</span>}</>
          : <>
            {stale
              ? <b className="err" data-tip="Connected, but no readings are arriving, so nothing can be recorded. Press the Tindeq's button to wake it; if that doesn't help, disconnect in Config and connect again." data-pos="right">no readings</b>
              : <b className="tlb" data-tip={`${st.hz} readings a second`} data-pos="center">{st.lb.toFixed(1)} lb</b>}
            <button type="button" className="switch" onClick={() => sensor.tare()} data-tip="Zero the reading with the line just taut." data-pos="center">Tare</button>
            <button type="button" className={'switch' + (armed ? ' on' : '')} aria-pressed={armed} onClick={() => (armed ? finish() : arm(Date.now()))}
              data-tip="Backup for when voice isn't on: start and end a set by hand." data-pos="center">{armed ? '■ Stop' : '● Record'}</button>
          </>}
      </div>
      {last && <span className="small muted">{last.length ? `${last.length} reps read · avg help ${Math.round(last.reduce((t, p) => t + p.mean, 0) / last.length)} lb` : 'no reps read'}
        {last.length > 1 && tempo?.rep_s != null && <span className="hastip" data-tip="Time from the start of one spotted rep to the start of the next (middle value), against the metronome's time per rep when it was running." data-pos="right"> · {tempo.rep_s.toFixed(1)} s/rep{tempo.beat_s ? <> vs <span className={Math.abs(tempo.rep_s - tempo.beat_s) / tempo.beat_s > 0.15 ? 'down' : 'up'}>{tempo.beat_s.toFixed(1)} s</span> beat</> : ''}</span>}</span>}
    </div>
  )
}
