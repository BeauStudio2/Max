import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { templateFor, useStore } from '../lib/store'
import { ALL_PLATES, LIFT_EXERCISE, fitFatigue, localDate, round, roundTo, weekdayOf } from '../lib/load'
import type { Lift, Session, SetRow, SummaryRow } from '../lib/types'
import { LadderPlanFields, useLadder, type LadderPlan } from './today/Ladder'
import SessionSheet, { type Placement } from './today/Sheet'
import { useSupportSlots } from './today/Support'
import { DeadliftPlanFields, useDeadlift, type DeadliftPlan } from './today/Deadlift'
import { ExercisePicker, Num, T, fmt, useClock, type Api } from './today/shared'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const DL_CYCLE_START = '2026-11-07'
/** Sheet rule: trap-bar weeks build 2% a week from the week-1 top; conventional weeks work off the best conventional pull. */
function dlDefaultTop(week: number | null, week1: number | null, best?: number) {
  if (!week) return week1 ? roundTo(week1, 5) : null
  if (week <= 2) return week1 ? roundTo(week1 * 1.02 ** (week - 1), 5) : null
  if (!best) return null
  return roundTo(best * ([0, 0, 0.8, 0.8, 0.85, 0.92][week - 1] ?? 0.85), 5)
}
const KEY_LABEL: Record<string, string> = { target_reps: 'target reps', stop_pct: 'stop %', step_lb: 'weight step', rest_s: 'rest', chain_half: '½ chains', chain_5_8: '⅝ chains',
  chains_on: 'chains on/off', plates_on: 'plates on', spotter: 'spotter', clamp: 'clamps', kept_45: '45s kept', kept_25: '25s kept', set1_lb: 'set 1 lb', bar_lb: 'bar',
  speed_choice: 'speed', support_choice: 'support', speed_placement: 'speed order', speed_offset_s: 'speed start', support_interleave: 'support order' }
const pick = <T,>(...vals: (T | null | undefined)[]) => vals.find(v => v !== null && v !== undefined) as T | undefined

