import { crOf, fitQualifies, learn, type CrLogEntry } from '../lib/creatine'
import { Fragment, useEffect, useRef, useState, useMemo } from 'react'
import { supabase } from '../supabase'
import { templateFor, useStore } from '../lib/store'
import { perRep } from './today/Ladder'
import { BELIEFS, learnOne, measureFatigue, measureRecovery, planProbes, predictionMiss, probeBudget, type Belief, type LearnEntry, type Measurement, type SetObs } from '../lib/learn'
import { ALL_PLATES, LIFT_EXERCISE, fitFatigue, localDate, round, roundTo, weekdayOf } from '../lib/load'
import type { Lift, Session, SetRow, SummaryRow } from '../lib/types'
import { LadderPlanFields, useLadder, type LadderPlan } from './today/Ladder'
import SessionSheet, { type Block, type Placement } from './today/Sheet'
import { useSupportSlots } from './today/Support'
import { DeadliftPlanFields, useDeadlift, type DeadliftPlan } from './today/Deadlift'
import { DelBtn, ExercisePicker, Num, T, fmt, useClock, type Api } from './today/shared'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const DL_CYCLE_START = '2026-11-07'
/** Sheet rule: trap-bar weeks build 2% a week from the week-1 top; conventional weeks work off the best conventional pull. */
function dlDefaultTop(week: number | null, week1: number | null, best?: number) {
  if (!week) return week1 ? roundTo(week1, 5) : null
  if (week <= 2) return week1 ? roundTo(week1 * 1.02 ** (week - 1), 5) : null
  if (!best) return null
  return roundTo(best * ([0, 0, 0.8, 0.8, 0.85, 0.92][week - 1] ?? 0.85), 5)
}
const KEY_LABEL: Record<string, string> = { probes_on: 'test sets', probe_skip: 'skipped tests', fatigue_rep_pct: 'fatigue per rep', target_reps: 'target reps', stop_pct: 'stop %', step_lb: 'weight step', rest_s: 'rest', chain_half: '½ chains', chain_5_8: '⅝ chains',
  chains_on: 'chains on/off', plates_on: 'plates on', spotter: 'spotter', assist_min_lb: 'assist threshold', assist_min_s: 'shortest rep', clamp: 'clamps', change_plate: 'change plate', max_sets: 'max heavy sets', speed_max: 'max speed sets', support_max: 'max support sets', set1_lb: 'set 1 lb', bar_lb: 'bar',
  speed_choice: 'speed', support_choice: 'support', support_ex: 'support exercises', speed_placement: 'interleave 1', speed_offset_s: 'speed start', support_interleave: 'interleave 2', block_order: 'block order' }
const pick = <T,>(...vals: (T | null | undefined)[]) => vals.find(v => v !== null && v !== undefined) as T | undefined

