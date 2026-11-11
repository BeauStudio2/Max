import { supabase } from '../supabase'
import type { Source } from './learn'

/* ---------- raw sensor readings ---------- */

export interface Observation { session_id: string; set_id?: string | null; rep_index?: number | null; source: Source | 'manual'; metric: string; value?: number | null; data?: Record<string, unknown>; at?: string }
/** Store raw readings (per rep or per sample) from any sensor. Best effort: a failure here never blocks logging a set. */
export async function recordObservations(rows: Observation[]) {
  if (!rows.length) return
  try { await supabase.from('observations').insert(rows) } catch { /* the set itself is already saved */ }
}
