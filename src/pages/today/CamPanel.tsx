import { useEffect, useRef } from 'react'
import { camera, useCamera } from '../../lib/camera'

/** A small live picture from one camera (the first one filming when none is named). */
export function CamPreview({ className, deviceId }: { className?: string; deviceId?: string }) {
  const s = useCamera(), ref = useRef<HTMLVideoElement>(null)
  const on = deviceId !== undefined ? s.cams.find(c => c.deviceId === deviceId)?.status === 'rec' : s.status === 'rec'
  useEffect(() => { if (ref.current) ref.current.srcObject = on ? camera.stream(deviceId) : null }, [on, deviceId])
  return on ? <video ref={ref} className={className} autoPlay muted playsInline /> : null
}

/** The cameras on Log: on or off, a small picture from each to aim it by, and what has been saved. */
export default function CamPanel() {
  const s = useCamera()
  useEffect(() => { camera.resume() }, [])
  const mb = Math.round(s.bytes / 1e6)
  const live = s.cams.filter(c => c.use && c.status === 'rec')
  const bad = s.cams.find(c => c.use && c.error)
  return (
    <div className="campanel">
      <span className="small muted hastip" data-pos="right" data-tip={`Films each heavy set. The cameras record all the time while on, and when a heavy set is logged the film of that set is saved (the last ${s.clip_s} seconds, or the exact set when the phone on the bar or the Tindeq timed it). With more than one camera, the one that saw the most movement during the set is used, and its station is noted with the set. Aim each side-on to its bar with the whole lift in view. Cameras, stations and clip length are in Config.`}>Camera</span>
      <div className="metrorow">
        <button type="button" className={'switch' + (s.on ? ' on' : '')} aria-pressed={s.on} onClick={() => camera.setOn(!s.on)}>{s.on ? 'On' : 'Off'}</button>
        {live.map(c => <span key={c.deviceId} className="camcell" data-tip={`${c.label}${c.station ? ` · ${c.station}` : ''}`} data-pos="center"><CamPreview className="camthumb" deviceId={c.deviceId} />{c.station && <span className="camst">{c.station}</span>}</span>)}
        {s.status === 'starting' && <span className="small muted">starting…</span>}
        {s.status === 'rec' && <span className="small"><i className="recdot" /> {s.clips ? `${s.clips} clip${s.clips > 1 ? 's' : ''} · ${mb} MB` : 'filming'}{s.uploading ? ' · saving…' : ''}{s.lastStation ? ` · last set: ${s.lastStation}` : ''}</span>}
      </div>
      {(s.error || bad) && <span className="small err">{s.error ?? `${bad!.label || 'Camera'}: ${bad!.error}`}</span>}
    </div>
  )
}
