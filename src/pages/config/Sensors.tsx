import { useEffect, useState } from 'react'
import { camera, useCamera } from '../../lib/camera'
import { imu, pairCode, useImu } from '../../lib/imuLink'
import { CamPreview } from '../today/CamPanel'
import { bluetoothAvailable, sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses, type Pulse } from '../../lib/creatine'
import { T } from '../today/shared'
import { repGap } from '../today/TindeqPanel'

/** Config → Sensors and machines: connect the Tindeq, zero it, set its direction, and check its readings. */
export default function Sensors() {
  const st = useSensor()
  useEffect(() => { sensor.resume() }, [])
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
            <p className="small muted">If the Tindeq drops out, Max reconnects by herself for up to two minutes. After a reload she takes it up again without asking when the browser allows it; otherwise press Connect. Flip direction is kept on this laptop.</p>
          </>
        )}
      <PhoneBar />
      <Camera />
    </section>
  )
}

/** A phone fixed to the bar as the bar-speed sensor: where to open it, and whether its readings are arriving. */
function PhoneBar() {
  const s = useImu()
  const [code, setCode] = useState('')
  useEffect(() => { imu.listen(); pairCode().then(setCode) }, [])
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
      {!live && <p className="small">On the phone, sign in to Max, open <b className="mono">{url}</b> and press Start. Then fix the phone to the bar. The page must stay on screen.</p>}
      <p className="small">Android app (keeps sending in the background): install <a className="linkish" href="https://github.com/BeauStudio2/Max/releases/tag/maxbar" target="_blank" rel="noreferrer">Max Bar</a> on the phone, enter the code <b className="mono">{code || '…'}</b> and press Start.</p>
      <div className="planfields sensfields">
        <label className="toggle"><T tip="Turn on if lifting the bar shows as a negative speed (some phones report motion the other way round).">Flip direction</T>
          <button type="button" className={'switch' + (s.flip ? ' on' : '')} aria-pressed={s.flip} onClick={() => imu.setFlip(!s.flip)}>{s.flip ? 'On' : 'Off'}</button>
        </label>
      </div>
    </>
  )
}


/** The cameras that film heavy sets: which to use, the station each looks at, how much to keep per set, and a picture to aim by. */
function Camera() {
  const s = useCamera()
  useEffect(() => { camera.resume(); camera.find() }, [])
  const STATIONS = ['Squat rack', 'Bench', 'Smith', 'Deadlift platform']
  return (
    <>
      <h3><T tip="Films each heavy set and saves the clip with the set, as raw material for tracking the bar: true bar speed and path, depth, sticking point. Nothing is analysed yet. With two cameras, give each a station: when a set is logged, the camera that saw the most movement during it says which station the set was on, and its film is the one kept. Aim each camera side-on to its bar, at about bar height, with the whole lift in view." pos="right">Cameras</T></h3>
      <div className="sensrow">
        <span className={'dot ' + (s.status === 'rec' ? 'on' : s.status === 'starting' ? 'connecting' : '')} />
        <span>{s.status === 'rec' ? <>Filming with <b>{s.cams.filter(c => c.status === 'rec').length}</b> camera{s.cams.filter(c => c.status === 'rec').length > 1 ? 's' : ''}</> : s.status === 'starting' ? 'Starting…' : 'Off'}</span>
        <button className={(s.on ? 'ghost' : 'primary') + ' small'} onClick={() => camera.setOn(!s.on)}>{s.on ? 'Turn off' : 'Turn on'}</button>
        <button className="ghost small" onClick={() => camera.find()} data-tip="Look again for cameras, after plugging one in." data-pos="right">Find cameras</button>
        {s.clips > 0 && <span className="small">{s.clips} clips saved this visit · {Math.round(s.bytes / 1e6)} MB</span>}
      </div>
      {s.error && <p className="small err">{s.error}</p>}
      <datalist id="stations">{STATIONS.map(x => <option key={x} value={x} />)}</datalist>
      <div className="tablewrap"><table className="sheet cfg camtable">
        <thead><tr><th className="stick">Camera</th><th data-tip="Film with this camera while cameras are on.">Use</th><th data-tip="The station this camera looks at. A set seen mostly by this camera is noted as done there.">Station</th><th data-tip="How much is moving in this camera's picture now. Wave at it to tell the cameras apart.">Movement</th><th>Picture</th></tr></thead>
        <tbody>
          {s.cams.filter(c => c.deviceId !== '' || c.use).map(c => (
            <tr key={c.deviceId || 'default'}>
              <td className="stick">{c.label || 'Camera'}{c.size && <div className="sub2">{c.size}</div>}{c.error && <div className="small err">{c.error}</div>}</td>
              <td><button type="button" className={'switch' + (c.use ? ' on' : '')} aria-pressed={c.use} onClick={() => camera.setCam(c.deviceId, { use: !c.use })}>{c.use ? 'On' : 'Off'}</button></td>
              <td><input list="stations" defaultValue={c.station} placeholder="e.g. Squat rack" onBlur={e => { if (e.target.value.trim() !== c.station) camera.setCam(c.deviceId, { station: e.target.value.trim() }) }} /></td>
              <td className="num">{c.status === 'rec' ? c.motion.toFixed(1) : ''}</td>
              <td><CamPreview className="camrow" deviceId={c.deviceId} /></td>
            </tr>
          ))}
          {!s.cams.some(c => c.deviceId !== '' || c.use) && <tr><td colSpan={5} className="small muted">No cameras listed yet. Press Find cameras and allow camera access.</td></tr>}
        </tbody>
      </table></div>
      <div className="planfields sensfields">
        <label><T tip="How much film to keep for a set when no sensor timed it: this many seconds before the moment you log it. 10 to 180. About 1 MB for every 8 seconds.">Seconds per set</T>
          <input inputMode="numeric" defaultValue={s.clip_s} key={s.clip_s} onBlur={e => camera.setClipS(Number(e.target.value))} />
        </label>
      </div>
    </>
  )
}
