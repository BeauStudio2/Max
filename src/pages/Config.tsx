import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useStore } from '../lib/store'
import type { Equipment } from '../lib/types'
import { CellText } from './today/Sheet'
import People from './People'

/** Reads a nested value: get(o, 'planned_e1rm.bench'). */
const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o)
/** Returns a copy with a nested value set; blank removes it. */
function put(o: any, path: string, value: any) {
  const out = structuredClone(o ?? {})
  const keys = path.split('.')
  let cur = out
  for (const k of keys.slice(0, -1)) cur = cur[k] = typeof cur[k] === 'object' && cur[k] !== null ? cur[k] : {}
  if (value === null || value === '') delete cur[keys.at(-1)!]
  else cur[keys.at(-1)!] = value
  return out
}
const asNum = (v: string) => (v.trim() === '' ? null : Number(v))

/** Per-person training values on the Profile, one row per lift. Equipment and plan choices (clamps, chains, bands) live in Config and Plan. */
const LIFT_COLS: { key: string; label: string }[] = [
  { key: 'planned_e1rm', label: 'Planned max' },
  { key: 'target_reps', label: 'Target reps' },
  { key: 'stop_pct', label: 'Stop %' },
  { key: 'fatigue_pct', label: 'Fatigue %/set' },
  { key: 'chain_geometry.rom_in', label: 'Range of motion (in)' },
  { key: 'chain_geometry.hang_in', label: 'Chain hang at bottom (in)' },
]
const liftPath = (key: string, lift: string) => key.includes('.') ? `${key.split('.')[0]}.${lift}.${key.split('.')[1]}` : `${key}.${lift}`

