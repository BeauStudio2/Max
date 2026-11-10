import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import { useStore } from '../../lib/store'
import type { SetRow } from '../../lib/types'
import type { Api } from './shared'
import SchemePicker from './SchemePicker'

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']

interface Slot { key: string; slot: string | null; exerciseId: string; setIndex: number; existing?: SetRow; defaults: any }

export type SupportSlot = Slot
export type SupportCtl = ReturnType<typeof useSupportSlots>

/** The day's support work as slots: plan exercises, extra sets and added exercises, each logged or not yet. */
export function useSupportSlots(support: any, sets: SetRow[], api: Api, resetKey = '', persist?: { hidden: string[]; setHidden: (h: string[]) => void }, maxSets?: Record<string, number>) {
  const { exercises } = useStore()
  const items: any[] = support?.items ?? []
  const [extras, setExtras] = useState<Slot[]>([])
  // Exercises removed from today's support are saved on the session, so they stay gone after a refresh.
  const [localHidden, setLocalHidden] = useState<string[]>([])
  const hidden = persist?.hidden ?? localHidden
  const hide = (name: string) => { const h = [...new Set([...hidden, name])]; if (persist) persist.setHidden(h); else setLocalHidden(h) }
  useEffect(() => { setExtras([]); setLocalHidden([]) }, [resetKey])
  const nameOf = (id: string) => exercises.find(e => e.id === id)?.name

  const slots = useMemo(() => {
    const used = new Set<string>()
    const out: Slot[] = []
    for (const it of items) {
      const mine = sets.filter(s => !used.has(s.id!) && (s.setup?.slot === it.name || (!s.setup?.slot && nameOf(s.exercise_id) === it.name)))
        .sort((a, b) => a.set_index - b.set_index)
      mine.forEach(s => used.add(s.id!))
      mine.forEach(s => out.push({ key: s.id!, slot: it.name, exerciseId: s.exercise_id, setIndex: s.set_index, existing: s, defaults: it }))
      // Sets still to do, up to today's max sets for this exercise (the day's default, 1 unless the Plan says otherwise).
      const cap = maxSets?.[it.name] ?? it.max_sets ?? 1
      const lastIdx = mine.at(-1)?.set_index ?? 0
      if (!hidden.includes(it.name)) for (let k = mine.length + 1; k <= cap; k++)
        out.push({ key: k === 1 ? 'tpl:' + it.name : `tpl:${it.name}:${k}`, slot: it.name, exerciseId: mine[0]?.exercise_id ?? api.exId(it.name) ?? '', setIndex: lastIdx + (k - mine.length),
          defaults: { ...it, start_lb: mine.at(-1)?.start_weight_lb ?? it.start_lb } })
      out.push(...extras.filter(x => x.slot === it.name))
    }
    for (const s of sets.filter(s => !used.has(s.id!)).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')))
      out.push({ key: s.id!, slot: s.setup?.slot ?? null, exerciseId: s.exercise_id, setIndex: s.set_index, existing: s, defaults: {} })
    out.push(...extras.filter(x => !items.some(it => it.name === x.slot)))
    return out
  }, [items, sets, extras, hidden, exercises, maxSets])

  function addSetFor(s: Slot) {
    const idxs = [s.setIndex, ...sets.filter(x => x.exercise_id === s.exerciseId).map(x => x.set_index), ...extras.filter(x => x.exerciseId === s.exerciseId).map(x => x.setIndex)]
    const nextIdx = Math.max(...idxs) + 1
    setExtras(prev => [...prev, { key: 'x' + Math.random(), slot: s.slot, exerciseId: s.exerciseId, setIndex: nextIdx, defaults: { ...s.defaults, start_lb: s.existing?.start_weight_lb ?? s.defaults.start_lb } }])
  }
  function addExercise() {
    const key = 'x' + Math.random()
    setExtras(prev => [...prev, { key, slot: 'extra:' + Math.random().toString(36).slice(2, 8), exerciseId: '', setIndex: 1, defaults: {} }])
    return key
  }
  async function remove(s: Slot) {
    if (s.existing) {
      await api.deleteSet(s.existing.id!)
      // Deleting the last logged set of a planned exercise removes the exercise too (otherwise its plan row comes back).
      const others = sets.filter(x => x.id !== s.existing!.id && (x.setup?.slot === s.slot))
      if (s.slot && !others.length && items.some(it => it.name === s.slot)) hide(s.slot)
    }
    else if (s.key.startsWith('tpl:')) hide(s.slot!)
    else setExtras(prev => prev.filter(x => x.key !== s.key))
  }

  const saved = (s: Slot) => setExtras(prev => prev.filter(x => x.key !== s.key))
  return { slots, addSetFor, addExercise, remove, saved }
}

/** One support exercise. In the Now card it saves when you tap Log; when editing a logged one it saves as you go. */
export function SupportRow({ slot, api, onAddSet, onRemove, onSaved, mode = 'edit' }: { slot: Slot; api: Api; onAddSet: () => void; onRemove: () => void; onSaved: () => void; mode?: 'now' | 'edit' }) {
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

  const auto = mode === 'edit' || !!e
  async function save(next = v, force = false) {
    if (!next.exerciseId || (!auto && !force)) return
    const patch = {
      exercise_id: next.exerciseId, scheme: next.scheme || null, start_weight_lb: n(next.start), step_lb: n(next.step),
      drops: n(next.drops), reps: n(next.reps), notes: next.notes.trim() || null,
    }
    if (e?.id) {
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(k => (patch[k] ?? null) !== ((e as any)[k] ?? null))
      if (changed) await api.updateSet(e.id, patch)
    } else if (force || patch.start_weight_lb !== null || patch.reps !== null || patch.notes) {
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
    <div className={'sub' + (e && mode === 'edit' ? '' : '')}>
      <div className="row">
        <label className="grow">{slot.setIndex > 1 ? `Set ${slot.setIndex}` : 'Exercise'}{e ? <span className="logged"> ✓ logged</span> : null}
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
        <div className="grow field"><span className="flabel">Scheme</span>
          <SchemePicker value={v.scheme} options={schemeOptions} onChange={scheme => { const next = { ...v, scheme }; setV(next); save(next) }} />
        </div>
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
      {!auto && <button className="primary" onClick={() => save(v, true)} disabled={!v.exerciseId}>Log {label ?? 'exercise'}</button>}
    </div>
  )
}
