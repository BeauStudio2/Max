import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { e1rm, e1rmFromRpe, expectedReps, lostReps, repGoal, loadSide, platesPerSide, round, totals, type Kept, type LoadSetup } from '../../lib/load'
import type { Equipment, SetRow } from '../../lib/types'
import { CLAMPS, CHAIN_CLAMP, setupOf, type Ladder } from './Ladder'
import { type DeadliftCtl, type PullRowDef } from './Deadlift'
import { type SupportCtl, type SupportSlot } from './Support'
import SchemePicker from './SchemePicker'
import Metronome from './Metronome'
import { DelBtn, fmt, useClock, type Api } from './shared'

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
      <td key={p} className={'c-plate' + (off ? ' off' : '') + (keptN?.[p] ? ' kept' : '')}>
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

interface Cols { chains: boolean; span: number; allBands: Equipment[] }
const ColsCtx = createContext<Cols>({ chains: false, span: 12, allBands: [] })

function ChainCells({ half, big, onSet }: { half: number; big: number; onSet?: (which: 'chain_half' | 'chain_5_8', n: number) => void }) {
  const C = useContext(ColsCtx)
  if (!C.chains) return null
  return <>{(['chain_half', 'chain_5_8'] as const).map(k => {
    const n = k === 'chain_half' ? half : big
    return <td key={k} className="c-chain">{onSet ? <CellText value={n ? String(n) : ''} narrow numeric onSave={v => onSet(k, v === '' ? 0 : Number(v))} /> : null}</td>
  })}</>
}

/**
 * One row's bands: each chip is one band per side, picked by colour. + adds another (the same colour is fine);
 * "remove" in a chip's list takes it off. Stored as one entry per band, so two of a colour are two chips.
 */
function BandEditor({ bands, onChange }: { bands: BandPick[]; onChange: (b: BandPick[]) => void }) {
  const C = useContext(ColsCtx)
  const chips = bands.flatMap(b => Array.from({ length: Math.max(1, b.per_side) }, () => b.name))
  const save = (names: string[]) => onChange(names.map(name => ({ name, per_side: 1 })))
  return (
    <div className="bandlist">
      {chips.map((name, i) => (
        <span key={i} className="bandpick" style={{ ['--band' as any]: bandColor(name) }}>
          <select value={name} aria-label={`Band ${i + 1}`} onChange={e => save(e.target.value === '' ? chips.filter((_, j) => j !== i) : chips.map((x, j) => (j === i ? e.target.value : x)))}>
            {C.allBands.map(x => <option key={x.id} value={x.name}>{x.name.replace('Rogue band ', '')}</option>)}
            {!C.allBands.some(x => x.name === name) && <option value={name}>{name}</option>}
            <option value="">remove</option>
          </select>
        </span>
      ))}
      <button type="button" className="bandadd" onClick={() => save([...chips, chips.at(-1) ?? C.allBands[0]?.name ?? ''])} aria-label="Add a band">+</button>
    </div>
  )
}

/* ---------- the order of rows: main set, then one round of speed, then main... ---------- */

/**
 * The session as one fixed sequence, built only from the plan and the two toggles — never from when things were typed.
 * Each set has a permanent place; logging a set fills its row in place.
 */
type Item =
  | { kind: 'main'; key: string; r?: SetRow; p?: Ladder['projected'][number] }
  | { kind: 'pull'; key: string; row: PullRowDef; r?: SetRow }
  | { kind: 'speed'; key: string; it: any; n: number; r?: SetRow }
  | { kind: 'sup'; key: string; slot: SupportSlot }
  | { kind: 'noplan'; key: string }

export type Block = 'heavy' | 'speed' | 'support'
/** Blocks joined by an interleave toggle form a group; groups run one after another. */
export function groupsOf(order: Block[], joins: boolean[]): Block[][] {
  const groups: Block[][] = [[order[0]]]
  for (let i = 1; i < order.length; i++) { if (joins[i - 1]) groups.at(-1)!.push(order[i]); else groups.push([order[i]]) }
  return groups
}

/** Within a group, round r takes one unit from each block in the group's order (a heavy set, a speed round, a support set). */
function buildSequence(units: Record<Block, Item[][]>, order: Block[], joins: boolean[]) {
  const out: Item[] = []
  for (const g of groupsOf(order, joins)) {
    const R = Math.max(...g.map(b => units[b].length))
    for (let r = 0; r < R; r++) for (const b of g) if (units[b][r]) out.push(...units[b][r])
  }
  return out
}

