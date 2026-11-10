import { useState } from 'react'
import { bluetoothAvailable, sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses, type Pulse } from '../../lib/creatine'
import { T } from '../today/shared'
import { repGap } from '../today/TindeqPanel'

/** Config → Sensors and machines: connect the Tindeq, zero it, set its direction, and check its readings. */
export default function Sensors() {
  const st = useSensor()
  const [test, setTest] = useState<Pulse[] | null>(null)
  const s = st.settings
  // The check here uses fixed values; a lift's own detection settings are on Log.
  const CHECK_LB = 3, CHECK_S = 0.25
  const span = Math.max(40, Math.abs(st.lb))
  const stopTest = () => setTest(findPulses(sensor.stop(), CHECK_LB, CHECK_S))

  return (
    <section className="card sensors">
      <h2>Sensors and machines</h2>
      <h3><T tip="Bluetooth force sensor. It measures the pull through it in lb, about 80 readings a second, and sends them to Max live. Put it in line with whatever you want measured: a spotter line, a pull against a fixed bar, a band or cable. Max shows the live force, zeroes it with Tare, and records it over a set." pos="right">Tindeq Progressor</T></h3>
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
                  <div className="sensbar"><i style={{ width: `${Math.min(100, (Math.max(0, st.lb) / span) * 100)}%` }} /></div>
                  <button className="ghost small" onClick={() => sensor.tare()} data-tip="Zero the reading with the line just taut." data-pos="right">Tare</button>
                </div>
                <div className="sensrow">
                  <button className={'ghost small' + (st.recording ? ' on' : '')} onClick={() => (st.recording ? stopTest() : (setTest(null), sensor.record()))}>{st.recording ? '■ Stop test' : '● Test recording'}</button>
                  {test && <span className="small">{test.length
                    ? <>{test.length} pulls: {test.map(p => Math.round(p.mean)).join(', ')} lb · {(test.reduce((t, p) => t + p.dur, 0) / test.length).toFixed(1)} s each{repGap(test) !== null ? ` · ${repGap(test)!.toFixed(1)} s apart` : ''}</>
                    : `no pulls above ${CHECK_LB} lb`}</span>}
                  {!test && !st.recording && <span className="small muted">Pull a few times and stop: lists each pull above {CHECK_LB} lb.</span>}
                </div>
              </>
            )}
            <div className="planfields sensfields">
              <label className="toggle"><T tip="Turn on if pulling makes the reading go negative (the Tindeq is rigged the other way round).">Flip direction</T>
                <button type="button" className={'switch' + (s.invert ? ' on' : '')} aria-pressed={s.invert} onClick={() => sensor.setSettings({ invert: !s.invert })}>{s.invert ? 'On' : 'Off'}</button>
              </label>
            </div>
            <p className="small muted">The connection lasts until this page is reloaded or closed; the browser asks you to pick the device again after that. Flip direction is kept on this laptop.</p>
          </>
        )}
    </section>
  )
}
