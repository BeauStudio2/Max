import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { e1rm, e1rmFromRpe, expectedReps, lostReps, repGoal, loadSide, platesPerSide, round, totals, type Kept, type LoadSetup } from '../../lib/load'
import type { Equipment, SetRow } from '../../lib/types'
import { CLAMPS, CHAIN_CLAMP, setupOf, type Ladder } from './Ladder'
import { type DeadliftCtl, type PullRowDef } from './Deadlift'
import { type SupportCtl, type SupportSlot } from './Support'
import SchemePicker from './SchemePicker'
import { fmt, useClock, type Api } from './shared'

export type Placement = 'between' | 'first' | 'after'
const n0 = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))
const isMain = (r?: SetRow) => r?.block === 'primary' || r?.block === 'deadlift'
const LIGHT_BAR = 'Light speed bar'

/* ---------- weight helpers: the table shows what's on the bar; the database keeps plates ---------- */

const fixedWeight = (s: LoadSetup, eq: Equipment[]) =>
  n0(eq.find(e => e.name === s.bar)?.weight_lb) + n0(eq.find(e => e.name === s.clamp)?.weight_lb)
/** Plates per side for a total plate weight (both sides): the session's kept-on plates when given, else largest first. */
const sideText = (plates: number | null, kept?: Kept, on?: number[], stored?: number[] | null) => {
  if (plates === null || plates < 0) return ''
  if (plates === 0) return '—'
  const sum = (st: number[]) => st.reduce((t, p) => t + p, 0)
  const stack = stored && Math.abs(sum(stored) * 2 - plates) < 0.01 ? stored : kept ? loadSide(plates / 2, kept) : null
  if (stack) {
    // List plates the way you'd say them (25+10+10+10); three or more of one size collapse to 4×10.
    const out: string[] = []
    for (const p of [...stack].sort((a, b) => b - a)) {
      const last = out.at(-1)
      if (last && last.split('×').at(-1) === String(p)) {
        const k = last.includes('×') ? Number(last.split('×')[0]) + 1 : 2
        out[out.length - 1] = k >= 3 ? `${k}×${p}` : `${p}+${p}`
        if (k === 2) continue
      } else if (last && last === `${p}+${p}`) out[out.length - 1] = `3×${p}`
      else out.push(String(p))
    }
    return out.join('+')
  }
  return platesPerSide(plates, on ?? kept?.on).replace(/(\d+)×([\d.]+)/g, (_, k, p) => Array(Number(k)).fill(p).join('+')).replace(/ \+ /g, '+')
}
/* ---------- plate columns: one per plate size, count per side, like the sheet ---------- */
const PLATE_COLS = [45, 25, 10, 5, 2.5, 1.25]
const countsOf = (stack: number[] | null) => Object.fromEntries(PLATE_COLS.map(p => [p, stack ? stack.filter(x => x === p).length : 0])) as Record<number, number>
/** Plates per side as a stack: stored when it still matches the weight, else the kept plates plus change, else largest first. */
function stackFor(plates: number | null, kept?: Kept, stored?: number[] | null, on?: number[]): number[] | null {
  if (plates === null || plates < 0) return null
  const sum = (st: number[]) => st.reduce((t, p) => t + p, 0)
  if (stored && Math.abs(sum(stored) * 2 - plates) < 0.01) return stored
  const k = kept ? loadSide(plates / 2, kept) : null
  if (k) return k
  let side = Math.round((plates / 2) * 100) / 100
  const out: number[] = []
  for (const p of PLATE_COLS.filter(x => !on || on.includes(x))) while (side >= p - 1e-9) { out.push(p); side = Math.round((side - p) * 100) / 100 }
  return side > 0.01 ? null : out
}
/** A count typed into one plate column → the new stack (heaviest first). */
const withCount = (stack: number[] | null, plate: number, n: number) =>
  [...(stack ?? []).filter(x => x !== plate), ...Array(Math.max(0, Math.round(n))).fill(plate)].sort((a, b) => b - a)

/** The plate cells for one row: editable counts, blank for zero, greyed when that plate is switched off. */
function PlateCells({ stack, on, onSet, keptN, disabled }: { stack: number[] | null; on?: number[]; onSet: (plate: number, n: number) => void; keptN?: Record<number, number>; disabled?: boolean }) {
  const c = countsOf(stack)
  return <>{PLATE_COLS.map(p => {
    const off = on ? !on.includes(p) : false
    return (
      <td key={p} className={'c-plate' + (off ? ' off' : '') + (keptN?.[p] ? ' kept' : '')} data-tip={off ? `${p}s are switched off in Plan` : keptN?.[p] ? `${keptN[p]}×${p} stay on the bar all session (underlined)` : undefined} data-pos="center">
        {disabled ? null : <CellText value={c[p] ? String(c[p]) : ''} narrow numeric onSave={v => onSet(p, v === '' ? 0 : Number(v))} />}
      </td>
    )
  })}</>
}
function PlateGrid({ stack, on, onSet }: { stack: number[] | null; on?: number[]; onSet: (plate: number, n: number) => void }) {
  const c = countsOf(stack)
  return (
    <div className="plategrid">
      {PLATE_COLS.map(p => (
        <label key={p} className={on && !on.includes(p) ? 'off' : ''}>{p}
          <CellText value={c[p] ? String(c[p]) : ''} narrow numeric onSave={v => onSet(p, v === '' ? 0 : Number(v))} />
        </label>
      ))}
    </div>
  )
}

/** "45+25+2x10" → [45, 25, 10, 10] (heaviest first), or null if it doesn't parse. */
const parseStack = (t: string): number[] | null => {
  const out: number[] = []
  for (const part of t.split('+').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[x×]\s*([\d.]+)$/.exec(part)
    if (m) out.push(...Array(Number(m[1])).fill(Number(m[2])))
    else if (!Number.isNaN(Number(part))) out.push(Number(part))
    else return null
  }
  return out.sort((a, b) => b - a)
}
/** "25+10+10+10" or "45+2x10+2.5" → pounds per side. */
const parseSide = (t: string) => {
  let sum = 0
  for (const part of t.split('+').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[x×]\s*([\d.]+)$/.exec(part)
    sum += m ? Number(m[1]) * Number(m[2]) : Number(part)
  }
  return Number.isFinite(sum) ? sum : null
}

/* ---------- bands ---------- */

export interface BandPick { name: string; per_side: number }
const bandsOf = (s: any): BandPick[] => Array.isArray(s?.bands) ? s.bands : s?.band ? [{ name: String(s.band), per_side: Math.max(1, Math.round(n0(s.bands) / 2) || 1) }] : []
function bandTension(bands: BandPick[], eq: Equipment[]) {
  const perSide = bands.reduce((t, b) => t + n0(eq.find(e => e.name === b.name)?.props?.one_band_lockout_lb) * b.per_side, 0)
  return { perSide, total: perSide * 2 }
}
const bandLabel = (bands: BandPick[]) => bands.length
  ? bands.map(b => `${b.name.replace('Rogue band ', '')}${b.per_side > 1 ? `×${b.per_side}` : ''}`).join(' + ') + ' /side'
  : 'no bands'

