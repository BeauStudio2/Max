// The two sensors checking each other, on a recorded workout: npx tsx test/fuse.ts
//  set 1 (5 reps, weight held up, let go on the last two) · the phone handled off the bar (looks like 3 reps; line taut and still)
//  · set 2 (6 reps) · a set with the phone off the bar (line worked 18 s, no reps) · set 3 (4 reps)
import { readRecording, type Reading } from '../src/lib/reread'
const hz = 100, leg = (d: number, T: number) => (t: number) => { const s = t / T; return d * (60 * s - 180 * s * s + 120 * s ** 3) / (T * T) }
const segs: [number, (t: number) => number][] = [], sets: { at: number; n: number }[] = []
const now = () => segs.reduce((t, x) => t + x[0], 0)
const set = (n: number, phone = true) => { const z = () => 0; segs.push([0.5, phone ? leg(0.08, 0.5) : z], [1, z]); sets.push({ at: now(), n }); for (let i = 0; i < n; i++) segs.push([1.0, phone ? leg(-0.4, 1.0) : z], [1.2, phone ? leg(0.4, 1.2) : z], [0.3, z]); segs.push([0.5, phone ? leg(-0.08, 0.5) : z]) }
segs.push([40, () => 0]); set(5); segs.push([30, () => 0])
for (let i = 0; i < 3; i++) segs.push([0.9, leg(-0.42, 0.9)], [1.0, leg(0.42, 1.0)], [0.3, () => 0])     // phone in the hand, waved about like reps
segs.push([40, () => 0]); set(6); segs.push([60, () => 0]); set(7, false); segs.push([60, () => 0]); set(4); segs.push([20, () => 0])
const T0 = Date.UTC(2026, 10, 12, 22, 0, 0), total = now()
const imu: Reading[] = [], tq: Reading[] = []
for (let i = 0; i < total * hz; i++) { let t = i / hz, a = 0; for (const [T, f] of segs) { if (t < T) { a = f(t); break } t -= T } imu.push([T0 + i * 10, a + 0.05 + Math.sin(i * 12.9898) * 0.05]) }
for (let i = 0; i < total * 80; i++) {
  const t = i / 80, m = sets.find(k => t >= k.at - 1 && t < k.at + k.n * 2.5 + 0.5), rep = m ? Math.floor((t - m.at) / 2.5) : -1
  tq.push([T0 + i * 12.5, (!m ? 15 : rep >= m.n - 2 ? 15 : 0.3) + Math.sin(i * 7.77) * 0.1])
}
const show = (f: any) => `${new Date(f.from).toISOString().slice(14, 19)}  ${f.lineOnly ? `line worked ${Math.round((f.to - f.from) / 1000)} s, no reps from the phone` : f.ignored ? `not a set (${f.why}): ${f.reps.length} "reps"` : `set: ${f.reps.length} reps` + (f.help ? ' · help ' + f.help.join(', ') : '')}`
const both = readRecording(imu, tq, { rom_m: 0.4, topStart: true, set_gap_s: 6, lineOnBar: true })
console.log('both sensors:'); both.forEach(f => console.log('  ' + show(f)))
const alone = readRecording(imu, tq, { rom_m: 0.4, topStart: true, set_gap_s: 6 })
console.log('phone alone: ', alone.map(f => f.ignored ? 'x' : f.reps.length).join(', '))
const ok = both.filter(f => !f.ignored && !f.lineOnly).map(f => f.reps.length).join() === '5,6,4' && both.filter(f => f.why === 'line').length === 1 && both.filter(f => f.lineOnly).length === 1
console.log(ok ? 'ok: 3 real sets, the handled phone thrown out by the line, the unseen set flagged by the line' : 'WRONG')
process.exit(ok ? 0 : 1)
