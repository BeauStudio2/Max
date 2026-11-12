import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { recorder } from '../../lib/record'
import { imu, summarize, useImu } from '../../lib/imuLink'
import { onCommand } from '../../lib/voice'

const IN = 39.37
/**
 * Bar speed from a phone on the bar: live speed, the reps of the set under way, and the last finished set.
 * A finished set's reps are saved with the next heavy set that is logged. The phone is set up in Config.
 */
// (One object per change, so the panel only repaints when the recording's state does.)
let recSnap = recorder.status()
const recStatus = () => { const n = recorder.status(); if (n.on !== recSnap.on || n.lastError !== recSnap.lastError) recSnap = n; return recSnap }

export default function BarPanel() {
  const s = useImu()
  const rec = useSyncExternalStore(recorder.subscribe, recStatus)
  useEffect(() => { imu.listen() }, [])
  useEffect(() => onCommand(c => { if (c.kind === 'stop' || c.kind === 'reps') imu.endSet() }), [])
  const live = s.hz > 0 && Date.now() - s.lastAt < 2500
  if (!live && !s.lastSet) return null
  const cur = summarize(s.reps), last = s.lastSet && !s.reps.length ? summarize(s.lastSet.reps) : null
  return (
    <div className="barpanel">
      <span className="small muted hastip" data-pos="right" data-tip="Bar speed from the phone on the bar. Each rep shows its average speed on the way up. A set ends when the bar has been still for a few seconds; its reps and speeds are saved with the next heavy set you log.">Bar{live ? '' : ' · phone not sending'}</span>
      <div className="metrorow">
        <button type="button" className={'switch' + (s.autolog ? ' on' : '')} aria-pressed={s.autolog} onClick={() => imu.setAutolog(!s.autolog)} data-pos="right" data-tip="On: when a set ends, Max logs the next heavy set by herself with the reps the phone counted, and says who, which set and how many. The count stays open (amber box) until the next set starts: type the right number, or say 'Max' and the number. Needs the workout started. Heavy sets only, spotter sets included: never speed or support. Turn off while the bar is used for anything else (warm-ups).">{s.autolog ? 'Auto' : 'Manual'}</button>
        {live && <b className="tlb" data-tip={`${s.hz} readings a second from the phone`} data-pos="center">{s.velocity >= 0 ? '+' : ''}{s.velocity.toFixed(2)} m/s</b>}
        {cur && <span className="barreps">{s.reps.map((r, i) => <i key={i} data-tip={`Rep ${i + 1}: ${r.mean_mps.toFixed(2)} m/s average, ${r.peak_mps.toFixed(2)} peak, ${(r.rom_m * IN).toFixed(0)} in, ${r.dur_s.toFixed(1)} s`}>{r.mean_mps.toFixed(2)}</i>)}</span>}
      </div>
      {s.ignored && Date.now() - s.ignored.at < 30_000 && <span className="small muted" data-tip="The bar moved, but not far enough to be the lift (a plate change, or the bar being shifted), so it was not logged as a set." data-pos="right">ignored: bar moved {(s.ignored.travel_m * IN).toFixed(0)} in, not a set</span>}
      {rec.on && <span className={'small ' + (rec.lastError ? 'err' : 'muted')} data-tip={rec.lastError ? `The last piece of the recording could not be saved (${rec.lastError}). It is kept and tried again.` : 'Every reading from the phone and the Tindeq is being saved for the whole workout, so any set can be read again later.'} data-pos="right">● recording{rec.lastError ? ' (not saving)' : ''}</span>}
      {last && <span className="small muted" data-tip="The last set the phone saw. It is saved with the next heavy set you log." data-pos="right">last set: {last.n} reps · {last.first_mps.toFixed(2)} → {last.last_mps.toFixed(2)} m/s ({last.loss_pct >= 0 ? '−' : '+'}{Math.abs(Math.round(last.loss_pct))}%){s.lastSet!.taken ? ' · saved' : ''}</span>}
    </div>
  )
}
