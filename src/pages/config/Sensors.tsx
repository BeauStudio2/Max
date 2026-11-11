import { useEffect, useState } from 'react'
import { imu, useImu } from '../../lib/imuLink'
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
                  <span className={'small ' + (st.hz ? 'muted' : 'err')} data-tip="Readings arriving each second. 0 means it's connected but not sending: press the Tindeq's button, or disconnect and connect again." data-pos="right">{st.hz} /s</span>
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
      <PhoneBar />
    </section>
  )
}

/** A phone fixed to the bar as the bar-speed sensor: where to open it, and whether its readings are arriving. */
function PhoneBar() {
  const s = useImu()
  useEffect(() => { imu.listen() }, [])
  const live = s.hz > 0 && Date.now() - s.lastAt < 2500
  const url = `${location.origin}/#phone`
  return (
    <>
      <h3><T tip="A phone fixed to the bar measures how fast the bar moves on every rep: speed up, travel, and how much speed is lost across a set. It streams its motion readings to Max live over the internet, so the phone and this laptop both need to be signed in to Max." pos="right">Phone on the bar</T></h3>
      <div className="sensrow">
        <span className={'dot ' + (live ? 'on' : '')} />
        <span>{live ? <>Receiving <b>{s.hz}</b> readings a second</> : 'Waiting for a phone'}</span>
        {live && <b className="senslb">{s.velocity >= 0 ? '+' : ''}{s.velocity.toFixed(2)} m/s</b>}
        {live && s.reps.length > 0 && <span className="small">{s.reps.length} reps: {s.reps.map(r => r.mean_mps.toFixed(2)).join(', ')} m/s</span>}
      </div>
      {!live && <p className="small">On the phone, sign in to Max, open <b className="mono">{url}</b> and press Start. Then fix the phone to the bar.</p>}
      <div className="planfields sensfields">
        <label className="toggle"><T tip="Turn on if lifting the bar shows as a negative speed (some phones report motion the other way round).">Flip direction</T>
          <button type="button" className={'switch' + (s.flip ? ' on' : '')} aria-pressed={s.flip} onClick={() => imu.setFlip(!s.flip)}>{s.flip ? 'On' : 'Off'}</button>
        </label>
      </div>
    </>
  )
}

