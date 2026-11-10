import { Fragment, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { e1rm, e1rmFromRpe, expectedReps, loadSide, platesPerSide, round, totals, type Kept, type LoadSetup } from '../../lib/load'
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
const sideText = (plates: number | null, kept?: Kept, on?: number[]) => {
  if (plates === null || plates < 0) return ''
  if (plates === 0) return '—'
  const stack = kept ? loadSide(plates / 2, kept) : null
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

/* ---------- the order of rows: main set, then one round of speed, then main... ---------- */

type Planned =
  | { kind: 'main'; key: string; p: Ladder['projected'][number] }
  | { kind: 'pull'; key: string; row: PullRowDef }
  | { kind: 'speed'; key: string; it: any; n: number }

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

export default function SessionSheet({ api, liftLabel, L, D, heavyExerciseId, restS, speed, speedEx, speedSets, placement, S, circuit, onCircuit }: {
  api: Api; liftLabel: string; L: Ladder | null; D: DeadliftCtl | null; heavyExerciseId?: string; restS: number
  speed: any | null; speedEx: (it: any) => string; speedSets: (it: any) => SetRow[]; placement: Placement
  S: SupportCtl; circuit: number | null; onCircuit: (min: number | null) => void
}) {
  const items: any[] = speed?.items ?? []
  const allSpeed = items.flatMap(it => speedSets(it))
  const mainSets = L ? L.logged : (D?.rows.map(r => r.existing).filter(Boolean) as SetRow[]) ?? []
  const done = useMemo(() => [...mainSets, ...allSpeed].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')), [mainSets, allSpeed])
  const mainPlanned: Planned[] = L
    ? L.projected.map(p => ({ kind: 'main', key: 'h' + p.idx, p }))
    : (D?.rows ?? []).filter(r => !r.existing).map(r => ({ kind: 'pull', key: 'd:' + r.row.step, row: r.row }))
  const planned = plannedOrder(done, mainPlanned, items, speedSets, placement)
  const lastMain = [...done].reverse().find(isMain)
  const rest = useClock(lastMain?.created_at)
  const nextMain = planned.find(p => p.kind !== 'speed')

  // Circuit time: what you entered, or first to last set of the circuit.
  const autoMin = done.length > 1 ? (Date.parse(done.at(-1)!.created_at!) - Date.parse(done[0].created_at!)) / 60000 : null
  const minutes = circuit ?? (autoMin && autoMin > 1 ? Math.round(autoMin) : null)
  const mainCount = mainSets.length
  const perMin = L?.fit && minutes && mainCount ? L.fit.ratePct / (minutes / mainCount) : null
  const slotName = (r: SetRow) => { const it = items.find(i => i.name === r.setup?.slot); return it ? speedEx(it) : r.setup?.slot ?? 'Speed' }

  return (
    <section className="card sheetcard">
      <div className="sheetbar">
        <div><span className="small muted">Rest</span><b className={lastMain && rest >= restS ? 'ready' : ''}>{lastMain ? `${fmt(rest)} / ${fmt(restS)}` : '—'}</b></div>
        <div><span className="small muted">Next {liftLabel}</span><b>{nextMain ? nextMain.kind === 'main' ? `#${nextMain.p.idx}` : nextMain.row.step : 'done'}</b></div>
        <label className="circuit"><span className="small muted">Circuit min</span>
          <input inputMode="decimal" placeholder={autoMin && autoMin > 1 ? String(Math.round(autoMin)) : ''} defaultValue={circuit ?? ''} key={circuit ?? 'x'}
            onBlur={e => { const v = e.target.value.trim(); onCircuit(v === '' ? null : Number(v)) }} />
        </label>
      </div>

      <div className="tablewrap">
        <table className="sheet">
          <thead>
            <tr>
              <th className="stick">Set</th><th>lb</th><th>Reps</th><th>{D ? 'RPE' : 'A · F'}</th><th className="c-side">Per side</th><th className="c-setup">Setup</th>
              <th className="c-exp">Exp ±</th><th>e1RM</th><th className="c-rest">Rest</th>
            </tr>
          </thead>
          <tbody>
            {done.map(r => r.block === 'primary' && L ? <MainTr key={r.id} L={L} api={api} r={r} exerciseId={heavyExerciseId} label={liftLabel} />
              : r.block === 'deadlift' && D ? <PullTr key={r.id} D={D} def={D.rows.find(x => x.existing?.id === r.id)!.row} r={r} />
                : <SpeedTr key={r.id} api={api} r={r} it={items.find(i => i.name === r.setup?.slot) ?? { name: r.setup?.slot }} name={slotName(r)} n={r.set_index} sets={[]} />)}
            {planned.map((p, i) => p.kind === 'main' && L ? <MainTr key={p.key} L={L} api={api} p={p.p} exerciseId={heavyExerciseId} label={liftLabel} next={i === 0} />
              : p.kind === 'pull' && D ? <PullTr key={p.key} D={D} def={p.row} next={i === 0} />
                : p.kind === 'speed' ? <SpeedTr key={p.key} api={api} it={p.it} name={speedEx(p.it)} n={p.n} sets={speedSets(p.it)} next={i === 0} lastMain={lastMain} /> : null)}
          </tbody>
        </table>
      </div>
      <p className="small muted sheetfoot">
        Grey rows are the plan; type reps in one to log it. {L?.floor ? `Stop line ${round(L.floor)}. ` : ''}
        {L?.fit ? `Fatigue ${L.fit.ratePct.toFixed(2)}%/set` : ''}{perMin ? ` · ${perMin.toFixed(2)}%/min over ${minutes} min, ${mainCount} sets` : ''}
        {D?.todayMax ? `Deadlift estimate ${round(D.todayMax)}.` : ''}
      </p>

      <SupportTable S={S} api={api} />
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
  useEffect(() => { if (!r) { setSetup(p!.setup); setPlates(p!.weight) } }, [p?.weight, p?.idx, p && setupKey(p.setup)])
  useEffect(() => { if (r) { setSetup(setupOf(r)); setPlates(r.weight_lb); setReps(r.reps?.toString() ?? ''); setA(r.assisted); setF(r.failed) } }, [r])

  const idx = r ? r.set_index : p!.idx
  const i = r ? L.logged.findIndex(x => x.id === r.id) : -1
  const target = r ? L.targets[i] : p!.target
  const t = totals(plates, setup, eq)
  const repsN = reps === '' ? null : Number(reps)
  const est = e1rm(t.bottom, t.top, repsN, a || f, cfg)
  const exp = target ? expectedReps(target, t.bottom, t.top, cfg) : null
  const diff = exp !== null && repsN !== null ? repsN - (a || f ? 1 : 0) - exp : null
  const pct = est && L.actual[0] ? (est / L.actual[0]) * 100 : null
  const below = L.floor !== null && est !== null && est < L.floor

  async function commit(patch: { setup?: LoadSetup; plates?: number | null; reps?: string; a?: boolean; f?: boolean }) {
    const s = patch.setup ?? setup, pl = patch.plates !== undefined ? patch.plates : plates
    const rp = patch.reps !== undefined ? patch.reps : reps, aa = patch.a ?? a, ff = patch.f ?? f
    const tt = totals(pl, s, eq)
    const row = { weight_lb: pl, total_bottom_lb: tt.bottom, total_top_lb: tt.top, reps: rp === '' ? null : Number(rp), assisted: aa, failed: ff,
      setup: { ...(r?.setup ?? {}), bar: s.bar, clamp: s.clamp, chain_half: s.chain_half, chain_5_8: s.chain_5_8, rom_in: s.rom_in ?? null, hang_in: s.hang_in ?? null } }
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
  const sideCell = !hasBar ? <span className="small muted">{loadNote(L.plan)}</span> : <CellText value={sideText(plates, L.kept)} wide onSave={v => { const sd = parseSide(v); if (sd === null) return; setPlates(sd * 2); commit({ plates: sd * 2 }) }} />
  const setupCell = !hasBar ? <span className="small muted">—</span> : (
    <select className="mini setupsel" value={setupValue(setup)} onChange={e => setSet(parseSetupValue(e.target.value, setup))} aria-label="Clamps and chains">
      {setupOptions(setup).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )

  return (
    <>
    <tr className={(logged ? 'done' : 'plan') + (next ? ' next' : '') + (below ? ' below' : '')}>
      <td className="stick" onClick={() => setMore(m => !m)}><span className="tagdot h" />{label} {idx}<span className="moretoggle">{more ? '▴' : '▾'}</span></td>
      <td><CellNum value={plates === null ? null : plates + fixed} onSave={v => { const pl = v === null ? null : Math.max(0, v - fixed); setPlates(pl); commit({ plates: pl }) }} />
        <div className="sub2 side-inline">{hasBar ? sideText(plates, L.kept) : loadNote(L.plan)}</div></td>
      <td><CellText value={reps} narrow placeholder={exp !== null ? exp.toFixed(0) : ''} numeric onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
      <td className="nowrap">
        <button className={'flag' + (a ? ' on' : '')} onClick={() => { setA(!a); if (r) commit({ a: !a }) }}>A</button>
        <button className={'flag' + (f ? ' on' : '')} onClick={() => { setF(!f); if (r) commit({ f: !f }) }}>F</button>
      </td>
      <td className="c-side">{sideCell}</td>
      <td className="c-setup">{setupCell}</td>
      <td className="num c-exp">{exp !== null ? exp.toFixed(1) : ''}{diff !== null && <div className={'sub2 ' + (diff >= 0 ? 'up' : 'down')}>{diff >= 0 ? '+' : ''}{diff.toFixed(1)}</div>}</td>
      <td className="num"><b>{logged || repsN !== null ? round(est) : target ? <span className="muted">{round(target)}</span> : ''}</b>
        {pct !== null && (logged || repsN !== null) && <div className="sub2">{round(pct)}%</div>}</td>
      <td className="num muted c-rest">{r?.rest_s ? fmt(r.rest_s) : ''}{logged && <button className="x" onClick={() => api.deleteSet(r!.id!)} aria-label="Delete set">×</button>}</td>
    </tr>
    {more && (
      <tr className="morerow"><td className="stick" /><td colSpan={8}>
        <div className="morebox">
          <label>Per side{sideCell}</label>
          <label>Setup{setupCell}</label>
          {exp !== null && <span className="small muted">Expect {exp.toFixed(1)} reps{diff !== null ? ` (${diff >= 0 ? '+' : ''}${diff.toFixed(1)})` : ''}</span>}
          {r?.rest_s ? <span className="small muted">Rest {fmt(r.rest_s)}</span> : null}
          {logged && <button className="ghost small" onClick={() => api.deleteSet(r!.id!)}>Delete set</button>}
        </div>
      </td></tr>
    )}
    </>
  )
}

const LOAD_NOTE: Record<string, string> = { added: 'added weight', per_hand: 'per hand', stack: 'machine stack', bodyweight: 'bodyweight +' }
const loadNote = (p: { bar: string | null; load?: string }) => (p.bar ? '' : LOAD_NOTE[p.load ?? 'added'] ?? 'load')

/* Clamps and chains as one choice: straight sets on Rogue or Eleiko, chain sets on the chain clamps. */
const CHAIN_COMBOS: [number, number][] = [[0, 1], [1, 0], [1, 1], [0, 2], [2, 0], [2, 1], [1, 2], [2, 2]]
const comboLabel = (h: number, b: number) => [h ? `½×${h}` : '', b ? `⅝×${b}` : ''].filter(Boolean).join(' + ')
function setupOptions(cur: LoadSetup): [string, string][] {
  const opts: [string, string][] = CLAMPS.filter(c => c[0] !== CHAIN_CLAMP).map(([v, l]) => [`${v}|0|0`, `${l}, straight`])
  for (const [h, b] of CHAIN_COMBOS) opts.push([`${CHAIN_CLAMP}|${h}|${b}`, comboLabel(h, b)])
  const v = setupValue(cur)
  if (!opts.some(o => o[0] === v)) opts.push([v, `${CLAMPS.find(c => c[0] === cur.clamp)?.[1] ?? cur.clamp}${cur.chain_half || cur.chain_5_8 ? ', ' + comboLabel(cur.chain_half, cur.chain_5_8) : ''}`])
  return opts
}
const setupValue = (s: LoadSetup) => `${s.clamp}|${s.chain_half}|${s.chain_5_8}`
function parseSetupValue(v: string, cur: LoadSetup): LoadSetup {
  const [clamp, h, b] = v.split('|')
  return { ...cur, clamp, chain_half: Number(h), chain_5_8: Number(b) }
}
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
  useEffect(() => { if (!r) setW(def.weight) }, [def.weight])
  async function commit(p: { w?: number | null; reps?: string; rpe?: string; inertia?: string; peak?: string }) {
    const ww = p.w !== undefined ? p.w : w, rp = p.reps ?? reps, rr = p.rpe ?? rpe, ii = p.inertia ?? inertia, pk = p.peak ?? peak
    const weight = fly ? null : ww
    const row: Partial<SetRow> = { weight_lb: weight, total_bottom_lb: weight, total_top_lb: weight, reps: rp === '' ? null : Number(rp), rpe: rr === '' ? null : Number(rr),
      setup: { ...(r?.setup ?? {}), step: def.step, bar_lb: bar, ...(fly ? { inertia: ii || null, peak: pk === '' ? null : Number(pk) } : {}) } }
    if (r) await D.api.updateSet(r.id!, row)
    else if (row.reps !== null) await D.api.addSet({ ...(row as any), exercise_id: D.api.exId(def.ex === 'Deadlift' ? D.main : def.ex)!, block: 'deadlift', set_index: def.idx, assisted: false, failed: false })
  }
  const est = !fly && w && reps ? e1rmFromRpe(w, Number(reps), rpe === '' ? null : Number(rpe)) : null
  return (
    <tr className={(r ? 'done' : 'plan') + (next ? ' next' : '')}>
      <td className="stick"><span className="tagdot h" />{def.step}</td>
      <td>{fly ? <CellText value={inertia} placeholder="inertia" onSave={v => { setInertia(v); commit({ inertia: v }) }} />
        : <CellNum value={w} onSave={v => { setW(v); commit({ w: v }) }} />}
        {!fly && <div className="sub2 side-inline">{sideText(w === null ? null : w - bar, undefined, D.plan.plates_on)}{def.pct ? ` · ${def.pct}%` : ''}</div>}</td>
      <td><CellText value={reps} narrow numeric placeholder={String(def.reps)} onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
      <td>{def.rpe ? <CellText value={rpe} narrow numeric onSave={v => { setRpe(v); commit({ rpe: v }) }} /> : null}</td>
      <td className="c-side"><CellText value={fly ? '' : sideText(w === null ? null : w - bar, undefined, D.plan.plates_on)} wide onSave={v => { const sd = parseSide(v); if (sd === null) return; const nw = sd * 2 + bar; setW(nw); commit({ w: nw }) }} /></td>
      <td className="small muted nowrap c-setup">{fly
        ? <CellText value={peak} narrow numeric placeholder="peak" onSave={v => { setPeak(v); commit({ peak: v }) }} />
        : <>{def.pct ? `${def.pct}% · ` : ''}goal {def.reps}{def.setup ? ` · ${def.setup}` : ''}</>}</td>
      <td className="c-exp" /><td className="num"><b>{est ? round(est) : ''}</b></td>
      <td className="num c-rest">{r && <button className="x" onClick={() => D.api.deleteSet(r.id!)} aria-label="Delete set">×</button>}</td>
    </tr>
  )
}

/* ---------- speed row ---------- */

function SpeedTr({ api, r, it, name, n, sets, next, lastMain }: {
  api: Api; r?: SetRow; it: any; name: string; n: number; sets: SetRow[]; next?: boolean; lastMain?: SetRow
}) {
  const { equipment: eq } = useStore()
  const prev = r ? undefined : sets.at(-1)
  const lower = name.toLowerCase()
  const banded = lower.includes('band') || lower.includes('jump')
  const isBench = lower.includes('banded bench')
  const src = r?.setup ?? prev?.setup ?? {}
  const defBands: BandPick[] = bandsOf(src).length ? bandsOf(src) : it.band ? [{ name: 'Rogue band ' + String(it.band).split(' ')[0], per_side: it.bands_per_side ?? 1 }] : []
  const [load, setLoad] = useState<number | null>(r?.weight_lb ?? prev?.weight_lb ?? it.load_lb ?? (isBench ? n0(eq.find(e => e.name === LIGHT_BAR)?.weight_lb) || 5 : null))
  const [bands, setBands] = useState<BandPick[]>(defBands)
  const [reps, setReps] = useState(r?.reps?.toString() ?? '')
  const [hits, setHits] = useState(r?.setup?.bell_hits?.toString() ?? '')
  const [string, setString] = useState(src.string_in?.toString() ?? '')
  const [open, setOpen] = useState(false)
  const ten = bandTension(bands, eq)

  async function commit(p: { load?: number | null; bands?: BandPick[]; reps?: string; hits?: string; string?: string }) {
    const bb = p.bands ?? bands, rp = p.reps ?? reps, hh = p.hits ?? hits, ss = p.string ?? string
    const tt = bandTension(bb, eq)
    const setup: Record<string, any> = { ...(r?.setup ?? {}), slot: it.name }
    if (banded) Object.assign(setup, { bands: bb, lockout_per_side_lb: tt.perSide, lockout_lb: tt.total, chest_lb: 0 })
    if (isBench) Object.assign(setup, { bar: LIGHT_BAR, bell_hits: hh === '' ? null : Number(hh), string_in: ss === '' ? null : Number(ss) })
    if (lower.includes('throw')) setup.bell_reps_of = 7
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
        <td className="stick" onClick={() => banded && setOpen(o => !o)}><span className="tagdot s" />{name} {n}{banded && <span className="moretoggle">{open ? '▴' : '▾'}</span>}</td>
        <td><CellNum value={load} onSave={v => { setLoad(v); commit({ load: v }) }} /></td>
        <td><CellText value={reps} narrow numeric placeholder={it.reps ? String(it.reps) : ''} onSave={v => { setReps(v); commit({ reps: v }) }} /></td>
        <td>{isBench ? <CellText value={hits} narrow numeric placeholder="bell" onSave={v => { setHits(v); commit({ hits: v }) }} /> : null}</td>
        <td className="small muted c-side">{banded ? `${round(ten.perSide, 1)}/side` : ''}</td>
        <td className="c-setup">{banded ? <button className="linkish" onClick={() => setOpen(o => !o)}>{bandLabel(bands)} ✎</button> : <span className="small muted">{lower.includes('throw') ? 'reps = bell hits /7' : ''}</span>}</td>
        <td className="c-exp" /><td />
        <td className="num muted c-rest">{r?.setup?.after_heavy ? `after ${r.setup.after_heavy}` : ''}{r && <button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button>}</td>
      </tr>
      {open && banded && (
        <tr className="bandrow"><td className="stick" /><td colSpan={8}>
          <p className="small side-inline">{bandLabel(bands)}</p>
          <BandEditor bands={bands} onChange={bb => { setBands(bb); commit({ bands: bb }) }} />
          <p className="small muted">Lockout {round(ten.perSide, 1)} lb per side, {round(ten.total, 1)} lb total · 0 at chest (anchor gap set for zero tension on the safeties).</p>
          {isBench && <label className="inline">Bell string (in) <CellText value={string} narrow numeric onSave={v => { setString(v); commit({ string: v }) }} /></label>}
        </td></tr>
      )}
    </>
  )
}

function BandEditor({ bands, onChange }: { bands: BandPick[]; onChange: (b: BandPick[]) => void }) {
  const { equipment } = useStore()
  const all = equipment.filter(e => e.kind === 'band')
  return (
    <div className="bandedit">
      {bands.map((b, i) => (
        <div key={i} className="row">
          <select value={b.name} onChange={e => onChange(bands.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}>
            {all.map(e => <option key={e.id} value={e.name}>{e.name.replace('Rogue band ', '')} ({e.props?.one_band_lockout_lb} lb)</option>)}
          </select>
          <select value={b.per_side} onChange={e => onChange(bands.map((x, j) => j === i ? { ...x, per_side: Number(e.target.value) } : x))} aria-label="Per side">
            {[1, 2, 3].map(v => <option key={v} value={v}>×{v} per side</option>)}
          </select>
          <button className="x" onClick={() => onChange(bands.filter((_, j) => j !== i))} aria-label="Remove band">×</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => onChange([...bands, { name: all[0]?.name ?? '', per_side: 1 }])}>+ band</button>
    </div>
  )
}

/* ---------- support table ---------- */

function SupportTable({ S, api }: { S: SupportCtl; api: Api }) {
  return (
    <div className="supsheet">
      <h3>Support</h3>
      <div className="tablewrap">
        <table className="sheet">
          <thead><tr><th className="stick">Exercise</th><th>Start</th><th>Reps</th><th>Each drop</th><th>Final</th><th className="c-setup">Scheme</th><th className="c-exp">Step</th><th className="c-exp">Drops</th><th className="c-side">Note</th><th className="c-rest"></th></tr></thead>
          <tbody>{S.slots.map(slot => <SupportTr key={slot.key} slot={slot} S={S} api={api} />)}</tbody>
        </table>
      </div>
      <button className="ghost small" onClick={() => S.addExercise()}>+ Add exercise</button>
    </div>
  )
}

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']

function SupportTr({ slot, S, api }: { slot: SupportSlot; S: SupportCtl; api: Api }) {
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
        <td className="nowrap c-rest"><button className="ghost small" onClick={() => S.addSetFor(slot)} disabled={!v.ex} title="Another set">+</button>
          <button className="x" onClick={() => S.remove(slot)} aria-label="Remove">×</button></td>
      </tr>
      {loads && <tr className="loadrow"><td className="stick" /><td colSpan={9} className="small muted">{loads}</td></tr>}
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
