import type { Lift } from './types'

/** Session plan fields an injury can change. They are the same keys a session saves when the workout is edited by hand. */
export const INJURY_KEYS = ['heavy_exercise', 'max_sets', 'speed_removed', 'speed_added', 'support_added', 'support_hidden', 'speed_max', 'support_max'] as const

/** A saved injury on the lifter (settings.injuries). While active, a new session for a lift it has changes for starts with them. */
export interface Injury {
  id: string
  name: string
  active: boolean
  created_at: string
  cleared_at: string | null
  overrides: Partial<Record<Lift, Record<string, any>>>
}

export const injuriesOf = (st: Record<string, any>): Injury[] => (st.injuries ?? []) as Injury[]
export const activeInjury = (st: Record<string, any>): Injury | null => injuriesOf(st).find(i => i.active) ?? null

const filled = (v: any) => v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v).length === 0)

/** The injury fields a session plan has edited. */
export function overridesFrom(planned: Record<string, any>): Record<string, any> {
  return Object.fromEntries(INJURY_KEYS.filter(k => filled(planned[k])).map(k => [k, planned[k]]))
}

/** The injury's changes for a lift, or null when it has none. */
export function changesFor(inj: Injury | null, lift: Lift): Record<string, any> | null {
  const o = inj?.overrides?.[lift]
  return o && Object.keys(o).length ? o : null
}

/** Plain-language list of what an injury changes. */
export function describeChanges(o: Record<string, any>): string[] {
  const names = (v: any) => (v as any[]).map(x => (typeof x === 'string' ? x : x.name)).join(', ')
  const caps = (v: Record<string, any>) => Object.entries(v).filter(([, n]) => n != null).map(([k, n]) => `${k} ${n}`).join(', ')
  const out: string[] = []
  if (o.heavy_exercise) out.push(`heavy lift: ${o.heavy_exercise}`)
  if (o.max_sets) out.push(`heavy sets capped at ${o.max_sets}`)
  if (o.speed_removed?.length) out.push(`speed removed: ${names(o.speed_removed)}`)
  if (o.speed_added?.length) out.push(`speed added: ${names(o.speed_added)}`)
  if (o.support_hidden?.length) out.push(`support removed: ${names(o.support_hidden)}`)
  if (o.support_added?.length) out.push(`support added: ${names(o.support_added)}`)
  if (o.speed_max && caps(o.speed_max)) out.push(`speed set caps: ${caps(o.speed_max)}`)
  if (o.support_max && caps(o.support_max)) out.push(`support set caps: ${caps(o.support_max)}`)
  return out
}
