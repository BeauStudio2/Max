import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { SetRow } from '../../lib/types'
import { useStore } from '../../lib/store'
import { supabase } from '../../supabase'

export type Api = {
  addSet: (row: Omit<SetRow, 'session_id'>) => Promise<SetRow | null>
  updateSet: (id: string, patch: Partial<SetRow>) => Promise<void>
  deleteSet: (id: string, ask?: boolean) => Promise<void>
  exId: (name: string) => string | undefined
}

/** Text input that keeps its own draft and reports a number (or null) when you leave it. */
export function Num({ value, onSave, className, placeholder, label, step, tip }: {
  value: number | null | undefined; onSave: (v: number | null) => void; className?: string; placeholder?: string; label?: string; step?: string; tip?: string
}) {
  const [v, setV] = useState(value?.toString() ?? '')
  useEffect(() => setV(value?.toString() ?? ''), [value])
  const input = (
    <input className={label ? undefined : className} inputMode="decimal" value={v} placeholder={placeholder} step={step}
      onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      onBlur={() => { const nv = v.trim() === '' ? null : Number(v); if (nv !== (value ?? null) && !Number.isNaN(nv)) onSave(nv) }} />
  )
  return label ? <label className={className}>{tip ? <T tip={tip}>{label}</T> : label}{input}</label> : input
}

/** Hover help: dotted underline, explanation on hover or keyboard focus. */
export function T({ tip, children, pos }: { tip: string; children: React.ReactNode; pos?: 'left' | 'right' | 'center' | 'below' }) {
  return <span className="hastip" data-tip={tip} data-pos={pos ?? 'left'} tabIndex={0}>{children}</span>
}

export function Text({ value, onSave, className, placeholder, label }: {
  value: string | null | undefined; onSave: (v: string | null) => void; className?: string; placeholder?: string; label?: string
}) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  const input = <input className={label ? undefined : className} value={v} placeholder={placeholder} onChange={e => setV(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    onBlur={() => { const nv = v.trim() || null; if (nv !== (value ?? null)) onSave(nv) }} />
  return label ? <label className={className}>{label}{input}</label> : input
}

export function useClock(since?: string | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return useMemo(() => (since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0), [now, since])
}

export function fmt(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Exercise dropdown over every exercise in the library; the coach can add a new one from it. */
export function ExercisePicker({ value, onChange, label = 'Exercise', className = 'grow' }: {
  value: string; onChange: (name: string) => void; label?: string; className?: string
}) {
  const { exercises, isCoach, reload } = useStore()
  async function pick(name: string) {
    if (name !== '__new') { onChange(name); return }
    const n = window.prompt('New exercise name')?.trim()
    if (!n) return
    const { error } = await supabase.from('exercises').insert({ name: n, category: 'support' })
    if (error && !error.message.includes('duplicate')) { alert(error.message); return }
    await reload(); onChange(n)
  }
  return (
    <label className={className}>{label}
      <select value={value} onChange={e => pick(e.target.value)}>
        {!exercises.some(e => e.name === value) && <option value={value}>{value}</option>}
        {exercises.map(e => <option key={e.id} value={e.name}>{e.name}</option>)}
        {isCoach && <option value="__new">+ New exercise…</option>}
      </select>
    </label>
  )
}

/**
 * Delete in two taps instead of a browser confirm pop-up (browsers can silently block those):
 * the first tap arms it ("Delete?"), a second tap within 3 s deletes.
 */
export function DelBtn({ onConfirm, label = 'Delete', text, tip }: { onConfirm: () => void; label?: string; text?: string; tip?: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t) }, [armed])
  return (
    <button type="button" className={(text ? 'ghost small del' : 'x') + (armed ? ' armed' : '')} aria-label={armed ? `Tap again to ${label.toLowerCase()}` : label}
      data-tip={armed ? 'Tap again to confirm' : tip} data-pos="right"
      onClick={() => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) }}>
      {armed ? `${label}?` : text ?? '×'}
    </button>
  )
}
