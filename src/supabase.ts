import { createClient } from '@supabase/supabase-js'

// The publishable key is safe in the browser: row-level security in the database decides what each person can see.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://bxswcxqkwkswffthqgls.supabase.co'
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5koVBvlr6eQSKk2QuSbWmg_wpCFJ6gQ'

export const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