/* ---------- chain and band columns ---------- */

/** Rogue band colours, from the band's name. */
const BAND_COLORS: [RegExp, string, string][] = [
  [/orange/i, '#f08a24', 'Or'], [/red.*wide/i, '#c62828', 'Red W'], [/red/i, '#e5484d', 'Red'], [/blue/i, '#2f6fd6', 'Blue'],
  [/green/i, '#2e9e4f', 'Grn'], [/black/i, '#3a3a3a', 'Blk'], [/purple/i, '#7b3fc4', 'Pur'], [/silver|gr[ae]y/i, '#a9adb5', 'Sil'],
]
export const bandColor = (name: string) => BAND_COLORS.find(([re]) => re.test(name))?.[1] ?? '#888'
const bandShort = (name: string) => BAND_COLORS.find(([re]) => re.test(name))?.[2] ?? name.replace('Rogue band ', '').slice(0, 4)

interface Cols { bands: string[]; chains: boolean; span: number; addBand: (name: string) => void; allBands: Equipment[]; mapName: (n: string) => string; swap: (from: string, to: string) => void }
const ColsCtx = createContext<Cols>({ bands: [], chains: false, span: 12, addBand: () => {}, allBands: [], mapName: n => n, swap: () => {} })
/** A row's bands with any column colour changes applied. */
const mapBands = (bands: BandPick[], C: Cols) => { const out: BandPick[] = []; for (const b of bands) { const nm = C.mapName(b.name); const ex = out.find(x => x.name === nm); if (ex) ex.per_side += b.per_side; else out.push({ ...b, name: nm }) } return out }

const withBand = (bands: BandPick[], name: string, n: number) =>
  n > 0 ? (bands.some(b => b.name === name) ? bands.map(b => b.name === name ? { ...b, per_side: n } : b) : [...bands, { name, per_side: n }]) : bands.filter(b => b.name !== name)

function BandCells({ bands: raw, onSet }: { bands: BandPick[] | null; onSet?: (name: string, n: number) => void }) {
  const C = useContext(ColsCtx)
  const bands = raw ? mapBands(raw, C) : raw
  return <>{C.bands.map(name => {
    const n = bands?.find(b => b.name === name)?.per_side ?? 0
    const lock = C.allBands.find(b => b.name === name)?.props?.one_band_lockout_lb
    return <td key={name} className={'c-band' + (n ? ' has' : '')} style={{ ['--band' as any]: bandColor(name) }} data-tip={onSet ? `${name.replace('Rogue band ', '')} bands per side · ${lock ?? '?'} lb each at lockout, 0 at the bottom` : undefined} data-pos="center">
      {onSet && bands ? <CellText value={n ? String(n) : ''} narrow numeric onSave={v => onSet(name, v === '' ? 0 : Number(v))} /> : null}
    </td>
  })}<td className="c-band c-addband" /></>
}
function ChainCells({ half, big, onSet }: { half: number; big: number; onSet?: (which: 'chain_half' | 'chain_5_8', n: number) => void }) {
  const C = useContext(ColsCtx)
  if (!C.chains) return null
  return <>{(['chain_half', 'chain_5_8'] as const).map(k => {
    const n = k === 'chain_half' ? half : big
    return <td key={k} className="c-chain" data-tip={onSet ? `${k === 'chain_half' ? '½' : '⅝'} in chains per side. Adding one switches to the chain clamps.` : undefined} data-pos="center">{onSet ? <CellText value={n ? String(n) : ''} narrow numeric onSave={v => onSet(k, v === '' ? 0 : Number(v))} /> : null}</td>
  })}</>
}
/** Phone: the same chain and band counts as a grid in the row's drop-down. */
function BandGrid({ bands: raw, onSet }: { bands: BandPick[]; onSet: (name: string, n: number) => void }) {
  const C = useContext(ColsCtx)
  const bands = mapBands(raw, C)
  return (
    <div className="plategrid bandgrid">
      {C.bands.map(name => {
        const n = bands.find(b => b.name === name)?.per_side ?? 0
        return <label key={name} style={{ ['--band' as any]: bandColor(name) }} className={n ? 'has' : ''}>{bandShort(name)}
          <CellText value={n ? String(n) : ''} narrow numeric onSave={v => onSet(name, v === '' ? 0 : Number(v))} /></label>
      })}
      <AddBand />
    </div>
  )
}
function AddBand({ compact }: { compact?: boolean }) {
  const C = useContext(ColsCtx)
  const left = C.allBands.filter(b => !C.bands.includes(b.name))
  if (!left.length) return null
  return (
    <span className="tipwrap" data-tip="Add a column for another band colour (lockout tension shown in the list)." data-pos="right">
    <select className={'mini addband' + (compact ? ' compact' : '')} value="" aria-label="Add a band column" onChange={e => e.target.value && C.addBand(e.target.value)}>
      <option value="">{compact ? '+' : '+ band'}</option>
      {left.map(b => <option key={b.id} value={b.name}>{b.name.replace('Rogue band ', '')} · {b.props?.one_band_lockout_lb} lb</option>)}
    </select>
    </span>
  )
}

/* ---------- the order of rows: main set, then one round of speed, then main... ---------- */

type Planned =
  | { kind: 'main'; key: string; p: Ladder['projected'][number] }
  | { kind: 'pull'; key: string; row: PullRowDef }
  | { kind: 'speed'; key: string; it: any; n: number }
  | { kind: 'sup'; key: string; slot: SupportSlot }

/** Support interleaved: one support set after each heavy set and its speed round; anything left goes at the end. */
function withSupport(planned: Planned[], slots: SupportSlot[]): Planned[] {
  const out: Planned[] = []
  const left = [...slots]
  let seenMain = false
  for (const p of planned) {
    if ((p.kind === 'main' || p.kind === 'pull') && seenMain && left.length) { const sl = left.shift()!; out.push({ kind: 'sup', key: 'sup:' + sl.key, slot: sl }) }
    if (p.kind === 'main' || p.kind === 'pull') seenMain = true
    out.push(p)
  }
  for (const sl of left) out.push({ kind: 'sup', key: 'sup:' + sl.key, slot: sl })
  return out
}

