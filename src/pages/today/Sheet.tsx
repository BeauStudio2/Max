import { perRep } from './Ladder'
import { ALL_PLATES } from '../../lib/load'
import { useRef, Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { e1rm, e1rmFromRpe, expectedReps, lostReps, repGoal, loadSide, platesPerSide, round, totals, type Kept, type LoadSetup } from '../../lib/load'
import type { Equipment, SetRow } from '../../lib/types'
import { CLAMPS, CHAIN_CLAMP, setupOf, type Ladder } from './Ladder'
import { type DeadliftCtl, type PullRowDef } from './Deadlift'
import { type SupportCtl, type SupportSlot } from './Support'
import SchemePicker from './SchemePicker'
import Metronome from './Metronome'
import VoiceBar from './VoiceBar'
import BarPanel from './BarPanel'
import CamPanel from './CamPanel'
import { camera } from '../../lib/camera'
import { imu, summarize as barSummary } from '../../lib/imuLink'
import { predictionMiss, type Probe, type SetObs } from '../../lib/learn'
import { recordObservations } from '../../lib/observations'
import RestOverlay from './RestOverlay'
import { cue, cueWord, onCommand, sayLb, saySeconds, speak, voice } from '../../lib/voice'
import { live, nextPhrases, platePhrases } from './live'
const cueOn = (k: 'next' | 'plates') => voice.get().settings.cues[k]?.on !== false
/** Rest taken so far and how full creatine is getting, for the next spotter set's prediction. */
const RestCtx = createContext<number | null>(null)
/** Test sets: which upcoming sets have a deliberate short or long rest before them, and how to skip one. */
const ProbeCtx = createContext<{ probes: Record<number, Probe>; skip?: (idx: number) => void }>({ probes: {} })
const SpotCtx = createContext<{ rows: Record<string, boolean>; set?: (idx: number, on: boolean) => void }>({ rows: {} })
import TindeqPanel, { type Tempo } from './TindeqPanel'
import { endLevel, fitQualifies, fitSession, levelAfter, predictSet, restFor, startLevel, strengthAt, type Pulse, type SpotSet } from '../../lib/creatine'
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
function PlateCells({ stack, on, onSet, keptN, disabled, origin = '' }: { origin?: string; stack: number[] | null; on?: number[]; onSet: (plate: number, n: number) => void; keptN?: Record<number, number>; disabled?: boolean }) {
  const c = countsOf(stack)
  return <>{PLATE_COLS.map(p => {
    const off = on ? !on.includes(p) : false
    return (
      <td key={p} className={'c-plate ' + origin + (off ? ' off' : '') + (keptN?.[p] ? ' kept' : '')}>
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
const CaptureCtx = createContext<{ id: number; pulses: Pulse[]; tempo: Tempo } | null>(null)
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))
const ColsCtx = createContext<Cols>({ chains: false, span: 12, allBands: [] })

function ChainCells({ half, big, onSet, origin = '' }: { origin?: string; half: number; big: number; onSet?: (which: 'chain_half' | 'chain_5_8', n: number) => void }) {
  const C = useContext(ColsCtx)
  if (!C.chains) return null
  return <>{(['chain_half', 'chain_5_8'] as const).map(k => {
    const n = k === 'chain_half' ? half : big
    return <td key={k} className={'c-chain ' + origin}>{onSet ? <CellText value={n ? String(n) : ''} narrow numeric onSave={v => onSet(k, v === '' ? 0 : Number(v))} /> : null}</td>
  })}</>
}

/**
 * One row's bands: each chip is one band per side, picked by colour. + adds another (the same colour is fine);
 * "remove" in a chip's list takes it off. Stored as one entry per band, so two of a colour are two chips.
 */
export function BandEditor({ bands, onChange, options }: { bands: BandPick[]; onChange: (b: BandPick[]) => void; options?: { id?: string; name: string }[] }) {
  const ctx = useContext(ColsCtx), C = { allBands: options ?? ctx.allBands }
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

export default function SessionSheet({ api, liftLabel, L, D, heavyExerciseId, restS, speedSetS = 25, speed, speedEx, speedSets, order, joins, running = false, onPlannedMax, onApplyFit, onAutoFit, onPlatesOn, speedMax = {}, supportMax = {}, speedBands = {}, onSpeedBands, spotRows = {}, onSpotRow, probes = {}, onSkipProbe, onObs, S, circuit, onCircuit }: {
  /** Test sets for today (by set number), skipping one, and the session's sets handed up for learning. */
  probes?: Record<number, Probe>; onSkipProbe?: (idx: number) => void; onObs?: (obs: SetObs[]) => void
  /** S switched on or off on sets not yet done, kept on the session so it survives leaving Log. */
  spotRows?: Record<string, boolean>; onSpotRow?: (idx: number, on: boolean) => void
  speedBands?: Record<string, BandPick[]>; onSpeedBands?: (exercise: string, bands: BandPick[]) => void
  api: Api; liftLabel: string; L: Ladder | null; D: DeadliftCtl | null; heavyExerciseId?: string; restS: number
  /** Seconds the rest timer allows for each speed set done between heavy sets. */
  speedSetS?: number
  speed: any | null; speedEx: (it: any) => string; speedSets: (it: any) => SetRow[]; order: Block[]; joins: boolean[]; running?: boolean; onPlannedMax?: (v: number | null) => void
  speedMax?: Record<string, number>; supportMax?: Record<string, number>; onApplyFit?: (patch: Record<string, number>) => void
  /** Switch plates on or off for this session (the plate column headings). */
  onPlatesOn?: (on: number[]) => void
  /** Today's fit, handed up so the lifter's numbers can learn from it. */
  onAutoFit?: (fit: { cost: number | null; costN: number; half_s: number | null; halfN: number }) => void
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
  // Auto spotter: rest is the time for creatine to refill from where the last set ended to the recovery target.
  const [capture, setCapture] = useState<{ id: number; pulses: Pulse[]; tempo: Tempo } | null>(null)
  // Rest runs from the end of the last rep: the Tindeq's last spotted rep when it recorded the set (even before the reps are typed), else when the set was logged.
  // It only runs while the workout clock is running (after Start workout, before Finish).
  const lastEnd = lastMain?.setup?.spot?.tempo?.ended_at ?? (lastMain?.setup as any)?.ended_at ?? lastMain?.created_at
  // The Tindeq panel shows whenever any heavy set today is a spotter set (S from the plan, or switched on for one set).
  const spotMode = !!L && (L.plan.spotter || Object.values(spotRows).some(Boolean) || L.logged.some(r => r.setup?.spot?.on))
  // The rest clock restarts only for a heavy set: when it was logged, or from its last rep when a sensor timed that set. A Tindeq reading
  // before the reps are typed counts only on a spotter day; speed and support sets never move it.
  const restFrom = spotMode && capture?.tempo.ended_at && (!lastEnd || capture.tempo.ended_at > lastEnd) ? capture.tempo.ended_at : lastEnd
  const rest = useClock(running ? restFrom : null)
  const lastSpot = lastMain?.setup?.spot?.on ? lastMain : null
  const crRest = (() => {
    if (!L || !lastSpot) return null
    const t = totals(lastSpot.weight_lb, setupOf(lastSpot), equipment)
    const load = t.bottom !== null && t.top !== null ? (t.bottom + t.top) / 2 : 0
    const pulses: Pulse[] | undefined = lastSpot.setup.spot.pulses
    // Only a measured last rep (Tindeq) is used; a hand-typed average says too little about the final rep, so the rep count is used instead.
    const lastAssist = pulses?.length ? pulses.at(-1)!.mean : null
    const Pend = endLevel({ load, totalReps: lastSpot.setup.spot.mode === 'all' ? (lastSpot.reps ?? 0) : (lastSpot.reps ?? 0) + (lastSpot.setup.spot.spotted ?? 0), lastAssist, P0: startLevel(lastSpot.set_index, L.cr) }, L.cr)
    return { seconds: Math.round(restFor(Pend, L.cr)), Pend }
  })()
  // A test set has a deliberate short or long rest before it; otherwise the plan's rest (or the creatine refill after a spotter set).
  const nextMainIdx = (() => { const n = seq.find(x => x.kind === 'main' && !x.r) as Extract<Item, { kind: 'main' }> | undefined; return n?.p?.idx ?? null })()
  const nextProbe = nextMainIdx !== null && lastMain ? probes[nextMainIdx] : undefined
  // Speed sets done between heavy sets need their own time: the target grows by the allowance for each speed set in the round.
  const speedBetween = withHeavy('speed') && lastMain ? (speedRounds[Math.max(0, Math.min(mainSets.length, speedRounds.length) - 1)] ?? []).length : 0
  const speedAllow = speedBetween * speedSetS
  const restBase = nextProbe ? nextProbe.rest_s : crRest ? crRest.seconds : restS
  const restTarget = restBase + speedAllow
  // What today's spotter sets say about the model, against the numbers in use.
  const fit = (() => {
    if (!L) return null
    const ss: SpotSet[] = L.logged.map((r, i) => ({ r, i })).filter(x => x.r.setup?.spot?.on).map(({ r, i }) => {
      const t = totals(r.weight_lb, setupOf(r), equipment)
      const pulses: Pulse[] = r.setup.spot.pulses ?? []
      return { idx: r.set_index, load: t.bottom !== null && t.top !== null ? (t.bottom + t.top) / 2 : 0, e1rm: L.actual[i], unaided: r.setup.spot.mode === 'all' ? Math.max(0, (r.reps ?? 0) - pulses.length) : r.reps ?? 0,
        spotted: r.setup.spot.mode === 'all' ? pulses.length : r.setup.spot.spotted ?? pulses.length, assists: pulses.map(p => p.mean), rest_s: r.rest_s ?? null }
    })
    if (!ss.length) return null
    return fitSession(ss, L.cr, L.plan.fatigue_rate_used_pct / 100)
  })()
  // The session's heavy sets in the form Max learns from: load, reps, estimated max, rest before, and what she predicted.
  const obs: SetObs[] = L ? L.logged.map((r, i) => ({ idx: r.set_index, load: r.total_bottom_lb != null && r.total_top_lb != null ? (r.total_bottom_lb + r.total_top_lb) / 2 : null,
    reps: r.reps, e1rm: L.actual[i], low: L.low[i], rest_s: r.rest_s ?? null, spot: !!r.setup?.spot?.on, pred_reps: r.setup?.pred_reps ?? null })) : []
  const obsKey = JSON.stringify(obs)
  useEffect(() => { if (obs.length) onObs?.(obs) }, [obsKey])
  const miss = predictionMiss(obs)
  const fitKey = fit ? JSON.stringify([fit.cost && Math.round(fit.cost * 1000), fit.costN, fit.half_s && Math.round(fit.half_s), fit.halfN]) : ''
  useEffect(() => { if (fit) onAutoFit?.(fit) }, [fitKey])
  // Column headings stay in view while scrolling the sets: they stick just under the rest bar, whatever its height.
  const cardRef = useRef<HTMLElement>(null), barRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const bar = barRef.current, card = cardRef.current
    if (!bar || !card) return
    const set = () => card.style.setProperty('--sheet-top', `${Math.round(parseFloat(getComputedStyle(bar).top) + bar.offsetHeight)}px`)
    set(); const ro = new ResizeObserver(set); ro.observe(bar); return () => ro.disconnect()
  }, [])
  const nextMain = seq.find(x => (x.kind === 'main' || x.kind === 'pull') && !x.r) as Extract<Item, { kind: 'main' | 'pull' }> | undefined
  // The phone on the bar logs into the next heavy or speed set in the order on the sheet (support has no bar).
  const nextBar = seq.find(x => (x.kind === 'main' || x.kind === 'speed') && !x.r)
  // Squats can have long breaths between reps, so the bar has to rest longer there before the set counts as over.
  const barGap = nextBar?.kind === 'main' && /squat/i.test(liftLabel) ? 12 : 6
  useEffect(() => { imu.setGap(barGap) }, [barGap])

  // Spoken cues: "Ten seconds" before rest is up, "Lift" when it is, "Overtime" a minute later. Each once per rest.
  const said = useRef<{ from: string | null; warn?: boolean; lift?: boolean; over?: boolean }>({ from: null })
  useEffect(() => {
    if (!running || !restFrom || restTarget <= 0) return
    if (said.current.from !== restFrom) said.current = { from: restFrom }
    const S = said.current
    if (restTarget > 15 && rest >= restTarget - 10 && rest < restTarget && !S.warn) { S.warn = true; cue('warn') }
    if (rest >= restTarget && !S.lift) { S.warn = true; S.lift = true; cue('lift') }
    if (rest >= restTarget + 60 && !S.over) { S.over = true; cue('over') }
  }, [rest, restFrom, running, restTarget])
  // After each heavy set is logged: the next weight and rep goal, then the plates and chains. The next set's row publishes these (live.next).
  const announce = (plates: boolean) => {
    const n = live.next
    if (!n || !nextMain) { cue('next', 'Done'); return }
    const say = [...(cueOn('next') ? nextPhrases(n, sayLb) : []), ...(plates && cueOn('plates') ? platePhrases(n) : [])]
    if (say.length) speak(say)
  }
  const loggedHeavy = useRef(mainSets.length)
  useEffect(() => {
    if (mainSets.length > loggedHeavy.current && running) setTimeout(() => announce(true), 400)
    loggedHeavy.current = mainSets.length
  }, [mainSets.length])
  const restLeft = restTarget - rest
  const cmd = useRef({ announce, restLeft, restFrom, running }); cmd.current = { announce, restLeft, restFrom, running }
  useEffect(() => onCommand(c => {
    const { announce, restLeft, restFrom, running } = cmd.current
    if (c.kind === 'next') announce(false)
    else if (c.kind === 'plates') { const n = live.next; if (n) speak(platePhrases(n)) }
    else if (c.kind === 'time') {
      if (!running || !restFrom) cue('lift')
      else speak(restLeft > 0 ? [saySeconds(restLeft), 'seconds'] : [cueWord('over'), saySeconds(-restLeft), 'seconds'])
    }
  }), [])
  // The next spotter set's expected reps follow the rest actually taken: creatine refills along its curve (to full at most) while you rest.
  const liveP0 = running && crRest && L ? Math.round(levelAfter(crRest.Pend, rest, L.cr) * 200) / 200 : null

  // Circuit time: what you entered, or first to last set of the circuit.
  const autoMin = done.length > 1 ? (Date.parse(done.at(-1)!.created_at!) - Date.parse(done[0].created_at!)) / 60000 : null
  const minutes = circuit ?? (autoMin && autoMin > 1 ? Math.round(autoMin) : null)
  const mainCount = mainSets.length
  const perMin = L?.fit && minutes && mainCount ? L.fit.ratePct / (minutes / mainCount) : null
  // Band columns: every band used today (logged or planned speed work), plus any added with "+ band".
  // The phone on the bar scales its speeds to this lift's range of motion from the profile.
  useEffect(() => { imu.setRom(L?.plan.rom_in ? L.plan.rom_in * 0.0254 : null) }, [L?.plan.rom_in])
  const chains = !!(L && L.plan.bar && L.plan.chains_ok)
  // Columns after the set name: lb, Exp, Reps, A·F, e1RM, plates, clamps, chains, bands, rest, delete.
  const cols: Cols = { chains, span: 5 + PLATE_COLS.length + 1 + (chains ? 2 : 0) + 1 + 1 + 1, allBands }
  const slotName = (r: SetRow) => { const it = items.find(i => i.name === r.setup?.slot); return it ? speedEx(it) : r.setup?.slot ?? 'Speed' }

  return (
    <section className="card sheetcard" ref={cardRef}>
      {running && restFrom && restTarget > 0 && <RestOverlay rest={rest} target={restTarget} />}
      <div className="sheetbar" ref={barRef}>
        <div><span className="small muted hastip" data-tip={`Time since the last heavy set / the rest target${speedAllow ? `: ${fmt(restBase)} rest + ${fmt(speedAllow)} for ${speedBetween} speed set${speedBetween > 1 ? 's' : ''} in between` : ''}. Only a heavy set restarts it. Turns green when it's time.`} data-pos="left">Rest</span>{nextProbe && <span className="probetag" data-tip={`Test rest: deliberately ${nextProbe.variant} (${fmt(nextProbe.rest_s)} instead of ${fmt(restS)}) so Max can learn how fast you recover. Lift when it's up. Skip it with the × on the set's row.`} data-pos="left">test · {nextProbe.variant}</span>}<b className={running && lastMain && rest >= restTarget ? 'ready' : ''}>{!running ? <span className="muted" data-tip="Press Start workout to run the rest timer." data-pos="left">— / {fmt(restTarget)}</span> : restFrom ? <>{fmt(rest)} / {fmt(restTarget)}{rest > restTarget && <span className="over" data-tip="Over the rest target. The rest is recorded as taken, and the next spotter set's expected reps allow for the extra recovery." data-pos="left"> +{fmt(rest - restTarget)}</span>}</> : `0:00 / ${fmt(restTarget)}`}</b>{crRest && <span className="small muted" data-tip="Creatine at the end of the last set, and the rest needed to refill it to the target." data-pos="left">creatine {Math.round(crRest.Pend * 100)}% → {Math.round(L!.cr.target * 100)}%</span>}</div>
        <div><span className="small muted hastip" data-tip="The next heavy set still to do." data-pos="left">Next {liftLabel}</span><b>{nextMain ? nextMain.kind === 'main' ? `#${nextMain.p?.idx ?? ''}` : nextMain.row.step : 'done'}</b></div>
        <label className="circuit"><span className="small muted hastip" data-tip="Minutes from the first to the last set of the heavy + speed circuit. Blank uses the logged times; type to override. Used for fatigue per minute." data-pos="right">Circuit min</span>
          <input inputMode="decimal" placeholder={autoMin && autoMin > 1 ? String(Math.round(autoMin)) : ''} defaultValue={circuit ?? ''} key={circuit ?? 'x'}
            onBlur={e => { const v = e.target.value.trim(); onCircuit(v === '' ? null : Number(v)) }} />
        </label>
        <Metronome />
        <VoiceBar />
        <BarPanel />
        <CamPanel />
        {L && <TindeqPanel auto={running} minLb={L!.plan.assist_min_lb} minS={L!.plan.assist_min_s} onCapture={(pulses, tempo) => setCapture({ id: Date.now(), pulses, tempo })} />}
      </div>

      <div className="tablewrap sheetwrap">
        <ProbeCtx.Provider value={{ probes, skip: onSkipProbe }}><SpotCtx.Provider value={{ rows: spotRows, set: onSpotRow }}><RestCtx.Provider value={liveP0}><CaptureCtx.Provider value={capture}><ColsCtx.Provider value={cols}>
        <table className="sheet">
          <thead>
            <tr>
              <th className="stick" data-tip="Grey rows are planned; logging reps saves the set. Tap a set name on narrow screens for plates, chains and bands." data-pos="left">Set</th><th data-tip="Total on the bar: bar + clamps + plates (not chains or bands). Type a total and the plates update." data-pos="left">lb</th><th className="c-exp" data-tip="Reps expected at this weight to hit the set's target max. Under it: logged reps minus expected (green ahead, red behind).">Exp</th><th data-tip="Reps done. The grey number is the rep goal (expected reps rounded down; up with Spotter on).">Reps</th>
              <th>{D ? <span data-tip="Rate of perceived exertion, 1–10. The top single's RPE sets today's deadlift estimate.">RPE</span> : <span data-tip="A = last rep assisted (counts half). F = last rep failed (counts nothing). S = spotter set: Reps holds the unaided reps, with spotted reps and average assist beside it.">A · F · S</span>}</th><th data-tip="Estimated 1-rep max from this set (Epley, chains averaged bottom/top). Grey on planned rows = the target. % = vs set 1. Red row = below the stop line.">e1RM</th>
              {PLATE_COLS.map(p => { const off = !!platesOn && !platesOn.includes(p); return (
                <th key={p} className={'c-plate' + (off ? ' off' : '')}>
                  {onPlatesOn ? <button type="button" className="platehd" aria-pressed={!off}
                    onClick={() => { const cur = platesOn?.length ? platesOn : ALL_PLATES; const next = off ? [...cur, p].sort((a, b) => b - a) : cur.filter(x => x !== p); if (next.length) onPlatesOn(next) }}
                    data-tip={off ? `${p} lb plates are off for this session: Max won't use them. Click to turn on.` : `${p} lb plates per side. Click to turn them off for this session.`} data-pos="below">{p}</button> : p}
                </th>
              ) })}
              <th className="c-setup" data-tip="Clamps on this set. Adding chains switches to the chain clamps; removing them switches back.">Clamps</th>
              {chains && <><th className="c-chain" data-tip="½ in chains per side">½ ch</th><th className="c-chain" data-tip="⅝ in chains per side">⅝ ch</th></>}
              <th className="c-band" data-tip="Bands per side: each chip is one band. + adds another (the same colour is fine); pick “remove” in a chip to take it off." data-pos="right">Bands</th>
              <th className="c-rest num" data-tip="Rest taken before this set (heavy rows), or which heavy set a speed round followed." data-pos="right">Rest</th><th className="c-del" />
            </tr>
          </thead>
          <tbody>
            {seq.map(x => {
              const next = x === nextItem
              if (x.kind === 'main' && L) return <MainTr key={x.key} L={L} api={api} r={x.r} p={x.p} exerciseId={heavyExerciseId} label={liftLabel} next={next} voiceTarget={x === nextMain} autoBar={running && x === nextBar} />
              if (x.kind === 'pull' && D) return <PullTr key={x.key} D={D} def={x.row} r={x.r} next={next} />
              if (x.kind === 'speed') return <SpeedTr key={x.key} api={api} r={x.r} it={x.it} name={speedEx(x.it)} n={x.n} sets={speedSets(x.it)} next={next} lastMain={lastMain} saved={speedBands[speedEx(x.it)]} onBands={onSpeedBands} autoBar={running && x === nextBar} />
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
        </ColsCtx.Provider></CaptureCtx.Provider></RestCtx.Provider></SpotCtx.Provider></ProbeCtx.Provider>
      </div>
      {fit && (fit.cost !== null || fit.half_s !== null) && (
        <p className="small fitline">
          <span className="hastip" data-tip="Fitted from today's spotter sets. Creatine per rep needs Tindeq readings (how fast strength falls rep to rep); recovery half-time comes from how much strength returned over each rest. With two read sets and one measured rest, Max moves the lifter's numbers a quarter of the way toward these (a reading under half or over double is ignored). See Profile → Creatine model." data-pos="left">Model check</span>
          {fit.half_s !== null && <> recovery half-time <b>{Math.round(fit.half_s)} s</b> from {fit.halfN} rest{fit.halfN > 1 ? 's' : ''}</>}
          {fit.cost !== null && <>{fit.half_s !== null ? ' · ' : ' '}creatine per rep <b>{(fit.cost * 100).toFixed(1)}%</b> from {fit.costN} set{fit.costN > 1 ? 's' : ''}</>}
          {' · '}{fitQualifies(fit) ? <>planning with {Math.round(L!.cr.half_s)} s, {(L!.cr.cost * 100).toFixed(1)}% (updated)</> : <span className="muted">needs 2 sets read by the Tindeq and a measured rest to update</span>}
        </p>
      )}
      <p className="small muted sheetfoot">
        <span className="okey"><i className="o-def" />from the plan <i className="o-dyn" />worked out by Max <i className="o-user" />set by you</span>
        {miss ? <span data-tip="How far Max's rep predictions were from what you did, on average, over the sets she predicted today. This is what tells her how well she understands you." data-pos="left">Predictions off by {miss.miss.toFixed(1)} reps over {miss.n} sets · </span> : ''}{L?.fitRep != null ? `Fatigue today ${L.fitRep.toFixed(2)}%/rep (planning with ${perRep(L.plan).toFixed(2)})` : ''}{perMin ? ` · ${perMin.toFixed(2)}%/min over ${minutes} min, ${mainCount} sets` : ''}
        {D?.todayMax ? `Deadlift estimate ${round(D.todayMax)}.` : ''}
      </p>

      <button className="ghost small" onClick={() => S.addExercise()} data-tip="Add a support exercise not in today's plan" data-pos="left">+ Add support exercise</button>
    </section>
  )
}

/* ---------- main lift row (logged or planned) ---------- */

function MainTr({ L, api, r, p, exerciseId, label, next, voiceTarget, autoBar }: {
  L: Ladder; api: Api; r?: SetRow; p?: Ladder['projected'][number]; exerciseId?: string; label: string; next?: boolean
  /** The first heavy set not yet done: spoken reps ("Max five") go here. */
  voiceTarget?: boolean
  /** The workout is running, so a set the phone on the bar sees may be logged by itself. */
  autoBar?: boolean
}) {
  const { equipment: eq, cfg } = useStore()
  const logged = !!r
  const [setup, setSetup] = useState<LoadSetup>(r ? setupOf(r) : p!.setup)
  const [plates, setPlates] = useState<number | null>(r ? r.weight_lb : p!.weight)
  const [reps, setReps] = useState(r?.reps?.toString() ?? '')
  const [a, setA] = useState(!!r?.assisted)
  const [f, setF] = useState(!!r?.failed)
  // S = this set is run with the spotter: Reps holds the unaided reps; spotted reps and their average assist are entered beside it.
  const spotCtx = useContext(SpotCtx), rowIdx = r ? r.set_index : p!.idx
  const probeCtx = useContext(ProbeCtx), probe = !r && rowIdx > 1 ? probeCtx.probes[rowIdx] : undefined
  const planSp = spotCtx.rows[rowIdx] ?? (L.plan.spotter && rowIdx > 1)
  const [sp, setSp] = useState<boolean>(r ? !!r.setup?.spot?.on : planSp)
  const [spotted, setSpotted] = useState<string>(r?.setup?.spot?.spotted?.toString() ?? '')
  const [assist, setAssist] = useState<string>(r?.setup?.spot?.assist_lb?.toString() ?? '')
  const [trace, setTrace] = useState<Pulse[] | null>(r?.setup?.spot?.pulses ?? null)
  const [tempo, setTempo] = useState<Tempo | null>(r?.setup?.spot?.tempo ?? null)
  useEffect(() => { if (!r) setSp(planSp) }, [planSp])
  // Plates typed into the columns, kept as entered until the set is logged (then they're saved on the set).
  const [manual, setManual] = useState<number[] | null>(null)
  // Which of this set's values were typed by hand (the rest are worked out by Max or come from the plan).
  const [mine, setMine] = useState<string[]>(r?.setup?.user ?? [])
  const org = (k: string, other: 'o-dyn' | 'o-def') => (mine.includes(k) ? 'o-user' : other)
  useEffect(() => { if (!r) { setSetup(p!.setup); setPlates(p!.weight); setManual(null); setMine([]) } }, [p?.weight, p?.idx, p && setupKey(p.setup)])
  useEffect(() => { if (r) { setSetup(setupOf(r)); setPlates(r.weight_lb); setReps(r.reps?.toString() ?? ''); setA(r.assisted); setF(r.failed) } }, [r])

  const idx = r ? r.set_index : p!.idx
  const i = r ? L.logged.findIndex(x => x.id === r.id) : -1
  const target = r ? L.targets[i] : p!.target
  const t = totals(plates, setup, eq)
  const repsN = reps === '' ? null : Number(reps)
  const est = e1rm(t.bottom, t.top, repsN, a, f, cfg)
  const exp = target ? expectedReps(target, t.bottom, t.top, cfg) : null
  const diff = exp !== null && repsN !== null ? repsN - lostReps(a, f, cfg) - exp : null
  // The next set to do starts from the creatine level the rest actually reached.
  const liveP0 = useContext(RestCtx)
  // Planned at the recovery target; once the rest runs past it, the extra recovery counts (up to full).
  const P0 = !r && voiceTarget && liveP0 !== null && idx > 1 ? Math.max(liveP0, startLevel(idx, L.cr)) : startLevel(idx, L.cr)
  const eff = t.bottom !== null && t.top !== null ? (t.bottom + t.top) / 2 : null
  // Strength on rep 1 of this set: the target max, moved from the level it was measured at to this set's starting level.
  const measuredAt = idx <= 1 ? 1 : r ? startLevel(idx - 1, L.cr) : L.spotBasis
  const pred = sp && target && eff ? predictSet(eff, target * strengthAt(P0, L.cr) / strengthAt(measuredAt, L.cr), P0, L.cr) : null
  // Spotter set: Max's rep count is every rep until creatine is spent, all of them done with the spotter helping as needed.
  const goal = pred ? pred.unaided + pred.spotted : exp !== null ? repGoal(exp, false) : null
  const pct = est && L.actual[0] ? (est / L.actual[0]) * 100 : null
  const isLow = !!r && L.low[L.logged.indexOf(r)]
  const pastStop = !r && !!target && ((L.floor !== null && target < L.floor) || (L.plan.max_sets != null && idx > L.plan.max_sets))
  const below = L.floor !== null && est !== null && est < L.floor

  async function commit(patch: { setup?: LoadSetup; plates?: number | null; reps?: string; a?: boolean; f?: boolean; stack?: number[] | null; sp?: boolean; spotted?: string; assist?: string; trace?: Pulse[] | null; tempo?: Tempo | null; touch?: string }) {
    const s = patch.setup ?? setup, pl = patch.plates !== undefined ? patch.plates : plates
    const user = patch.touch && !mine.includes(patch.touch) ? [...mine, patch.touch] : mine
    if (user !== mine) setMine(user)
    // The plates actually loaded: as typed, else the planned stack when the weight still matches, else the kept plates plus change.
    const sumSt = (st: number[]) => st.reduce((t, p) => t + p, 0) * 2
    const prevStack: number[] | null = manual ?? (Array.isArray(r?.setup?.stack) ? r!.setup.stack : p?.stack ?? null)
    const stack = !L.plan.bar || pl === null ? null : patch.stack && Math.abs(sumSt(patch.stack) - pl) < 0.01 ? patch.stack
      : prevStack && Math.abs(sumSt(prevStack) - pl) < 0.01 ? prevStack : loadSide(pl / 2, L.kept)
    const rp = patch.reps !== undefined ? patch.reps : reps, aa = patch.a ?? a, ff = patch.f ?? f
    const tt = totals(pl, s, eq)
    const row = { weight_lb: pl, total_bottom_lb: tt.bottom, total_top_lb: tt.top, reps: rp === '' ? null : Number(rp), assisted: aa, failed: ff,
      setup: { ...(r?.setup ?? {}), bar: s.bar, clamp: s.clamp, chain_half: s.chain_half, chain_5_8: s.chain_5_8, rom_in: s.rom_in ?? null, hang_in: s.hang_in ?? null, bands: s.bands ?? [], user,
        stack, kept: r?.setup?.kept ?? (L.plan.bar ? { base: L.kept.base, change: L.kept.change } : null),
        spot: (patch.sp ?? sp) ? { on: true, mode: 'all', spotted: numOrNull(patch.spotted ?? spotted), assist_lb: numOrNull(patch.assist ?? assist), pulses: (patch.trace !== undefined ? patch.trace : trace) ?? undefined, tempo: (patch.tempo !== undefined ? patch.tempo : tempo) ?? undefined } : null } }
    if (r) await api.updateSet(r.id!, row)
    else if (row.reps !== null && exerciseId) {
      const last = L.logged.at(-1)
      // Bar speed: the set the phone on the bar just saw (its reps, speeds and travel) is saved with this set.
      const bar = imu.take(), barSum = bar ? barSummary(bar.reps) : null
      const r3 = (x: number) => Math.round(x * 1000) / 1000
      const saved = await api.addSet({ ...row, exercise_id: exerciseId, block: 'primary', set_index: idx,
        // Rest before this set: from the end of the last one to the start of this one, measured by the Tindeq where it recorded them.
        rest_s: (() => { const from = last?.setup?.spot?.tempo?.ended_at ?? last?.created_at, to = (tempo ?? row.setup.spot?.tempo)?.rec_at
          return from ? Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000) : null })(),
        // What Max predicted for this set and whether it was a test set, saved with it so her predictions can be scored.
        setup: { ...row.setup, target_e1rm: target ?? null, pred_reps: !(patch.sp ?? sp) && exp !== null ? Math.round(exp * 10) / 10 : null, probe: probe ?? null,
          force: (() => { const tr = (patch.trace !== undefined ? patch.trace : trace) ?? []; return !(patch.sp ?? sp) && tr.length ? { n: tr.length, mean_lb: Math.round((tr.reduce((t, x) => t + x.mean, 0) / tr.length) * 10) / 10, peak_lb: Math.round(Math.max(...tr.map(x => x.peak)) * 10) / 10 } : null })(),
          ended_at: bar && bar.reps.length === row.reps ? new Date(bar.ended_ms).toISOString() : null,
          bar_speed: bar && barSum ? { n: barSum.n, first_mps: r3(barSum.first_mps), last_mps: r3(barSum.last_mps), best_mps: r3(barSum.best_mps), loss_pct: Math.round(barSum.loss_pct * 10) / 10, rom_from: bar.reps[0]?.raw_rom_m != null ? 'profile' : 'sensor', unrack_dropped: !!bar.unrack, agrees: bar.reps.length === row.reps, reps: bar.reps.map(x => ({ mean_mps: r3(x.mean_mps), peak_mps: r3(x.peak_mps), rom_m: r3(x.rom_m), dur_s: r3(x.dur_s), ...(x.raw_rom_m != null ? { raw_rom_m: r3(x.raw_rom_m) } : {}) })) } : null } })
      if (saved?.id && saved.session_id && bar) recordObservations(bar.reps.map((x, k) => ({ session_id: saved.session_id!, set_id: saved.id!, rep_index: k + 1, source: 'inertiometer' as const, metric: 'mean_velocity_mps', value: r3(x.mean_mps), data: { peak_mps: r3(x.peak_mps), rom_m: r3(x.rom_m), dur_s: r3(x.dur_s), ...(x.raw_rom_m != null ? { raw_rom_m: r3(x.raw_rom_m) } : {}) } })))
      // The phone's raw readings over the set (the last two minutes), whether or not it read the reps right.
      if (saved?.id && saved.session_id) { const raw = imu.raw(120); if (raw) recordObservations([{ session_id: saved.session_id, set_id: saved.id, source: 'inertiometer' as const, metric: 'raw_accel', value: raw.n, data: { ...raw, typed_reps: row.reps, sensor_reps: bar?.reps.length ?? null } }]) }
      // Film of the set from the laptop camera: the exact set when a sensor timed it, otherwise the last stretch before logging.
      if (saved?.id && saved.session_id) {
        const tm = tempo ?? row.setup.spot?.tempo
        const win = bar ? { from: bar.ended_ms - (bar.ended - bar.started + 8) * 1000, to: Math.min(bar.at, bar.ended_ms + 6000) }
          : tm?.rec_at && tm?.ended_at ? { from: Date.parse(tm.rec_at) - 5000, to: Date.parse(tm.ended_at) + 5000 } : undefined
        camera.saveClip({ session_id: saved.session_id, set_id: saved.id, set_index: idx }, win)
      }
      // Raw Tindeq readings, one row per pull (spotter help when S is on, plain force otherwise), kept for later mining.
      const pulses = (patch.trace !== undefined ? patch.trace : trace) ?? []
      if (saved?.id && saved.session_id && pulses.length) recordObservations(pulses.map((pl, k) => ({ session_id: saved.session_id!, set_id: saved.id!, rep_index: k + 1, source: 'tindeq' as const, metric: (patch.sp ?? sp) ? 'assist_lb' : 'force_lb', value: Math.round(pl.mean * 10) / 10, data: { peak_lb: pl.peak, dur_s: pl.dur, start_s: pl.start } })))
    }
  }
  const setSet = (s: LoadSetup, touch?: string) => {
    setSetup(s)
    if (!r && target) { const w = L.weightFor(target, s, idx, sp); setPlates(w); return commit({ setup: s, plates: w, touch }) }
    return commit({ setup: s, touch })
  }
  // A set recorded on the Tindeq goes to the next set to do: with S on it fills the row's spotted reps and average assist.
  const cap = useContext(CaptureCtx)
  useEffect(() => {
    if (!cap || !next || !cap.pulses.length) return
    // With S off the pulls are not spotter help: they are kept with the set as raw force readings and nothing else changes.
    if (!sp) { if (!r) { setTrace(cap.pulses); setTempo(cap.tempo) } return }
    const n = String(cap.pulses.length), avg = String(Math.round((cap.pulses.reduce((t, x) => t + x.mean, 0) / cap.pulses.length) * 10) / 10)
    setSpotted(n); setAssist(avg); setTrace(cap.pulses); setTempo(cap.tempo)
    if (r) commit({ spotted: n, assist: avg, trace: cap.pulses, tempo: cap.tempo })
  }, [cap?.id])
  // Spoken reps ("Max five") log this set when it's the next one to do.
  const commitRef = useRef(commit); commitRef.current = commit
  // A short wait first, so a spotter set the Tindeq is closing at the same moment fills this row before it's saved.
  useEffect(() => voiceTarget ? onCommand(c => { if (c.kind === 'reps') { const v = String(c.n); setReps(v); cue('ack', v); setTimeout(() => commitRef.current({ reps: v }), 350) } }) : undefined, [voiceTarget])
  // The phone on the bar logs this set by itself when it sees the set end: its rep count goes in, and its speeds are saved with it.
  const tinRef = useRef({ trace, sp }); tinRef.current = { trace, sp }
  useEffect(() => autoBar && !r ? imu.onSet(s => {
    const v = String(s.reps.length); setReps(v); cue('ack', v)
    setTimeout(() => {
      // The Tindeq feels the unrack as a pull too: when the phone left the unrack out and the Tindeq has exactly one pull more, its first goes as well.
      const { trace: tr, sp: spot } = tinRef.current
      if (s.unrack && tr && tr.length === s.reps.length + 1) {
        const t2 = tr.slice(1); setTrace(t2)
        if (spot) { const n = String(t2.length), avg = String(Math.round((t2.reduce((t, x) => t + x.mean, 0) / Math.max(1, t2.length)) * 10) / 10); setSpotted(n); setAssist(avg); commitRef.current({ reps: v, trace: t2, spotted: n, assist: avg }) }
        else commitRef.current({ reps: v, trace: t2 })
      } else commitRef.current({ reps: v })
    }, 350)
  }) : undefined, [autoBar, !r])
  const fixed = fixedWeight(setup, eq)
  const [more, setMore] = useState(false)
  const hasBar = !!L.plan.bar
  const stored: number[] | null = manual ?? (Array.isArray(r?.setup?.stack) ? r!.setup.stack : p?.stack ?? null)
  const stack = hasBar ? stackFor(plates, L.kept, stored, L.plan.plates_on) : null
  // The next set to do tells the voice and the Tindeq about itself: weight, rep goal, plates, chains, and for a spotter set
  // the rep count at which Max says "Rack".
  const nextInfo = voiceTarget && plates !== null ? {
    lb: Math.round((plates + fixed) * 100) / 100, goal, stack: hasBar ? stack : null,
    chains: hasBar && L.plan.chains_ok ? { half: setup.chain_half ?? 0, big: setup.chain_5_8 ?? 0 } : null,
    rackLb: null, rackAt: pred ? goal : null,
  } : null
  useEffect(() => { if (voiceTarget) { live.next = nextInfo; return () => { if (live.next === nextInfo) live.next = null } } })
  const setPlate = (plate: number, n: number) => {
    const next = withCount(stack, plate, n), pl = next.reduce((t, x) => t + x, 0) * 2
    setManual(next); setPlates(pl); commit({ plates: pl, stack: next, touch: 'plates' })
  }
  const keptN = countsOf(L.kept.base)
  const straightClamp = L.plan.clamp || CLAMPS[0][0]
  const setupCell = !hasBar ? <span className="small muted">—</span> : (
    <select className="mini" value={setup.clamp} aria-label="Clamps" onChange={e => setSet({ ...setup, clamp: e.target.value }, 'clamp')}>
      {CLAMPS.map(([v, l]) => <option key={v} value={v}>{v === CHAIN_CLAMP ? 'Chain' : l}</option>)}
      {!CLAMPS.some(c => c[0] === setup.clamp) && <option value={setup.clamp}>{setup.clamp || 'none'}</option>}
    </select>
  )
  // Chains hang from the chain clamps; taking the last chain off goes back to the normal clamps.
  const setChain = (k: 'chain_half' | 'chain_5_8', n: number) => {
    const next = { ...setup, [k]: Math.max(0, Math.round(n)) }
    const any = next.chain_half || next.chain_5_8
    setSet({ ...next, clamp: any ? CHAIN_CLAMP : setup.clamp === CHAIN_CLAMP ? straightClamp : setup.clamp }, 'chains')
  }
  const C = useContext(ColsCtx)

  return (
    <>
    <tr className={(logged ? 'done' : 'plan') + (next ? ' next' : '') + (below ? ' below' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot h" />{label} {idx}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td className={mine.includes('lb') || mine.includes('plates') ? 'o-user' : 'o-dyn'}><CellNum value={plates === null ? null : plates + fixed} onSave={v => { const pl = v === null ? null : Math.max(0, v - fixed); setPlates(pl); commit({ plates: pl, touch: 'lb' }) }} />
        <div className="sub2 side-inline">{hasBar ? sideText(plates, L.kept, undefined, stack) : loadNote(L.plan)}{setup.bands?.length ? ` · ${bandLabel(setup.bands)}` : ''}</div></td>
      <td className="num c-exp o-dyn">{pred ? <span data-tip={`Spotter set: Max's reps for this set, all done with the spotter helping on every rep as needed (until creatine is spent).`} data-pos="center">{pred.unaided + pred.spotted}</span> : exp !== null ? exp.toFixed(1) : ''}{!pred && diff !== null && <div className={'sub2 ' + (diff >= 0 ? 'up' : 'down')} data-tip="Reps done (less any failed rep and the uncredited half of an assisted rep) minus expected.">{diff >= 0 ? '+' : ''}{diff.toFixed(1)}</div>}</td>
      <td className="o-user ph-dyn"><CellText value={reps} narrow placeholder={goal !== null ? String(goal) : ''} numeric onSave={v => { setReps(v); commit({ reps: v }) }} />
        {sp && <div className="spotin" data-tip="Average help per rep in lb. The Tindeq fills it when it reads the set; otherwise type your best guess or leave it." data-pos="left">
          <span className="small muted">avg help</span><CellText value={assist} narrow numeric placeholder="lb" onSave={v => { setAssist(v); commit({ assist: v }) }} />
        </div>}</td>
      <td className="nowrap">
        <button className={'flag' + (a ? ' on' : '')} data-tip="Assisted: last rep had help (counts half)" aria-label="Assisted" aria-pressed={a} onClick={() => { setA(!a); if (r) commit({ a: !a }) }}>A</button>
        <button className={'flag' + (f ? ' on' : '')} data-tip="Failed: last rep missed (counts nothing)" aria-label="Failed" aria-pressed={f} onClick={() => { setF(!f); if (r) commit({ f: !f }) }}>F</button>
        <button className={'flag s' + (sp ? ' on' : '')} data-tip="Spotter set: Max sets the reps and the spotter helps on every rep as needed. Reps = all reps done." aria-label="Spotter set" aria-pressed={sp} onClick={() => { setSp(!sp); if (r) commit({ sp: !sp }); else spotCtx.set?.(idx, !sp) }}>S</button>
      </td>
      <td className="num"><b>{logged || repsN !== null ? round(est) : target ? <span className="muted">{round(target)}</span> : ''}</b>
        {pct !== null && (logged || repsN !== null) && <div className="sub2" data-tip="This set's estimated max as % of set 1's. The stop line is at the Plan's stop %." data-pos="right">{round(pct)}%</div>}
        {r?.setup?.bar_speed && r.setup.bar_speed.agrees !== false && r.setup.bar_speed.n === r.reps && <div className="sub2 barspeed" data-tip={`Bar speed from the phone: ${r.setup.bar_speed.n} reps seen. Average speed up per rep: ${r.setup.bar_speed.reps.map((x: any) => x.mean_mps.toFixed(2)).join(', ')} m/s.`} data-pos="right">{r.setup.bar_speed.first_mps.toFixed(2)} m/s {r.setup.bar_speed.n > 1 ? `· −${Math.max(0, Math.round(r.setup.bar_speed.loss_pct))}%` : ''}</div>}
        {isLow && <div className="sub2 lowset" data-tip="Low set: under half the reps Max expected at this weight. It's kept as logged, but the next sets are planned from the last good set, not this one." data-pos="right">low</div>}
        {pastStop && <div className="sub2 muted" data-tip="Past the stop line (or the max sets). Max would stop here; this row is open so another set can still be logged." data-pos="right">past stop</div>}</td>
      {hasBar ? <PlateCells stack={stack} on={L.plan.plates_on} onSet={setPlate} keptN={keptN} origin={mine.includes('plates') ? 'o-user' : 'o-dyn'} />
        : <td colSpan={PLATE_COLS.length} className="c-plate small muted">{loadNote(L.plan)}</td>}
      <td className={'c-setup ' + org('clamp', 'o-def')}>{setupCell}</td>
      <ChainCells half={setup.chain_half} big={setup.chain_5_8} onSet={hasBar && L.plan.chains_ok ? setChain : undefined} origin={org('chains', 'o-def')} />
      <td className="c-band"><BandEditor bands={setup.bands ?? []} onChange={bb => setSet({ ...setup, bands: bb })} /></td>
      <td className="num muted c-rest">{r?.rest_s ? fmt(r.rest_s) : ''}
        {r?.setup?.probe && <div className="probetag" data-tip={`Test set: the rest before it was deliberately ${r.setup.probe.variant} (${fmt(r.setup.probe.rest_s)}).`} data-pos="right">test</div>}
        {!r && probe && <div className="probetag" data-tip={`Test set: rest ${fmt(probe.rest_s)} before this one (deliberately ${probe.variant}) so Max can learn how fast you recover. × skips the test and uses the normal rest.`} data-pos="right">test {fmt(probe.rest_s)} <button type="button" className="probex" aria-label="Skip this test" onClick={() => probeCtx.skip?.(idx)}>×</button></div>}</td>
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

function SpeedTr({ api, r, it, name, n, sets, next, lastMain, saved, onBands, autoBar }: {
  api: Api; r?: SetRow; it: any; name: string; n: number; sets: SetRow[]; next?: boolean; lastMain?: SetRow
  /** The workout is running and this is the next set on the sheet, so a set the phone on the bar sees is logged here by itself. */
  autoBar?: boolean
  /** The bands this lifter last used on this exercise (Profile), and where to save a change. */
  saved?: BandPick[]; onBands?: (exercise: string, bands: BandPick[]) => void
}) {
  const { equipment: eq } = useStore()
  const C = useContext(ColsCtx)
  const prev = r ? undefined : sets.at(-1)
  const lower = name.toLowerCase()
  const isBench = lower.includes('banded bench')
  const src = r?.setup ?? prev?.setup ?? {}
  // Bands: this set's, else the last set today, else what this lifter last used on this exercise, else the Plan's.
  const defBands: BandPick[] = bandsOf(src).length ? bandsOf(src) : saved?.length ? saved : it.band ? [{ name: eq.find(e => e.kind === 'band' && e.name.startsWith('Rogue band ' + String(it.band).split(' ')[0]))?.name ?? 'Rogue band ' + String(it.band).split(' ')[0], per_side: it.bands_per_side ?? 1 }] : []
  const planLoad: number | null = it.load_lb ?? (isBench ? n0(eq.find(e => e.name === LIGHT_BAR)?.weight_lb) || 5 : null)
  const [load, setLoad] = useState<number | null>(r?.weight_lb ?? prev?.weight_lb ?? planLoad)
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
      // Bar speed from the phone on the bar. Speed work has its own travel, so the readings are kept as the sensor measured them
      // (not scaled to the heavy lift's range of motion).
      const bar = imu.take()
      const raw = bar ? bar.reps.map(x => { const rom = x.raw_rom_m ?? x.rom_m, k = rom / x.rom_m; return { mean_mps: rom / x.dur_s, peak_mps: x.peak_mps * k, rom_m: rom, dur_s: x.dur_s } }) : []
      const r3 = (x: number) => Math.round(x * 1000) / 1000
      if (bar && raw.length) Object.assign(setup, {
        bar_speed: { n: raw.length, best_mps: r3(Math.max(...raw.map(x => x.mean_mps))), peak_mps: r3(Math.max(...raw.map(x => x.peak_mps))), first_mps: r3(raw[0].mean_mps), last_mps: r3(raw.at(-1)!.mean_mps), rom_from: 'sensor', unrack_dropped: !!bar.unrack, agrees: raw.length === row.reps,
          reps: raw.map(x => ({ mean_mps: r3(x.mean_mps), peak_mps: r3(x.peak_mps), rom_m: r3(x.rom_m), dur_s: r3(x.dur_s) })) } })
      const saved = await api.addSet({ ...row, exercise_id: id, block: 'speed', set_index: n, total_bottom_lb: null, total_top_lb: null, assisted: false, failed: false })
      onBands?.(name, bb)
      if (saved?.id && saved.session_id && bar) {
        recordObservations(raw.map((x, k) => ({ session_id: saved.session_id!, set_id: saved.id!, rep_index: k + 1, source: 'inertiometer' as const, metric: 'mean_velocity_mps', value: r3(x.mean_mps), data: { peak_mps: r3(x.peak_mps), rom_m: r3(x.rom_m), dur_s: r3(x.dur_s) } })))
      }
      if (saved?.id && saved.session_id) { const rw = imu.raw(90); if (rw) recordObservations([{ session_id: saved.session_id, set_id: saved.id, source: 'inertiometer' as const, metric: 'raw_accel', value: rw.n, data: { ...rw, typed_reps: row.reps, sensor_reps: bar?.reps.length ?? null } }]) }
    }
  }
  // The phone on the bar logs this set by itself when it is the next one on the sheet.
  const commitRef = useRef(commit); commitRef.current = commit
  useEffect(() => autoBar && !r ? imu.onSet(s => { const v = String(s.reps.length); setReps(v); cue('ack', v); setTimeout(() => commitRef.current({ reps: v }), 350) }) : undefined, [autoBar, !r])
  const bs = r?.setup?.bar_speed as { best_mps?: number; peak_mps?: number } | undefined

  return (
    <>
      <tr className={(r ? 'done' : 'plan') + (next ? ' next' : '') + ' speed'}>
        <td className="stick" onClick={() => setOpen(o => !o)}><span className="tagdot s" />{name} {n}<span className="moretoggle">{open ? '▴' : '▾'}</span></td>
        <td className={load !== null && load !== planLoad ? 'o-user' : 'o-def'}><CellNum value={load} onSave={v => { setLoad(v); commit({ load: v }) }} />
          {bands.length > 0 && <div className="sub2 side-inline">{bandLabel(bands)}</div>}</td>
        <td className="c-exp" />
        <td className="o-user ph-def"><CellText value={reps} narrow numeric placeholder={it.reps ? String(it.reps) : ''} onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
        <td />
        <td className="num">{bs?.best_mps && (bs as any).agrees !== false ? <div className="barspeed" data-tip="From the phone on the bar: the fastest rep's average speed up, and the highest speed reached." data-pos="center">{bs.best_mps.toFixed(2)} m/s{bs.peak_mps ? ` · peak ${bs.peak_mps.toFixed(2)}` : ''}</div> : null}</td>
        <td colSpan={PLATE_COLS.length} className="c-plate" />
        <td className="c-setup" />
        <ChainCells half={0} big={0} />
        <td className="c-band"><BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }); onBands?.(name, bb) }} /></td>
        <td className="num muted c-rest">{r?.setup?.after_heavy ? `after ${r.setup.after_heavy}` : ''}</td>
        <td className="c-del">{r && <DelBtn tip="Delete this logged set" onConfirm={() => api.deleteSet(r.id!)} />}</td>
      </tr>
      {open && (
        <tr className="morerow"><td className="stick" /><td colSpan={C.span}>
          <div className="morebox">
            <label className="wide">Bands per side<BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }); onBands?.(name, bb) }} /></label>
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
  const adding = useRef<Promise<any> | null>(null), made = useRef<string | null>(null)
  const [v, setV] = useState(init)
  useEffect(() => { setV(init()); if (!e) made.current = null }, [e?.id, e?.exercise_id, e?.reps, e ? '' : slot.exerciseId, e ? '' : d.start_lb])
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
    // A second field typed while the first is still being saved must update that same set, not log another.
    if (!e?.id && adding.current) made.current = (await adding.current)?.id ?? made.current
    const id = e?.id ?? made.current
    if (id) await api.updateSet(id, patch)
    else if (patch.start_weight_lb !== null || patch.reps !== null || patch.notes) {
      adding.current = api.addSet({ ...patch, block: 'support', set_index: slot.setIndex, weight_lb: null, total_bottom_lb: null, total_top_lb: null, assisted: false, failed: false })
      const row = await adding.current
      adding.current = null
      if (row) { made.current = row.id ?? null; S.saved(slot) }
    }
  }
  const field = (k: keyof ReturnType<typeof init>, narrow = true, numeric = true) => (
    <CellText value={v[k]} narrow={narrow} numeric={numeric} onSave={x => { const nv = { ...v, [k]: x }; setV(nv); save(nv) }} />
  )
  const [more, setMore] = useState(false)
  // Grey while it still matches the plan's value; white once it's been changed.
  const so = (k: 'start' | 'step' | 'drops', planned: any) => (v[k] !== '' && v[k] === String(planned ?? '') ? 'o-def' : 'o-user')
  const scheme = <SchemePicker value={v.scheme} options={schemeOptions} onChange={scheme => { const nv = { ...v, scheme }; setV(nv); save(nv) }} />
  const note = <CellText value={v.notes} placeholder={d.note ? 'see plan note' : 'note'} wide onSave={x => { const nv = { ...v, notes: x }; setV(nv); save(nv) }} />
  if (inline) return (
    <tr className={(e && e.reps != null ? 'done' : 'plan') + ' supinline' + (more ? ' open' : '') + (next ? ' next' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot u" />{exercises.find(x => x.id === v.ex)?.name ?? 'Support'}{slot.setIndex > 1 ? ` · set ${slot.setIndex}` : ''}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td colSpan={C.span}>
        <div className="supfields">
          <label className="exfield" data-tip="The exercise for this set only. Change the day's exercise in the plan panel.">Exercise
            <select className="mini" value={v.ex} onChange={ev => { const nv = { ...v, ex: ev.target.value }; setV(nv); save(nv) }}>
              <option value="">choose…</option>
              {exercises.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className={so('start', d.start_lb)} data-tip="Starting weight (the first, heaviest load).">Start{field('start')}</label>
          <label className="o-user" data-tip="Reps at the start weight.">Reps{field('reps')}</label>
          <label className="opt" data-tip="Reps at each drop, e.g. 3 or 3,3,4.">Each drop{field('each', true, false)}</label>
          <label className="opt" data-tip="Reps at the last drop.">Final{field('final')}</label>
          <div className="field opt"><span className="flabel">Scheme</span>{scheme}</div>
          <label className={'opt ' + so('step', d.step_lb)} data-tip="Weight removed at each drop.">Step{field('step')}</label>
          <label className={'opt ' + so('drops', d.drops)} data-tip="Number of drops after the start weight.">Drops{field('drops')}</label>
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
