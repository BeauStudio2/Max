import { createPortal } from 'react-dom'
import { fmt } from './shared'

/**
 * The rest timer across the whole screen at half opacity, readable from across the gym. It ignores the mouse and touch,
 * so everything underneath stays usable. Counts down to the rest target, then up from zero.
 */
export default function RestOverlay({ rest, target }: { rest: number; target: number }) {
  const left = target - rest
  // Counts down to 0:00, then up from 0:00. White while resting, amber in the last 10 s, green once it's time to lift, red a minute over.
  const state = left > 10 ? 'wait' : left > 0 ? 'soon' : left > -60 ? 'lift' : 'over'
  return createPortal(
    <div className={'restoverlay ' + state} aria-hidden="true">
      <div className="ro-big">{fmt(Math.abs(left))}</div>
      <div className="ro-sub">{left > 0 ? `rest ${fmt(rest)} of ${fmt(target)}` : `lift · rest ${fmt(rest)}`}</div>
    </div>,
    document.body,
  )
}
