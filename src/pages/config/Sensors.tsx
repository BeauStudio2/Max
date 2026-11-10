import { useState } from 'react'
import { bluetoothAvailable, sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses, type Pulse } from '../../lib/creatine'
import { Num, T } from '../today/shared'
import { repGap } from '../today/TindeqPanel'

/** Config → Sensors and machines: connect the Tindeq, zero it, set how assisted reps are detected, and test it. */
export default function Sensors() {
  const st = useSensor()
  const [test, setTest] = useState<Pulse[] | null>(null)
  const s = st.settings
  const span = Math.max(40, Math.abs(st.lb))
  const stopTest = () => setTest(findPulses(sensor.stop(), s.threshold_lb, s.min_rep_s))

  return (
    <section className="card sensors">
      <h2>Sensors and machines</h2>
      <h3>Tindeq Progressor <span className="small muted">in the spotter line</span></h3>
      {!bluetoothAvailable()
        ? <p className="small muted">This browser has no Bluetooth access. Use Chrome or Edge on the laptop (or Android).</p>
        : (
          <>
            <div className="sensrow">
              <span className={'dot ' + st.status} />
              <span>{st.status === 'on' ? <>Connected: <b>{st.name}</b></> : st.status === 'connecting' ? 'Connecting…' : 'Not connected'}</span>
              {st.status === 'on'
                ? <button className="ghost small" onClick={() => sensor.disconnect()}>Disconnect</button>
                : <button className="primary small" onClick={() => sensor.connect()} disabled={st.status === 'connecting'}>Connect</button>}
            </div>
            {st.error && <p className="small err">{st.error}</p>}
            {st.status === 'on' && (
              <>
                <div className="sensrow">
                  <b className="senslb">{st.lb.toFixed(1)} lb</b>
                  <div className="sensbar"><i style={{ width: `${Math.min(100, (Math.max(0, st.lb) / span) * 100)}%` }} /><u style={{ left: `${Math.min(100, (s.threshold_lb / span) * 100)}%` }} /></div>
                  <button className="ghost small" onClick={() => sensor.tare()} data-tip="Zero the reading with the line just taut." data-pos="right">Tare</button>
                </div>
                <div className="sensrow">
                  <button className={'ghost small' + (st.recording ? ' on' : '')} onClick={() => (st.recording ? stopTest() : (setTest(null), sensor.record()))}>{st.recording ? '■ Stop test' : '● Test recording'}</button>
                  {test && <span className="small">{test.length
                    ? <>{test.length} pulses: {test.map(p => Math.round(p.mean)).join(', ')} lb · {(test.reduce((t, p) => t + p.dur, 0) / test.length).toFixed(1)} s each{repGap(test) !== null ? ` · ${repGap(test)!.toFixed(1)} s apart` : ''}</>
                    : 'no pulses found above the threshold'}</span>}
                  {!test && !st.recording && <span className="small muted">Pull the line a few times to see what Max counts as spotted reps.</span>}
                </div>
              </>
            )}
            <div className="planfields sensfields">
              <Num label="Assist above (lb)" tip="A spotted rep is a stretch of pull above this. Raise it if the weight of the line or small tugs get counted; lower it if light assists are missed." value={s.threshold_lb} onSave={v => v !== null && v >= 0 && sensor.setSettings({ threshold_lb: v })} />
              <Num label="Shortest rep (s)" tip="Pulls shorter than this are ignored as blips." value={s.min_rep_s} onSave={v => v !== null && v >= 0 && sensor.setSettings({ min_rep_s: v })} />
              <label className="toggle"><T tip="Turn on if pulling the line makes the reading go negative (the Tindeq is rigged the other way round).">Flip direction</T>
                <button type="button" className={'switch' + (s.invert ? ' on' : '')} aria-pressed={s.invert} onClick={() => sensor.setSettings({ invert: !s.invert })}>{s.invert ? 'On' : 'Off'}</button>
              </label>
            </div>
            <p className="small muted">The connection lasts until this page is reloaded or closed; the browser asks you to pick the device again after that. These three settings are kept on this laptop.</p>
          </>
        )}
    </section>
  )
}