function plannedOrder(done: SetRow[], main: Planned[], items: any[], speedSets: (it: any) => SetRow[], placement: Placement) {
  const since = new Set<string>()
  for (let i = done.length - 1; i >= 0 && !isMain(done[i]); i--) if (done[i].setup?.slot) since.add(done[i].setup.slot)
  // Between main sets, every main set gets one round of speed, so speed runs as long as the main lift does.
  const mainTotal = done.filter(isMain).length + main.length
  const target = (it: any) => placement === 'between' ? mainTotal : (it.sets ?? 0)
  const left = items.map(it => ({ it, done: speedSets(it).length, left: Math.max(0, target(it) - speedSets(it).length) }))
  const rounds: Planned[][] = []
  let first = since.size > 0, partial = false
  while (left.some(x => x.left > 0)) {
    const round: Planned[] = []
    for (const x of left) if (x.left > 0 && !(first && since.has(x.it.name))) { x.done++; x.left--; round.push({ kind: 'speed', key: `s:${x.it.name}:${x.done}`, it: x.it, n: x.done }) }
    if (round.length) { rounds.push(round); if (first) partial = true }
    first = false
  }
  const m = [...main]
  if (placement === 'first') return [...rounds.flat(), ...m]
  if (placement === 'after') return [...m, ...rounds.flat()]
  const out: Planned[] = []
  let turn: 'main' | 'speed' = isMain(done.at(-1)) || partial ? 'speed' : 'main'
  while (m.length || rounds.length) {
    if (turn === 'main' && m.length) out.push(m.shift()!)
    else if (turn === 'speed' && rounds.length) out.push(...rounds.shift()!)
    else if (m.length) out.push(m.shift()!)
    else out.push(...rounds.shift()!)
    turn = turn === 'main' ? 'speed' : 'main'
  }
  return out
}

/* ---------- the sheet ---------- */