/* ---------- the sheet ---------- */

export default function SessionSheet({ api, liftLabel, L, D, heavyExerciseId, restS, speed, speedEx, speedSets, order, joins, running = false, onPlannedMax, speedMax = {}, supportMax = {}, S, circuit, onCircuit }: {
  api: Api; liftLabel: string; L: Ladder | null; D: DeadliftCtl | null; heavyExerciseId?: string; restS: number
  speed: any | null; speedEx: (it: any) => string; speedSets: (it: any) => SetRow[]; order: Block[]; joins: boolean[]; running?: boolean; onPlannedMax?: (v: number | null) => void
  speedMax?: Record<string, number>; supportMax?: Record<string, number>
  S: SupportCtl; circuit: number | null; onCircuit: (min: number | null) => void
}) {
  const platesOn: number[] | undefined = L?.plan.plates_on ?? D?.plan.plates_on
  const { equipment } = useStore()
  const allBands = useMemo(() => equipment.filter(e => e.kind === 'band').sort((a, b) => n0(a.props?.one_band_lockout_lb) - n0(b.props?.one_band_lockout_lb)), [equipment])
  const items: any[] = speed?.items ?? []
  const allSpeed = items.flatMap(it => speedSets(it))
  const groups = groupsOf(order, joins)
  const withHeavy = (b: Block) => groups.some(g => g.includes(b) && g.includes('heavy'))
  // Support interleaved with another block rotates through its exercises one set at a time.
  const supInterleave = groups.some(g => g.includes('support') && g.length > 1)
  // Support capped per exercise: logged sets always show; unlogged ones only up to that exercise's max sets.
  const supSlots = S.slots
  const mainSets = L ? L.logged : (D?.rows.map(r => r.existing).filter(Boolean) as SetRow[]) ?? []
  // A support set only counts as done once it has reps; one with just a start weight typed is still to do.
  const supIsDone = (x: SupportSlot) => !!x.existing && x.existing.reps != null
  // Everything logged, in the order it was done: for the rest timer and circuit time only (never for the row order).
  const done = useMemo(() => [...mainSets, ...allSpeed, ...S.slots.filter(supIsDone).map(x => x.existing!)].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')), [mainSets, allSpeed, S.slots])
  // Heavy with no planned max can't plan its sets; speed then runs on its own count so the rounds still exist.
  const heavyUnplanned = !!L && !L.plan.planned_e1rm
  const heavy: Item[] = L
    ? [...L.logged.map(r => ({ kind: 'main' as const, key: r.id!, r })), ...L.projected.map(p => ({ kind: 'main' as const, key: 'h' + p.idx, p }))]
    : (D?.rows ?? []).map(x => ({ kind: 'pull' as const, key: 'd:' + x.row.step, row: x.row, r: x.existing }))
  const heavyCount = heavy.length
  const speedRounds: Item[][] = []
  for (const it of items) {
    const logged = [...speedSets(it)].sort((a, b) => a.set_index - b.set_index)
    // Interleaved with heavy and no max sets: one speed round per heavy set. A max sets number overrides that
    // (and carries the cycle on past the heavy sets if it's bigger). Not interleaved: the day's own number of sets.
    const cap = speedMax[it.name]
    const planned = cap != null ? cap : withHeavy('speed') && heavyCount > 0 ? heavyCount : (it.sets ?? 0)
    const rounds = Math.max(planned, logged.at(-1)?.set_index ?? 0)
    for (let n = 1; n <= rounds; n++) {
      const here = logged.filter(x => x.set_index === n)
      const round = (speedRounds[n - 1] ??= [])
      if (!here.length) round.push({ kind: 'speed', key: `s:${it.name}:${n}`, it, n })
      here.forEach((r, j) => round.push({ kind: 'speed', key: r.id ?? `s:${it.name}:${n}:${j}`, it, n, r }))
    }
  }
  // Interleaved, support rotates: one set of each exercise in turn, then round again for any with more sets.
  const ordinal = new Map<string, number>(); const seenSup: Record<string, number> = {}
  for (const x of supSlots) { const nm = x.slot ?? x.key; seenSup[nm] = (seenSup[nm] ?? 0) + 1; ordinal.set(x.key, seenSup[nm]) }
  const supOrdered = supInterleave ? [...supSlots].sort((a, b) => ordinal.get(a.key)! - ordinal.get(b.key)!) : supSlots
  const support: Item[] = supOrdered.map(slot => ({ kind: 'sup', key: 'sup:' + slot.key, slot }))
  const seq = [...(heavyUnplanned ? [{ kind: 'noplan' as const, key: 'noplan' }] : []), ...buildSequence({ heavy: heavy.map(h => [h]), speed: speedRounds.filter(Boolean), support: support.map(u => [u]) }, order, joins)]
  const isDoneItem = (x: Item) => (x.kind === 'sup' ? supIsDone(x.slot) : x.kind === 'noplan' ? true : !!x.r)
  const nextItem = seq.find(x => !isDoneItem(x))
  const lastMain = [...done].reverse().find(isMain)
  // The rest timer only runs while the workout clock is running (after Start workout, before Finish).
  const rest = useClock(running ? lastMain?.created_at : null)
  const nextMain = seq.find(x => (x.kind === 'main' || x.kind === 'pull') && !x.r) as Extract<Item, { kind: 'main' | 'pull' }> | undefined

  // Circuit time: what you entered, or first to last set of the circuit.
  const autoMin = done.length > 1 ? (Date.parse(done.at(-1)!.created_at!) - Date.parse(done[0].created_at!)) / 60000 : null
  const minutes = circuit ?? (autoMin && autoMin > 1 ? Math.round(autoMin) : null)
  const mainCount = mainSets.length
  const perMin = L?.fit && minutes && mainCount ? L.fit.ratePct / (minutes / mainCount) : null
  // Band columns: every band used today (logged or planned speed work), plus any added with "+ band".
  const chains = !!(L && L.plan.bar && L.plan.chains_ok)
  // Columns after the set name: lb, Exp, Reps, A·F, e1RM, plates, clamps, chains, bands, rest, delete.
  const cols: Cols = { chains, span: 5 + PLATE_COLS.length + 1 + (chains ? 2 : 0) + 1 + 1 + 1, allBands }
  const slotName = (r: SetRow) => { const it = items.find(i => i.name === r.setup?.slot); return it ? speedEx(it) : r.setup?.slot ?? 'Speed' }

  return (
    <section className="card sheetcard">
      <div className="sheetbar">
        <div><span className="small muted hastip" data-tip="Time since the last heavy set / your rest target. Turns green when it's time." data-pos="left">Rest</span><b className={running && lastMain && rest >= restS ? 'ready' : ''}>{!running ? <span className="muted" data-tip="Press Start workout to run the rest timer." data-pos="left">— / {fmt(restS)}</span> : lastMain ? `${fmt(rest)} / ${fmt(restS)}` : `0:00 / ${fmt(restS)}`}</b></div>
        <div><span className="small muted hastip" data-tip="The next heavy set still to do." data-pos="left">Next {liftLabel}</span><b>{nextMain ? nextMain.kind === 'main' ? `#${nextMain.p?.idx ?? ''}` : nextMain.row.step : 'done'}</b></div>
        <label className="circuit"><span className="small muted hastip" data-tip="Minutes from the first to the last set of the heavy + speed circuit. Blank uses the logged times; type to override. Used for fatigue per minute." data-pos="right">Circuit min</span>
          <input inputMode="decimal" placeholder={autoMin && autoMin > 1 ? String(Math.round(autoMin)) : ''} defaultValue={circuit ?? ''} key={circuit ?? 'x'}
            onBlur={e => { const v = e.target.value.trim(); onCircuit(v === '' ? null : Number(v)) }} />
        </label>
        <Metronome />
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
              <th className="c-band" data-tip="Bands per side: each chip is one band. + adds another (the same colour is fine); pick “remove” in a chip to take it off." data-pos="right">Bands</th>
              <th className="c-rest num" data-tip="Rest taken before this set (heavy rows), or which heavy set a speed round followed." data-pos="right">Rest</th><th className="c-del" />
            </tr>
          </thead>
          <tbody>
            {seq.map(x => {
              const next = x === nextItem
              if (x.kind === 'main' && L) return <MainTr key={x.key} L={L} api={api} r={x.r} p={x.p} exerciseId={heavyExerciseId} label={liftLabel} next={next} />
              if (x.kind === 'pull' && D) return <PullTr key={x.key} D={D} def={x.row} r={x.r} next={next} />
              if (x.kind === 'speed') return <SpeedTr key={x.key} api={api} r={x.r} it={x.it} name={speedEx(x.it)} n={x.n} sets={speedSets(x.it)} next={next} lastMain={lastMain} />
              if (x.kind === 'sup') return <SupportTr key={x.key} slot={x.slot} S={S} api={api} inline next={next} />
              if (x.kind === 'noplan') return (
                <tr key={x.key} className="noplan"><td className="stick"><span className="tagdot h" />{liftLabel}</td>
                  <td colSpan={cols.span}><div className="noplanbox">
                    <span>No planned max for <b>{liftLabel}</b> yet, so its sets can't be planned.</span>
                    <label>Planned max (est. 1-rep max) <CellNum value={null} onSave={v => v && onPlannedMax?.(v)} /></label>
                  </div></td></tr>)
              return null
            })}
          </tbody>
        </table>
        </ColsCtx.Provider>
      </div>
      <p className="small muted sheetfoot">
        Grey rows are the plan; type reps in one to log it. {L?.floor ? `Stop line ${round(L.floor)}. ` : ''}
        {L?.fit ? `Fatigue ${L.fit.ratePct.toFixed(2)}%/set` : ''}{perMin ? ` · ${perMin.toFixed(2)}%/min over ${minutes} min, ${mainCount} sets` : ''}
        {D?.todayMax ? `Deadlift estimate ${round(D.todayMax)}.` : ''}
      </p>

      <button className="ghost small" onClick={() => S.addExercise()} data-tip="Add a support exercise not in today's plan" data-pos="left">+ Add support exercise</button>
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
        stack, kept: r?.setup?.kept ?? (L.plan.bar ? { base: L.kept.base, change: L.kept.change } : null) } }
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
  const keptN = countsOf(L.kept.base)
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
      <td className="c-band"><BandEditor bands={setup.bands ?? []} onChange={bb => setSet({ ...setup, bands: bb })} /></td>
      <td className="num muted c-rest">{r?.rest_s ? fmt(r.rest_s) : ''}</td>
      <td className="c-del">{logged && <DelBtn tip="Delete this logged set" onConfirm={() => api.deleteSet(r!.id!)} />}</td>
    </tr>
    {more && (
      <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
        <div className="morebox">
          {hasBar && <label className="wide m-plates">Plates per side<PlateGrid stack={stack} on={L.plan.plates_on} onSet={setPlate} /></label>}
          {hasBar && <label className="m-clamp">Clamps{setupCell}</label>}
          {C.chains && <label className="wide">Chains per side
            <div className="plategrid chaingrid">{(['chain_half', 'chain_5_8'] as const).map(k => <label key={k}>{k === 'chain_half' ? '½ in' : '⅝ in'}
              <CellText value={setup[k] ? String(setup[k]) : ''} narrow numeric onSave={v => setChain(k, v === '' ? 0 : Number(v))} /></label>)}</div></label>}
          <label className="wide">Bands per side<BandEditor bands={setup.bands ?? []} onChange={bb => setSet({ ...setup, bands: bb })} /></label>
          {exp !== null && <span className="small muted">Goal {goal} · expect {exp.toFixed(1)} reps{diff !== null ? ` (${diff >= 0 ? '+' : ''}${diff.toFixed(1)})` : ''}</span>}
          {r?.rest_s ? <span className="small muted">Rest {fmt(r.rest_s)}</span> : null}
          {logged && <DelBtn text="Delete set" onConfirm={() => api.deleteSet(r!.id!)} />}
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
      <td className="c-band"><BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }) }} /></td>
      <td className="num c-rest" />
      <td className="c-del">{r && <DelBtn tip="Delete this logged set" onConfirm={() => D.api.deleteSet(r.id!)} />}</td>
    </tr>
    {more && (
      <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
        <div className="morebox">
          {!fly && <label className="wide m-plates">Plates per side<PlateGrid stack={pstack} on={D.plan.plates_on} onSet={(pl, n) => { const next = withCount(pstack, pl, n); const nw = next.reduce((t, x) => t + x, 0) * 2 + bar; setW(nw); commit({ w: nw }) }} /></label>}
          {fly && <label>Peak<CellText value={peak} narrow numeric onSave={v => { setPeak(v); commit({ peak: v }) }} /></label>}
          <label className="wide">Bands per side<BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }) }} /></label>
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
        <td className="c-band"><BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }) }} /></td>
        <td className="num muted c-rest">{r?.setup?.after_heavy ? `after ${r.setup.after_heavy}` : ''}</td>
        <td className="c-del">{r && <DelBtn tip="Delete this logged set" onConfirm={() => api.deleteSet(r.id!)} />}</td>
      </tr>
      {open && (
        <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
          <div className="morebox">
            <label className="wide">Bands per side<BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }) }} /></label>
          </div>
        </td></tr>
      )}
    </>
  )
}

