// Replays saved real sensor readings through the rep reader: npx tsx test/replay.ts
import { readFileSync } from 'node:fs'
import { BarTracker, calibrate, dropUnrack, type BarRep } from '../src/lib/imu'
const dir = new URL('./fixtures/', import.meta.url).pathname
// file, readings a second, true reps (null = not known), range of motion in
const CASES: [string, number, number | null, string][] = [
  ['set1', 100, 4, 'bench 225, 11/12 10:09'], ['set2', 100, 3, 'bench 190, 10:10'], ['set3', 100, 6, 'bench 175, 10:12'], ['set5', 100, 2, 'bench, 10:26'],
  ['s1', 50, 7, 'bench 225, 10:35'], ['s9', 50, null, 'spotter set, 55 lb (old reader said 11)'], ['s10', 50, 15, '2.5s + chain, no spotter'],
  ['s4', 50, null, 'spotter set 210'], ['s7', 50, null, 'spotter set 100'],
]
const rom = 18 * 0.0254
let bad = 0
for (const [file, hz, truth, what] of CASES) {
  const a = readFileSync(dir + file + '.txt', 'utf8').trim().split(',').map(Number)
  const samples = [...Array(3 * hz).fill(0), ...a, ...Array(14 * hz).fill(0)]
  const sets: BarRep[][] = []
  const tr = new BarTracker({ set: s => sets.push(s.reps) })
  samples.forEach((x, i) => tr.push({ t: i / hz, a: x }))
  tr.flush()
  const counts = sets.map(reps => dropUnrack(reps, rom))
  const n = counts.reduce((t, u) => t + u.reps.length, 0)
  const ok = truth === null ? '?' : n === truth && sets.length === 1 ? 'ok' : 'WRONG'
  if (ok === 'WRONG') bad++
  console.log(`${ok.padEnd(5)} ${file.padEnd(5)} ${what.padEnd(26)} true ${String(truth ?? '?').padStart(2)}  read ${String(n).padStart(2)}  in ${sets.length} set(s)  ` +
    counts.map(u => (u.unrack ? 'U ' : '') + calibrate(u.reps, rom).map(r => r.mean_mps.toFixed(2)).join(' ')).join(' || '))
  if (process.argv.includes('-v')) for (const reps of sets) console.log('      ' + reps.map(r => `[${(r.rom_m * 39.37).toFixed(0)}in ${r.dur_s.toFixed(2)}s dn${((r.down_m ?? 0) * 39.37).toFixed(0)}]`).join(' '))
}
process.exit(bad ? 1 : 0)
