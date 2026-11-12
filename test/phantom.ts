// Tonight's real sets and plate changes (Wyatt, bench, 11/12): the travel check must keep every set and drop every plate change. npx tsx test/phantom.ts
import { isLiftSet, type BarRep } from '../src/lib/imu'
const rom = 16 * 0.0254
// [is a real set, sensor travel of each rep (m)], in the order they happened
const SEEN: [boolean, number[]][] = [
  [true, [0.457, 0.437, 0.503, 0.345]], [true, [0.439, 0.456, 0.462, 0.427, 0.43]], [true, [0.413, 0.415, 0.525, 0.412, 0.417]], [true, [0.407, 0.474, 0.473, 0.456, 0.459]],
  [true, [0.462, 0.48, 0.506, 0.437, 0.404]], [false, [0.258, 0.286, 0.161]], [true, [0.424, 0.478, 0.46, 0.448, 0.378]], [false, [0.097]],
  [true, [0.428, 0.43, 0.491, 0.372, 0.414]], [false, [0.109]], [true, [0.446, 0.494, 0.421, 0.43, 0.365]], [false, [0.292]],
  [true, [0.38, 0.41, 0.442, 0.475, 0.425]], [true, [0.361, 0.449, 0.483, 0.404, 0.408, 0.447]], [true, [0.223, 0.411, 0.389, 0.432, 0.516, 0.426]], [false, [0.265, 0.116]],
]
const seen: number[] = []
let bad = 0
SEEN.forEach(([real, roms], i) => {
  const reps = roms.map(r => ({ raw_rom_m: r, rom_m: rom, dur_s: 1.5, mean_mps: 0.3, peak_mps: 0.4, at: 0 }) as BarRep)
  const kept = isLiftSet(reps, seen, rom)
  if (kept) seen.push(...roms)
  if (kept !== real) bad++
  console.log(`${kept === real ? 'ok   ' : 'WRONG'} ${real ? 'set         ' : 'plate change'} ${roms.length} reps, furthest ${(Math.max(...roms) * 39.37).toFixed(0)} in → ${kept ? 'logged' : 'ignored'}`)
})
// Beau's bench reads short on the sensor (12-14 in for 18): his first set of a day must still count.
const beau = [0.305, 0.356, 0.361, 0.365, 0.364].map(r => ({ raw_rom_m: r, rom_m: 0.457, dur_s: 1, mean_mps: 0.45, peak_mps: 0.7, at: 0 }) as BarRep)
const ok = isLiftSet(beau, [], 0.457); if (!ok) bad++
console.log(`${ok ? 'ok   ' : 'WRONG'} Beau's first set of the day (sensor reads 12-14 in of 18) → ${ok ? 'logged' : 'ignored'}`)
process.exit(bad ? 1 : 0)
