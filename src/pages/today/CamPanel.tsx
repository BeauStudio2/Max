import { useEffect, useRef } from 'react'
import { camera, useCamera } from '../../lib/camera'

/** A small live picture from the camera. */
export function CamPreview({ className }: { className?: string }) {
  const s = useCamera(), ref = useRef<HTMLVideoElement>(null)
  useEffect(() => { if (ref.current) ref.current.srcObject = s.status === 'rec' ? camera.stream() : null }, [s.status, s.deviceId])
  return s.status === 'rec' ? <video ref={ref} className={className} autoPlay muted playsInline /> : null
}

/** The camera on Log: on or off, a small picture to aim it by, and what has been saved. */
export default function CamPanel() {
  const s = useCamera()
  useEffect(() => { camera.resume() }, [])
  const mb = Math.round(s.bytes / 1e6)
  return (
    <div className="campanel">
      <span className="small muted hastip" data-pos="right" data-tip={`Films each heavy set with the laptop camera. It records all the time while on, and when you log a heavy set it saves the film of that set (the last ${s.clip_s} seconds, or the exact set when the phone on the bar or the Tindeq timed it). Aim it side-on to the bar with the whole lift in view. Camera choice and clip length are in Config.`}>Camera</span>
      <div className="metrorow">
        <button type="button" className={'switch' + (s.on ? ' on' : '')} aria-pressed={s.on} onClick={() => camera.setOn(!s.on)}>{s.on ? 'On' : 'Off'}</button>
        <CamPreview className="camthumb" />
        {s.status === 'starting' && <span className="small muted">starting…</span>}
        {s.status === 'rec' && <span className="small"><i className="recdot" /> {s.clips ? `${s.clips} clip${s.clips > 1 ? 's' : ''} · ${mb} MB` : 'filming'}{s.uploading ? ' · saving…' : ''}</span>}
      </div>
      {s.error && <span className="small err">{s.error}</span>}
    </div>
  )
}
