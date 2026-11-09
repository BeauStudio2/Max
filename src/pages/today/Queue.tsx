import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { round } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { HeavyDone, HeavyNext, setupLabel, type Ladder } from './Ladder'
import SpeedBlock from './Speed'
import { SupportRow, type SupportCtl, type SupportSlot } from './Support'
import { PullForm, pullLabel, type DeadliftCtl, type PullRowDef } from './Deadlift'
import { fmt, useClock, type Api } from './shared'

export type Placement = 'between' | 'first' | 'after'

type Up =
  | { kind: 'heavy'; key: string; group: string; p: Ladder['projected'][number] }
  | { kind: 'pull'; key: string; group: string; row: PullRowDef }
  | { kind: 'speed'; key: string; group: string; it: any; n: number }
  | { kind: 'support'; key: string; group: string; slot: SupportSlot }

const isMain = (r?: SetRow) => r?.block === 'primary' || r?.block === 'deadlift'

/**
 * Every set of the session in one list: done, now, and coming up.
 * Default order: main lift with one speed set in each of its rests, then support. Rebuilt after every set,
 * and any upcoming item can be pulled forward by tapping it.
 */
export default function Queue({ api, L, D, heavyExerciseId, restS, speed, speedEx, onSpeedEx, speedSets, placement, offsetS, S }: {
  api: Api; L: Ladder | null; D: DeadliftCtl | null; heavyExerciseId?: string; restS: number
  speed: any | null; speedEx: (it: any) => string; onSpeedEx: (it: any, n: string) => void; speedSets: (it: any) => SetRow[]
  placement: Placement; offsetS: number; S: SupportCtl
}) {
  const { exercises } = useStore()
  const items: any[] = speed?.items ?? []
  const allSpeed = items.flatMap(it => speedSets(it))
  const mainSets = L ? L.logged : (D?.rows.map(r => r.existing).filter(Boolean) as SetRow[]) ?? []
  const supportDone = S.slots.filter(s => s.existing).map(s => s.existing!)
  const done = useMemo(() => [...mainSets, ...allSpeed, ...supportDone].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')),
    [mainSets, allSpeed, supportDone])
  const lastDone = done.at(-1)
  const lastMain = [...done].reverse().find(isMain)

  const speedRem = useMemo(() => {
    const left = items.map(it => ({ it, done: speedSets(it).length, left: Math.max(0, (it.sets ?? 0) - speedSets(it).length) }))
    const alternate = items.some(it => /alternat/i.test(it.rule ?? '') || /alt\b/i.test(it.scheme ?? ''))
    const out: Up[] = []
    const take = (s: typeof left[number]) => { s.done++; s.left--; out.push({ kind: 'speed', key: `s:${s.it.name}:${s.done}`, group: 'speed:' + s.it.name, it: s.it, n: s.done }) }
    if (alternate) { let more = true; while (more) { more = false; for (const s of left) if (s.left > 0) { take(s); more = true } } }
    else for (const s of left) while (s.left > 0) take(s)
    return out
  }, [items, allSpeed.length])

  const upcoming = useMemo(() => {
    const main: Up[] = L
      ? L.projected.map(p => ({ kind: 'heavy' as const, key: 'h' + p.idx, group: 'heavy', p }))
      : (D?.rows ?? []).filter(r => !r.existing).map(r => ({ kind: 'pull' as const, key: 'd:' + r.row.step, group: 'pull:' + r.row.step, row: r.row }))
    const sp = [...speedRem]
    const out: Up[] = []
    if (placement === 'first') out.push(...sp, ...main)
    else if (placement === 'after') out.push(...main, ...sp)
    else {
      let turn: 'main' | 'speed' = isMain(lastDone) ? 'speed' : 'main'
      while (main.length || sp.length) {
        if (turn === 'main' && main.length) out.push(main.shift()!)
        else if (turn === 'speed' && sp.length) out.push(sp.shift()!)
        else out.push((main.shift() ?? sp.shift())!)
        turn = turn === 'main' ? 'speed' : 'main'
      }
    }
    for (const slot of S.slots.filter(s => !s.existing)) out.push({ kind: 'support', key: 'p:' + slot.key, group: 'sup:' + slot.key, slot })
    return out
  }, [L?.projected, D?.rows, speedRem, placement, lastDone?.id, S.slots])

  const [active, setActive] = useState<string | null>(null)
  useEffect(() => { setActive(null) }, [done.length])
  const groups = new Set(upcoming.map(u => u.group))
  const activeGroup = active && groups.has(active) ? active : upcoming[0]?.group ?? null
  const current = upcoming.find(u => u.group === activeGroup) ?? null
  const [showAll, setShowAll] = useState(false)
  const rest = useClock(lastMain?.created_at)
  const sinceAny = useClock(lastDone?.created_at)

  let cue: { text: string; ready: boolean } | null = null
  if ((current?.kind === 'heavy' || current?.kind === 'pull') && lastMain)
    cue = rest >= restS ? { text: 'Ready', ready: true } : { text: `Rest ${fmt(restS - rest)}`, ready: false }
  if (current?.kind === 'speed' && isMain(lastDone))
    cue = rest >= offsetS ? { text: 'Speed now', ready: true } : { text: `Speed in ${offsetS - rest}s`, ready: false }

  const exName = (id: string) => exercises.find(e => e.id === id)?.name ?? 'Exercise'
  const label = (u: Up) =>
    u.kind === 'heavy' ? `Heavy set ${u.p.idx}`
      : u.kind === 'pull' ? pullLabel(u.row)
        : u.kind === 'speed' ? `${speedEx(u.it)} · set ${u.n}${u.it.sets ? ` of ${u.it.sets}` : ''}`
          : `${u.slot.exerciseId ? exName(u.slot.exerciseId) : 'New exercise'}${u.slot.setIndex > 1 ? ` · set ${u.slot.setIndex}` : ''}`
  const tag = (u: Up) => u.kind === 'heavy' ? [`H${u.p.idx}`, 'h'] : u.kind === 'pull' ? ['D', 'h'] : u.kind === 'speed' ? ['S', 's'] : ['+', 'p']
  const afterMain = () => ({
    after_main: lastMain ? `${lastMain.block}:${lastMain.set_index}` : null,
    after_heavy: lastMain?.block === 'primary' ? lastMain.set_index : null,
    after_heavy_s: lastMain?.created_at ? Math.round((Date.now() - Date.parse(lastMain.created_at)) / 1000) : null,
  })
  const shown = showAll ? upcoming.slice(1) : upcoming.slice(1, 7)

  return (
    <section className="card queue">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Now</h2>
        {lastDone && (
          <span className={'clock' + (cue?.ready ? ' ready' : '')} title={lastMain ? 'Time since your last main set' : 'Time since your last set'}>
            {fmt(lastMain ? rest : sinceAny)}{(current?.kind === 'heavy' || current?.kind === 'pull') && lastMain ? <span className="small muted"> / {fmt(restS)}</span> : null}
          </span>
        )}
      </div>
      {current ? (
        <div className="now">
          <div className="row between"><b>{label(current)}</b>{cue && <span className={'cue' + (cue.ready ? ' ready' : '')}>{cue.text}</span>}</div>
          {current.kind === 'heavy' && L && <HeavyNext key="hn" L={L} api={api} exerciseId={heavyExerciseId} />}
          {current.kind === 'pull' && D && <PullForm key={current.row.step} row={current.row} D={D} extraSetup={afterMain} />}
          {current.kind === 'speed' && (
            <SpeedBlock key={current.it.name} item={current.it} exerciseName={speedEx(current.it)} onExercise={n => onSpeedEx(current.it, n)}
              sets={speedSets(current.it)} api={api} extraSetup={afterMain} />
          )}
          {current.kind === 'support' && (
            <SupportRow key={current.slot.key} slot={current.slot} api={api} mode="now"
              onAddSet={() => S.addSetFor(current.slot)} onRemove={() => S.remove(current.slot)} onSaved={() => S.saved(current.slot)} />
          )}
        </div>
      ) : <p className="muted">Everything planned is done. Add more below, or finish the workout.</p>}

      <div className="qadd">
        <button className="ghost small" onClick={() => setActive('sup:' + S.addExercise())}>+ Support exercise</button>
        {D && <button className="ghost small" onClick={D.addPull}>+ Pull</button>}
      </div>

      {upcoming.length > 1 && (
        <>
          <p className="small muted qhead">Up next <span>(tap to do something else now)</span></p>
          <ul className="qlist">
            {shown.map(u => {
              const [t, c] = tag(u)
              return (
                <li key={u.key}>
                  <button className={'qline up' + (u.group === activeGroup ? ' cur' : '')} onClick={() => setActive(u.group)}>
                    <span className={'qtag ' + c}>{t}</span>
                    <span className="grow">{u.kind === 'heavy'
                      ? <>{u.p.weight} <span className="muted small">{setupLabel(u.p.setup)}{u.p.change ? ` · ${u.p.change}` : ''}</span></>
                      : u.kind === 'pull' ? <>{label(u)} <span className="muted small">{u.row.weight ? `${u.row.weight} × ${u.row.reps}` : `× ${u.row.reps}`}</span></>
                        : u.kind === 'support' ? <>{label(u)} <span className="muted small">{u.slot.defaults?.scheme ?? ''}</span></>
                          : label(u)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {upcoming.length > 7 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${upcoming.length - 1}`}</button>}
        </>
      )}

      {done.length > 0 && (
        <>
          <p className="small muted qhead">Done ({done.length}){L?.fit ? ` · fatigue ${L.fit.ratePct.toFixed(2)}%/set` : ''}{D?.todayMax ? ` · deadlift estimate ${round(D.todayMax)}` : ''}</p>
          <ul className="qlist">
            {[...done].reverse().map(r => {
              if (r.block === 'primary' && L) return <HeavyDone key={r.id} r={r} L={L} api={api} />
              if (r.block === 'deadlift' && D) {
                const def = D.rows.find(x => x.existing?.id === r.id)
                return def ? <DoneLine key={r.id} tag={['D', 'h']} title={pullLabel(def.row)} detail={`${r.weight_lb ?? r.setup?.inertia ?? ''} × ${r.reps ?? ''}${r.rpe ? ` @${r.rpe}` : ''}`}>
                  <PullForm row={def.row} existing={r} D={D} mode="edit" />
                </DoneLine> : null
              }
              if (r.block === 'support') {
                const slot = S.slots.find(s => s.existing?.id === r.id)!
                return <DoneLine key={r.id} tag={['+', 'p']} title={exName(r.exercise_id)} detail={`${r.start_weight_lb ?? '—'}${r.reps ? ` × ${r.reps}` : ''}${r.scheme ? ` · ${r.scheme}` : ''}`}>
                  {slot && <SupportRow slot={slot} api={api} onAddSet={() => S.addSetFor(slot)} onRemove={() => S.remove(slot)} onSaved={() => S.saved(slot)} />}
                </DoneLine>
              }
              return (
                <li key={r.id} className="qdone">
                  <div className="qline">
                    <span className="qtag s">S</span>
                    <span className="grow">{speedName(r, items, speedEx)} <span className="muted small">{speedSummary(r)}</span></span>
                    <span className="small muted qtime">{r.setup?.after_heavy ? `after H${r.setup.after_heavy}` : ''}</span>
                    <button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

function DoneLine({ tag, title, detail, children }: { tag: [string, string]; title: string; detail: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="qdone">
      <button className="qline" onClick={() => setOpen(o => !o)}>
        <span className={'qtag ' + tag[1]}>{tag[0]}</span>
        <span className="grow">{title} <span className="muted small">{detail}</span></span>
        <span className="small muted">{open ? '▴' : '✎'}</span>
      </button>
      {open && <div className="qedit block">{children}</div>}
    </li>
  )
}

function speedName(r: SetRow, items: any[], speedEx: (it: any) => string) {
  const it = items.find(i => i.name === r.setup?.slot)
  return it ? speedEx(it) : r.setup?.slot ?? 'Speed'
}

function speedSummary(r: SetRow) {
  const s = r.setup ?? {}
  const bits = []
  if (r.weight_lb) bits.push(`${round(r.weight_lb, 1)} lb`)
  bits.push(s.bell_reps_of ? `${r.reps}/${s.bell_reps_of}` : `${r.reps} reps`)
  if (s.band) bits.push(`${String(s.band).replace('Rogue band ', '')}${s.bands ? ` ×${s.bands}` : ''}`)
  if (s.bell_hits != null) bits.push(`${s.bell_hits} bell`)
  return bits.join(' · ')
}
