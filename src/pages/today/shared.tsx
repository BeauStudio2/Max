import { useEffect, useMemo, useState } from 'react'
import type { SetRow } from '../../lib/types'

export type Api = {
  addSet: (row: Omit<SetRow, 'session_id'>) => Promise<SetRow | null>
  updateSet: (id: string, patch: Partial<SetRow>) => Promise<void>
  deleteSet: (id: string, ask?: boolean) => Promise<void>
  exId: (name: string) => string | undefined
}

/** Text input that keeps its own draft and reports a number (or null) when you leave it. */
export function Num({ value, onSave, className, placeholder, label, step }: {
  value: number | null | undefined; onSave: (v: number | null) => void; className?: string; placeholder?: string; label?: string; step?: string
}) {
  const [v, setV] = useState(value?.toString() ?? '')
  useEffect(() => setV(value?.toString() ?? ''), [value])
  const input = (
    <input className={label ? undefined : className} inputMode="decimal" value={v} placeholder={placeholder} step={step}
      onChange={e => setV(e.target.value)}
      onBlur={() => { const nv = v.trim() === '' ? null : Number(v); if (nv !== (value ?? null) && !Number.isNaN(nv)) onSave(nv) }} />
  )
  return label ? <label className={className}>{label}{input}</label> : input
}

export function Text({ value, onSave, className, placeholder, label }: {
  value: string | null | undefined; onSave: (v: string | null) => void; className?: string; placeholder?: string; label?: string
}) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  const input = <input className={label ? undefined : className} value={v} placeholder={placeholder} onChange={e => setV(e.target.value)}
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
