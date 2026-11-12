import { useEffect, useRef, useState } from 'react'
import { linkReady, sendBatch } from '../lib/imuLink'

/**
 * The phone's side of the bar sensor: open this page on the phone, press Start, and fix the phone to the bar.
 * It reads the phone's motion sensors, works out acceleration along the vertical (whichever way the phone is turned),
 * and streams it to Max on the laptop. The screen is kept awake while it runs.
 */
export default function Phone() {
  const [on, setOn] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stat, setStat] = useState({ hz: 0, a: 0, sent: 0, linked: false })
  const buf = useRef<[number, number][]>([])
  const grav = useRef<[number, number, number] | null>(null)
  const upNow = useRef<[number, number, number] | null>(null)
  const n = useRef({ count: 0, from: 0, sent: 0, a: 0 })
  const wake = useRef<any>(null)

  useEffect(() => {
    if (!on) return
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity, a = e.acceleration
      if (!g || g.x == null || g.y == null || g.z == null) return
      let lin: [number, number, number], up: [number, number, number]
      if (a && a.x != null && a.y != null && a.z != null) {
        // The phone already separates gravity from movement.
        lin = [a.x, a.y, a.z]; up = [g.x - a.x, g.y - a.y, g.z - a.z]
      } else {
        // It doesn't: take gravity as the slow part of the signal.
        const p = grav.current ?? [g.x, g.y, g.z], k = 0.02
        grav.current = [p[0] + (g.x - p[0]) * k, p[1] + (g.y - p[1]) * k, p[2] + (g.z - p[2]) * k]
        up = grav.current; lin = [g.x - up[0], g.y - up[1], g.z - up[2]]
      }
      const m = Math.hypot(up[0], up[1], up[2])
      if (m < 1) return
      const av = (lin[0] * up[0] + lin[1] * up[1] + lin[2] * up[2]) / m       // acceleration along the vertical, up positive
      upNow.current = [Math.round((up[0] / m) * 1000) / 1000, Math.round((up[1] / m) * 1000) / 1000, Math.round((up[2] / m) * 1000) / 1000]
      buf.current.push([Math.round(e.timeStamp) / 1000, Math.round(av * 1000) / 1000])
      n.current.count++; n.current.a = av
    }
    window.addEventListener('devicemotion', onMotion)
    n.current = { count: 0, from: performance.now(), sent: 0, a: 0 }
    const send = setInterval(() => {
      const s = buf.current; buf.current = []
      if (s.length) { sendBatch(upNow.current ? { s, g: upNow.current } : { s }); n.current.sent += s.length }
    }, 100)
    const show = setInterval(() => {
      const now = performance.now(), c = n.current
      setStat({ hz: Math.round((c.count * 1000) / Math.max(1, now - c.from)), a: c.a, sent: c.sent, linked: linkReady() })
      c.count = 0; c.from = now
    }, 1000)
    const lock = async () => { try { wake.current = await (navigator as any).wakeLock?.request('screen') } catch { /* not supported: keep the screen on by hand */ } }
    lock(); const vis = () => { if (document.visibilityState === 'visible') lock() }
    document.addEventListener('visibilitychange', vis)
    return () => { window.removeEventListener('devicemotion', onMotion); clearInterval(send); clearInterval(show); document.removeEventListener('visibilitychange', vis); wake.current?.release?.() }
  }, [on])

  async function start() {
    setErr(null)
    try {
      // iPhones ask for permission, and only from a tap.
      if (typeof DeviceMotionEvent === 'undefined') { setErr('This browser has no motion sensors.'); return }
      const DM = DeviceMotionEvent as any
      // A refusal isn't always final (some browsers answer "denied" and send readings anyway), so start regardless and say so if nothing arrives.
      if (typeof DM.requestPermission === 'function') { const r = await DM.requestPermission().catch(() => 'denied'); if (r !== 'granted') setErr('If no readings arrive: motion access was refused. Allow "Motion & Orientation" for this site in the browser settings, then reload.') }
      setOn(true)
    } catch (e: any) { setErr(e?.message ?? String(e)) }
  }

  return (
    <div className="phonepage">
      <div className="brand">MAX</div>
      <h1>Bar sensor</h1>
      {!on ? (
        <>
          <p>Press Start, then fix the phone to the bar. Any way round is fine, as long as it can't shift.</p>
          <button className="primary bigbtn" onClick={start}>Start</button>
        </>
      ) : (
        <>
          <div className={'phonestat ' + (stat.hz > 0 ? 'ok' : 'bad')}>{stat.hz > 0 ? `${stat.hz} readings a second` : 'no motion readings'}</div>
          <div className="phonebig">{stat.a >= 0 ? '+' : ''}{stat.a.toFixed(2)} <small>m/s²</small></div>
          <p className="muted">{stat.linked ? 'Linked to Max' : 'Linking…'} · {stat.sent.toLocaleString()} sent</p>
          <p className="muted small">Keep this page open and the screen on. Lift the phone straight up: the number should go positive.</p>
          <button className="ghost bigbtn" onClick={() => setOn(false)}>Stop</button>
        </>
      )}
      {err && !(on && stat.hz > 0) && <p className="err">{err}</p>}
      <p className="muted small"><a className="linkish" href="#today" onClick={() => setTimeout(() => location.reload(), 0)}>Back to Max</a></p>
    </div>
  )
}
