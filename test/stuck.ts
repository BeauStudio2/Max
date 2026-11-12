// A jump in the sensor's resting offset (the phone knocked during a plate change) must not stop later sets being read: npx tsx test/stuck.ts
import { BarTracker, dropUnrack } from '../src/lib/imu'
const hz = 100, leg = (d: number, T: number) => (t: number) => { const s = t / T; return d * (60 * s - 180 * s * s + 120 * s ** 3) / (T * T) }
const segs: [number, (t: number) => number][] = []
const reps = (n: number) => { segs.push([0.5, leg(0.08, 0.5)], [1, () => 0]); for (let i = 0; i < n; i++) segs.push([1.0, leg(-0.4, 1.0)], [1.2, leg(0.4, 1.2)], [0.3, () => 0]); segs.push([0.5, leg(-0.08, 0.5)]) }
segs.push([3, () => 0]); reps(5); segs.push([20, () => 0])
const jumpAt = segs.reduce((t, x) => t + x[0], 0)
reps(5); segs.push([20, () => 0]); reps(4); segs.push([15, () => 0])
let bad = 0
for (const jump of [0, 0.6, -0.9, 1.5]) {
  const sets: number[] = []
  const tr = new BarTracker({ set: s => sets.push(dropUnrack(s.reps, 0.4).reps.length) })
  const total = segs.reduce((t, x) => t + x[0], 0)
  for (let i = 0; i < total * hz; i++) {
    let t = i / hz, a = 0
    for (const [T, f] of segs) { if (t < T) { a = f(t); break } t -= T }
    tr.push({ t: i / hz, a: a + 0.05 + (i / hz >= jumpAt - 10 ? jump : 0) + Math.sin(i * 12.9898) * 0.05 })
  }
  tr.flush()
  const ok = sets.join(',') === '5,5,4'
  if (!ok) bad++
  console.log(`${ok ? 'ok   ' : 'WRONG'} offset jump ${jump} m/s² after set 1 → sets read: ${sets.join(', ') || 'none'}`)
}
process.exit(bad ? 1 : 0)
