import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session as AuthSession } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import type { Config, Equipment, Exercise, Lifter, Profile, Template } from './types'

export interface Store {
  auth: AuthSession
  profile: Profile | null
  isCoach: boolean
  lifters: Lifter[]          // lifters this person may see (all for the coach, their own otherwise)
  myLifter: Lifter | null
  equipment: Equipment[]
  exercises: Exercise[]
  templates: Template[]
  cfg: Config
  reload: () => Promise<void>
}

const Ctx = createContext<Store | null>(null)
export const useStore = () => {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}

const DEFAULT_CFG: Config = { rep_divisor: 30, chain_bottom_ratio: 0.5, chain_top_ratio: 0.5, assist_lb: 7.5, met: 6, seconds_per_rep: 4, recovery_h: 24, assisted_rep_credit: 0.5 }

export function StoreProvider({ auth, children }: { auth: AuthSession; children: ReactNode }) {
  const [state, setState] = useState<Omit<Store, 'reload' | 'auth'> | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const uid = auth.user.id
    const [p, l, e, x, t, s] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.from('lifters').select('*').order('created_at'),
      supabase.from('equipment').select('*').order('kind'),
      supabase.from('exercises').select('*').order('name'),
      supabase.from('day_templates').select('*').order('active_from', { ascending: false }),
      supabase.from('settings').select('*'),
    ])
    const err = [p, l, e, x, t, s].find(r => r.error)?.error
    if (err) { setError(err.message); return }
    const cfg = { ...DEFAULT_CFG }
    // Model numbers only; other settings (e.g. the voice choice) are read where they're used.
    for (const row of s.data ?? []) if (typeof row.value !== 'object' || row.value === null) (cfg as any)[row.key] = Number(row.value)
    const profile = (p.data as Profile) ?? null
    const lifters = (l.data as Lifter[]) ?? []
    setState({
      profile,
      isCoach: profile?.role === 'coach',
      lifters,
      myLifter: lifters.find(x => x.user_id === uid) ?? null,
      equipment: (e.data as Equipment[]) ?? [],
      exercises: (x.data as Exercise[]) ?? [],
      templates: (t.data as Template[]) ?? [],
      cfg,
    })
  }

  useEffect(() => { load() }, [auth.user.id])

  if (error) return <div className="center"><p className="err">Could not load: {error}</p></div>
  if (!state) return <div className="center muted">Loading…</div>
  return <Ctx.Provider value={{ ...state, auth, reload: load }}>{children}</Ctx.Provider>
}

/** The template in force for a weekday on a date: a lifter's own beats the shared one, newest active_from wins. */
export function templateFor(templates: Template[], lifterId: string | null, weekday: number, date: string) {
  const ok = templates.filter(t => t.weekday === weekday && t.active_from <= date)
  return ok.find(t => t.lifter_id === lifterId) ?? ok.find(t => t.lifter_id === null)
    ?? templates.find(t => t.weekday === weekday && t.lifter_id === null) ?? null
}
