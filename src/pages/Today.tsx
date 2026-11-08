import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { templateFor, useStore } from '../lib/store'
import { LIFT_EXERCISE, e1rm, localDate, round, totals, weekdayOf, weightFor, type LoadSetup } from '../lib/load'
import type { Lift, Session, SetRow, SummaryRow } from '../lib/types'

const DL_CYCLE_START = '2026-11-07'

export default function Today({ lifterId }: { lifterId: string }) {
  const store = useStore()
  const { templates, lifters, exercises } = store
  const lifter = lifters.find(l => l.id === lifterId)
  const [date, setDate] = useState(localDate())
  const tpl = templateFor(templates, lifterId, weekdayOf(date), date)
  const planLift: Lift = tpl?.spec?.heavy?.lift ?? 'bench'
  const [lift, setLift] = useState<Lift>(planLift)
  useEffect(() => setLift(planLift), [planLift, date])

  const [session, setSession] = useState<Session | null>(null)
  const [sets, setSets] = useState<SetRow[]>([])
  const [history, setHistory] = useState<SummaryRow[]>([])
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setErr(null)
    const { data: s, error } = await supabase.from('sessions').select('*')
      .eq('lifter_id', lifterId).eq('session_date', date).eq('primary_lift', lift).maybeSingle()
    if (error) { setErr(error.message); return }
    setSession(s as Session | null)
    if (s) {
      const { data } = await supabase.from('sets').select('*').eq('session_id', s.id).order('block').order('set_index')
      setSets((data as SetRow[]) ?? [])
    } else setSets([])
    const { data: h } = await supabase.from('session_summary').select('*')
      .eq('lifter_id', lifterId).eq('primary_lift', lift).lt('session_date', date).order('session_date', { ascending: false }).limit(20)
    setHistory((h as SummaryRow[]) ?? [])
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
      started_at: new Date().toISOString(), source: 'app', ...patch,
    }).select().single()
    if (error) { setErr(error.message); return null }
    setSession(data as Session); return data as Session
  }

  const exId = (name: string) => exercises.find(e => e.name === name)?.id

  async function addSet(row: Omit<SetRow, 'session_id'>) {
    const s = await ensureSession()
    if (!s) return
    const { data, error } = await supabase.from('sets').insert({ ...row, session_id: s.id }).select().single()
    if (error) { setErr(error.message); return }
    setSets(prev => [...prev, data as SetRow])
  }
  async function updateSet(id: string, patch: Partial<SetRow>) {
    const { data, error } = await supabase.from('sets').update(patch).eq('id', id).select().single()
    if (error) { setErr(error.message); return }
    setSets(prev => prev.map(r => (r.id === id ? (data as SetRow) : r)))
  }
  async function deleteSet(id: string) {
    if (!confirm('Delete this set?')) return
    const { error } = await supabase.from('sets').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    setSets(prev => prev.filter(r => r.id !== id))
  }
  const api = { addSet, updateSet, deleteSet, exId }

  // Current max: the most recent session that is not excluded (sick or hurt) with a logged set 1.
  const lastGood = history.find(h => !h.excluded && h.set1_e1rm_lb)
  const best = history.filter(h => !h.excluded && h.set1_e1rm_lb).reduce((m, h) => Math.max(m, Number(h.set1_e1rm_lb)), 0)

  const order: string[] = tpl?.spec?.order ?? ['speed', 'heavy', 'support']
  const speedFor = tpl?.spec?.speed
  const support = tpl?.spec?.support
  const dlWeek = (() => {
    const days = Math.round((Date.parse(date) - Date.parse(DL_CYCLE_START)) / 86400000)
    return days < 0 ? null : (Math.floor(days / 7) % 6) + 1
  })()

  return (
    <div className="stack">
      <section className="card">
        <div className="row wrap">
          <label className="grow">Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="grow">Main lift
            <select value={lift} onChange={e => setLift(e.target.value as Lift)}>
              <option value="bench">Bench</option><option value="squat">Squat</option><option value="deadlift">Deadlift</option>
            </select>
          </label>
        </div>
        {tpl && <p className="muted small"><b>{tpl.name}</b>{tpl.spec?.logic ? ` · ${tpl.spec.logic}` : ''}</p>}
        <Status session={session} save={ensureSession} />
        {lastGood && (
          <p className="small">Current {lift} max <b>{round(lastGood.set1_e1rm_lb)}</b> lb ({lastGood.session_date})
            {best > Number(lastGood.set1_e1rm_lb) + 0.5 && <> · best {round(best)}</>}</p>
        )}
      </section>

      {err && <p className="err">{err}</p>}

      {order.map(b => {
        if (b === 'speed' && speedFor?.items?.length) return (
          <section className="card" key="speed">
            <h2>Speed · {speedFor.lift}</h2>
            {speedFor.items.map((it: any) => (
              <SpeedBlock key={it.name} item={it} sets={sets.filter(s => s.block === 'speed' && s.exercise_id === exId(it.name))} api={api} />
            ))}
          </section>
        )
        if (b === 'heavy') return lift === 'deadlift'
          ? <Deadlift key="dl" week={dlWeek} cycle={tpl?.spec?.deadlift_cycle} sets={sets.filter(s => s.block === 'deadlift')} api={api} best={lifter?.settings?.deadlift_best_conventional_lb} />
          : <Ladder key="ladder" lift={lift} sets={sets.filter(s => s.block === 'primary')} api={api}
              lifterSettings={lifter?.settings ?? {}} tplReps={tpl?.spec?.heavy?.target_reps} currentMax={lastGood ? Number(lastGood.set1_e1rm_lb) : null} />
        if (b === 'support' && support?.items?.length) return (
          <section className="card" key="support">
            <h2>Support · {support.group}</h2>
            {support.items.map((it: any) => (
              <SupportRow key={it.name} item={it} existing={sets.find(s => s.block === 'support' && s.exercise_id === exId(it.name))} api={api} />
            ))}
          </section>
        )
        return null
      })}

      {session && (
        <button className="ghost" onClick={() => ensureSession({ ended_at: new Date().toISOString() })}>
          {session.ended_at ? `Finished ${new Date(session.ended_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Finish session'}
        </button>
      )}
    </div>
  )
}

type Api = {
  addSet: (row: Omit<SetRow, 'session_id'>) => Promise<void>
  updateSet: (id: string, patch: Partial<SetRow>) => Promise<void>
  deleteSet: (id: string) => Promise<void>
  exId: (name: string) => string | undefined
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
        <label className="grow">Hurt (describe)
          <input value={hurt} placeholder="blank = not hurt" onChange={e => setHurt(e.target.value)}
            onBlur={() => hurt !== (session?.hurt ?? '') && save({ hurt: hurt.trim() || null })} />
        </label>
        <label className="narrow">Body wt
          <input inputMode="decimal" value={bw} onChange={e => setBw(e.target.value)}
            onBlur={() => bw !== (session?.bodyweight_lb?.toString() ?? '') && save({ bodyweight_lb: bw ? Number(bw) : null })} />
        </label>
      </div>
      {excluded && <p className="warn small">Left out of max and projections (sick or hurt).</p>}
      <label>Notes
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (session?.notes ?? '') && save({ notes: notes.trim() || null })} />
      </label>
    </div>
  )
}

/* ---------- Heavy ladder (bench / squat) ---------- */

const CLAMPS = [
  { name: 'Eleiko clamps (pair)', short: 'Eleiko' },
  { name: 'Chain clamp + carabiner (pair)', short: 'Chain clamp' },
]

function setupOf(r?: SetRow): LoadSetup {
  const s = r?.setup ?? {}
  const clamp = s.clamp === 'Eleiko' ? CLAMPS[0].name : s.clamp === 'chain clamp' ? CLAMPS[1].name : s.clamp ?? CLAMPS[0].name
  return { bar: s.bar ?? 'Ohio Power Bar', clamp, chain_half: Number(s.chain_half ?? 0), chain_5_8: Number(s.chain_5_8 ?? 0) }
}

function Ladder({ lift, sets, api, lifterSettings, tplReps, currentMax }: {
  lift: Lift; sets: SetRow[]; api: Api; lifterSettings: Record<string, any>; tplReps?: number; currentMax: number | null
}) {
  const { equipment, cfg } = useStore()
  const exerciseId = api.exId(LIFT_EXERCISE[lift])
  const targetReps: number = lifterSettings?.target_reps?.[lift] ?? tplReps ?? 5
  const stopPct: number = lifterSettings?.stop_pct?.[lift] ?? 70
  const restTarget: number = lifterSettings?.rest_s ?? 100
  const sorted = [...sets].sort((a, b) => a.set_index - b.set_index)
  const est = sorted.map(r => e1rm(r.total_bottom_lb, r.total_top_lb, r.reps, r.assisted || r.failed, cfg))
  const first = est[0] ?? null
  const last = sorted.at(-1)
  const lastEst = est.at(-1) ?? null
  const stopped = first && lastEst !== null && lastEst < first * stopPct / 100

  // Next set form, prefilled with the suggestion.
  const [setup, setSetup] = useState<LoadSetup>(setupOf(last))
  const [weight, setWeight] = useState('')
  const [reps, setReps] = useState('')
  const [assisted, setAssisted] = useState(false)
  const [failed, setFailed] = useState(false)
  const target = lastEst ?? currentMax
  const suggestion = target ? weightFor(target, targetReps, setup, equipment, cfg) : null
  useEffect(() => { setSetup(setupOf(last)) }, [last?.id])
  useEffect(() => { setWeight(suggestion !== null ? String(suggestion) : '') }, [suggestion, last?.id])

  const t = totals(weight === '' ? null : Number(weight), setup, equipment)
  const preview = e1rm(t.bottom, t.top, reps === '' ? null : Number(reps), assisted || failed, cfg)

  const clock = useClock(last?.created_at)

  async function log() {
    if (!exerciseId || weight === '' || reps === '') return
    const rest = last?.created_at ? Math.round((Date.now() - Date.parse(last.created_at)) / 1000) : null
    await api.addSet({
      exercise_id: exerciseId, block: 'primary', set_index: (last?.set_index ?? 0) + 1,
      weight_lb: Number(weight), total_bottom_lb: t.bottom, total_top_lb: t.top, reps: Number(reps),
      assisted, failed, rest_s: rest,
      setup: { bar: setup.bar, clamp: setup.clamp, chain_half: setup.chain_half, chain_5_8: setup.chain_5_8 },
    })
    setReps(''); setAssisted(false); setFailed(false)
  }

  return (
    <section className="card">
      <h2>Heavy · {lift}</h2>
      <p className="muted small">Target {targetReps} reps · stop below {stopPct}% of set 1 · rest about {Math.round(restTarget / 60 * 10) / 10} min</p>
      {sorted.length > 0 && (
        <div className="tablewrap">
          <table className="sets">
            <thead><tr><th>#</th><th>Plates</th><th>Total</th><th>Reps</th><th>e1RM</th><th>%1</th><th>Rest</th><th></th></tr></thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.id} className={first && est[i] !== null && est[i]! < first * stopPct / 100 ? 'below' : ''}>
                  <td>{r.set_index}</td>
                  <td><NumCell value={r.weight_lb} onSave={v => {
                    const tt = totals(v, setupOf(r), equipment)
                    api.updateSet(r.id!, { weight_lb: v, total_bottom_lb: tt.bottom, total_top_lb: tt.top })
                  }} /></td>
                  <td className="small">{round(r.total_bottom_lb, 1)}{r.total_top_lb !== r.total_bottom_lb ? `→${round(r.total_top_lb, 1)}` : ''}</td>
                  <td>
                    <NumCell value={r.reps} onSave={v => api.updateSet(r.id!, { reps: v })} />
                    <span className="flags">{r.assisted ? 'A' : ''}{r.failed ? 'F' : ''}</span>
                  </td>
                  <td><b>{round(est[i])}</b></td>
                  <td className="small">{first && est[i] ? round(est[i]! / first * 100) : ''}</td>
                  <td className="small">{r.rest_s ? fmt(r.rest_s) : ''}</td>
                  <td><button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stopped && <p className="warn">Last set fell below {stopPct}% of set 1. Ladder done.</p>}

      <div className="next">
        <div className="row between">
          <b>Set {(last?.set_index ?? 0) + 1}</b>
          {last && <span className={'clock' + (clock >= restTarget ? ' ready' : '')}>{fmt(clock)}</span>}
        </div>
        <div className="row wrap">
          <label className="narrow">Plates lb<input inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} /></label>
          <label className="narrow">Reps<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} placeholder={String(targetReps)} /></label>
          <label className="check"><input type="checkbox" checked={assisted} onChange={e => setAssisted(e.target.checked)} /> Assisted</label>
          <label className="check"><input type="checkbox" checked={failed} onChange={e => setFailed(e.target.checked)} /> Failed</label>
        </div>
        <div className="row wrap">
          <label className="grow">Clamps
            <select value={setup.clamp} onChange={e => setSetup({ ...setup, clamp: e.target.value })}>
              {CLAMPS.map(c => <option key={c.name} value={c.name}>{c.short}</option>)}
            </select>
          </label>
          <label className="narrow">½ chains/side
            <select value={setup.chain_half} onChange={e => setSetup({ ...setup, chain_half: Number(e.target.value) })}>
              {[0, 1, 2].map(v => <option key={v}>{v}</option>)}
            </select>
          </label>
          <label className="narrow">⅝ chains/side
            <select value={setup.chain_5_8} onChange={e => setSetup({ ...setup, chain_5_8: Number(e.target.value) })}>
              {[0, 1, 2].map(v => <option key={v}>{v}</option>)}
            </select>
          </label>
        </div>
        <p className="small muted">
          Total {round(t.bottom, 1)}{t.top !== t.bottom ? ` → ${round(t.top, 1)}` : ''} lb
          {suggestion !== null && <> · suggested {suggestion} for {targetReps} (aiming at e1RM {round(target)})</>}
          {preview !== null && <> · this set e1RM <b>{round(preview)}</b></>}
        </p>
        <button className="primary" onClick={log} disabled={!exerciseId || weight === '' || reps === ''}>Log set</button>
      </div>
    </section>
  )
}

/* ---------- Deadlift (Saturday cycle) ---------- */

function Deadlift({ week, cycle, sets, api, best }: { week: number | null; cycle?: any[]; sets: SetRow[]; api: Api; best?: number }) {
  const { cfg } = useStore()
  const exerciseId = api.exId('Deadlift')
  const plan = week && cycle ? cycle.find(c => c.week === week) : null
  const sorted = [...sets].sort((a, b) => a.set_index - b.set_index)
  const [weight, setWeight] = useState('')
  const [reps, setReps] = useState('1')
  const [rpe, setRpe] = useState('')
  const [note, setNote] = useState('')
  async function log() {
    if (!exerciseId || !weight) return
    await api.addSet({
      exercise_id: exerciseId, block: 'deadlift', set_index: (sorted.at(-1)?.set_index ?? 0) + 1,
      weight_lb: Number(weight), total_bottom_lb: Number(weight), total_top_lb: Number(weight), reps: Number(reps || 1),
      assisted: false, failed: false, rpe: rpe ? Number(rpe) : null, setup: { pull: plan?.pull ?? null, week }, notes: note || null,
    })
    setNote(''); setRpe('')
  }
  return (
    <section className="card">
      <h2>Deadlift{week ? ` · cycle week ${week} of 6` : ''}</h2>
      {plan && (
        <ul className="plan small">
          <li><b>Pull:</b> {plan.pull}</li>
          <li><b>Top:</b> {plan.top}</li>
          {plan.backoff && <li><b>Back-off:</b> {plan.backoff}</li>}
          {plan.flywheel_sets ? <li><b>Flywheel:</b> {plan.flywheel_sets} sets</li> : null}
          {best && <li className="muted">Best conventional {best} lb (85% = {Math.round(best * 0.85 / 5) * 5}, 92% = {Math.round(best * 0.92 / 5) * 5}, 97% = {Math.round(best * 0.97 / 5) * 5})</li>}
        </ul>
      )}
      {sorted.length > 0 && (
        <table className="sets">
          <thead><tr><th>#</th><th>Total lb</th><th>Reps</th><th>RPE</th><th>e1RM</th><th></th></tr></thead>
          <tbody>{sorted.map(r => (
            <tr key={r.id}>
              <td>{r.set_index}</td><td>{round(r.weight_lb, 1)}</td><td>{r.reps}</td><td>{r.rpe ?? ''}</td>
              <td>{round(e1rm(r.total_bottom_lb, r.total_top_lb, r.reps, false, cfg))}</td>
              <td><button className="x" onClick={() => api.deleteSet(r.id!)} aria-label="Delete set">×</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="next">
        <div className="row wrap">
          <label className="narrow">Total lb<input inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} /></label>
          <label className="narrow">Reps<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} /></label>
          <label className="narrow">RPE<input inputMode="decimal" value={rpe} onChange={e => setRpe(e.target.value)} /></label>
          <label className="grow">Note<input value={note} onChange={e => setNote(e.target.value)} /></label>
        </div>
        <p className="small muted">Trap bar weighs 85 lb balanced; enter the total.</p>
        <button className="primary" onClick={log} disabled={!exerciseId || !weight}>Log pull</button>
      </div>
    </section>
  )
}

/* ---------- Speed ---------- */

function SpeedBlock({ item, sets, api }: { item: any; sets: SetRow[]; api: Api }) {
  const exerciseId = api.exId(item.name)
  const sorted = [...sets].sort((a, b) => a.set_index - b.set_index)
  const last = sorted.at(-1)
  const [load, setLoad] = useState(String(last?.weight_lb ?? item.load_lb ?? ''))
  const [band, setBand] = useState(last?.setup?.band ?? item.band ?? '')
  const [reps, setReps] = useState('')
  async function log() {
    if (!exerciseId || reps === '') return
    await api.addSet({
      exercise_id: exerciseId, block: 'speed', set_index: (last?.set_index ?? 0) + 1,
      weight_lb: load ? Number(load) : null, total_bottom_lb: null, total_top_lb: null, reps: Number(reps),
      assisted: false, failed: false, setup: band ? { band } : {},
    })
    setReps('')
  }
  return (
    <div className="sub">
      <div className="row between"><b>{item.name}</b><span className="small muted">{sorted.length}/{item.sets ?? '?'} sets{item.reps ? ` × ${item.reps}` : ''}</span></div>
      {item.rule && <p className="small muted">{item.rule}</p>}
      {sorted.length > 0 && (
        <p className="chips">{sorted.map(r => (
          <span key={r.id} className="chip" onClick={() => api.deleteSet(r.id!)} title="Tap to delete">
            {r.weight_lb ? `${round(r.weight_lb, 1)}×` : ''}{r.reps}
          </span>
        ))}</p>
      )}
      {exerciseId ? (
        <div className="row wrap">
          <label className="narrow">Load lb<input inputMode="decimal" value={load} onChange={e => setLoad(e.target.value)} /></label>
          {(item.band || item.name.toLowerCase().includes('band')) && (
            <label className="narrow">Band<input value={band} onChange={e => setBand(e.target.value)} /></label>
          )}
          <label className="narrow">Reps<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} /></label>
          <button className="primary inline" onClick={log} disabled={reps === ''}>Log</button>
        </div>
      ) : <p className="small err">Exercise not set up yet.</p>}
    </div>
  )
}

/* ---------- Support: start weight + reps at start only ---------- */

function SupportRow({ item, existing, api }: { item: any; existing?: SetRow; api: Api }) {
  const exerciseId = api.exId(item.name)
  const [w, setW] = useState(String(existing?.start_weight_lb ?? item.start_lb ?? ''))
  const [reps, setReps] = useState(existing?.reps?.toString() ?? '')
  const [note, setNote] = useState(existing?.notes ?? '')
  useEffect(() => {
    setW(String(existing?.start_weight_lb ?? item.start_lb ?? '')); setReps(existing?.reps?.toString() ?? ''); setNote(existing?.notes ?? '')
  }, [existing?.id])
  async function save() {
    if (!exerciseId) return
    const patch = {
      start_weight_lb: w ? Number(w) : null, reps: reps ? Number(reps) : null, notes: note || null,
      scheme: item.scheme ?? null, step_lb: item.step_lb ?? null, drops: item.drops ?? null,
    }
    if (existing?.id) await api.updateSet(existing.id, patch)
    else if (w || reps || note) await api.addSet({
      exercise_id: exerciseId, block: 'support', set_index: 1, weight_lb: null, total_bottom_lb: null, total_top_lb: null,
      assisted: false, failed: false, setup: {}, ...patch,
    })
  }
  return (
    <div className={'sub' + (existing ? ' done' : '')}>
      <div className="row between"><b>{item.name}</b><span className="small muted">{item.scheme}{item.step_lb ? ` · −${item.step_lb}` : ''}</span></div>
      {item.note && <p className="small muted">{item.note}</p>}
      {exerciseId ? (
        <div className="row wrap">
          <label className="narrow">Start lb<input inputMode="decimal" value={w} onChange={e => setW(e.target.value)} onBlur={save} /></label>
          <label className="narrow">Reps<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} onBlur={save} /></label>
          <label className="grow">Note<input value={note} onChange={e => setNote(e.target.value)} onBlur={save} /></label>
        </div>
      ) : <p className="small err">Exercise not set up yet.</p>}
    </div>
  )
}

/* ---------- helpers ---------- */

function NumCell({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(value?.toString() ?? '')
  useEffect(() => setV(value?.toString() ?? ''), [value])
  return <input className="cell" inputMode="decimal" value={v} onChange={e => setV(e.target.value)}
    onBlur={() => { const nv = v === '' ? null : Number(v); if (nv !== value) onSave(nv) }} />
}

function useClock(since?: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return useMemo(() => (since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0), [now, since])
}

function fmt(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
