import { useEffect, useMemo, useState } from 'react'
import { round } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { HeavyDone, HeavyNext, setupLabel, type Ladder } from './Ladder'
import SpeedBlock from './Speed'
import { fmt, useClock, type Api } from './shared'

export type Placement = 'between' | 'first' | 'after'

type Up =
  | { kind: 'heavy'; key: string; group: 'heavy'; p: Ladder['projected'][number] }
  | { kind: 'speed'; key: string; group: string; it: any; n: number }
  | { kind: 'support'; key: string; group: 'support'; name: string }

/**
 * One list for the whole session: what's been done, what's next, and what's coming.
 * The order starts from a default (one speed set in each heavy rest) and is rebuilt after every set.
 */
export default function Queue({ L, api, heavyExerciseId, speed, speedEx, onSpeedEx, speedSets, placement, offsetS, support }: {
  L: Ladder; api: Api; heavyExerciseId?: string
  speed: any | null; speedEx: (it: any) => string; onSpeedEx: (it: any, n: string) => void; speedSets: (it: any) => SetRow[]
  placement: Placement; offsetS: number; support: string[]
}) {
  const items: any[] = speed?.items ?? []
  const allSpeed = items.flatMap(it => speedSets(it))
  const done = useMemo(() => [...L.logged, ...allSpeed].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')), [L.logged, allSpeed])
  const lastDone = done.at(-1)
  const lastHeavy = L.logged.at(-1)

  // Remaining speed sets, slot by slot, or alternating when the plan says the slots are a contrast pair.
  const speedRem = useMemo(() => {
    const left = items.map(it => ({ it, done: speedSets(it).length, left: Math.max(0, (it.sets ?? 0) - speedSets(it).length) }))
    const alternate = items.some(it => /alternat/i.test(it.rule ?? '') || /alt\b/i.test(it.scheme ?? ''))
    const out: Up[] = []
    if (alternate) {
      let more = true
      while (more) {
        more = false
        for (const s of left) if (s.left > 0) { s.done++; s.left--; more = true; out.push({ kind: 'speed', key: `s:${s.it.name}:${s.done}`, group: 'speed:' + s.it.name, it: s.it, n: s.done }) }
      }
    } else {
      for (const s of left) while (s.left > 0) { s.done++; s.left--; out.push({ kind: 'speed', key: `s:${s.it.name}:${s.done}`, group: 'speed:' + s.it.name, it: s.it, n: s.done }) }
    }
    return out
  }, [items, allSpeed.length])

  const upcoming = useMemo(() => {
    const heavy: Up[] = L.projected.map(p => ({ kind: 'heavy', key: 'h' + p.idx, group: 'heavy', p }))
    const sp = [...speedRem]
    const out: Up[] = []
    if (placement === 'first') out.push(...sp, ...heavy)
    else if (placement === 'after') out.push(...heavy, ...sp)
    else {
      // Between: heavy set, then a speed set in its rest, and so on. Set 1 goes first so the benchmark is fresh.
      let turn: 'heavy' | 'speed' = lastDone && lastDone.block === 'primary' ? 'speed' : 'heavy'
      if (!lastDone && heavy.length === 0) turn = 'speed'
      while (heavy.length || sp.length) {
        if (turn === 'heavy' && heavy.length) out.push(heavy.shift()!)
        else if (turn === 'speed' && sp.length) out.push(sp.shift()!)
        else out.push((heavy.shift() ?? sp.shift())!)
        turn = turn === 'heavy' ? 'speed' : 'heavy'
      }
    }
    out.push(...support.map(name => ({ kind: 'support' as const, key: 'p:' + name, group: 'support' as const, name })))
    return out
  }, [L.projected, speedRem, placement, lastDone?.id, support])

  const [active, setActive] = useState<string | null>(null)
  useEffect(() => { setActive(null) }, [done.length])
  const groups = new Set(upcoming.map(u => u.group))
  const activeGroup = active && groups.has(active) ? active : upcoming[0]?.group ?? null
  const current = upcoming.find(u => u.group === activeGroup) ?? null
  const [showAll, setShowAll] = useState(false)
  const rest = useClock(lastHeavy?.created_at)
  const sinceAny = useClock(lastDone?.created_at)

  // Cue for the current item: speed waits a little after a heavy set, heavy waits for the full rest.
  let cue: { text: string; ready: boolean } | null = null
  if (current?.kind === 'heavy' && lastHeavy) cue = rest >= L.plan.rest_s ? { text: 'Heavy ready', ready: true } : { text: `Heavy in ${fmt(L.plan.rest_s - rest)}`, ready: false }
  if (current?.kind === 'speed' && lastDone?.block === 'primary') cue = rest >= offsetS ? { text: 'Speed now', ready: true } : { text: `Speed in ${rest >= 0 ? offsetS - rest : offsetS}s`, ready: false }

  const label = (u: Up) => u.kind === 'heavy' ? `Heavy set ${u.p.idx}` : u.kind === 'speed' ? `${speedEx(u.it)} · set ${u.n}${u.it.sets ? ` of ${u.it.sets}` : ''}` : `Support · ${u.name}`
  const shown = showAll ? upcoming.slice(1) : upcoming.slice(1, 7)

  return (
    <section className="card queue">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Now</h2>
        {lastDone && (
          <span className={'clock' + (cue?.ready ? ' ready' : '')} title="Time since your last heavy set">
            {fmt(lastHeavy ? rest : sinceAny)}{current?.kind === 'heavy' && lastHeavy ? <span className="small muted"> / {fmt(L.plan.rest_s)}</span> : null}
          </span>
        )}
      </div>
      {current ? (
        <div className="now">
          <div className="row between"><b>{label(current)}</b>{cue && <span className={'cue' + (cue.ready ? ' ready' : '')}>{cue.text}</span>}</div>
          {current.kind === 'heavy' && <HeavyNext key="hn" L={L} api={api} exerciseId={heavyExerciseId} />}
          {current.kind === 'speed' && (
            <SpeedBlock key={current.it.name} item={current.it} exerciseName={speedEx(current.it)} onExercise={n => onSpeedEx(current.it, n)}
              sets={speedSets(current.it)} api={api}
              extraSetup={() => ({ after_heavy: lastHeavy?.set_index ?? null, after_heavy_s: lastHeavy?.created_at ? Math.round((Date.now() - Date.parse(lastHeavy.created_at)) / 1000) : null })} />
          )}
          {current.kind === 'support' && (
            <p className="small">Heavy and speed are done. Log support below.
              <button className="link" onClick={() => document.getElementById('support')?.scrollIntoView({ behavior: 'smooth' })}>Go to support</button></p>
          )}
        </div>
      ) : <p className="muted">Nothing left in the plan. Add sets from Plan, or finish the workout.</p>}

      {upcoming.length > 1 && (
        <>
          <p className="small muted qhead">Up next <span>(tap to do something else now)</span></p>
          <ul className="qlist">
            {shown.map(u => (
              <li key={u.key}>
                <button className={'qline up' + (u.group === activeGroup ? ' cur' : '')} onClick={() => setActive(u.group)}>
                  <span className={'qtag ' + (u.kind === 'heavy' ? 'h' : u.kind === 'speed' ? 's' : 'p')}>{u.kind === 'heavy' ? `H${u.p.idx}` : u.kind === 'speed' ? 'S' : '+'}</span>
                  <span className="grow">{u.kind === 'heavy' ? <>{u.p.weight} <span className="muted small">{setupLabel(u.p.setup)}{u.p.change ? ` · ${u.p.change}` : ''}</span></> : label(u)}</span>
                </button>
              </li>
            ))}
          </ul>
          {upcoming.length > 7 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${upcoming.length - 1}`}</button>}
        </>
      )}

      {done.length > 0 && (
        <>
          <p className="small muted qhead">Done ({L.logged.length} heavy, {allSpeed.length} speed){L.fit ? ` · fatigue ${L.fit.ratePct.toFixed(2)}%/set` : ''}</p>
          <ul className="qlist">
            {[...done].reverse().map(r => r.block === 'primary'
              ? <HeavyDone key={r.id} r={r} L={L} api={api} />
              : (
                <li key={r.id} className="qdone">
                  <div className="qline">
                    <span className="qtag s">S</span>
                    <span className="grow">{speedName(r, items, speedEx)} <span className="muted small">{speedSummary(r)}</span></span>
                    <span className="small muted qtime">{r.setup?.after_heavy ? `after H${r.setup.after_heavy}` : ''}</span>
                    <button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button>
                  </div>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
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