export default function Today({ lifterId }: { lifterId: string }) {
  const { templates, lifters, exercises } = useStore()
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

  async function load() {
    setErr(null)
    const { data: s, error } = await supabase.from('sessions').select('*')
      .eq('lifter_id', lifterId).eq('session_date', date).eq('primary_lift', lift).maybeSingle()
    if (error) { setErr(error.message); return }
    setSession(s as Session | null)
    if (s) {
      const { data } = await supabase.from('sets').select('*').eq('session_id', s.id).order('set_index')
      setSets((data as SetRow[]) ?? [])
    } else setSets([])
    const [{ data: h }, { data: p }] = await Promise.all([
      supabase.from('session_summary').select('*').eq('lifter_id', lifterId).eq('primary_lift', lift)
        .lt('session_date', date).order('session_date', { ascending: false }).limit(30),
      supabase.from('sessions').select('id, session_date, primary_lift, planned, sick, hurt, exclude_reason').eq('lifter_id', lifterId)
        .lt('session_date', date).order('session_date', { ascending: false }).limit(60),
    ])
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
    setPrevPlan(carried)
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
      const { data, error } = await supabase.from('sets').insert({ ...row, session_id: s.id }).select().single()
      if (error) { setErr(error.message); return null }
      setSets(prev => [...prev, data as SetRow]); return data as SetRow
    },
    async updateSet(id, patch) {
      const { data, error } = await supabase.from('sets').update(patch).eq('id', id).select().single()
      if (error) { setErr(error.message); return }
      setSets(prev => prev.map(r => (r.id === id ? (data as SetRow) : r)))
    },
    async deleteSet(id, ask = true) {
      if (ask && !confirm('Delete this set?')) return
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
    step_lb: pick(sp.step_lb, f.step_lb, H.step_lb) ?? 2.5,
    rest_s: pick(sp.rest_s, f.rest_s, H.rest_s, st.rest_s) ?? 100,
    chain_half: pick(sp.chain_half, f.chain_half, H.chain_half, st.chain_setup?.[lift]?.chain_half) ?? 0,
    chain_5_8: pick(sp.chain_5_8, f.chain_5_8, H.chain_5_8, st.chain_setup?.[lift]?.chain_5_8) ?? 1,
    clamp: pick(sp.clamp, f.clamp, st.default_clamp) ?? 'Rogue aluminum clamps (pair)',
    rom_in: pick(sp.rom_in, f.rom_in, st.chain_geometry?.[lift]?.rom_in) ?? null,
    hang_in: pick(sp.hang_in, f.hang_in, st.chain_geometry?.[lift]?.hang_in) ?? null,
    bar: 'bar' in exEquip ? exEquip.bar ?? null : 'Ohio Power Bar',
    chains_ok: exEquip.chains ?? true,
    load: exEquip.load ?? 'bar',
    implement: exEquip.bar ? null : exEquip.implement ?? null,
    plates_on: pick(sp.plates_on, f.plates_on, H.plates_on, st.plates_on) ?? ALL_PLATES,
    chains_on: pick(sp.chains_on, f.chains_on, H.chains_on) ?? true,
    kept_45: pick(sp.kept_45, f.kept_45) ?? null,
    kept_25: pick(sp.kept_25, f.kept_25) ?? null,
    set1_lb: pick(sp.set1_lb, f.set1_lb) ?? null,
    spotter: pick(sp.spotter, f.spotter, H.spotter) ?? false,
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
  const strip = ({ bar, chains_ok, load, implement, ...rest }: Record<string, any>) => rest
  // Saving writes only what was edited, so everything else keeps following the Plan page.
  const own = () => (session?.planned ?? {}) as Record<string, any>
  const savePlan = (_base: Record<string, any>) => (patch: Record<string, any>) => ensureSession({ planned: strip({ ...own(), ...patch }) })
  async function freeze(s: Session) {
    const plan = { ...strip(lift === 'deadlift' ? dlPlanRef.current : ladderPlanRef.current), speed_placement: placement, support_interleave: supInter }
    const { deadlift_cycle, ...daySpec } = tpl?.spec ?? {}
    const snapSpec = { ...daySpec, speed: speedFor ?? daySpec.speed ?? null, support: support ?? daySpec.support ?? null, deadlift_cycle: deadlift_cycle ? deadlift_cycle : undefined }
    const { data, error } = await supabase.from('sessions').update({ planned: { ...((s.planned as any) ?? {}), snap: { plan, spec: snapSpec, at: new Date().toISOString() } } }).eq('id', s.id).select().single()
    if (error) { setErr(error.message); return null }
    setSession(data as Session); return data as Session
  }
  /** Fields this session has edited itself (they no longer follow the Plan page). */
  const PROGRAM_KEYS = ['target_reps', 'stop_pct', 'step_lb', 'rest_s', 'chain_half', 'chain_5_8', 'chains_on', 'plates_on', 'spotter', 'clamp', 'kept_45', 'kept_25', 'set1_lb', 'bar_lb', 'speed_choice', 'support_choice', 'speed_placement', 'speed_offset_s', 'support_interleave']
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
      chain_half: undefined, chain_5_8: undefined, rom_in: undefined, hang_in: undefined, set1_lb: undefined, kept_45: undefined, kept_25: undefined })
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
  const offsetS: number = sp.speed_offset_s ?? 20
  const D = useDeadlift({ week: dlWeek, cycle, plan: dlPlan, sets: sets.filter(s => s.block === 'deadlift'), api, exerciseName: heavyEx, resetKey: date + lift })
  const S = useSupportSlots(support, sets.filter(s => s.block === 'support'), api, date + lift + supportKey,
    { hidden: (sp.support_hidden as string[] | undefined) ?? [], setHidden: h => { savePlanned({ support_hidden: h }) } })
  const [planOpen, setPlanOpen] = useState(false)

  return (
    <div className="stack today">
      <section className="card">
        <div className="row wrap">
          <label className="grow">Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        </div>
        <div className="choices">
          <label><T tip="The main lift today. Its sets ladder down from the planned max; change the exercise itself in Plan.">Heavy</T>
            <select value={lift} onChange={e => setLift(e.target.value as Lift)}>
              <option value="squat">Squat</option>
              <option value="bench">Bench</option>
              <option value="deadlift">Deadlift</option>
            </select>
          </label>
          <Interleave on={placement === 'between'} label="heavy and speed"
            tip={placement === 'between' ? 'Interleaved: one round of speed after each heavy set. Tap to do all heavy sets first, then all speed.' : 'In order: all heavy sets, then all speed sets. Tap to interleave them.'}
            onToggle={() => savePlanned({ speed_placement: placement === 'between' ? 'after' : 'between' })} />
          <label><T tip="Speed work done between heavy sets (the opposite lift). None hides it.">Speed</T>
            <select value={speedKey} onChange={e => choose('speed_choice', e.target.value)}>
              <option value="none">None</option>
              {[...speedOptions.keys()].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
            </select>
          </label>
          <Interleave on={supInter} label="speed and support"
            tip={supInter ? 'Interleaved: one support set after each heavy + speed round, all in one list. Tap to do support at the end.' : 'In order: support after all heavy and speed sets, in its own table. Tap to interleave it.'}
            onToggle={() => savePlanned({ support_interleave: !supInter })} />
          <label><T tip="Accessory group for after the heavy work. Exercises can be swapped or added in the Support table.">Support</T>
            <select value={supportKey} onChange={e => choose('support_choice', e.target.value)}>
              <option value="none">None</option>
              {[...supportOptions.keys()].map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
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
              <button className="ghost small" data-tip="Clears start and finish times. Logged sets are kept." data-pos="right" onClick={() => confirm('Clear the start and finish times?') && ensureSession({ started_at: null, ended_at: null })}>Reset</button>
            </>
          )}
        </div>
        <SessionStats session={session} sets={sets} volume={L?.volume ?? null} bwDefault={lifter?.bodyweight_lb ?? st.bodyweight_lb ?? null} lifterId={lifter?.id} date={date} />
      </section>

      {err && <p className="err">{err}</p>}

      <section className="card">
        <button className="planhead" onClick={() => setPlanOpen(o => !o)} aria-expanded={planOpen} data-tip="Tap to open: planned max, reps, stop line, fatigue, plates, chains and the exercises for today." data-pos="left">
          <h2 style={{ margin: 0 }}>Plan · {lift}{lift === 'deadlift' && dlWeek ? ` week ${dlWeek}` : ''}</h2>
          <span className="small muted">{lift === 'deadlift'
            ? `top ${dlPlan.planned_top_lb ?? '—'} · bar ${dlPlan.bar_lb} · rest ${dlPlan.rest_s}s`
            : `${ladderPlan.planned_e1rm ? `max ${round(ladderPlan.planned_e1rm)} · ` : ''}${ladderPlan.target_reps} reps · stop ${ladderPlan.stop_pct}% · ${ladderPlan.fatigue_rate_used_pct}%/set`} {planOpen ? '▴' : '▾'}</span>
        </button>
        {planOpen && (
          <div className="planbody">
            <ExercisePicker label="Main exercise" value={heavyEx} onChange={setHeavyEx} className="exrow" />
            {lift === 'deadlift'
              ? <DeadliftPlanFields D={D} setPlan={savePlan(dlPlan)} best={best} />
              : <LadderPlanFields L={L} setPlan={savePlan(ladderPlan)} carriedFrom={sp.planned_e1rm === undefined ? prevPlan.from : undefined} currentMax={currentMax} />}
            {edited.length > 0 && (
              <p className="small edited">
                <T tip="These were changed on this session, so they no longer follow the Plan page. Everything else still does.">Edited for this session</T>: {edited.map(k => KEY_LABEL[k] ?? k).join(', ')}
                {' · '}<button className="linkish" onClick={resetEdits} data-tip="Clear this session's edits so it follows the Plan page again." data-pos="right">Use the Plan</button>
              </p>
            )}
            {past && snap && <p className="small muted">Past session: shows the plan as it stood when its first set was logged. Plan page edits don't change it.</p>}
            {speedFor?.items?.map((it: any, i: number) => (
              <ExercisePicker key={it.name} label={`Speed exercise ${i + 1}`} value={speedEx(it)} onChange={n => setSpeedEx(it, n)} className="exrow" />
            ))}
            {speedFor?.items?.length ? (
              <div className="planfields">
                <label><T tip="Between: one round of speed after each heavy set. All first / all after: every speed set in a block.">Speed sets</T>
                  <select value={placement} onChange={e => savePlanned({ speed_placement: e.target.value })}>
                    <option value="between">Between main sets</option>
                    <option value="first">All first</option>
                    <option value="after">All after</option>
                  </select>
                </label>
                <Num label="Speed starts (s into rest)" tip="How many seconds after a heavy set the speed round begins." value={offsetS} onSave={v => v !== null && savePlanned({ speed_offset_s: v })} />
              </div>
            ) : null}
          </div>
        )}
      </section>

      <SessionSheet key={date + lift + supportKey} api={api} liftLabel={heavyEx} L={lift === 'deadlift' ? null : L} D={lift === 'deadlift' ? D : null}
        heavyExerciseId={exId(heavyEx)} restS={lift === 'deadlift' ? (dlPlan.rest_s ?? 180) : ladderPlan.rest_s}
        speed={speedFor} speedEx={speedEx} speedSets={speedSlotSets} placement={placement} supInterleave={supInter} S={S} running={!!session?.started_at && !session?.ended_at}
        circuit={(session?.extra as any)?.circuit_minutes ?? null}
        onCircuit={m => ensureSession({ extra: { ...((session?.extra as any) ?? {}), circuit_minutes: m } } as any)} />

      {currentMax && <p className="small muted center-text">Current {lift} max {round(currentMax)} (latest session not sick or injured).</p>}
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
function Interleave({ on, onToggle, tip, label }: { on: boolean; onToggle: () => void; tip: string; label: string }) {
  return (
    <button type="button" className={'interleave' + (on ? ' on' : '')} onClick={onToggle} aria-pressed={on} aria-label={`Interleave ${label}`} data-tip={tip} data-pos="center">
      <span aria-hidden>{on ? '⇄' : '→'}</span><span className="ilabel">{on ? 'interleave' : 'in order'}</span>
    </button>
  )
}