export default function SessionSheet({ api, liftLabel, L, D, heavyExerciseId, restS, speed, speedEx, speedSets, placement, supInterleave = false, running = false, bandMap = {}, onBandMap, S, circuit, onCircuit }: {
  api: Api; liftLabel: string; L: Ladder | null; D: DeadliftCtl | null; heavyExerciseId?: string; restS: number
  speed: any | null; speedEx: (it: any) => string; speedSets: (it: any) => SetRow[]; placement: Placement; supInterleave?: boolean; running?: boolean; bandMap?: Record<string, string>; onBandMap?: (m: Record<string, string>) => void
  S: SupportCtl; circuit: number | null; onCircuit: (min: number | null) => void
}) {
  const platesOn: number[] | undefined = L?.plan.plates_on ?? D?.plan.plates_on
  const { equipment } = useStore()
  const allBands = useMemo(() => equipment.filter(e => e.kind === 'band').sort((a, b) => n0(a.props?.one_band_lockout_lb) - n0(b.props?.one_band_lockout_lb)), [equipment])
  const [extraBands, setExtraBands] = useState<string[]>([])
  const items: any[] = speed?.items ?? []
  const allSpeed = items.flatMap(it => speedSets(it))
  const mainSets = L ? L.logged : (D?.rows.map(r => r.existing).filter(Boolean) as SetRow[]) ?? []
  // With support interleaved, its logged sets sit in the same list, in the order they were done.
  const supDone = supInterleave ? (S.slots.filter(x => x.existing).map(x => x.existing!) as SetRow[]) : []
  const done = useMemo(() => [...mainSets, ...allSpeed, ...supDone].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')), [mainSets, allSpeed, supDone])
  const mainPlanned: Planned[] = L
    ? L.projected.map(p => ({ kind: 'main', key: 'h' + p.idx, p }))
    : (D?.rows ?? []).filter(r => !r.existing).map(r => ({ kind: 'pull', key: 'd:' + r.row.step, row: r.row }))
  const planned0 = plannedOrder(done.filter(r => r.block !== 'support'), mainPlanned, items, speedSets, placement)
  const planned = supInterleave ? withSupport(planned0, S.slots.filter(x => !x.existing)) : planned0
  const lastMain = [...done].reverse().find(isMain)
  // The rest timer only runs while the workout clock is running (after Start workout, before Finish).
  const rest = useClock(running ? lastMain?.created_at : null)
  const nextMain = planned.find(p => p.kind === 'main' || p.kind === 'pull')

  // Circuit time: what you entered, or first to last set of the circuit.
  const autoMin = done.length > 1 ? (Date.parse(done.at(-1)!.created_at!) - Date.parse(done[0].created_at!)) / 60000 : null
  const minutes = circuit ?? (autoMin && autoMin > 1 ? Math.round(autoMin) : null)
  const mainCount = mainSets.length
  const perMin = L?.fit && minutes && mainCount ? L.fit.ratePct / (minutes / mainCount) : null
  // Band columns: every band used today (logged or planned speed work), plus any added with "+ band".
  const mapName = (n: string) => bandMap[n] ?? n
  const itemBand = (it: any) => allBands.find(b => b.name.startsWith('Rogue band ' + String(it.band).split(' ')[0]))?.name ?? 'Rogue band ' + String(it.band).split(' ')[0]
  const usedBands = new Set<string>([...done.flatMap(r => bandsOf(r.setup).map(b => b.name)), ...items.filter(it => it.band).map(itemBand), ...extraBands].map(mapName))
  const bandCols = allBands.map(b => b.name).filter(nm => usedBands.has(nm))
  // Changing a column's colour: rows planned with the old band follow it, and sets already logged today are rewritten.
  async function swap(from: string, to: string) {
    if (from === to) return
    const next = Object.fromEntries(Object.entries(bandMap).map(([k, v]) => [k, v === from ? to : v]))
    next[from] = to
    onBandMap?.(next)
    setExtraBands(x => x.map(n => (n === from ? to : n)))
    for (const r of done) {
      const bb = bandsOf(r.setup)
      if (!bb.some(b => b.name === from)) continue
      const merged = mapBands(bb, { mapName: n => (n === from ? to : n) } as Cols)
      const setup = { ...r.setup, bands: merged }
      const patch: Partial<SetRow> = { setup }
      if (r.block === 'primary') { const t = totals(r.weight_lb, { ...setupOf(r), bands: merged }, equipment); patch.total_bottom_lb = t.bottom; patch.total_top_lb = t.top }
      await api.updateSet(r.id!, patch)
    }
  }
  const chains = !!(L && L.plan.bar && L.plan.chains_ok)
  const cols: Cols = { bands: bandCols, chains, span: 6 + PLATE_COLS.length + 1 + (chains ? 2 : 0) + bandCols.length + 1 + 1 - 1, addBand: nm => setExtraBands(x => [...x, nm]), allBands, mapName, swap }
  const slotName = (r: SetRow) => { const it = items.find(i => i.name === r.setup?.slot); return it ? speedEx(it) : r.setup?.slot ?? 'Speed' }

  return (
    <section className="card sheetcard">
      <div className="sheetbar">
        <div><span className="small muted hastip" data-tip="Time since the last heavy set / your rest target. Turns green when it's time." data-pos="left">Rest</span><b className={running && lastMain && rest >= restS ? 'ready' : ''}>{!running ? <span className="muted" data-tip="Press Start workout to run the rest timer." data-pos="left">— / {fmt(restS)}</span> : lastMain ? `${fmt(rest)} / ${fmt(restS)}` : `0:00 / ${fmt(restS)}`}</b></div>
        <div><span className="small muted hastip" data-tip="The next heavy set still to do." data-pos="left">Next {liftLabel}</span><b>{nextMain ? nextMain.kind === 'main' ? `#${nextMain.p.idx}` : nextMain.kind === 'pull' ? nextMain.row.step : '' : 'done'}</b></div>
        <label className="circuit"><span className="small muted hastip" data-tip="Minutes from the first to the last set of the heavy + speed circuit. Blank uses the logged times; type to override. Used for fatigue per minute." data-pos="right">Circuit min</span>
          <input inputMode="decimal" placeholder={autoMin && autoMin > 1 ? String(Math.round(autoMin)) : ''} defaultValue={circuit ?? ''} key={circuit ?? 'x'}
            onBlur={e => { const v = e.target.value.trim(); onCircuit(v === '' ? null : Number(v)) }} />
        </label>
      </div>

      <div className="tablewrap">
        <ColsCtx.Provider value={cols}>
        <table className="sheet">
          <thead>
            <tr>
              <th className="stick" data-tip="Grey rows are planned; logging reps saves the set. Tap a set name on narrow screens for plates, chains and bands." data-pos="left">Set</th><th data-tip="Total on the bar: bar + clamps + plates (not chains or bands). Type a total and the plates update." data-pos="left">lb</th><th className="c-exp" data-tip="Reps expected at this weight to hit the set's target max. Under it: logged reps minus expected (green ahead, red behind).">Exp</th><th data-tip="Reps done. The grey number is the rep goal (expected reps rounded down; up with Spotter on).">Reps</th>
              <th>{D ? <span data-tip="Rate of perceived exertion, 1–10. The top single's RPE sets today's deadlift estimate.">RPE</span> : <span data-tip="A = last rep assisted (counts half). F = last rep failed (counts nothing).">A · F</span>}</th><th data-tip="Estimated 1-rep max from this set (Epley, chains averaged bottom/top). Grey on planned rows = the target. % = vs set 1. Red row = below the stop line.">e1RM</th>
              {PLATE_COLS.map(p => <th key={p} className={'c-plate' + (platesOn && !platesOn.includes(p) ? ' off' : '')} data-tip={`${p} lb plates per side`}>{p}</th>)}
              <th className="c-setup" data-tip="Clamps on this set. Adding chains switches to the chain clamps; removing them switches back.">Clamps</th>
              {chains && <><th className="c-chain" data-tip="½ in chains per side">½ ch</th><th className="c-chain" data-tip="⅝ in chains per side">⅝ ch</th></>}
              {bandCols.map(nm => { const b = allBands.find(x => x.name === nm); return (
                <th key={nm} className="c-band" style={{ ['--band' as any]: bandColor(nm) }}>
                  <span className="tipwrap" data-tip={`${nm.replace('Rogue band ', '')} band per side · ${b?.props?.one_band_lockout_lb ?? '?'} lb at lockout. Tap to change this column's colour.`} data-pos="center">
                    <select className="bandchip bandsel" value={nm} aria-label="Band colour for this column" onChange={e => swap(nm, e.target.value)}>
                      {allBands.filter(x => x.name === nm || !bandCols.includes(x.name)).map(x => <option key={x.id} value={x.name}>{x.name.replace('Rogue band ', '')}</option>)}
                    </select>
                  </span>
                </th>) })}
              <th className="c-band c-addband"><AddBand compact /></th>
              <th className="c-rest" data-tip="Rest taken before this set (heavy rows), or which heavy set a speed round followed. × deletes a logged set." data-pos="right">Rest</th>
            </tr>
          </thead>
          <tbody>
            {done.map(r => r.block === 'support' ? (() => { const sl = S.slots.find(x => x.existing?.id === r.id); return sl ? <SupportTr key={r.id} slot={sl} S={S} api={api} inline /> : null })()
              : r.block === 'primary' && L ? <MainTr key={r.id} L={L} api={api} r={r} exerciseId={heavyExerciseId} label={liftLabel} />
              : r.block === 'deadlift' && D ? <PullTr key={r.id} D={D} def={D.rows.find(x => x.existing?.id === r.id)!.row} r={r} />
                : <SpeedTr key={r.id} api={api} r={r} it={items.find(i => i.name === r.setup?.slot) ?? { name: r.setup?.slot }} name={slotName(r)} n={r.set_index} sets={[]} />)}
            {planned.map((p, i) => p.kind === 'main' && L ? <MainTr key={p.key} L={L} api={api} p={p.p} exerciseId={heavyExerciseId} label={liftLabel} next={i === 0} />
              : p.kind === 'pull' && D ? <PullTr key={p.key} D={D} def={p.row} next={i === 0} />
                : p.kind === 'speed' ? <SpeedTr key={p.key} api={api} it={p.it} name={speedEx(p.it)} n={p.n} sets={speedSets(p.it)} next={i === 0} lastMain={lastMain} />
                  : p.kind === 'sup' ? <SupportTr key={p.key} slot={p.slot} S={S} api={api} inline /> : null)}
          </tbody>
        </table>
        </ColsCtx.Provider>
      </div>
      <p className="small muted sheetfoot">
        Grey rows are the plan; type reps in one to log it. {L?.floor ? `Stop line ${round(L.floor)}. ` : ''}
        {L?.fit ? `Fatigue ${L.fit.ratePct.toFixed(2)}%/set` : ''}{perMin ? ` · ${perMin.toFixed(2)}%/min over ${minutes} min, ${mainCount} sets` : ''}
        {D?.todayMax ? `Deadlift estimate ${round(D.todayMax)}.` : ''}
      </p>

      {supInterleave
        ? <button className="ghost small" onClick={() => S.addExercise()} data-tip="Add a support exercise; it joins the interleaved list." data-pos="left">+ Add support exercise</button>
        : <SupportTable S={S} api={api} />}
    </section>
  )
}

/* ---------- main lift row (logged or planned) ---------- */

function MainTr({ L, api, r, p, exerciseId, label, next }: {
  L: Ladder; api: Api; r?: SetRow; p?: Ladder['projected'][number]; exerciseId?: string; label: string; next?: boolean
}) {
  const { equipment: eq, cfg } = useStore()
  const logged = !!r
  const [setup, setSetup] = useState<LoadSetup>(r ? setupOf(r) : p!.setup)
  const [plates, setPlates] = useState<number | null>(r ? r.weight_lb : p!.weight)
  const [reps, setReps] = useState(r?.reps?.toString() ?? '')
  const [a, setA] = useState(!!r?.assisted)
  const [f, setF] = useState(!!r?.failed)
  // Plates typed into the columns, kept as entered until the set is logged (then they're saved on the set).
  const [manual, setManual] = useState<number[] | null>(null)
  useEffect(() => { if (!r) { setSetup(p!.setup); setPlates(p!.weight); setManual(null) } }, [p?.weight, p?.idx, p && setupKey(p.setup)])
  useEffect(() => { if (r) { setSetup(setupOf(r)); setPlates(r.weight_lb); setReps(r.reps?.toString() ?? ''); setA(r.assisted); setF(r.failed) } }, [r])

  const idx = r ? r.set_index : p!.idx
  const i = r ? L.logged.findIndex(x => x.id === r.id) : -1
  const target = r ? L.targets[i] : p!.target
  const t = totals(plates, setup, eq)
  const repsN = reps === '' ? null : Number(reps)
  const est = e1rm(t.bottom, t.top, repsN, a, f, cfg)
  const exp = target ? expectedReps(target, t.bottom, t.top, cfg) : null
  const diff = exp !== null && repsN !== null ? repsN - lostReps(a, f, cfg) - exp : null
  const goal = exp !== null ? repGoal(exp, L.plan.spotter) : null
  const pct = est && L.actual[0] ? (est / L.actual[0]) * 100 : null
  const below = L.floor !== null && est !== null && est < L.floor

  async function commit(patch: { setup?: LoadSetup; plates?: number | null; reps?: string; a?: boolean; f?: boolean; stack?: number[] | null }) {
    const s = patch.setup ?? setup, pl = patch.plates !== undefined ? patch.plates : plates
    // The plates actually loaded: as typed, else the planned stack when the weight still matches, else the kept plates plus change.
    const sumSt = (st: number[]) => st.reduce((t, p) => t + p, 0) * 2
    const prevStack: number[] | null = manual ?? (Array.isArray(r?.setup?.stack) ? r!.setup.stack : p?.stack ?? null)
    const stack = !L.plan.bar || pl === null ? null : patch.stack && Math.abs(sumSt(patch.stack) - pl) < 0.01 ? patch.stack
      : prevStack && Math.abs(sumSt(prevStack) - pl) < 0.01 ? prevStack : loadSide(pl / 2, L.kept)
    const rp = patch.reps !== undefined ? patch.reps : reps, aa = patch.a ?? a, ff = patch.f ?? f
    const tt = totals(pl, s, eq)
    const row = { weight_lb: pl, total_bottom_lb: tt.bottom, total_top_lb: tt.top, reps: rp === '' ? null : Number(rp), assisted: aa, failed: ff,
      setup: { ...(r?.setup ?? {}), bar: s.bar, clamp: s.clamp, chain_half: s.chain_half, chain_5_8: s.chain_5_8, rom_in: s.rom_in ?? null, hang_in: s.hang_in ?? null, bands: s.bands ?? [],
        stack, kept: r?.setup?.kept ?? (L.plan.bar ? { n45: L.kept.n45, n25: L.kept.n25 } : null) } }
    if (r) await api.updateSet(r.id!, row)
    else if (row.reps !== null && exerciseId) {
      const last = L.logged.at(-1)
      await api.addSet({ ...row, exercise_id: exerciseId, block: 'primary', set_index: idx,
        rest_s: last?.created_at ? Math.round((Date.now() - Date.parse(last.created_at)) / 1000) : null,
        setup: { ...row.setup, target_e1rm: target ?? null } })
    }
  }
  const setSet = (s: LoadSetup) => {
    setSetup(s)
    if (!r && target) { const w = L.weightFor(target, s); setPlates(w); return commit({ setup: s, plates: w }) }
    return commit({ setup: s })
  }
  const fixed = fixedWeight(setup, eq)
  const [more, setMore] = useState(false)
  const hasBar = !!L.plan.bar
  const stored: number[] | null = manual ?? (Array.isArray(r?.setup?.stack) ? r!.setup.stack : p?.stack ?? null)
  const stack = hasBar ? stackFor(plates, L.kept, stored, L.plan.plates_on) : null
  const setPlate = (plate: number, n: number) => {
    const next = withCount(stack, plate, n), pl = next.reduce((t, x) => t + x, 0) * 2
    setManual(next); setPlates(pl); commit({ plates: pl, stack: next })
  }
  const keptN = { 45: L.kept.n45, 25: L.kept.n25 }
  const straightClamp = L.plan.clamp || CLAMPS[0][0]
  const setupCell = !hasBar ? <span className="small muted">—</span> : (
    <select className="mini" value={setup.clamp} aria-label="Clamps" onChange={e => setSet({ ...setup, clamp: e.target.value })}>
      {CLAMPS.map(([v, l]) => <option key={v} value={v}>{v === CHAIN_CLAMP ? 'Chain' : l}</option>)}
      {!CLAMPS.some(c => c[0] === setup.clamp) && <option value={setup.clamp}>{setup.clamp || 'none'}</option>}
    </select>
  )
  // Chains hang from the chain clamps; taking the last chain off goes back to the normal clamps.
  const setChain = (k: 'chain_half' | 'chain_5_8', n: number) => {
    const next = { ...setup, [k]: Math.max(0, Math.round(n)) }
    const any = next.chain_half || next.chain_5_8
    setSet({ ...next, clamp: any ? CHAIN_CLAMP : setup.clamp === CHAIN_CLAMP ? straightClamp : setup.clamp })
  }
  const setBand = (name: string, n: number) => setSet({ ...setup, bands: withBand(mapBands(setup.bands ?? [], C), name, Math.max(0, Math.round(n))) })
  const C = useContext(ColsCtx)

  return (
    <>
    <tr className={(logged ? 'done' : 'plan') + (next ? ' next' : '') + (below ? ' below' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot h" />{label} {idx}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td><CellNum value={plates === null ? null : plates + fixed} onSave={v => { const pl = v === null ? null : Math.max(0, v - fixed); setPlates(pl); commit({ plates: pl }) }} />
        <div className="sub2 side-inline">{hasBar ? sideText(plates, L.kept, undefined, stack) : loadNote(L.plan)}{setup.bands?.length ? ` · ${bandLabel(setup.bands)}` : ''}</div></td>
      <td className="num c-exp">{exp !== null ? exp.toFixed(1) : ''}{diff !== null && <div className={'sub2 ' + (diff >= 0 ? 'up' : 'down')} data-tip="Reps done (less any failed rep and the uncredited half of an assisted rep) minus expected.">{diff >= 0 ? '+' : ''}{diff.toFixed(1)}</div>}</td>
      <td><CellText value={reps} narrow placeholder={goal !== null ? String(goal) : ''} numeric onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
      <td className="nowrap">
        <button className={'flag' + (a ? ' on' : '')} data-tip="Assisted: last rep had help (counts half)" aria-label="Assisted" aria-pressed={a} onClick={() => { setA(!a); if (r) commit({ a: !a }) }}>A</button>
        <button className={'flag' + (f ? ' on' : '')} data-tip="Failed: last rep missed (counts nothing)" aria-label="Failed" aria-pressed={f} onClick={() => { setF(!f); if (r) commit({ f: !f }) }}>F</button>
      </td>
      <td className="num"><b>{logged || repsN !== null ? round(est) : target ? <span className="muted">{round(target)}</span> : ''}</b>
        {pct !== null && (logged || repsN !== null) && <div className="sub2" data-tip="This set's estimated max as % of set 1's. The stop line is at the Plan's stop %." data-pos="right">{round(pct)}%</div>}</td>
      {hasBar ? <PlateCells stack={stack} on={L.plan.plates_on} onSet={setPlate} keptN={keptN} />
        : <td colSpan={PLATE_COLS.length} className="c-plate small muted">{loadNote(L.plan)}</td>}
      <td className="c-setup">{setupCell}</td>
      <ChainCells half={setup.chain_half} big={setup.chain_5_8} onSet={hasBar && L.plan.chains_ok ? setChain : undefined} />
      <BandCells bands={setup.bands ?? []} onSet={setBand} />
      <td className="num muted c-rest">{r?.rest_s ? fmt(r.rest_s) : ''}{logged && <button className="x" onClick={() => api.deleteSet(r!.id!)} aria-label="Delete set" data-tip="Delete this logged set" data-pos="right">×</button>}</td>
    </tr>
    {more && (
      <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
        <div className="morebox">
          {hasBar && <label className="wide m-plates">Plates per side<PlateGrid stack={stack} on={L.plan.plates_on} onSet={setPlate} /></label>}
          {hasBar && <label className="m-clamp">Clamps{setupCell}</label>}
          {C.chains && <label className="wide">Chains per side
            <div className="plategrid chaingrid">{(['chain_half', 'chain_5_8'] as const).map(k => <label key={k}>{k === 'chain_half' ? '½ in' : '⅝ in'}
              <CellText value={setup[k] ? String(setup[k]) : ''} narrow numeric onSave={v => setChain(k, v === '' ? 0 : Number(v))} /></label>)}</div></label>}
          <label className="wide">Bands per side<BandGrid bands={setup.bands ?? []} onSet={setBand} /></label>
          {exp !== null && <span className="small muted">Goal {goal} · expect {exp.toFixed(1)} reps{diff !== null ? ` (${diff >= 0 ? '+' : ''}${diff.toFixed(1)})` : ''}</span>}
          {r?.rest_s ? <span className="small muted">Rest {fmt(r.rest_s)}</span> : null}
          {logged && <button className="ghost small" onClick={() => api.deleteSet(r!.id!)}>Delete set</button>}
        </div>
      </td></tr>
    )}
    </>
  )
}

const LOAD_NOTE: Record<string, string> = { added: 'added weight', per_hand: 'per hand', stack: 'machine stack', bodyweight: 'bodyweight +' }
const loadNote = (p: { bar: string | null; load?: string; implement?: string | null }) => (p.bar ? '' : (LOAD_NOTE[p.load ?? 'added'] ?? 'load') + (p.implement ? ` + ${p.implement.toLowerCase()}` : ''))

/* Clamps and chains as one choice: straight sets on Rogue or Eleiko, chain sets on the chain clamps. */
const CHAIN_COMBOS: [number, number][] = [[0, 1], [1, 0], [1, 1], [0, 2], [2, 0], [2, 1], [1, 2], [2, 2]]
const comboLabel = (h: number, b: number) => [h ? `½×${h}` : '', b ? `⅝×${b}` : ''].filter(Boolean).join(' + ')
const setupKey = (s: LoadSetup) => `${s.clamp}|${s.chain_half}|${s.chain_5_8}`

/* ---------- deadlift row ---------- */

function PullTr({ D, def, r, next }: { D: DeadliftCtl; def: PullRowDef; r?: SetRow; next?: boolean }) {
  const fly = def.ex === 'Flywheel deadlift'
  const bar = D.plan.bar_lb
  const [w, setW] = useState<number | null>(r?.weight_lb ?? def.weight)
  const [inertia, setInertia] = useState<string>(r?.setup?.inertia ?? '')
  const [peak, setPeak] = useState<string>(r?.setup?.peak?.toString() ?? '')
  const [reps, setReps] = useState(r?.reps?.toString() ?? '')
  const [rpe, setRpe] = useState(r?.rpe?.toString() ?? '')
  const [bands, setBands] = useState<BandPick[]>(bandsOf(r?.setup))
  const [more, setMore] = useState(false)
  const C = useContext(ColsCtx)
  useEffect(() => { if (!r) setW(def.weight) }, [def.weight])
  async function commit(p: { w?: number | null; reps?: string; rpe?: string; inertia?: string; peak?: string; bands?: BandPick[] }) {
    const ww = p.w !== undefined ? p.w : w, rp = p.reps ?? reps, rr = p.rpe ?? rpe, ii = p.inertia ?? inertia, pk = p.peak ?? peak, bb = p.bands ?? bands
    const weight = fly ? null : ww
    const row: Partial<SetRow> = { weight_lb: weight, total_bottom_lb: weight, total_top_lb: weight, reps: rp === '' ? null : Number(rp), rpe: rr === '' ? null : Number(rr),
      setup: { ...(r?.setup ?? {}), step: def.step, bar_lb: bar, bands: bb, ...(fly ? { inertia: ii || null, peak: pk === '' ? null : Number(pk) } : {}) } }
    if (r) await D.api.updateSet(r.id!, row)
    else if (row.reps !== null) await D.api.addSet({ ...(row as any), exercise_id: D.api.exId(def.ex === 'Deadlift' ? D.main : def.ex)!, block: 'deadlift', set_index: def.idx, assisted: false, failed: false })
  }
  const est = !fly && w && reps ? e1rmFromRpe(w, Number(reps), rpe === '' ? null : Number(rpe)) : null
  const setBand = (name: string, n: number) => { const bb = withBand(mapBands(bands, C), name, Math.max(0, Math.round(n))); setBands(bb); commit({ bands: bb }) }
  const pstack = stackFor(w === null ? null : w - bar, undefined, null, D.plan.plates_on)
  return (
    <>
    <tr className={(r ? 'done' : 'plan') + (next ? ' next' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot h" />{def.step}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td>{fly ? <CellText value={inertia} placeholder="inertia" onSave={v => { setInertia(v); commit({ inertia: v }) }} />
        : <CellNum value={w} onSave={v => { setW(v); commit({ w: v }) }} />}
        {!fly && <div className="sub2 side-inline">{sideText(w === null ? null : w - bar, undefined, D.plan.plates_on)}{def.pct ? ` · ${def.pct}%` : ''}{bands.length ? ` · ${bandLabel(bands)}` : ''}</div>}</td>
      <td className="c-exp" />
      <td><CellText value={reps} narrow numeric placeholder={String(def.reps)} onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
      <td>{def.rpe ? <CellText value={rpe} narrow numeric onSave={v => { setRpe(v); commit({ rpe: v }) }} /> : null}</td>
      <td className="num"><b>{est ? round(est) : ''}</b></td>
      {fly ? <td colSpan={PLATE_COLS.length} className="c-plate" />
        : <PlateCells stack={pstack} on={D.plan.plates_on}
            onSet={(pl, n) => { const next = withCount(pstack, pl, n); const nw = next.reduce((t, x) => t + x, 0) * 2 + bar; setW(nw); commit({ w: nw }) }} />}
      <td className="small muted nowrap c-setup">{fly
        ? <CellText value={peak} narrow numeric placeholder="peak" onSave={v => { setPeak(v); commit({ peak: v }) }} />
        : <>{def.pct ? `${def.pct}% · ` : ''}goal {def.reps}{def.setup ? ` · ${def.setup}` : ''}</>}</td>
      <ChainCells half={0} big={0} />
      <BandCells bands={bands} onSet={setBand} />
      <td className="num c-rest">{r && <button className="x" onClick={() => D.api.deleteSet(r.id!)} aria-label="Delete set" data-tip="Delete this logged set" data-pos="right">×</button>}</td>
    </tr>
    {more && (
      <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
        <div className="morebox">
          {!fly && <label className="wide m-plates">Plates per side<PlateGrid stack={pstack} on={D.plan.plates_on} onSet={(pl, n) => { const next = withCount(pstack, pl, n); const nw = next.reduce((t, x) => t + x, 0) * 2 + bar; setW(nw); commit({ w: nw }) }} /></label>}
          {fly && <label>Peak<CellText value={peak} narrow numeric onSave={v => { setPeak(v); commit({ peak: v }) }} /></label>}
          <label className="wide">Bands per side<BandGrid bands={bands} onSet={setBand} /></label>
          {!fly && <span className="small muted">{def.pct ? `${def.pct}% · ` : ''}goal {def.reps}{def.setup ? ` · ${def.setup}` : ''}</span>}
        </div>
      </td></tr>
    )}
    </>
  )
}

/* ---------- speed row ---------- */

function SpeedTr({ api, r, it, name, n, sets, next, lastMain }: {
  api: Api; r?: SetRow; it: any; name: string; n: number; sets: SetRow[]; next?: boolean; lastMain?: SetRow
}) {
  const { equipment: eq } = useStore()
  const C = useContext(ColsCtx)
  const prev = r ? undefined : sets.at(-1)
  const lower = name.toLowerCase()
  const isBench = lower.includes('banded bench')
  const src = r?.setup ?? prev?.setup ?? {}
  const defBands: BandPick[] = bandsOf(src).length ? bandsOf(src) : it.band ? [{ name: eq.find(e => e.kind === 'band' && e.name.startsWith('Rogue band ' + String(it.band).split(' ')[0]))?.name ?? 'Rogue band ' + String(it.band).split(' ')[0], per_side: it.bands_per_side ?? 1 }] : []
  const [load, setLoad] = useState<number | null>(r?.weight_lb ?? prev?.weight_lb ?? it.load_lb ?? (isBench ? n0(eq.find(e => e.name === LIGHT_BAR)?.weight_lb) || 5 : null))
  const [bands, setBands] = useState<BandPick[]>(defBands)
  const [reps, setReps] = useState(r?.reps?.toString() ?? '')
  const [open, setOpen] = useState(false)
  const ten = bandTension(bands, eq)

  async function commit(p: { load?: number | null; bands?: BandPick[]; reps?: string }) {
    const bb = p.bands ?? bands, rp = p.reps ?? reps
    const tt = bandTension(bb, eq)
    const setup: Record<string, any> = { ...(r?.setup ?? {}), slot: it.name, bands: bb, lockout_per_side_lb: tt.perSide, lockout_lb: tt.total, chest_lb: 0 }
    if (isBench) setup.bar = LIGHT_BAR
    delete setup.band
    const row = { weight_lb: p.load !== undefined ? p.load : load, reps: rp === '' ? null : Number(rp), setup }
    if (r) await api.updateSet(r.id!, row)
    else if (row.reps !== null) {
      const id = api.exId(name)
      if (!id) return
      if (lastMain) Object.assign(setup, { after_heavy: lastMain.block === 'primary' ? lastMain.set_index : null, after_main: `${lastMain.block}:${lastMain.set_index}`,
        after_heavy_s: lastMain.created_at ? Math.round((Date.now() - Date.parse(lastMain.created_at)) / 1000) : null })
      await api.addSet({ ...row, exercise_id: id, block: 'speed', set_index: n, total_bottom_lb: null, total_top_lb: null, assisted: false, failed: false })
    }
  }
  const setBand = (nm: string, k: number) => { const bb = withBand(mapBands(bands, C), nm, Math.max(0, Math.round(k))); setBands(bb); commit({ bands: bb }) }

  return (
    <>
      <tr className={(r ? 'done' : 'plan') + (next ? ' next' : '') + ' speed'}>
        <td className="stick" onClick={() => setOpen(o => !o)}><span className="tagdot s" />{name} {n}<span className="moretoggle">{open ? '▴' : '▾'}</span></td>
        <td><CellNum value={load} onSave={v => { setLoad(v); commit({ load: v }) }} />
          {bands.length > 0 && <div className="sub2 side-inline">{bandLabel(bands)}</div>}</td>
        <td className="c-exp" />
        <td><CellText value={reps} narrow numeric placeholder={it.reps ? String(it.reps) : ''} onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
        <td />
        <td />
        <td colSpan={PLATE_COLS.length} className="c-plate" />
        <td className="c-setup" />
        <ChainCells half={0} big={0} />
        <BandCells bands={bands} onSet={setBand} />
        <td className="num muted c-rest">{r?.setup?.after_heavy ? `after ${r.setup.after_heavy}` : ''}{r && <button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set" data-tip="Delete this logged set" data-pos="right">×</button>}</td>
      </tr>
      {open && (
        <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
          <div className="morebox">
            <label className="wide">Bands per side<BandGrid bands={bands} onSet={setBand} /></label>
          </div>
        </td></tr>
      )}
    </>
  )
}

/* ---------- support table ---------- */

function SupportTable({ S, api }: { S: SupportCtl; api: Api }) {
  return (
    <div className="supsheet">
      <h3><span className="hastip" data-tip="Accessory work. Log the start weight and reps at that weight; drops follow the scheme." data-pos="left">Support</span></h3>
      <div className="tablewrap">
        <table className="sheet">
          <thead><tr><th className="stick" data-tip="Pick from the library; the plan's default is preselected." data-pos="left">Exercise</th><th data-tip="Starting weight (the first, heaviest load).">Start</th><th data-tip="Reps at the start weight.">Reps</th><th data-tip="Reps at each drop, e.g. 3+3+3 for a run-the-rack.">Each drop</th><th data-tip="Reps at the last drop.">Final</th><th className="c-setup" data-tip="F = to failure · TF = technical failure · DS×n = n drops · ST = strip set · RP = rest-pause · RTR = run the rack. Tap the scheme for details.">Scheme</th><th className="c-exp" data-tip="Weight removed at each drop.">Step</th><th className="c-exp" data-tip="Number of drops after the start weight.">Drops</th><th className="c-side">Note</th><th className="c-rest"></th></tr></thead>
          <tbody>{S.slots.map(slot => <SupportTr key={slot.key} slot={slot} S={S} api={api} />)}</tbody>
        </table>
      </div>
      <button className="ghost small" onClick={() => S.addExercise()} data-tip="Add a support exercise not in today's plan" data-pos="left">+ Add exercise</button>
    </div>
  )
}

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']

function SupportTr({ slot, S, api, inline }: { slot: SupportSlot; S: SupportCtl; api: Api; inline?: boolean }) {
  const C = useContext(ColsCtx)
  const { exercises, templates } = useStore()
  const schemeOptions = Array.from(new Set([...SCHEMES, ...templates.flatMap(t => (t.spec?.support?.items ?? []).map((i: any) => i.scheme).filter(Boolean))]))
  const e = slot.existing, d = slot.defaults ?? {}
  const init = () => {
    const dr: number[] = e?.setup?.drop_reps ?? []
    return {
      ex: slot.exerciseId, scheme: e?.scheme ?? d.scheme ?? '',
      start: e?.start_weight_lb?.toString() ?? d.start_lb?.toString() ?? '', step: e?.step_lb?.toString() ?? d.step_lb?.toString() ?? '',
      drops: e?.drops?.toString() ?? d.drops?.toString() ?? '', reps: e?.reps?.toString() ?? '',
      each: dr.length > 1 ? (new Set(dr.slice(0, -1)).size === 1 ? String(dr[0]) : dr.slice(0, -1).join(',')) : '',
      final: e?.setup?.final_reps?.toString() ?? (dr.length ? String(dr.at(-1)) : ''),
      notes: e?.notes ?? '',
    }
  }
  const [v, setV] = useState(init)
  useEffect(() => setV(init()), [e?.id, e?.exercise_id, e?.reps])
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  const drops = num(v.drops)
  const loads = (() => {
    const start = num(v.start), step = num(v.step)
    if (start === null || !step || !drops) return ''
    return Array.from({ length: Math.min(drops, 30) + 1 }, (_, i) => Math.max(0, start - i * step)).join('→')
  })()

  async function save(nv = v) {
    if (!nv.ex) return
    const dn = num(nv.drops)
    let dropReps: number[] | null = null
    if (dn && (nv.each || nv.final)) {
      const list = nv.each.split(/[ ,]+/).filter(Boolean).map(Number)
      const middle = list.length > 1 ? list.slice(0, dn - 1) : Array(Math.max(0, dn - 1)).fill(list[0] ?? null)
      dropReps = [...middle, num(nv.final) ?? list.at(-1) ?? null]
    }
    const patch = {
      exercise_id: nv.ex, scheme: nv.scheme || null, start_weight_lb: num(nv.start), step_lb: num(nv.step), drops: dn, reps: num(nv.reps),
      notes: nv.notes.trim() || null, setup: { ...(e?.setup ?? {}), slot: slot.slot, drop_reps: dropReps, final_reps: num(nv.final) },
    }
    if (e?.id) await api.updateSet(e.id, patch)
    else if (patch.start_weight_lb !== null || patch.reps !== null || patch.notes) {
      const row = await api.addSet({ ...patch, block: 'support', set_index: slot.setIndex, weight_lb: null, total_bottom_lb: null, total_top_lb: null, assisted: false, failed: false })
      if (row) S.saved(slot)
    }
  }
  const field = (k: keyof ReturnType<typeof init>, narrow = true, numeric = true) => (
    <CellText value={v[k]} narrow={narrow} numeric={numeric} onSave={x => { const nv = { ...v, [k]: x }; setV(nv); save(nv) }} />
  )
  const [more, setMore] = useState(false)
  const scheme = <SchemePicker value={v.scheme} options={schemeOptions} onChange={scheme => { const nv = { ...v, scheme }; setV(nv); save(nv) }} />
  const note = <CellText value={v.notes} placeholder={d.note ? 'see plan note' : 'note'} wide onSave={x => { const nv = { ...v, notes: x }; setV(nv); save(nv) }} />
  if (inline) return (
    <tr className={(e ? 'done' : 'plan') + ' supinline'}>
      <td className="stick"><span className="tagdot u" />
        <select className="exsel" value={v.ex} onChange={ev => { const nv = { ...v, ex: ev.target.value }; setV(nv); save(nv) }}>
            <option value="">choose…</option>
            {exercises.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        {slot.setIndex > 1 && <span className="small muted"> set {slot.setIndex}</span>}
      </td>
      <td colSpan={C.span}>
        <div className="supfields">
          <label data-tip="Starting weight (the first, heaviest load).">Start{field('start')}</label>
          <label data-tip="Reps at the start weight.">Reps{field('reps')}</label>
          <label data-tip="Reps at each drop, e.g. 3 or 3,3,4.">Each drop{field('each', true, false)}</label>
          <label data-tip="Reps at the last drop.">Final{field('final')}</label>
          <div className="field"><span className="flabel">Scheme</span>{scheme}</div>
          <label data-tip="Weight removed at each drop.">Step{field('step')}</label>
          <label data-tip="Number of drops after the start weight.">Drops{field('drops')}</label>
          <label className="grow">Note{note}</label>
          <span className="nowrap"><button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex} data-tip="Add another set of this exercise" data-pos="right" aria-label="Another set">+</button>
            <button className="x" onClick={() => S.remove(slot)} aria-label="Remove" data-tip="Remove this exercise or set" data-pos="right">×</button></span>
        </div>
      </td>
    </tr>
  )
  return (
    <>
      <tr className={e ? 'done' : 'plan'}>
        <td className="stick">
          <span className="moretoggle sup" onClick={() => setMore(m => !m)}>{more ? '▴' : '▾'}</span>
          <select className="exsel" value={v.ex} onChange={ev => { const nv = { ...v, ex: ev.target.value }; setV(nv); save(nv) }}>
            <option value="">choose…</option>
            {exercises.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          {slot.setIndex > 1 && <span className="small muted"> set {slot.setIndex}</span>}
          {d.note && <div className="sub2 wrap">{d.note}</div>}
        </td>
        <td>{field('start')}</td><td>{field('reps')}</td><td>{field('each', true, false)}</td><td>{field('final')}</td>
        <td className="c-setup">{scheme}</td>
        <td className="c-exp">{field('step')}</td><td className="c-exp">{field('drops')}</td>
        <td className="c-side">{note}</td>
        <td className="nowrap c-rest"><button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex} data-tip="Add another set of this exercise" data-pos="right" aria-label="Another set">+</button>
          <button className="x" onClick={() => S.remove(slot)} aria-label="Remove" data-tip="Remove this exercise or set" data-pos="right">×</button></td>
      </tr>
      {more && (
        <tr className="morerow"><td className="stick" /><td colSpan={9}>
          <div className="morebox">
            <div className="field"><span className="flabel">Scheme</span>{scheme}</div>
            <label>Step{field('step')}</label><label>Drops{field('drops')}</label>
            <label className="grow">Note{note}</label>
            <button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex}>+ set</button>
            <button className="ghost small" onClick={() => S.remove(slot)}>Remove</button>
          </div>
        </td></tr>
      )}
    </>
  )
}

/* ---------- cells ---------- */

export function CellNum({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  return <CellText value={value === null ? '' : String(Math.round(value * 100) / 100)} narrow numeric onSave={v => onSave(v === '' ? null : Number(v))} />
}

export function CellText({ value, onSave, placeholder, narrow, wide, full, numeric }: {
  value: string; onSave: (v: string) => void; placeholder?: string; narrow?: boolean; wide?: boolean; full?: boolean; numeric?: boolean
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input className={'cellin' + (narrow ? ' n' : '') + (wide ? ' w' : '') + (full ? ' f' : '')} value={v} placeholder={placeholder}
      inputMode={numeric ? 'decimal' : 'text'} onChange={e => setV(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      onBlur={() => { if (v.trim() !== value) onSave(v.trim()) }} />
  )
}

export { Fragment }
