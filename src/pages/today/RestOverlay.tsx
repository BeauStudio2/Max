import { createPortal } from 'react-dom'
import { fmt } from './shared'

/**
 * The rest timer across the whole screen at half opacity, readable from across the gym. It ignores the mouse and touch,
 * so everything underneath stays usable. Counts down to the rest target, says LIFT at it, then shows the overtime.
 */
export default function RestOverlay({ rest, target }: { rest: number; target: number }) {
  const left = target - rest
  const state = left > 10 ? 'wait' : left > 0 ? 'soon' : left > -60 ? 'lift' : 'over'
  return createPortal(
    <div className={'restoverlay ' + state} aria-hidden="true">
      <div className="ro-big">{left > 0 ? fmt(left) : left > -3 ? 'LIFT' : '+' + fmt(-left)}</div>
      <div className="ro-sub">{left > 0 ? `rest ${fmt(rest)} of ${fmt(target)}` : left > -3 ? '' : `over · rest ${fmt(rest)}`}</div>
    </div>,
    document.body,
  )
}
