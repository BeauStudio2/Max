import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { templateFor, useStore } from '../lib/store'
import { LIFT_EXERCISE, fitFatigue, localDate, round, roundTo, weekdayOf } from '../lib/load'
import type { Lift, Session, SetRow, SummaryRow } from '../lib/types'
import Ladder, { type LadderPlan } from './today/Ladder'
import SpeedBlock from './today/Speed'
import Support from './today/Support'
import Deadlift, { type DeadliftPlan } from './today/Deadlift'
import { fmt, useClock, type Api } from './today/shared'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const DL_CYCLE_START = '2026-11-07'
/** Sheet rule: trap-bar weeks build 2% a week from the week-1 top; conventional weeks work off the best conventional pull. */
function dlDefaultTop(week: number | null, week1: number | null, best?: number) {
  if (!week) return week1 ? roundTo(week1, 5) : null
  if (week <= 2) return week1 ? roundTo(week1 * 1.02 ** (week - 1), 5) : null
  if (!best) return null
  return roundTo(best * ([0, 0, 0.8, 0.8, 0.85, 0.92][week - 1] ?? 0.85), 5)
}
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
      supabase.from('sessions').select('id, session_date, planned, sick, hurt').eq('lifter_id', lifterId).eq('primary_lift', lift)
        .lt('session_date', date).order('session_date', { ascending: false }).limit(1),
    ])
    setHistory((h as SummaryRow[]) ?? [])
    const prev = p?.[0]
    const carried: Record<string, any> = { ...((prev?.planned as Record<string, any>) ?? {}) }
    if (prev && !prev.sick && !prev.hurt) {
      // Same rule as the sheet: a healthy previous session hands on its actual set-1 max and its fitted fatigue rate.
      const { data: est } = await supabase.from('set_estimates').select('set_index, e1rm_lb')
        .eq('session_id', prev.id).in('block', ['primary', 'deadlift']).order('set_index')
      const e = (est ?? []).map(r => (r.e1rm_lb === null ? null : Number(r.e1rm_lb)))
      if (e[0]) carried.planned_e1rm = Math.round(e[0])
      const fit = fitFatigue(e)
      if (fit && fit.ratePct > 0) carried.fatigue_rate_used_pct = Math.round(fit.ratePct * 100) / 100
      carried.from = prev.session_date
    } else if (prev) carried.from = prev.session_date + ' (sick/hurt: its planned values)'
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
      planned: lift === 'deadlift' ? dlPlanRef.current : ladderPlanRef.current, ...patch,
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
      const s = await ensureSession()
      if (!s) return null
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

  const valid = history.filter(h => !h.excluded && h.set1_e1rm_lb)
  const currentMax = valid[0] ? Number(valid[0].set1_e1rm_lb) : null
  const sp = session?.planned ?? {}

  const ladderPlan: LadderPlan = {
    planned_e1rm: pick(sp.planned_e1rm, prevPlan.planned_e1rm, st.planned_e1rm?.[lift], currentMax) ?? null,
    target_reps: pick(sp.target_reps, prevPlan.target_reps, st.target_reps?.[lift], tpl?.spec?.heavy?.target_reps) ?? 5,
    stop_pct: pick(sp.stop_pct, prevPlan.stop_pct, st.stop_pct?.[lift]) ?? 70,
    fatigue_rate_used_pct: pick(sp.fatigue_rate_used_pct, prevPlan.fatigue_rate_used_pct, st.fatigue_pct?.[lift]) ?? 3,
    step_lb: pick(sp.step_lb, prevPlan.step_lb) ?? 2.5,
    rest_s: pick(sp.rest_s, prevPlan.rest_s, st.rest_s) ?? 100,
    chain_half: pick(sp.chain_half, prevPlan.chain_half, st.chain_setup?.[lift]?.chain_half) ?? 0,
    chain_5_8: pick(sp.chain_5_8, prevPlan.chain_5_8, st.chain_setup?.[lift]?.chain_5_8) ?? 1,
  }

  const dlWeek = (() => {
    const days = Math.round((Date.parse(date) - Date.parse(DL_CYCLE_START)) / 86400000)
    return days < 0 ? null : (Math.floor(days / 7) % 6) + 1
  })()
  const cycle: any[] | undefined = tpl?.spec?.deadlift_cycle ?? templates.find(t => t.spec?.deadlift_cycle)?.spec?.deadlift_cycle
  const wk = dlWeek && cycle ? cycle.find(c => c.week === dlWeek) : null
  const best = st.deadlift_best_conventional_lb as number | undefined
  const dlPlan: DeadliftPlan = {
    planned_top_lb: pick(sp.planned_top_lb, dlDefaultTop(dlWeek, st.deadlift_planned_top_lb ?? (best ? best * 0.825 : null), best)) ?? null,
    bar_lb: pick(sp.bar_lb) ?? (String(wk?.pull ?? '').toLowerCase().includes('trap') ? 85 : 45),
  }

  ladderPlanRef.current = ladderPlan
  dlPlanRef.current = dlPlan
  const savePlan = (base: Record<string, any>) => (patch: Record<string, any>) => ensureSession({ planned: { ...base, ...patch } })

  const order: string[] = tpl?.spec?.order ?? ['speed', 'heavy', 'support']
  // Every block is a choice: the day's plan is the default, any other day's block can be picked instead.
  const speedOptions = new Map<string, any>()
  const supportOptions = new Map<string, any>()
  for (const t of [...templates].sort((a, b) => a.weekday - b.weekday)) {
    if (t.spec?.speed?.lift && !speedOptions.has(t.spec.speed.lift)) speedOptions.set(t.spec.speed.lift, t.spec.speed)
    if (t.spec?.support?.group && !supportOptions.has(t.spec.support.group)) supportOptions.set(t.spec.support.group, t.spec.support)
  }
  const speedKey: string = sp.speed_choice ?? (lift === planLift ? tpl?.spec?.speed?.lift : null) ?? 'none'
  const supportKey: string = sp.support_choice ?? (lift === planLift ? tpl?.spec?.support?.group : null) ?? 'none'
  const speedFor = speedOptions.get(speedKey) ?? null
  const support = supportOptions.get(supportKey) ?? null
  const savePlanned = (patch: Record<string, any>) =>
    ensureSession({ planned: { ...(lift === 'deadlift' ? dlPlanRef.current : ladderPlanRef.current), ...(session?.planned ?? {}), ...patch } })
  const choose = (k: 'speed_choice' | 'support_choice', v: string) => savePlanned({ [k]: v })

  // Exercise choices for the heavy block and each speed slot; switching also relabels sets already logged there.
  const heavyBlock = lift === 'deadlift' ? 'deadlift' : 'primary'
  const heavyDefault = LIFT_EXERCISE[lift]
  const heavyEx: string = sp.heavy_exercise ?? heavyDefault
  const relabel = async (rows: SetRow[], name: string) => {
    const id = exId(name)
    if (!id) return
    for (const r of rows) if (r.exercise_id !== id) await api.updateSet(r.id!, { exercise_id: id })
  }
  async function setHeavyEx(name: string) {
    const oldId = exId(heavyEx)
    await relabel(sets.filter(r => r.block === heavyBlock && r.exercise_id === oldId), name)
    await savePlanned({ heavy_exercise: name })
  }
  const speedSlotSets = (it: any) => sets.filter(s => s.block === 'speed' && (s.setup?.slot === it.name || (!s.setup?.slot && s.exercise_id === exId(it.name))))
  const speedEx = (it: any): string => sp.speed_ex?.[it.name] ?? it.name
  async function setSpeedEx(it: any, name: string) {
    await relabel(speedSlotSets(it), name)
    await savePlanned({ speed_ex: { ...(sp.speed_ex ?? {}), [it.name]: name } })
  }
  const elapsed = useClock(session?.started_at && !session.ended_at ? session.started_at : null)

  return (
    <div className="stack">
      <section className="card">
        <div className="row wrap">
          <label className="grow">Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        </div>
        <div className="choices">
          <label>Heavy
            <select value={lift} onChange={e => setLift(e.target.value as Lift)}>
              <option value="squat">Squat</option>
              <option value="bench">Bench</option>
              <option value="deadlift">Deadlift</option>
            </select>
          </label>
          <label>Speed
            <select value={speedKey} onChange={e => choose('speed_choice', e.target.value)}>
              <option value="none">None</option>
              {[...speedOptions.keys()].map(k => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
            </select>
          </label>
          <label>Support
            <select value={supportKey} onChange={e => choose('support_choice', e.target.value)}>
              <option value="none">None</option>
              {[...supportOptions.keys()].map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>
        {tpl && <p className="muted small"><b>{tpl.name}</b>{tpl.spec?.logic ? ` · ${tpl.spec.logic}` : ''}</p>}
        <Status session={session} save={ensureSession} />
        <div className="timer">
          {!session?.started_at ? (
            <button className="primary" onClick={() => ensureSession({ started_at: new Date().toISOString(), ended_at: null })}>▶ Start workout</button>
          ) : !session.ended_at ? (
            <>
              <div><span className="small muted">Started {clock(session.started_at)}</span><b className="elapsed">{fmt(elapsed)}</b></div>
              <button className="ghost" onClick={() => ensureSession({ ended_at: new Date().toISOString() })}>■ Finish</button>
            </>
          ) : (
            <>
              <div><span className="small muted">{clock(session.started_at)} – {clock(session.ended_at)}</span>
                <b className="elapsed">{fmt(Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000))}</b></div>
              <button className="ghost small" onClick={() => ensureSession({ ended_at: null })}>Resume</button>
              <button className="ghost small" onClick={() => confirm('Clear the start and finish times?') && ensureSession({ started_at: null, ended_at: null })}>Reset</button>
            </>
          )}
        </div>
      </section>

      {err && <p className="err">{err}</p>}

      {order.map(b => {
        if (b === 'speed' && speedFor?.items?.length) return (
          <section className="card" key="speed">
            <h2>Speed · {speedFor.lift}</h2>
            {speedFor.items.map((it: any) => (
              <SpeedBlock key={date + it.name} item={it} exerciseName={speedEx(it)} onExercise={n => setSpeedEx(it, n)} sets={speedSlotSets(it)} api={api} />
            ))}
          </section>
        )
        if (b === 'heavy') return lift === 'deadlift'
          ? <Deadlift key="dl" exerciseName={heavyEx} onExercise={setHeavyEx} week={dlWeek} cycle={cycle} plan={dlPlan} setPlan={savePlan(dlPlan)} sets={sets.filter(s => s.block === 'deadlift')} api={api} best={best} />
          : <Ladder key={'ladder' + lift} exerciseName={heavyEx} onExercise={setHeavyEx} lift={lift} plan={ladderPlan} carriedFrom={sp.planned_e1rm === undefined ? prevPlan.from : undefined} setPlan={savePlan(ladderPlan)} sets={sets.filter(s => s.block === 'primary')} api={api} currentMax={currentMax} />
        if (b === 'support' && support) return <Support key={'support' + date + lift + supportKey} support={support} sets={sets.filter(s => s.block === 'support')} api={api} />
        return null
      })}

      {currentMax && <p className="small muted center-text">Current {lift} max {round(currentMax)} (latest session not sick or injured).</p>}
    </div>
  )
}

function Status({ session, save }: { session: Session | null; save: (p: Partial<Session>) => Promise<Session | null> }) {
  const [hurt, setHurt] = useState(session?.hurt ?? '')
  const [notes, setNotes] = useState(session?.notes ?? '')
  const [bw, setBw] = useState(session?.bodyweight_lb?.toString() ?? '')
  useEffect(() => {
    setHurt(session?.hurt ?? ''); setNotes(session?.notes ?? ''); setBw(session?.bodyweight_lb?.toString() ?? '')
  }, [session?.id])
  const excluded = !!session?.sick || !!session?.hurt
  return (
    <div className="status">
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={!!session?.sick} onChange={e => save({ sick: e.target.checked })} /> Sick</label>
        <label className="grow">Injury (describe)
          <input value={hurt} placeholder="blank = no injury" onChange={e => setHurt(e.target.value)}
            onBlur={() => hurt !== (session?.hurt ?? '') && save({ hurt: hurt.trim() || null })} />
        </label>
        <label className="narrow">Body wt
          <input inputMode="decimal" value={bw} onChange={e => setBw(e.target.value)}
            onBlur={() => bw !== (session?.bodyweight_lb?.toString() ?? '') && save({ bodyweight_lb: bw ? Number(bw) : null })} />
        </label>
      </div>
      {excluded && <p className="warn small">Left out of max and projections (sick or injured).</p>}
      <label>Notes
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (session?.notes ?? '') && save({ notes: notes.trim() || null })} />
      </label>
    </div>
  )
}
