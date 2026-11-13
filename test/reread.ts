// A recorded workout read again: three sets with a plate change and a knocked phone between them, help released on the last reps. npx tsx test/reread.ts
import { readRecording, unpack, type Reading } from '../src/lib/reread'
const hz = 100, leg = (d: number, T: number) => (t: number) => { const s = t / T; return d * (60 * s - 180 * s * s + 120 * s ** 3) / (T * T) }
const segs: [number, (t: number) => number][] = []
const marks: { at: number; n: number }[] = []
const now = () => segs.reduce((t, x) => t + x[0], 0)
const set = (n: number) => { segs.push([0.5, leg(0.08, 0.5)], [1, () => 0]); marks.push({ at: now(), n }); for (let i = 0; i < n; i++) segs.push([1.0, leg(-0.4, 1.0)], [1.2, leg(0.4, 1.2)], [0.3, () => 0]); segs.push([0.5, leg(-0.08, 0.5)]) }
segs.push([3, () => 0]); set(5); segs.push([15, () => 0])
for (const d of [0.12, 0.2]) segs.push([0.4, leg(-d, 0.4)], [0.3, leg(d, 0.3)], [0.3, () => 0])   // plate change
segs.push([15, () => 0]); const knock = now(); set(6); segs.push([20, () => 0]); set(4); segs.push([10, () => 0])
const T0 = Date.UTC(2026, 10, 12, 22, 0, 0), total = now()
const imu: Reading[] = [], tq: Reading[] = []
for (let i = 0; i < total * hz; i++) {
  let t = i / hz, a = 0
  for (const [T, f] of segs) { if (t < T) { a = f(t); break } t -= T }
  imu.push([T0 + i * 10, a + 0.05 + (i / hz >= knock - 8 ? 0.8 : 0) + Math.sin(i * 12.9898) * 0.05])
}
// The line: 15 lb hanging between sets, held up during a set, let go for the last two reps of each set.
for (let i = 0; i < total * 80; i++) {
  const t = i / 80
  const m = marks.find(k => t >= k.at - 1 && t < k.at + k.n * 2.5 + 0.5)
  const rep = m ? Math.floor((t - m.at) / 2.5) : -1
  tq.push([T0 + i * 12.5, !m ? 15 : rep >= m.n - 2 ? 15 : 0.3])
}
// Through the same packing the recorder uses, in half-minute pieces.
const pack = (src: string, r: Reading[], k: number) => { const out = []; for (let i = 0; i < r.length; ) { const t0 = r[i][0]; let j = i; while (j < r.length && r[j][0] < t0 + 30000) j++; out.push({ source: src, from_at: new Date(t0).toISOString(), data: JSON.stringify({ t: r.slice(i, j).map(x => x[0] - t0), v: r.slice(i, j).map(x => Math.round(x[1] * k)) }) }); i = j } return out }
const imu2 = pack('imu', imu, 1000).flatMap(unpack), tq2 = pack('tindeq', tq, 100).flatMap(unpack)
const found = readRecording(imu2, tq2, { rom_m: 0.4, topStart: true, set_gap_s: 6 })
for (const f of found) console.log(`${new Date(f.from).toISOString().slice(11, 19)}  ${f.ignored ? 'not a set' : 'set'}: ${f.reps.length} reps${f.help ? ' · help per rep ' + f.help.join(', ') + ' lb' : ''}`)
const sets = found.filter(f => !f.ignored)
const ok = sets.map(f => f.reps.length).join() === '5,6,4' && found.filter(f => f.ignored).length <= 1
  && sets.every(f => f.help && f.help.slice(0, -2).every(h => h < 2) && f.help.slice(-2).every(h => h > 12))
console.log(ok ? 'ok: 3 sets (5, 6, 4), the plate change left out, help on the last two reps of each' : 'WRONG')
process.exit(ok ? 0 : 1)