export default function Config() {
  const { isCoach, equipment, exercises, templates, reload } = useStore()
  const [settings, setSettings] = useState<{ key: string; value: any; notes: string | null }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const ro = !isCoach
  useEffect(() => { supabase.from('settings').select('*').order('key').then(({ data }) => setSettings(data ?? [])) }, [])
  const done = async (p: PromiseLike<{ error: any }>) => { const { error } = await p; if (error) setErr(error.message); else await reload() }

  // Deadlift cycle lives on the Saturday plan.
  const sat = templates.find(t => t.spec?.deadlift_cycle)
  const cycle: any[] = sat?.spec?.deadlift_cycle ?? []
  const saveCycle = (i: number, key: string, raw: string) => {
    if (!sat) return
    const next = cycle.map((w, j) => (j === i ? { ...w, [key]: key === 'flywheel_sets' ? asNum(raw) : raw || null } : w))
    return done(supabase.from('day_templates').update({ spec: { ...sat.spec, deadlift_cycle: next } }).eq('id', sat.id))
  }

  const groups: [string, (e: Equipment) => boolean][] = [
    ['Bars and clamps', e => e.kind === 'bar' || e.kind === 'clamp' || e.kind === 'trap_bar' || e.kind === 'other'],
    ['Chains', e => e.kind === 'chain'],
    ['Bands', e => e.kind === 'band'],
    ['Sensors and machines', e => e.kind === 'sensor' || e.kind === 'spotter'],
  ]
  const propCols: Record<string, [string, string][]> = {
    Chains: [['total_lb', 'Total lb (one chain)'], ['length_in', 'Length in'], ['bottom_lb_per_side', 'Fallback bottom lb'], ['top_lb_per_side', 'Fallback top lb']],
    Bands: [['one_band_lockout_lb', 'Lockout lb (1 band)'], ['rogue_rating_lb_at_100pct', 'Rogue rating lb'], ['rogue_number', 'Rogue #']],
  }

  return (
    <div className="stack config">
      {ro && <p className="small muted">Read only. The coach edits these.</p>}
      {err && <p className="err">{err}</p>}

      <section className="card">
        <h2>Model</h2>
        <div className="tablewrap"><table className="sheet cfg">
          <thead><tr><th className="stick">Setting</th><th>Value</th><th>What it does</th></tr></thead>
          <tbody>{settings.map(s => (
            <tr key={s.key}>
              <td className="stick">{s.key.replace(/_/g, ' ')}</td>
              <td>{ro ? String(s.value) : <CellText value={String(s.value)} narrow numeric onSave={v => done(supabase.from('settings').update({ value: Number(v) }).eq('key', s.key)).then(() => setSettings(x => x.map(y => y.key === s.key ? { ...y, value: Number(v) } : y)))} />}</td>
              <td className="small muted wrapcell">{s.notes}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>


      {groups.map(([title, test]) => {
        const rows = equipment.filter(test)
        if (!rows.length) return null
        const pc = propCols[title] ?? []
        return (
          <section className="card" key={title}>
            <h2>{title}</h2>
            <div className="tablewrap"><table className="sheet cfg">
              <thead><tr><th className="stick">Name</th>{!pc.length && <th>lb</th>}{pc.map(([, lab]) => <th key={lab}>{lab}</th>)}{title === 'Chains' && <th>Per inch</th>}<th>Notes</th></tr></thead>
              <tbody>{rows.map(e => (
                <tr key={e.id}>
                  <td className="stick">{e.name.replace('Rogue band ', '')}</td>
                  {!pc.length && <td>{ro ? e.weight_lb ?? '' : <CellText value={e.weight_lb == null ? '' : String(e.weight_lb)} narrow numeric
                    onSave={v => done(supabase.from('equipment').update({ weight_lb: asNum(v) }).eq('id', e.id))} />}</td>}
                  {pc.map(([k]) => <td key={k}>{ro ? e.props?.[k] ?? '' : <CellText value={e.props?.[k] == null ? '' : String(e.props[k])} narrow numeric
                    onSave={v => done(supabase.from('equipment').update({ props: put(e.props, k, asNum(v)) }).eq('id', e.id))} />}</td>)}
                  {title === 'Chains' && <td className="num small">{e.props?.total_lb && e.props?.length_in ? `${(e.props.total_lb / e.props.length_in).toFixed(3)} lb/in` : '—'}</td>}
                  <td>{ro ? <span className="small muted">{(e as any).notes}</span> : <CellText value={(e as any).notes ?? ''} full
                    onSave={v => done(supabase.from('equipment').update({ notes: v || null }).eq('id', e.id))} />}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {title === 'Chains' && <p className="small muted">Load from chains: weight per inch × inches off the floor. At the bottom that's the lifter's chain hang; at the top, hang + range of motion (never more than the whole chain). Until total weight and length are entered, the fallback bottom/top values are used. Hang and range of motion are set per lifter and lift on the Lifters page, and per session in Plan.</p>}
            {!ro && <button className="ghost small" onClick={() => {
              const name = window.prompt(`New item for ${title}`)?.trim()
              if (!name) return
              const kind = title === 'Chains' ? 'chain' : title === 'Bands' ? 'band' : title === 'Sensors and machines' ? 'sensor' : window.prompt('Kind: bar, clamp or other', 'bar') || 'other'
              done(supabase.from('equipment').insert({ name, kind }))
            }}>+ Add</button>}
          </section>
        )
      })}

      {cycle.length > 0 && (
        <section className="card">
          <h2>Deadlift cycle</h2>
          <div className="tablewrap"><table className="sheet cfg">
            <thead><tr><th className="stick">Week</th><th>Main pull</th><th>Top single</th><th>Back-off</th><th>Flywheel sets</th></tr></thead>
            <tbody>{cycle.map((w, i) => (
              <tr key={w.week}>
                <td className="stick">{w.week}</td>
                {(['pull', 'top', 'backoff'] as const).map(k => <td key={k}>{ro ? w[k] ?? '' : <CellText value={w[k] ?? ''} full onSave={v => saveCycle(i, k, v)} />}</td>)}
                <td>{ro ? w.flywheel_sets ?? '' : <CellText value={w.flywheel_sets == null ? '' : String(w.flywheel_sets)} narrow numeric onSave={v => saveCycle(i, 'flywheel_sets', v)} />}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="small muted">Cycle week 1 started Saturday 11/07. Back-off is read as sets×reps @ % of the day's best top single.</p>
        </section>
      )}

      {isCoach && <People />}

      <section className="card">
        <h2>Exercises</h2>
        <div className="tablewrap"><table className="sheet cfg">
          <thead><tr><th className="stick">Exercise</th><th>Category</th><th>Muscle group</th></tr></thead>
          <tbody>{exercises.map(x => (
            <tr key={x.id}>
              <td className="stick">{x.name}</td>
              <td>{ro ? x.category : (
                <select className="mini" value={x.category} onChange={e => done(supabase.from('exercises').update({ category: e.target.value }).eq('id', x.id))}>
                  {['primary', 'speed', 'support', 'deadlift'].map(c => <option key={c}>{c}</option>)}
                </select>)}</td>
              <td>{ro ? x.muscle_group ?? '' : <CellText value={x.muscle_group ?? ''} wide onSave={v => done(supabase.from('exercises').update({ muscle_group: v || null }).eq('id', x.id))} />}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {!ro && <button className="ghost small" onClick={() => {
          const name = window.prompt('New exercise name')?.trim()
          if (name) done(supabase.from('exercises').insert({ name, category: 'support' }))
        }}>+ Add exercise</button>}
      </section>
    </div>
  )
}

/** One lifter's training settings, label by value (shown on their Profile). */
export function LifterSettings({ lifterId }: { lifterId: string }) {
  const { isCoach, lifters, reload } = useStore()
  const [err, setErr] = useState<string | null>(null)
  const l = lifters.find(x => x.id === lifterId)
  if (!l) return null
  const ro = !isCoach
  const done = async (p: PromiseLike<{ error: any }>) => { const { error } = await p; if (error) setErr(error.message); else await reload() }
  const save = (path: string, raw: string) => {
    const v = path.endsWith('default_clamp') ? raw || null : asNum(raw)
    if (path === 'bodyweight_lb') return done(supabase.from('lifters').update({ bodyweight_lb: v }).eq('id', l.id))
    return done(supabase.from('lifters').update({ settings: put(l.settings, path.replace('settings.', ''), v) }).eq('id', l.id))
  }
  const cell = (path: string) => {
    const v = get(l.settings, path)
    return ro ? (v ?? '—') : <CellText value={v == null ? '' : String(v)} narrow numeric onSave={x => save('settings.' + path, x)} />
  }
  return (
    <section className="card">
      <h2>Training settings</h2>
      {err && <p className="err">{err}</p>}
      <div className="tablewrap"><table className="sheet cfg">
        <thead><tr><th className="stick">Lift</th>{LIFT_COLS.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{(['bench', 'squat'] as const).map(lift => (
          <tr key={lift}><td className="stick cap">{lift}</td>{LIFT_COLS.map(c => <td key={c.key}>{cell(liftPath(c.key, lift))}</td>)}</tr>
        ))}</tbody>
      </table></div>
      <div className="planfields" style={{ marginTop: 10 }}>
        <label>Deadlift best (lb){cell('deadlift_best_conventional_lb')}</label>
        <label>Deadlift week-1 top (lb){cell('deadlift_planned_top_lb')}</label>
        <label>Rest between heavy sets (s){cell('rest_s')}</label>
      </div>
      <p className="small muted">Starting values. Once {l.name} trains, each session carries its numbers forward to the next.{ro ? ' The coach edits these.' : ''}</p>
    </section>
  )
}
