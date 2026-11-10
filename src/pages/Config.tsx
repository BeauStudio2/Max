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


export default function Config() {
  const { isCoach, equipment, exercises, templates, reload } = useStore()
  const [settings, setSettings] = useState<{ key: string; value: any; notes: string | null }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const ro = !isCoach
  useEffect(() => { supabase.from('settings').select('*').order('key').then(({ data }) => setSettings(data ?? [])) }, [])
  const done = async (p: PromiseLike<{ error: any }>) => { const { error } = await p; if (error) setErr(error.message); else await reload() }

  const setEquip = (x: any, patch: Record<string, any>) => done(supabase.from('exercises').update({ equipment: { ...(x.equipment ?? {}), ...patch } }).eq('id', x.id))

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
            <thead><tr><th className="stick">Week</th><th>Main pull</th><th>Setup</th><th>Bar</th><th>Top single</th><th>Back-off</th><th>Back-off setup</th><th>Flywheel sets</th></tr></thead>
            <tbody>{cycle.map((w, i) => (
              <tr key={w.week}>
                <td className="stick">{w.week}</td>
                {(['pull', 'setup', 'bar', 'top', 'backoff', 'backoff_setup'] as const).map(k => <td key={k}>{ro ? w[k] ?? '' : <CellText value={w[k] ?? ''} full onSave={v => saveCycle(i, k, v)} />}</td>)}
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
        <p className="small muted">Each exercise's equipment. Pick any exercise as the main lift on the Log page and the table uses its bar (or none), chains and what its weight means.</p>
        <div className="tablewrap"><table className="sheet cfg">
          <thead><tr><th className="stick">Exercise</th><th>Category</th><th>Bar</th><th>Chains</th><th>lb means</th><th>Muscle group</th></tr></thead>
          <tbody>{exercises.map(x => (
            <tr key={x.id}>
              <td className="stick">{x.name}</td>
              <td>{ro ? x.category : (
                <select className="mini" value={x.category} onChange={e => done(supabase.from('exercises').update({ category: e.target.value }).eq('id', x.id))}>
                  {['primary', 'speed', 'support', 'deadlift'].map(c => <option key={c}>{c}</option>)}
                </select>)}</td>
              <td>{ro ? (x.equipment?.bar ?? 'none') : (
                <select className="mini" value={x.equipment?.bar ?? ''} onChange={e => setEquip(x, { bar: e.target.value || null })}>
                  <option value="">no bar</option>
                  {equipment.filter(b => b.kind === 'bar' || b.kind === 'trap_bar').map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>)}</td>
              <td>{ro ? (x.equipment?.chains ? 'yes' : 'no') : <input type="checkbox" checked={!!x.equipment?.chains} onChange={e => setEquip(x, { chains: e.target.checked })} />}</td>
              <td>{ro ? (x.equipment?.load ?? 'bar') : (
                <select className="mini" value={x.equipment?.load ?? (x.equipment?.bar ? 'bar' : 'added')} onChange={e => setEquip(x, { load: e.target.value as any })}>
                  <option value="bar">everything on the bar</option><option value="added">added weight</option><option value="per_hand">per hand</option>
                  <option value="stack">machine stack</option><option value="bodyweight">bodyweight +</option>
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