/* ---------- support table ---------- */

function SupportTable({ S, api, slots }: { S: SupportCtl; api: Api; slots?: SupportSlot[] }) {
  return (
    <div className="supsheet">
      <h3><span className="hastip" data-tip="Accessory work. Log the start weight and reps at that weight; drops follow the scheme." data-pos="left">Support</span></h3>
      <div className="tablewrap">
        <table className="sheet">
          <thead><tr><th className="stick" data-tip="Pick from the library; the plan's default is preselected." data-pos="left">Exercise</th><th data-tip="Starting weight (the first, heaviest load).">Start</th><th data-tip="Reps at the start weight.">Reps</th><th data-tip="Reps at each drop, e.g. 3+3+3 for a run-the-rack.">Each drop</th><th data-tip="Reps at the last drop.">Final</th><th className="c-setup" data-tip="F = to failure · TF = technical failure · DS×n = n drops · ST = strip set · RP = rest-pause · RTR = run the rack. Tap the scheme for details.">Scheme</th><th className="c-exp" data-tip="Weight removed at each drop.">Step</th><th className="c-exp" data-tip="Number of drops after the start weight.">Drops</th><th className="c-side">Note</th><th className="c-rest"></th></tr></thead>
          <tbody>{(slots ?? S.slots).map(slot => <SupportTr key={slot.key} slot={slot} S={S} api={api} />)}</tbody>
        </table>
      </div>
      <button className="ghost small" onClick={() => S.addExercise()} data-tip="Add a support exercise not in today's plan" data-pos="left">+ Add exercise</button>
    </div>
  )
}

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']