export default function Today({ lifterId }: { lifterId: string }) {
  const { templates, lifters, exercises, reload, cfg } = useStore()
  const lifter = lifters.find(l => l.id === lifterId)
  const st = lifter?.settings ?? {}
  const [date, setDate] = useState(localDate())
  const tpl = templateFor(templates, lifterId, weekdayOf(date), date)
  const planLift: Lift = tpl?.spec?.heavy?.lift ?? 'bench'
  const [lift, setLift] = useState<Lift>(planLift)
  useEffect(() => setLift(planLift), [planLift, date])

  const [session, setSession] = useState<Session | null>(null)
  const [sets, setSets] = useState<SetRow[]>([])
  const [history, setHistory] = useState<SummaryRow[]>([])
  const [prevPlan, setPrevPlan] = useState<Record<string, any>>({})
  const [err, setErr] = useState<string | null>(null)

  // A session whose data was corrected by hand and must not be removed from the app.
  const LOCKED = ['0def149c-5840-425a-817e-68e42f847301']
  /** Clear day: delete this day's session with everything logged in it (sets, sensor readings, film), back to a blank day. */
  const [clearing, setClearing] = useState<'ask' | 'busy' | 'done' | null>(null)
  const [cleared, setCleared] = useState(0)
  async function clearDay() {
    if (!session?.id || LOCKED.includes(session.id)) return
    const id = session.id
    setClearing('busy')
    const { data: films } = await supabase.storage.from('video').list(id, { limit: 1000 })
    if (films?.length) await supabase.storage.from('video').remove(films.map(f => `${id}/${f.name}`))
    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) { setErr(error.message); setClearing(null); return }
    await load()
    setCleared(n => n + 1); setClearing('done'); setTimeout(() => setClearing(c => (c === 'done' ? null : c)), 2500)
  }

  const loadSeq = useRef(0)
  /** Which person, day and lift the data on screen belongs to (null while a switch is loading). */
  const [shown, setShown] = useState<string | null>(null)
  const shownRef = useRef<string | null>(null)
  // Only the latest load may write: changing the date changes the lift a moment later, and the first (stale) load must not win.
  async function load() {
    const my = ++loadSeq.current, stale = () => my !== loadSeq.current
    const want = `${lifterId}|${date}|${lift}`
    // Switching person, day or lift: take the old sheet off screen at once, so nothing typed, spoken or sensed lands on the wrong one.
    if (shownRef.current !== want) { shownRef.current = null; setShown(null); setSession(null); setSets([]) }
    setErr(null)
    const { data: s, error } = await supabase.from('sessions').select('*')
      .eq('lifter_id', lifterId).eq('session_date', date).eq('primary_lift', lift).maybeSingle()
    if (stale()) return
    if (error) { setErr(error.message); return }
    setSession(s as Session | null)
    if (s) {
      const { data } = await supabase.from('sets').select('*').eq('session_id', s.id).order('set_index')
      if (stale()) return
      setSets((data as SetRow[]) ?? [])
    } else setSets([])
    const [{ data: h }, { data: p }] = await Promise.all([
      supabase.from('session_summary').select('*').eq('lifter_id', lifterId).eq('primary_lift', lift)
        .lt('session_date', date).order('session_date', { ascending: false }).limit(30),
      supabase.from('sessions').select('id, session_date, primary_lift, planned, sick, hurt, exclude_reason').eq('lifter_id', lifterId)
        .lt('session_date', date).order('session_date', { ascending: false }).limit(60),
    ])
    if (stale()) return
    setHistory((h as SummaryRow[]) ?? [])
    // The plan carries forward from the last session of the same exercise (a substitute has its own history).
    const exOf = (x: any) => x?.planned?.heavy_exercise ?? LIFT_EXERCISE[x?.primary_lift ?? lift]
    const heavyNow = (s as any)?.planned?.heavy_exercise ?? LIFT_EXERCISE[lift]
    const prev = (p ?? []).find(x => exOf(x) === heavyNow)
    const heavyId = exercises.find(e => e.name === heavyNow)?.id
    // Only results carry forward (planned max, fatigue); program settings come from the Plan page.
    const pp: Record<string, any> = (prev?.planned as Record<string, any>) ?? {}
    const carried: Record<string, any> = {
      planned_e1rm: pp.planned_e1rm ?? pp.snap?.plan?.planned_e1rm, fatigue_rate_used_pct: pp.fatigue_rate_used_pct ?? pp.snap?.plan?.fatigue_rate_used_pct,
    }
    if (prev && !prev.sick && !prev.hurt?.trim() && !prev.exclude_reason?.trim()) {
      // Same rule as the sheet: a healthy previous session hands on its actual set-1 max and its fitted fatigue rate.
      let q = supabase.from('set_estimates').select('set_index, e1rm_lb').eq('session_id', prev.id).in('block', ['primary', 'deadlift'])
      if (heavyId) q = q.eq('exercise_id', heavyId)
      const { data: est } = await q.order('set_index')
      const e = (est ?? []).map(r => (r.e1rm_lb === null ? null : Number(r.e1rm_lb)))
      if (e[0]) carried.planned_e1rm = Math.round(e[0])
      const fit = fitFatigue(e)
      if (fit && fit.ratePct > 0) carried.fatigue_rate_used_pct = Math.round(fit.ratePct * 100) / 100
      carried.from = prev.session_date
    } else if (prev) carried.from = prev.session_date + ' (excluded: its planned values)'
    if (stale()) return
    setPrevPlan(carried)
    shownRef.current = want; setShown(want)
  }
  useEffect(() => { if (lifterId) load() }, [lifterId, date, lift])

  async function ensureSession(patch: Partial<Session> = {}): Promise<Session | null> {
    if (session) {
      if (Object.keys(patch).length === 0) return session
      const { data, error } = await supabase.from('sessions').update(patch).eq('id', session.id).select().single()
      if (error) { setErr(error.message); return null }
      setSession(data as Session); return data as Session
    }
    const { data, error } = await supabase.from('sessions').insert({
      lifter_id: lifterId, session_date: date, primary_lift: lift, template_id: tpl?.id ?? null,
      source: 'app',
      planned: {}, ...patch,
    }).select().single()
    if (error) { setErr(error.message); return null }
    setSession(data as Session); return data as Session
  }

  const ladderPlanRef = useRef<Record<string, any>>({})
  const dlPlanRef = useRef<Record<string, any>>({})
  const exId = (name: string) => exercises.find(e => e.name === name)?.id
  const api: Api = {
    exId,
    async addSet(row) {
      let s = await ensureSession()
      if (!s) return null
      // The first logged set freezes the plan as it stood, so later Plan edits don't rewrite this session once it's past.
      if (!(s.planned as any)?.snap) s = await freeze(s) ?? s
      // Logging a set after Finish (pressed early, or by mistake) reopens the workout so the clocks keep running.
      if (s.started_at && s.ended_at) s = await ensureSession({ ended_at: null }) ?? s
      const { data, error } = await supabase.from('sets').insert({ ...row, session_id: s.id }).select().single()
      if (error) { setErr(error.message); return null }
      setSets(prev => [...prev, data as SetRow]); return data as SetRow
    },
    async updateSet(id, patch) {
      const { data, error } = await supabase.from('sets').update(patch).eq('id', id).select().single()
      if (error) { setErr(error.message); return }
      setSets(prev => prev.map(r => (r.id === id ? (data as SetRow) : r)))
    },
    async deleteSet(id) {
      const { error } = await supabase.from('sets').delete().eq('id', id)
      if (error) { setErr(error.message); return }
      setSets(prev => prev.filter(r => r.id !== id))
    },
  }

  // Inheritance: this session's own edits → (once past) the plan frozen at its first set → the day's Plan → lifter → defaults.
  const { snap, ...sp } = (session?.planned ?? {}) as Record<string, any>
  const past = date < localDate()
  const frozen: Record<string, any> = past && snap?.plan ? snap.plan : {}
  const spec: any = (past && snap?.spec) ? snap.spec : tpl?.spec ?? {}
  const hv: any = spec.heavy ?? {}
  const heavyDefault = LIFT_EXERCISE[lift]
  const heavyEx: string = sp.heavy_exercise ?? heavyDefault
  const isMainEx = heavyEx === heavyDefault
  const exEquip = exercises.find(e => e.name === heavyEx)?.equipment ?? {}
  const valid = history.filter(h => !h.excluded && h.set1_e1rm_lb)
  const currentMax = isMainEx && valid[0] ? Number(valid[0].set1_e1rm_lb) : null

  // The heavy block's settings come from today's plan, or from the day that programs this lift if heavy was switched.
  const H: any = hv.lift === lift ? hv : templates.map(t => t.spec?.heavy).find(h => h?.lift === lift) ?? {}
  const f = frozen
  const ladderPlan: LadderPlan = {
    planned_e1rm: pick(sp.planned_e1rm, f.planned_e1rm, prevPlan.planned_e1rm, isMainEx ? st.planned_e1rm?.[lift] : st.planned_e1rm?.[heavyEx], currentMax) ?? null,
    target_reps: pick(sp.target_reps, f.target_reps, H.target_reps, st.target_reps?.[lift]) ?? 5,
    stop_pct: pick(sp.stop_pct, f.stop_pct, H.stop_pct, st.stop_pct?.[lift]) ?? 70,
    fatigue_rate_used_pct: pick(sp.fatigue_rate_used_pct, f.fatigue_rate_used_pct, prevPlan.fatigue_rate_used_pct, st.fatigue_pct?.[lift]) ?? 3,
    // Fatigue is planned per rep: the estimated max falls this % for every rep done. Until one is set (session → lifter), it's the per-set rate spread over the target reps.
    fatigue_rep_pct: pick(sp.fatigue_rep_pct, f.fatigue_rep_pct, st.fatigue_rep_pct?.[lift]) as number | undefined,
    rest_s: pick(sp.rest_s, f.rest_s, H.rest_s, st.rest_s) ?? 100,
    // Chains are the lifter's (Profile → chain setup): the shared day plan only fills in for a lifter who has none.
    chain_half: pick(sp.chain_half, f.chain_half, st.chain_setup?.[lift]?.chain_half, H.chain_half) ?? 0,
    chain_5_8: pick(sp.chain_5_8, f.chain_5_8, st.chain_setup?.[lift]?.chain_5_8, H.chain_5_8) ?? 0,
    clamp: pick(sp.clamp, f.clamp, st.default_clamp) ?? 'Rogue aluminum clamps (pair)',
    // Chain geometry is the lifter's (Profile): range of motion, and how much chain hangs off the floor at the bottom. Until the hang is entered, the chains' measured weights are used.
    rom_in: pick(f.rom_in, st.chain_geometry?.[lift]?.rom_in) ?? null,
    hang_in: pick(f.hang_in, st.chain_geometry?.[lift]?.hang_in) ?? null,
    // No equipment set on the exercise: only the main barbell lifts get a bar; anything else is a plain load.
    bar: 'bar' in exEquip ? exEquip.bar ?? null : (exercises.find(e => e.name === heavyEx)?.category === 'primary' || isMainEx ? 'Ohio Power Bar' : null),
    chains_ok: exEquip.chains ?? isMainEx,
    load: exEquip.load ?? (isMainEx ? 'bar' : 'added'),
    implement: exEquip.bar ? null : exEquip.implement ?? null,
    plates_on: pick(sp.plates_on, f.plates_on, H.plates_on, st.plates_on) ?? ALL_PLATES,
    // Smallest jump the plates that are on can make: two of the smallest plate.
    step_lb: 2 * Math.min(...((pick(sp.plates_on, f.plates_on, H.plates_on, st.plates_on) as number[] | undefined)?.length ? pick(sp.plates_on, f.plates_on, H.plates_on, st.plates_on) as number[] : ALL_PLATES)),
    chains_on: pick(sp.chains_on, f.chains_on, H.chains_on) ?? true,
    change_plate: pick(sp.change_plate, f.change_plate, H.change_plate) ?? 10,
    max_sets: pick(sp.max_sets) ?? null,
    set1_lb: pick(sp.set1_lb, f.set1_lb) ?? null,
    // Auto spotter is off until switched on in the plan panel; set 1 is a normal set either way.
    spotter: pick(sp.spotter, f.spotter, H.spotter) ?? false,
    // S switched on or off on single sets: these decide how each of those sets is planned; Auto spotter is only the default.
    spot_rows: (sp.spot_rows as Record<string, boolean> | undefined) ?? {},
    assist_min_lb: pick(sp.assist_min_lb, f.assist_min_lb, H.assist_min_lb) ?? 3,
    assist_min_s: pick(sp.assist_min_s, f.assist_min_s, H.assist_min_s) ?? 0.25,
    cr: st.creatine?.[lift],
  }

  // Colour code: typed for this session → the lifter's settings or the Plan page → otherwise carried from the last session by Max.
  const planSrc = (k: string): 'def' | 'dyn' | 'user' => {
    if (sp[k] !== undefined && sp[k] !== null) return 'user'
    if (k === 'planned_e1rm') return ladderPlan.planned_e1rm !== null && ladderPlan.planned_e1rm === (isMainEx ? st.planned_e1rm?.[lift] : st.planned_e1rm?.[heavyEx]) && prevPlan.planned_e1rm == null ? 'def' : 'dyn'
    if (k === 'fatigue_rep_pct') return st.fatigue_rep_pct?.[lift] != null || f.fatigue_rep_pct != null ? 'def' : 'dyn'
    return 'def'
  }

  const dlWeek = (() => {
    const days = Math.round((Date.parse(date) - Date.parse(DL_CYCLE_START)) / 86400000)
    return days < 0 ? null : (Math.floor(days / 7) % 6) + 1
  })()
  const cycle: any[] | undefined = spec.deadlift_cycle ?? tpl?.spec?.deadlift_cycle ?? templates.find(t => t.spec?.deadlift_cycle)?.spec?.deadlift_cycle
  const wk = dlWeek && cycle ? cycle.find(c => c.week === dlWeek) : null
  const best = st.deadlift_best_conventional_lb as number | undefined
  const dlPlan: DeadliftPlan = {
    planned_top_lb: pick(sp.planned_top_lb, frozen.planned_top_lb, dlDefaultTop(dlWeek, st.deadlift_planned_top_lb ?? (best ? best * 0.825 : null), best)) ?? null,
    bar_lb: pick(sp.bar_lb, frozen.bar_lb) ?? (String(wk?.bar ?? wk?.pull ?? '').toLowerCase().includes('trap') ? 85 : 45),
    rest_s: pick(sp.rest_s, frozen.rest_s, H.rest_s) ?? 180,
    plates_on: pick(sp.plates_on, frozen.plates_on, H.plates_on, st.plates_on) ?? ALL_PLATES,
  }

  ladderPlanRef.current = ladderPlan
  dlPlanRef.current = dlPlan
  // The exercise's own equipment (bar, chains, load) is looked up each time, not frozen into the session plan.
  const strip = ({ bar, chains_ok, load, implement, cr, ...rest }: Record<string, any>) => rest
  // Fitted creatine numbers are the lifter's, per lift: saved on their settings so every later session uses them.
  // Bands used on each speed exercise are kept on the lifter, so the next session starts with them.
  async function saveSpeedBands(exercise: string, bands: { name: string; per_side: number }[]) {
    if (!lifter) return
    const cur = st.speed_bands ?? {}
    if (JSON.stringify(cur[exercise] ?? null) === JSON.stringify(bands)) return
    const { error } = await supabase.from('lifters').update({ settings: { ...st, speed_bands: { ...cur, [exercise]: bands } } }).eq('id', lifter.id)
    if (error) setErr(error.message); else await reload()
  }
  // After a session with enough Tindeq data, the lifter's creatine numbers for this lift move a quarter of the way toward what it measured.
  // Done per session (recomputed from the numbers before it as more sets come in), logged on the lifter, and undoable on Profile.
  // The workout clock runs from Start workout to Finish. A set logged after Finish means the workout carried on, so the clock (and rest timer) keep running.
  const running = !!session?.started_at && (!session?.ended_at || sets.some(x => !!x.created_at && x.created_at > session.ended_at!))
  // ---- Learning: beliefs, test sets, and the update after each session ----
  const beliefs: Record<string, Belief> = { ...Object.fromEntries(BELIEFS.map(d => [d.key, d.key === 'fatigue_rep_pct' ? { ...d.init, value: perRep(ladderPlan) } : d.init])), ...(st.beliefs?.[lift] ?? {}) }
  const recentMiss: number | null = (() => { const m = (st.pred_miss?.[lift] ?? []) as { miss: number }[]; return m.length ? m.slice(0, 3).reduce((t, x) => t + x.miss, 0) / Math.min(3, m.length) : null })()
  const budget = probeBudget(beliefs, recentMiss)
  const probesOn = lift !== 'deadlift' && (sp.probes_on ?? st.probes_on ?? true)
  const probes = useMemo(() => {
    if (!probesOn) return {}
    const all = planProbes(`${lifterId}:${date}:${lift}`, budget, ladderPlan.rest_s)
    const skip = (sp.probe_skip ?? {}) as Record<string, boolean>
    return Object.fromEntries(Object.entries(all).filter(([i]) => !skip[i]))
  }, [probesOn, lifterId, date, lift, budget.share, budget.count, ladderPlan.rest_s, JSON.stringify(sp.probe_skip ?? {})])
  const [obs, setObs] = useState<SetObs[]>([])
  // Once the workout is finished (or the day is past), Max updates what she believes about this lifter and lift from the session.
  // One entry per session and belief, recomputed from the belief as it stood before the session if more sets come in.
  async function learnSession(o: SetObs[]) {
    if (!lifter || !session?.id || lift === 'deadlift') return
    const off = !!session.sick || !!session.hurt?.trim()
    const log: LearnEntry[] = st.belief_log ?? []
    // With rests that differ, recovery and fatigue are fitted together; otherwise fatigue alone, from the fall across the session.
    const both = measureRecovery(o)
    const measured: Record<string, Measurement | null> = { fatigue_rep_pct: both?.fatigue ?? measureFatigue(o), recovery_half_s: both?.recovery ?? null }
    let nextLog = log, nextBeliefs = { ...(st.beliefs?.[lift] ?? {}) } as Record<string, Belief>, changed = false
    for (const d of BELIEFS) {
      const m = measured[d.key]
      const prior = log.find(e => e.session === session.id && e.lift === lift && e.key === d.key)
      if (!m || prior?.undone) continue
      const before = prior?.before ?? beliefs[d.key]
      const healthy = log.filter(e => e.lift === lift && e.key === d.key && !e.off && !e.flag && !e.undone && e.session !== session.id).map(e => e.measured.value)
      const { after, flag } = learnOne(d, before, m, off, healthy)
      if (prior && Math.abs(prior.measured.value - m.value) < 1e-6 && prior.flag === flag) continue
      const entry: LearnEntry = { session: session.id, date, lift, key: d.key, before, measured: m, after, flag, off, at: new Date().toISOString() }
      nextLog = [entry, ...nextLog.filter(e => !(e.session === session.id && e.lift === lift && e.key === d.key))].slice(0, 120)
      nextBeliefs = { ...nextBeliefs, [d.key]: after }; changed = true
    }
    const miss = predictionMiss(o)
    const pm = (st.pred_miss?.[lift] ?? []) as { session: string; date: string; miss: number; n: number }[]
    const missChanged = miss && !(pm[0]?.session === session.id && Math.abs(pm[0].miss - miss.miss) < 1e-6)
    if (!changed && !missChanged) return
    const settings = { ...st, beliefs: { ...(st.beliefs ?? {}), [lift]: nextBeliefs }, belief_log: nextLog,
      // Planning reads the fatigue rate from the lifter's settings: keep it in step with the belief.
      fatigue_rep_pct: nextBeliefs.fatigue_rep_pct ? { ...(st.fatigue_rep_pct ?? {}), [lift]: Math.round(nextBeliefs.fatigue_rep_pct.value * 1000) / 1000 } : st.fatigue_rep_pct,
      pred_miss: miss ? { ...(st.pred_miss ?? {}), [lift]: [{ session: session.id, date, miss: Math.round(miss.miss * 100) / 100, n: miss.n }, ...pm.filter(x => x.session !== session.id)].slice(0, 10) } : st.pred_miss }
    const { error } = await supabase.from('lifters').update({ settings }).eq('id', lifter.id)
    if (error) setErr(error.message); else await reload()
  }
  // Only sessions just done teach her (today's once finished, or yesterday's): browsing old sessions never changes what she believes.
  const yesterday = localDate(new Date(Date.now() - 864e5))
  const finished = !!session?.id && !running && ((date === localDate() && !!session.ended_at) || date === yesterday)
  const obsKey = JSON.stringify(obs)
  useEffect(() => { if (finished && obs.length >= 4) learnSession(obs) }, [finished, obsKey, session?.sick, session?.hurt])

  async function autoFit(fit: { cost: number | null; costN: number; half_s: number | null; halfN: number }) {
    if (!lifter || !session?.id || !fitQualifies(fit)) return
    const log: CrLogEntry[] = st.creatine_log ?? []
    const prior = log.find(e => e.session === session.id && e.lift === lift)
    if (prior?.undone) return
    const cur = { ...crOf(cfg), ...(st.creatine?.[lift] ?? {}) }
    const before = prior?.before ?? { half_s: cur.half_s, cost: cur.cost }
    const fitted = { half_s: fit.half_s, cost: fit.cost }
    const { after, rejected } = learn(before, fitted)
    if (prior && Math.round(prior.after.half_s) === Math.round(after.half_s) && Math.round(prior.after.cost * 1000) === Math.round(after.cost * 1000) && prior.rejected.length === rejected.length) return
    const entry: CrLogEntry = { session: session.id, date, lift, before, fitted, after, rejected, at: new Date().toISOString() }
    const creatine = { ...(st.creatine ?? {}), [lift]: { ...(st.creatine?.[lift] ?? {}), half_s: after.half_s, cost: after.cost } }
    const nextLog = [entry, ...log.filter(e => !(e.session === session.id && e.lift === lift))].slice(0, 60)
    const { error } = await supabase.from('lifters').update({ settings: { ...st, creatine, creatine_log: nextLog } }).eq('id', lifter.id)
    if (error) setErr(error.message); else await reload()
  }
  async function applyFit(patch: Record<string, number>) {
    if (!lifter) return
    const creatine = { ...(st.creatine ?? {}), [lift]: { ...(st.creatine?.[lift] ?? {}), ...patch } }
    const { error } = await supabase.from('lifters').update({ settings: { ...st, creatine } }).eq('id', lifter.id)
    if (error) setErr(error.message); else await reload()
  }
  // Saving writes only what was edited, so everything else keeps following the Plan page.
  const own = () => (session?.planned ?? {}) as Record<string, any>
  const savePlan = (_base: Record<string, any>) => (patch: Record<string, any>) => ensureSession({ planned: strip({ ...own(), ...patch }) })
  async function freeze(s: Session) {
    const plan = { ...strip(lift === 'deadlift' ? dlPlanRef.current : ladderPlanRef.current), speed_placement: placement, support_interleave: supInter, block_order: order }
    const { deadlift_cycle, ...daySpec } = tpl?.spec ?? {}
    const snapSpec = { ...daySpec, speed: speedFor ?? daySpec.speed ?? null, support: support ?? daySpec.support ?? null, deadlift_cycle: deadlift_cycle ? deadlift_cycle : undefined }
    const { data, error } = await supabase.from('sessions').update({ planned: { ...((s.planned as any) ?? {}), snap: { plan, spec: snapSpec, at: new Date().toISOString() } } }).eq('id', s.id).select().single()
    if (error) { setErr(error.message); return null }
    setSession(data as Session); return data as Session
  }
  /** Fields this session has edited itself (they no longer follow the Plan page). */
  const PROGRAM_KEYS = ['probes_on', 'probe_skip', 'fatigue_rep_pct', 'target_reps', 'stop_pct', 'step_lb', 'rest_s', 'chain_half', 'chain_5_8', 'chains_on', 'plates_on', 'spotter', 'assist_min_lb', 'assist_min_s', 'clamp', 'change_plate', 'max_sets', 'speed_max', 'support_max', 'set1_lb', 'bar_lb', 'speed_choice', 'support_choice', 'support_ex', 'speed_placement', 'speed_offset_s', 'support_interleave', 'block_order']
  const edited = PROGRAM_KEYS.filter(k => sp[k] !== undefined && sp[k] !== null)
  const resetEdits = () => ensureSession({ planned: Object.fromEntries(Object.entries(own()).filter(([k]) => !PROGRAM_KEYS.includes(k))) })

  // Every block is a choice: the day's plan is the default, any other day's block can be picked instead.
  const speedOptions = new Map<string, any>()
  const supportOptions = new Map<string, any>()
  for (const t of [...templates].sort((a, b) => a.weekday - b.weekday)) {
    if (t.spec?.speed?.lift && !speedOptions.has(t.spec.speed.lift)) speedOptions.set(t.spec.speed.lift, t.spec.speed)
    if (t.spec?.support?.group && !supportOptions.has(t.spec.support.group)) supportOptions.set(t.spec.support.group, t.spec.support)
  }
  // Speed pairs with the other lift: heavy squat gets speed bench and heavy bench gets speed squat, whatever the day planned.
  const pairedSpeed = lift === 'squat' ? 'bench' : lift === 'bench' ? 'squat' : null
  const speedKey: string = sp.speed_choice ?? (lift === planLift ? spec.speed?.lift : pairedSpeed) ?? 'none'
  const supportKey: string = sp.support_choice ?? spec.support?.group ?? 'none'
  // A past session shows the speed and support it was planned with, not today's versions.
  const speedFor = (past && snap?.spec?.speed?.lift === speedKey ? snap.spec.speed : null) ?? (spec.speed?.lift === speedKey ? spec.speed : null) ?? speedOptions.get(speedKey) ?? null
  const support = (past && snap?.spec?.support?.group === supportKey ? snap.spec.support : null) ?? (spec.support?.group === supportKey ? spec.support : null) ?? supportOptions.get(supportKey) ?? null
  const savePlanned = (patch: Record<string, any>) => ensureSession({ planned: strip({ ...own(), ...patch }) })
  const choose = (k: 'speed_choice' | 'support_choice', v: string) => savePlanned({ [k]: v })

  // Exercise choices for the heavy block and each speed slot; switching also relabels sets already logged there.
  const heavyBlock = lift === 'deadlift' ? 'deadlift' : 'primary'
  const relabel = async (rows: SetRow[], name: string) => {
    const id = exId(name)
    if (!id) return
    for (const r of rows) if (r.exercise_id !== id) await api.updateSet(r.id!, { exercise_id: id })
  }
  async function setHeavyEx(name: string) {
    const oldId = exId(heavyEx)
    await relabel(sets.filter(r => r.block === heavyBlock && r.exercise_id === oldId), name)
    // A different exercise brings its own plan: forget this session's max, fatigue and bar setup so they reload for it.
    await savePlanned({ heavy_exercise: name, planned_e1rm: undefined, fatigue_rate_used_pct: undefined, clamp: undefined,
      chain_half: undefined, chain_5_8: undefined, set1_lb: undefined, max_sets: undefined })
    await load()
  }
  const speedSlotSets = (it: any) => sets.filter(s => s.block === 'speed' && (s.setup?.slot === it.name || (!s.setup?.slot && s.exercise_id === exId(it.name))))
  const speedEx = (it: any): string => sp.speed_ex?.[it.name] ?? it.name
  async function setSpeedEx(it: any, name: string) {
    await relabel(speedSlotSets(it), name)
    await savePlanned({ speed_ex: { ...(sp.speed_ex ?? {}), [it.name]: name } })
  }
  const elapsed = useClock(session?.started_at && !session.ended_at ? session.started_at : null)
  const L = useLadder(ladderPlan, sets.filter(s => s.block === 'primary'))
  const placement: Placement = pick(sp.speed_placement, frozen.speed_placement, spec.speed_placement) ?? 'between'
  const supInter: boolean = pick(sp.support_interleave, frozen.support_interleave, spec.support_interleave) ?? false
  // Block order for the workout, and whether each neighbouring pair is interleaved.
  const order: Block[] = pick(sp.block_order, frozen.block_order, spec.block_order) ?? (placement === 'first' ? ['speed', 'heavy', 'support'] : ['heavy', 'speed', 'support'])
  const joins = [placement === 'between', supInter]
  const move = (i: number, d: number) => { const o = [...order];[o[i], o[i + d]] = [o[i + d], o[i]]; savePlanned({ block_order: o }) }
  // Per-exercise caps for today (blank = as planned): speed by plan item, support by exercise slot.
  const speedMax: Record<string, number> = sp.speed_max ?? {}
  const supportMax: Record<string, number> = sp.support_max ?? {}
  const clean = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''))
  const D = useDeadlift({ week: dlWeek, cycle, plan: dlPlan, sets: sets.filter(s => s.block === 'deadlift'), api, exerciseName: heavyEx, resetKey: date + lift })
  const S = useSupportSlots(support, sets.filter(s => s.block === 'support'), api, date + lift + supportKey,
    { hidden: (sp.support_hidden as string[] | undefined) ?? [], setHidden: h => { savePlanned({ support_hidden: h }) } }, supportMax, sp.support_ex)
  const supportNames = [...new Set(S.slots.map(x => x.slot ?? '').filter(n => n && !n.startsWith('extra:')))]
  const [planOpen, setPlanOpen] = useState(false)

  return (
    <div className="stack today">
      <section className="card">
        <div className="row wrap">
          <label className="grow">Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        </div>
        <div className="choices">
          {order.map((blk, i) => (
            <Fragment key={blk}>
              {i > 0 && <Interleave on={joins[i - 1]} a={order[i - 1]} b={blk} onToggle={() => savePlanned(i === 1 ? { speed_placement: joins[0] ? 'after' : 'between' } : { support_interleave: !joins[1] })} />}
              <label>
                <span className="blockhead">
                  <T tip={BLOCK_TIP[blk]}>{blk[0].toUpperCase() + blk.slice(1)}</T>
                  <span className="movers">
                    <button type="button" className="mover" disabled={i === 0} onClick={e => { e.preventDefault(); move(i, -1) }} aria-label={`Move ${blk} up (earlier)`} data-tip={`Move ${blk} up: earlier in the workout`} data-pos="center">▲</button>
                    <button type="button" className="mover" disabled={i === order.length - 1} onClick={e => { e.preventDefault(); move(i, 1) }} aria-label={`Move ${blk} down (later)`} data-tip={`Move ${blk} down: later in the workout`} data-pos="right">▼</button>
                  </span>
                </span>
                {blk === 'heavy' ? (
                  <select value={lift} onChange={e => setLift(e.target.value as Lift)}>
                    <option value="squat">Squat</option><option value="bench">Bench</option><option value="deadlift">Deadlift</option>
                  </select>
                ) : blk === 'speed' ? (
                  <select value={speedKey} onChange={e => choose('speed_choice', e.target.value)}>
                    <option value="none">None</option>
                    {[...speedOptions.keys()].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                  </select>
                ) : (
                  <select value={supportKey} onChange={e => choose('support_choice', e.target.value)}>
                    <option value="none">None</option>
                    {[...supportOptions.keys()].map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                )}
              </label>
            </Fragment>
          ))}
        </div>
        <Status session={session} save={ensureSession} />
        <div className="timer">
          {!session?.started_at ? (
            <button className="primary" data-tip="Starts the session clock. Duration, calories and the earliest next session come from it." data-pos="center" onClick={() => ensureSession({ started_at: new Date().toISOString(), ended_at: null })}>▶ Start workout</button>
          ) : !session.ended_at ? (
            <>
              <div><span className="small muted">Started {clock(session.started_at)}</span><b className="elapsed">{fmt(elapsed)}</b></div>
              <button className="ghost" data-tip="Stops the clock and records the end time." data-pos="right" onClick={() => ensureSession({ ended_at: new Date().toISOString() })}>■ Finish</button>
            </>
          ) : (
            <>
              <div><span className="small muted">{clock(session.started_at)} – {clock(session.ended_at)}</span>
                <b className="elapsed">{fmt(Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000))}</b></div>
              <button className="ghost small" data-tip="Keeps the original start time and clears the finish." data-pos="right" onClick={() => ensureSession({ ended_at: null })}>Resume</button>
              <DelBtn label="Reset" text="Reset" tip="Clears start and finish times. Logged sets are kept." onConfirm={() => ensureSession({ started_at: null, ended_at: null })} />
            </>
          )}
        </div>
        <div className="clearday">
          {clearing === 'ask' ? (
            <>
              <span className="small">Delete {sets.length === 1 ? "the 1 set and " : sets.length ? `all ${sets.length} sets and ` : ""}everything saved for {heavyEx} on {date}?</span>
              <button type="button" className="small danger" onClick={clearDay}>Delete</button>
              <button type="button" className="ghost small" onClick={() => setClearing(null)}>Cancel</button>
            </>
          ) : clearing === 'busy' ? <span className="small muted">Clearing…</span>
            : clearing === 'done' ? <span className="small ok">Day cleared.</span>
            : <button type="button" className="ghost small" disabled={!session?.id || LOCKED.includes(session.id)} onClick={() => setClearing('ask')} data-pos="right"
                data-tip={!session?.id ? 'Nothing is saved for this lift on this day yet, so there is nothing to clear.' : LOCKED.includes(session.id) ? 'This session was corrected by hand and is protected: it cannot be cleared from here.' : 'Deletes everything logged for this lift on this day (sets, notes, times, sensor readings, film) and starts the day blank. Asks first.'}>Clear day</button>}
        </div>
        <SessionStats session={session} sets={sets} volume={L?.volume ?? null} bwDefault={lifter?.bodyweight_lb ?? st.bodyweight_lb ?? null} lifterId={lifter?.id} date={date} />
      </section>

      {err && <p className="err">{err}</p>}

      <section className="card">
        <button className="planhead" onClick={() => setPlanOpen(o => !o)} aria-expanded={planOpen} data-tip="Tap to open: planned max, reps, stop line, fatigue, plates, chains and the exercises for today." data-pos="left">
          <h2 style={{ margin: 0 }}>Plan · {lift}{lift === 'deadlift' && dlWeek ? ` week ${dlWeek}` : ''}</h2>
          <span className="small muted">{lift === 'deadlift'
            ? `top ${dlPlan.planned_top_lb ?? '—'} · bar ${dlPlan.bar_lb} · rest ${dlPlan.rest_s}s`
            : `${ladderPlan.planned_e1rm ? `max ${round(ladderPlan.planned_e1rm)} · ` : ''}${ladderPlan.target_reps} reps · stop ${ladderPlan.stop_pct}% · ${perRep(ladderPlan).toFixed(2)}%/rep`} {planOpen ? '▴' : '▾'}</span>
        </button>
        {planOpen && (
          <div className="planbody">
            <ExercisePicker label="Main exercise" value={heavyEx} onChange={setHeavyEx} className="exrow mainex" />
            {lift === 'deadlift'
              ? <DeadliftPlanFields D={D} setPlan={savePlan(dlPlan)} best={best} />
              : <LadderPlanFields L={L} src={planSrc} setPlan={savePlan(ladderPlan)} carriedFrom={sp.planned_e1rm === undefined ? prevPlan.from : undefined} currentMax={currentMax} lifterGeometry={st.chain_geometry?.[lift]} />}
            {lift !== 'deadlift' && (
              <div className="planfields probeline">
                <label className="toggle"><T tip="Test sets: Max deliberately makes the rest before some sets short or long, in random order, to learn how fast this lifter recovers. They're marked on the sheet and each can be skipped. She tests a lot while she's unsure and about once a session once she's settled. What she has learned is on Profile.">Test sets</T>
                  <button type="button" className={'switch' + (probesOn ? ' on' : '')} aria-pressed={probesOn} onClick={() => savePlanned({ probes_on: !probesOn })}>{probesOn ? 'On' : 'Off'}</button>
                </label>
                {probesOn && <span className="small muted probewhy">{budget.count ? `${budget.count} today` : `up to ${Math.round(budget.share * 100)}% of sets`}: {budget.why}</span>}
              </div>
            )}
            {edited.length > 0 && (
              <p className="small edited">
                <T tip="These were changed on this session, so they no longer follow the Plan page. Everything else still does.">Edited for this session</T>: {edited.map(k => KEY_LABEL[k] ?? k).join(', ')}
                {' · '}<button className="linkish" onClick={resetEdits} data-tip="Clear this session's edits so it follows the Plan page again." data-pos="right">Use the Plan</button>
              </p>
            )}
            {past && snap && <p className="small muted">Past session: shows the plan as it stood when its first set was logged. Plan page edits don't change it.</p>}
            {(speedFor?.items?.length || S.slots.length) ? (
              <div className="caps">
                <p className="small"><T tip="Pick the exercise for each slot today; any single set can still be switched in its row. The number is the most sets of it today. Speed blank: as planned (one round per heavy set when interleaved). Support starts at the Plan's number, usually 1. 0 skips it today.">Exercises today · max sets</T></p>
                <div className="capgrid">
                  {speedFor?.items?.map((it: any, i: number) => (
                    <Fragment key={it.name}>
                      <span className="capkind">Speed {i + 1}</span>
                      <ExercisePicker label="" value={speedEx(it)} onChange={n => setSpeedEx(it, n)} className={'capex ' + (sp.speed_ex?.[it.name] && sp.speed_ex[it.name] !== it.name ? 'o-user' : 'o-def')} />
                      <Num placeholder="plan" origin="user" value={speedMax[it.name] ?? null} onSave={v => savePlanned({ speed_max: clean({ ...speedMax, [it.name]: v }) })} />
                    </Fragment>
                  ))}
                  {supportNames.map(nm => (
                    <Fragment key={nm}>
                      <span className="capkind">Support</span>
                      <ExercisePicker label="" value={sp.support_ex?.[nm] ?? nm} onChange={n => savePlanned({ support_ex: { ...(sp.support_ex ?? {}), [nm]: n } })} className={'capex ' + (sp.support_ex?.[nm] && sp.support_ex[nm] !== nm ? 'o-user' : 'o-def')} />
                      <Num origin={supportMax[nm] != null ? 'user' : 'def'} value={supportMax[nm] ?? (support?.items ?? []).find((i: any) => i.name === nm)?.max_sets ?? 1} onSave={v => savePlanned({ support_max: clean({ ...supportMax, [nm]: v }) })} />
                    </Fragment>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {shown !== `${lifterId}|${date}|${lift}` ? <section className="card"><p className="small muted">Loading…</p></section> : <SessionSheet key={lifterId + date + lift + supportKey + cleared} api={api} liftLabel={heavyEx} L={lift === 'deadlift' ? null : L} D={lift === 'deadlift' ? D : null}
        heavyExerciseId={exId(heavyEx)} restS={lift === 'deadlift' ? (dlPlan.rest_s ?? 180) : ladderPlan.rest_s}
        speed={speedFor} speedEx={speedEx} speedSets={speedSlotSets} order={order} joins={joins} S={S} running={running} onPlatesOn={v => (lift === 'deadlift' ? savePlan(dlPlan) : savePlan(ladderPlan))({ plates_on: v })} onPlannedMax={v => savePlan(ladderPlan)({ planned_e1rm: v })} onApplyFit={applyFit} onAutoFit={autoFit} probes={probes} onSkipProbe={(idx: number) => savePlanned({ probe_skip: { ...(sp.probe_skip ?? {}), [idx]: true } })} onObs={setObs} spotRows={(sp.spot_rows as Record<string, boolean> | undefined) ?? {}} onSpotRow={(idx: number, on: boolean) => savePlanned({ spot_rows: { ...(sp.spot_rows ?? {}), [idx]: on } })} speedBands={st.speed_bands ?? {}} onSpeedBands={saveSpeedBands} speedMax={speedMax} supportMax={supportMax}
        circuit={(session?.extra as any)?.circuit_minutes ?? null}
        onCircuit={m => ensureSession({ extra: { ...((session?.extra as any) ?? {}), circuit_minutes: m } } as any)} />}

    </div>
  )
}

function Status({ session, save }: { session: Session | null; save: (p: Partial<Session>) => Promise<Session | null> }) {
  const [hurt, setHurt] = useState(session?.hurt ?? '')
  const [notes, setNotes] = useState(session?.notes ?? '')
  useEffect(() => {
    setHurt(session?.hurt ?? ''); setNotes(session?.notes ?? '')
  }, [session?.id])
  const [excl, setExcl] = useState(session?.exclude_reason ?? '')
  useEffect(() => setExcl(session?.exclude_reason ?? ''), [session?.id])
  const excluded = !!session?.sick || !!session?.hurt || !!session?.exclude_reason
  return (
    <div className="status">
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={!!session?.sick} onChange={e => save({ sick: e.target.checked })} /> <T tip="Sick sessions are left out of maxes, fatigue fits and the next session's plan.">Sick</T></label>
        <label className="grow"><T tip="Anything written here marks the session injured: it's left out of maxes, fatigue fits and planning.">Injury (describe)</T>
          <input value={hurt} placeholder="blank = no injury" onChange={e => setHurt(e.target.value)}
            onBlur={() => hurt !== (session?.hurt ?? '') && save({ hurt: hurt.trim() || null })} />
        </label>
      </div>
      <label><T tip="For bad data or equipment problems. Any text here leaves the session out of maxes and fatigue, like sick or injured.">Exclude for another reason (blank = count it)</T>
        <input value={excl} placeholder="e.g. bad data, equipment problem" onChange={e => setExcl(e.target.value)}
          onBlur={() => excl !== (session?.exclude_reason ?? '') && save({ exclude_reason: excl.trim() || null })} />
      </label>
      {excluded && <p className="warn small">Left out of maxes, fatigue and projections.</p>}
      <label>Notes
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (session?.notes ?? '') && save({ notes: notes.trim() || null })} />
      </label>
    </div>
  )
}

/** The sheet's bottom block: duration, calories, volume, recovery from the last session and the earliest next one. */
function SessionStats({ session, sets, volume, bwDefault, lifterId, date }: { session: Session | null; sets: SetRow[]; volume: number | null; bwDefault: number | null; lifterId?: string; date: string }) {
  const { cfg } = useStore()
  const [prev, setPrev] = useState<{ at: string; date: string } | null>(null)
  const [profileBw, setProfileBw] = useState<number | null>(null)
  useEffect(() => {
    if (!lifterId) return
    // Bodyweight lives on Profile: the latest entry on or before this date.
    supabase.from('body_metrics').select('value').eq('lifter_id', lifterId).eq('metric', 'bodyweight').lte('measured_on', date)
      .order('measured_on', { ascending: false }).limit(1).then(({ data }) => setProfileBw(data?.[0] ? Number(data[0].value) : null))
    supabase.from('sessions').select('session_date, started_at, ended_at').eq('lifter_id', lifterId).lt('session_date', date)
      .order('session_date', { ascending: false }).limit(1)
      .then(({ data }) => { const r = data?.[0]; setPrev(r ? { at: r.ended_at ?? r.started_at ?? r.session_date + 'T12:00:00', date: r.session_date } : null) })
  }, [lifterId, date])
  const reps = sets.reduce((t, s) => t + (s.reps ?? 0), 0)
  const timed = session?.started_at ? ((session.ended_at ? Date.parse(session.ended_at) : Date.now()) - Date.parse(session.started_at)) / 60000 : null
  const minutes = timed ?? (reps ? (reps * (cfg.seconds_per_rep ?? 4)) / 60 : null)
  const bw = profileBw ?? session?.bodyweight_lb ?? bwDefault
  const kcal = minutes && bw ? (cfg.met ?? 6) * (bw / 2.2046) * (minutes / 60) : null
  const startMs = session?.started_at ? Date.parse(session.started_at) : null
  const since = prev ? ((startMs ?? Date.now()) - Date.parse(prev.at)) / 3600000 : null
  const rec = cfg.recovery_h ?? 24
  const next = new Date((session?.ended_at ? Date.parse(session.ended_at) : startMs ?? Date.now()) + rec * 3600000)
  if (!minutes && !volume && since === null) return null
  return (
    <div className="stats small">
      {minutes ? <span data-tip={timed === null ? `No timer run: estimated at ${cfg.seconds_per_rep ?? 4} s per rep logged.` : 'From the workout clock (start to finish, or to now).'}><b>{Math.round(minutes)}</b> min{timed === null ? ' (est from reps)' : ''}</span> : null}
      {kcal ? <span data-tip={`Estimate: ${cfg.met ?? 6} MET × body weight (${bw} lb, from Profile) × hours.`}><b>{Math.round(kcal)}</b> kcal</span> : null}
      {volume ? <span data-tip={`Heavy sets: load × reps. An assisted rep counts at the load less ${cfg.assist_lb} lb; a failed rep counts nothing.`}><b>{Math.round(volume).toLocaleString()}</b> lb volume</span> : null}
      {since !== null && since > 0 ? <span className={since < rec ? 'warn' : ''} data-tip={`Hours from the end of the previous session to the start of this one. Under ${rec} h is flagged.`}><b>{Math.round(since)}</b> h since {prev!.date.slice(5).replace('-', '/')}{since < rec ? ` (under ${rec} h)` : ''}</span> : null}
      {session?.started_at ? <span data-tip={`Earliest next session: ${rec} h recommended recovery after this one.`} data-pos="right">next ≥ <b>{next.toLocaleDateString(undefined, { weekday: 'short' })} {next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b></span> : null}
    </div>
  )
}

/** The toggle between two blocks: interleave their sets, or do one block to the end before the next. */
function Interleave({ on, onToggle, a, b }: { on: boolean; onToggle: () => void; a: string; b: string }) {
  const tip = on
    ? `Interleaved: ${a} and ${b} alternate, one ${unit(a)} then one ${unit(b)}, round after round. Tap to finish all of ${a} before starting ${b}.`
    : `In order: all of ${a} is done before ${b} starts. Tap to alternate them, one ${unit(a)} then one ${unit(b)}.`
  return (
    <button type="button" className={'interleave' + (on ? ' on' : '')} onClick={onToggle} aria-pressed={on} aria-label={`${on ? 'Interleaved' : 'In order'}: ${a} and ${b}`} data-tip={tip} data-pos="center">
      <span aria-hidden>{on ? '⇄' : '→'}</span>
    </button>
  )
}
const unit = (b: string) => (b === 'heavy' ? 'heavy set' : b === 'speed' ? 'speed round' : 'support set')
const BLOCK_TIP: Record<string, string> = {
  heavy: 'The main lift today. Its sets ladder down from the planned max; change the exercise itself in Plan.',
  speed: 'Speed work (the opposite lift). None hides it.',
  support: 'Accessory group. Exercises can be swapped or added in the list.',
}
