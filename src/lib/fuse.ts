/**
 * The two sensors read together. The phone on the bar says how the bar moved; the Tindeq in the spotter line says what the
 * line did. When the line is on the bar they describe the same thing, so each can check the other:
 *  - the phone reports reps while the line sat taut and dead still: the bar did not move (the phone was being handled, or
 *    taken off for a plate change). Not a set.
 *  - the line was worked for a set's length while the phone reported nothing: a set happened that the phone did not see.
 * Nothing here touches the network or the page.
 */
export type Reading = [number, number]   // [clock time in ms, value]

export function lineStats(r: Reading[]) {
  const v = r.map(x => x[1]).sort((a, b) => a - b)
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))]
  return { n: v.length, mean: v.length ? v.reduce((t, x) => t + x, 0) / v.length : 0, lo: v.length ? at(0.05) : 0, hi: v.length ? at(0.95) : 0 }
}
/**
 * Did the line show the bar staying put? Only a taut line can say so: with a weight hanging on it, every rep swings the
 * tension (the weight has to be moved too: measured 11/12, 0.5 to 4.7 lb around a 2 lb rest), so a taut line that barely
 * changed over the "reps" means the bar never travelled. A slack line (the spotter holding the weight up) says nothing.
 */
export function lineSaysBarStill(r: Reading[]): boolean {
  const s = lineStats(r)
  return s.n >= 20 && s.mean >= 2 && s.hi - s.lo < Math.max(1, 0.25 * s.mean)
}

/**
 * Watches the line for stretches where it is being worked: away from where it rests (a weight lifted off it, pushes on it,
 * or the swing of reps) for a set's length. Where it rests is the middle value of the last three minutes, since rest is
 * most of a workout. Each finished stretch is reported once.
 */
export class LineWatch {
  private hist: Reading[] = []      // ten a second, three minutes
  private rest: number | null = null
  private lastRest = 0
  private open: { from: number; lastOut: number } | null = null
  constructor(private on: (e: { from: number; to: number }) => void, private o = { min_s: 6, quiet_s: 4, history_s: 180, warm_s: 30 }) {}
  push(ms: number, lb: number) {
    const h = this.hist
    if (!h.length || ms - h[h.length - 1][0] >= 100) { h.push([ms, lb]); while (h.length && h[0][0] < ms - this.o.history_s * 1000) h.shift() }
    if (ms - this.lastRest >= 2000 && h.length && ms - h[0][0] >= this.o.warm_s * 1000) {
      const v = h.map(x => x[1]).sort((a, b) => a - b); this.rest = v[Math.floor(v.length / 2)]; this.lastRest = ms
    }
    if (this.rest === null) return
    const out = Math.abs(lb - this.rest) > Math.max(1.5, 0.3 * Math.abs(this.rest))
    if (out) { if (!this.open) this.open = { from: ms, lastOut: ms }; else this.open.lastOut = ms }
    else if (this.open && ms - this.open.lastOut >= this.o.quiet_s * 1000) {
      const e = this.open; this.open = null
      if (e.lastOut - e.from >= this.o.min_s * 1000) this.on({ from: e.from, to: e.lastOut })
    }
  }
  /** The readings stopped (end of a recording): close whatever was open. */
  flush() { const e = this.open; this.open = null; if (e && e.lastOut - e.from >= this.o.min_s * 1000) this.on({ from: e.from, to: e.lastOut }) }
}