function SupportTr({ slot, S, api, inline, next }: { slot: SupportSlot; S: SupportCtl; api: Api; inline?: boolean; next?: boolean }) {
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
    <tr className={(e && e.reps != null ? 'done' : 'plan') + ' supinline' + (more ? ' open' : '') + (next ? ' next' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot u" />{exercises.find(x => x.id === v.ex)?.name ?? 'Support'}{slot.setIndex > 1 ? ` · set ${slot.setIndex}` : ''}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td colSpan={C.span}>
        <div className="supfields">
          <label className="exfield opt">Exercise
            <select className="mini" value={v.ex} onChange={ev => { const nv = { ...v, ex: ev.target.value }; setV(nv); save(nv) }}>
              <option value="">choose…</option>
              {exercises.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label data-tip="Starting weight (the first, heaviest load).">Start{field('start')}</label>
          <label data-tip="Reps at the start weight.">Reps{field('reps')}</label>
          <label className="opt" data-tip="Reps at each drop, e.g. 3 or 3,3,4.">Each drop{field('each', true, false)}</label>
          <label className="opt" data-tip="Reps at the last drop.">Final{field('final')}</label>
          <div className="field opt"><span className="flabel">Scheme</span>{scheme}</div>
          <label className="opt" data-tip="Weight removed at each drop.">Step{field('step')}</label>
          <label className="opt" data-tip="Number of drops after the start weight.">Drops{field('drops')}</label>
          <label className="grow opt">Note{note}</label>
          <span className="nowrap"><button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex} data-tip="Add another set of this exercise" data-pos="right" aria-label="Another set">+</button>
            <DelBtn label="Remove" tip="Remove this exercise or set" onConfirm={() => S.remove(slot)} /></span>
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
          <DelBtn label="Remove" tip="Remove this exercise or set" onConfirm={() => S.remove(slot)} /></td>
      </tr>
      {more && (
        <tr className="morerow"><td className="stick" /><td colSpan={9}>
          <div className="morebox">
            <div className="field"><span className="flabel">Scheme</span>{scheme}</div>
            <label>Step{field('step')}</label><label>Drops{field('drops')}</label>
            <label className="grow">Note{note}</label>
            <button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex}>+ set</button>
            <DelBtn label="Remove" text="Remove" onConfirm={() => S.remove(slot)} />
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
