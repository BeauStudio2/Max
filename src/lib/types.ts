export type Lift = 'bench' | 'squat' | 'deadlift'
export type Block = 'speed' | 'primary' | 'support' | 'deadlift'

export interface Profile { id: string; display_name: string | null; role: 'coach' | 'lifter' }
export interface Lifter { id: string; name: string; user_id: string | null; bodyweight_lb: number | null; settings: Record<string, any> }
export interface Equipment { id: string; kind: string; name: string; weight_lb: number | null; props: Record<string, any> }
export interface ExerciseEquipment { bar?: string | null; chains?: boolean; load?: 'bar' | 'added' | 'per_hand' | 'stack' | 'bodyweight' }
export interface Exercise { id: string; name: string; category: string; muscle_group: string | null; equipment?: ExerciseEquipment }
export interface Template { id: string; weekday: number; name: string; spec: any; active_from: string; lifter_id: string | null }

export interface Session {
  id: string; lifter_id: string; session_date: string; primary_lift: Lift | null; template_id: string | null
  sick: boolean; hurt: string | null; exclude_reason?: string | null; bodyweight_lb: number | null; notes: string | null
  planned: Record<string, any>; extra?: Record<string, any>; source: string; started_at: string | null; ended_at: string | null
}

export interface SetRow {
  id?: string; session_id: string; exercise_id: string; block: Block; set_index: number
  weight_lb: number | null; total_bottom_lb: number | null; total_top_lb: number | null
  reps: number | null; assisted: boolean; failed: boolean; rpe?: number | null; rest_s?: number | null
  scheme?: string | null; start_weight_lb?: number | null; step_lb?: number | null; drops?: number | null
  setup: Record<string, any>; notes?: string | null; created_at?: string
}

export interface Config { rep_divisor: number; chain_bottom_ratio: number; chain_top_ratio: number; assist_lb: number; met?: number; seconds_per_rep?: number; recovery_h?: number }

export interface SummaryRow {
  session_id: string; lifter_id: string; lifter: string; session_date: string; primary_lift: Lift | null
  sick: boolean; hurt: string | null; excluded: boolean; exclude_reason?: string | null; notes: string | null
  set1_weight_lb: number | null; set1_reps: number | null; set1_e1rm_lb: number | null
  sets_done: number; volume_lb: number | null; resting_hr: number | null; hrv_ms: number | null; sleep_h: number | null
}
