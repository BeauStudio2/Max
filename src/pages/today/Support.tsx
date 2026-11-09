import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import { useStore } from '../../lib/store'
import type { SetRow } from '../../lib/types'
import type { Api } from './shared'

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']

interface Slot { key: string; slot: string | null; exerciseId: string; setIndex: number; existing?: SetRow; defaults: any }

export default function Support({ support, sets, api }: { support: any; sets: SetRow[]; api: Api }) {
  const { exercises } = useStore()
  const items: any[] = support?.items ?? []
  const [extras, setExtras] = useState<Slot[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const nameOf = (id: string) => exercises.find(e => e.id === id)?.name

  const slots = useMemo(() => {
    const used = new Set<string>()
    const out: Slot[] = []
    for (const it of items) {
      const mine = sets.filter(s => !used.has(s.id!) && (s.setup?.slot === it.name || (!s.setup?.slot && nameOf(s.exercise_id) === it.name)))
        .sort((a, b) => a.set_index - b.set_index)
      mine.forEach(s => used.add(s.id!))
      if (mine.length) mine.forEach(s => out.push({ key: s.id!, slot: it.name, exerciseId: s.exercise_id, setIndex: s.set_index, existing: s, defaults: it }))
      else if (!hidden.includes(it.name)) out.push({ key: 'tpl:' + it.name, slot: it.name, exerciseId: api.exId(it.name) ?? '', setIndex: 1, defaults: it })
      out.push(...extras.filter(x => x.slot === it.name))
    }
    for (const s of sets.filter(s => !used.has(s.id!)).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')))
      out.push({ key: s.id!, slot: s.setup?.slot ?? null, exerciseId: s.exercise_id, setIndex: s.set_index, existing: s, defaults: {} })
    out.push(...extras.filter(x => !items.some(it => it.name === x.slot)))
    return out
  }, [items, sets, extras, hidden, exercises])

  function addSetFor(s: Slot) {
    const idxs = [s.setIndex, ...sets.filter(x => x.exercise_id === s.exerciseId).map(x => x.set_index), ...extras.filter(x => x.exerciseId === s.exerciseId).map(x => x.setIndex)]
    const nextIdx = Math.max(...idxs) + 1
    setExtras(prev => [...prev, { key: 'x' + Math.random(), slot: s.slot, exerciseId: s.exerciseId, setIndex: nextIdx, defaults: { ...s.defaults, start_lb: s.existing?.start_weight_lb ?? s.defaults.start_lb } }])
  }
  function addExercise() {
    setExtras(prev => [...prev, { key: 'x' + Math.random(), slot: 'extra:' + Math.random().toString(36).slice(2, 8), exerciseId: '', setIndex: 1, defaults: {} }])
  }
  async function remove(s: Slot) {
    if (s.existing) await api.deleteSet(s.existing.id!)
    else if (s.key.startsWith('tpl:')) setHidden(h => [...h, s.slot!])
    else setExtras(prev => prev.filter(x => x.key !== s.key))
  }
  const saved = (s: Slot) => setExtras(prev => prev.filter(x => x.key !== s.key))

  return (
    <section className="card">
      <h2>Support{support?.group ? ` · ${support.group}` : ''}</h2>
      <p className="small muted">F = to failure · TF = technical failure · DS×n = drop set · ST×n = strip set · RP×n = rest-pause · RTR = run the rack. Log the start weight and reps at that weight.</p>
      {slots.map(s => <SupportRow key={s.key} slot={s} api={api} onAddSet={() => addSetFor(s)} onRemove={() => remove(s)} onSaved={() => saved(s)} />)}
      <button className="ghost" onClick={addExercise}>+ Add exercise</button>
    </section>
  )
}

function SupportRow({ slot, api, onAddSet, onRemove, onSaved }: { slot: Slot; api: Api; onAddSet: () => void; onRemove: () => void; onSaved: () => void }) {
  const { exercises, isCoach, reload, templates } = useStore()
  const schemeOptions = Array.from(new Set([...SCHEMES, ...templates.flatMap(t => (t.spec?.support?.items ?? []).map((i: any) => i.scheme).filter(Boolean))]))
  const e = slot.existing, d = slot.defaults
  const init = () => ({
    exerciseId: slot.exerciseId,
    scheme: e?.scheme ?? d.scheme ?? '',
    start: e?.start_weight_lb?.toString() ?? d.start_lb?.toString() ?? '',
    step: e?.step_lb?.toString() ?? d.step_lb?.toString() ?? '',
    drops: e?.drops?.toString() ?? d.drops?.toString() ?? '',
    reps: e?.reps?.toString() ?? '',
    notes: e?.notes ?? '',
  })
  const [v, setV] = useState(init)
  useEffect(() => setV(init()), [e?.id, e?.exercise_id])
  const set = (k: keyof ReturnType<typeof init>) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: ev.target.value })

  const n = (s: string) => (s.trim() === '' ? null : Number(s))
  const loads = (() => {
    const start = n(v.start), step = n(v.step), drops = n(v.drops)
    if (start === null || !step || !drops) return ''
    return Array.from({ length: Math.min(drops, 30) + 1 }, (_, i) => Math.max(0, start - i * step)).join('→')
  })()

  async function save(next = v) {
    if (!next.exerciseId) return
    const patch = {
      exercise_id: next.exerciseId, scheme: next.scheme || null, start_weight_lb: n(next.start), step_lb: n(next.step),
      drops: n(next.drops), reps: n(next.reps), notes: next.notes.trim() || null,
    }
    if (e?.id) {
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(k => (patch[k] ?? null) !== ((e as any)[k] ?? null))
      if (changed) await api.updateSet(e.id, patch)
    } else if (patch.start_weight_lb !== null || patch.reps !== null || patch.notes) {
      const row = await api.addSet({
        ...patch, block: 'support', set_index: slot.setIndex, weight_lb: null, total_bottom_lb: null, total_top_lb: null,
        assisted: false, failed: false, setup: { slot: slot.slot },
      })
      if (row) onSaved()
    }
  }

  async function pick(id: string) {
    if (id === '__new') {
      const name = window.prompt('New exercise name')?.trim()
      if (!name) return
      const { data, error } = await supabase.from('exercises').insert({ name, category: 'support' }).select().single()
      if (error) { alert(error.message); return }
      await reload()
      const next = { ...v, exerciseId: data.id }
      setV(next); save(next)
      return
    }
    const next = { ...v, exerciseId: id }
    setV(next); save(next)
  }

  const label = exercises.find(x => x.id === v.exerciseId)?.name
  return (
    <div className={'sub' + (e ? ' done' : '')}>
      <div className="row">
        <label className="grow">{slot.setIndex > 1 ? `Set ${slot.setIndex}` : 'Exercise'}
          <select value={v.exerciseId} onChange={ev => pick(ev.target.value)}>
            <option value="">choose…</option>
            {exercises.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            {isCoach && <option value="__new">+ New exercise…</option>}
          </select>
        </label>
        <button className="x" onClick={onRemove} aria-label={`Remove ${label ?? 'exercise'}`}>×</button>
      </div>
      {d.note && <p className="small muted">{d.note}</p>}
      <div className="row wrap">
        <label className="grow">Scheme
          <select value={v.scheme} onChange={ev => {
            let scheme = ev.target.value
            if (scheme === '__other') { scheme = window.prompt('Scheme', v.scheme)?.trim() ?? v.scheme }
            const next = { ...v, scheme }
            setV(next); save(next)
          }}>
            <option value="">—</option>
            {[...schemeOptions, ...(v.scheme && !schemeOptions.includes(v.scheme) ? [v.scheme] : [])].map(o => <option key={o} value={o}>{o}</option>)}
            <option value="__other">Other…</option>
          </select>
        </label>
        <label className="narrow">Start lb<input inputMode="decimal" value={v.start} onChange={set('start')} onBlur={() => save()} /></label>
        <label className="tiny-f">Step<input inputMode="decimal" value={v.step} onChange={set('step')} onBlur={() => save()} /></label>
        <label className="tiny-f">Drops<input inputMode="numeric" value={v.drops} onChange={set('drops')} onBlur={() => save()} /></label>
        <label className="tiny-f">Reps<input inputMode="numeric" value={v.reps} onChange={set('reps')} onBlur={() => save()} /></label>
      </div>
      <div className="row">
        <label className="grow">Note<input value={v.notes} onChange={set('notes')} onBlur={() => save()} /></label>
        <button className="ghost small addset" onClick={onAddSet} disabled={!v.exerciseId}>+ set</button>
      </div>
      {loads && <p className="small muted">Loads: {loads}</p>}
    </div>
  )
}
