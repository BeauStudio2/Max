import { useState } from 'react'
import { supabase } from '../supabase'
import { useStore, plansFor } from '../lib/store'
import type { Template } from '../lib/types'
import { CellText } from './today/Sheet'
import SchemePicker from './today/SchemePicker'
import { T } from './today/shared'

const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF', '3×10 not to max']
const BANDS = ['', 'Orange', 'Red', 'Blue', 'Green', 'Black', 'Purple', 'Silver']
/** Cycles a lift can run instead of its standard program. A lift with none always runs its standard. */
const CYCLES: Record<string, { id: string; label: string }[]> = { deadlift: [{ id: 'deadlift_6wk', label: '6-week cycle' }] }
/** New plans start with a bracketed name, which sorts above every lettered name until it is renamed. */
const NEW_PLAN = '(New plan)'
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

/**
 * The plans: named, individually designed days (no weekdays). The log picks one per session, and sessions inherit
 * from it live — an edit here changes every session on that plan, except fields a session edited itself and past sessions.
 */
export default function Plan({ lifterId }: { lifterId: string }) {
  const { templates, lifters, isCoach, reload } = useStore()
  const [err, setErr] = useState<string | null>(null)
  const lifterName = lifters.find(l => l.id === lifterId)?.name ?? 'this lifter'

  async function save(t: Template, spec: any, extra: Partial<Template> = {}) {
    setErr(null)
    const { error } = await supabase.from('day_templates').update({ spec, ...extra }).eq('id', t.id)
    if (error) setErr(error.message); else await reload()
  }
  // The plan just made: pinned to the top with its name selected, so it can be renamed straight away.
  const [fresh, setFresh] = useState<string | null>(null)
  const [making, setMaking] = useState<'busy' | 'done' | null>(null)
  async function create(name: string, spec: any, lifter_id: string | null) {
    setErr(null); setMaking('busy')
    const { data, error } = await supabase.from('day_templates').insert({ name, spec, lifter_id, weekday: null, active_from: '2000-01-01' }).select('id').single()
    if (error) { setErr(error.message); setMaking(null); return }
    await reload()
    setFresh(data.id); setMaking('done')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setTimeout(() => setMaking(m => (m === 'done' ? null : m)), 2000)
  }
  async function remove(t: Template) {
    setErr(null)
    const { error } = await supabase.from('day_templates').delete().eq('id', t.id)
    if (error) setErr(error.message); else await reload()
  }

  return (
    <div className="stack planpage">
      <p className="small muted">
        <T tip="Each session inherits from the plan picked for it in the Log. Fields a session changed itself, and sessions already past, keep their own values.">How edits apply</T>:
        {' '}plans are designed days, picked in the Log. Changes here flow to every session on that plan; a session's own edits and past sessions are left alone.
        {!isCoach && ' The coach edits the plans.'}
      </p>
      {err && <p className="err">{err}</p>}
      {isCoach && <button className={making === 'done' ? 'small' : 'ghost small'} disabled={making === 'busy'}
        onClick={() => create(NEW_PLAN, { heavy: { lift: 'bench' }, order: ['speed', 'heavy', 'support'] }, null)}>
        {making === 'busy' ? 'Creating…' : making === 'done' ? '✓ Plan created: name it below' : '+ New plan'}</button>}
      {[...plansFor(templates, lifterId)].sort((a, b) => (b.id === fresh ? 1 : 0) - (a.id === fresh ? 1 : 0)).map(t => (
        <DayCard key={t.id} t={t} fresh={t.id === fresh} ro={!isCoach} lifterName={lifterName} save={(spec, extra) => save(t, spec, extra)}
          onOnly={only => save(t, t.spec, { lifter_id: only ? lifterId : null })}
          onCopy={() => create('(Copy) ' + t.name, t.spec, t.lifter_id)} onDelete={() => remove(t)} />
      ))}
    </div>
  )
}

function DayCard({ t, ro, save, lifterName, onOnly, onCopy, onDelete, fresh = false }: {
  t: Template; fresh?: boolean; ro: boolean; save: (spec: any, extra?: Partial<Template>) => void
  lifterName: string; onOnly: (only: boolean) => void; onCopy: () => void; onDelete: () => void
}) {
  const [askDel, setAskDel] = useState(false)
  const { exercises } = useStore()
  const s = t.spec ?? {}
  const H = s.heavy ?? {}
  const setHeavy = (patch: any) => save({ ...s, heavy: clean({ ...H, ...patch }) })
  const speedItems: any[] = s.speed?.items ?? []
  const supItems: any[] = s.support?.items ?? []
  const setSpeed = (items: any[], patch: any = {}) => save({ ...s, speed: items.length || patch.lift ? { ...(s.speed ?? {}), ...patch, items } : null })
  const setSupport = (items: any[], patch: any = {}) => save({ ...s, support: { ...(s.support ?? {}), ...patch, items } })
  const exOptions = exercises.map(e => e.name).sort((a, b) => a.localeCompare(b))
  const ExSel = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => ro ? <span>{value}</span> : (
    <select className="mini" value={value} onChange={e => onChange(e.target.value)}>
      {!exOptions.includes(value) && <option value={value}>{value}</option>}
      {exOptions.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  )
  const cell = (v: any, onSave: (x: string) => void, opts: { numeric?: boolean; wide?: boolean; placeholder?: string } = {}) =>
    ro ? <span>{v ?? ''}</span> : <CellText value={v == null ? '' : String(v)} narrow={opts.numeric && !opts.wide} wide={opts.wide} numeric={opts.numeric} placeholder={opts.placeholder} onSave={onSave} />
  const isDl = H.lift === 'deadlift'

  return (
    <section className={'card dayplan' + (fresh ? ' today' : '')}>
      <div className="dayhead">
        {ro ? <h2>{t.name}</h2> : <input className="dayname" defaultValue={t.name} key={t.name} aria-label="Day name" autoFocus={fresh} onFocus={e => fresh && e.target.select()}
          onBlur={e => e.target.value.trim() && e.target.value !== t.name && save(s, { name: e.target.value.trim() })} />}
        {fresh && <span className="pill">new</span>}
        {t.lifter_id && <span className="pill">{lifterName} only</span>}
      </div>
      {!ro && <div className="row wrap small">
        <label className="check" data-tip="On: only this lifter sees and picks this plan. Off: shared with everyone." data-pos="left">
          <input type="checkbox" checked={!!t.lifter_id} onChange={e => onOnly(e.target.checked)} /> Only {lifterName}</label>
        <button className="ghost small" onClick={onCopy} data-tip="Make a copy to design a variation">Duplicate</button>
        {askDel
          ? <><button className="ghost small" onClick={() => { setAskDel(false); onDelete() }}>Delete this plan</button><button className="ghost small" onClick={() => setAskDel(false)}>Keep</button></>
          : <button className="ghost small" onClick={() => setAskDel(true)} data-tip="Delete the plan. Past sessions keep the plan they were logged with.">Delete…</button>}
      </div>}
      {ro ? (s.logic && <p className="small muted">{s.logic}</p>) : (
        <textarea className="logic small" rows={1} defaultValue={s.logic ?? ''} key={s.logic ?? ''} placeholder="Why this day is built this way"
          onBlur={e => e.target.value !== (s.logic ?? '') && save({ ...s, logic: e.target.value.trim() || undefined })} />
      )}

      <div className="dayorder small">
        <label className="check" data-tip="On: one speed round after each heavy set. Off: all heavy sets, then all speed." data-pos="left">
          <input type="checkbox" disabled={ro} checked={(s.speed_placement ?? 'between') === 'between'} onChange={e => save({ ...s, speed_placement: e.target.checked ? 'between' : 'after' })} /> Interleave heavy and speed</label>
        <label className="check" data-tip="On: one support set after each heavy + speed round, in one list. Off: support at the end." data-pos="left">
          <input type="checkbox" disabled={ro} checked={!!s.support_interleave} onChange={e => save({ ...s, support_interleave: e.target.checked })} /> Interleave support</label>
      </div>
      <h3><T tip="The main lift. Every session of this day inherits these unless it changes them itself.">Heavy</T></h3>
      <div className="tablewrap"><table className="sheet cfg plantable">
        <thead><tr>
          <th>Lift</th>
          <th data-tip="Standard: the lift's everyday program. A cycle, where the lift has one, changes the work week by week.">Program</th>
          {!isDl && <>
            <th data-tip="Reps each set is weighted for.">Target reps</th>
            <th data-tip="Stop when a set's estimated max falls below this % of set 1's.">Stop %</th>
            <th data-tip="The plate that spans lightest to heaviest set; bigger plates stay on all session.">Change plate</th>
            <th data-tip="½ in chains per side on sets 2+.">½ ch</th>
            <th data-tip="⅝ in chains per side on sets 2+.">⅝ ch</th>
            <th data-tip="Chains used on sets 2+ at all.">Chains</th>
          </>}
          <th data-tip="Target rest between heavy sets (seconds).">Rest s</th>
        </tr></thead>
        <tbody><tr>
          <td data-l="Lift">{ro ? <span className="cap">{H.lift}</span> : (
            <select className="mini" value={H.lift ?? 'bench'} onChange={e => setHeavy({ lift: e.target.value, cycle: undefined, scheme: undefined })}>
              <option value="bench">Bench</option><option value="squat">Squat</option><option value="deadlift">Deadlift</option>
            </select>)}</td>
          <td data-l="Program">{(CYCLES[H.lift ?? 'bench'] ?? []).length === 0 || ro
            ? <span className="muted">{(CYCLES[H.lift ?? 'bench'] ?? []).find(c => c.id === H.cycle)?.label ?? 'Standard'}</span>
            : <select className="mini" value={H.cycle ?? ''} onChange={e => setHeavy({ cycle: e.target.value || undefined })}>
                <option value="">Standard</option>
                {CYCLES[H.lift].map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>}</td>
          {!isDl && <>
            <td data-l="Target reps">{cell(H.target_reps, v => setHeavy({ target_reps: num(v) }), { numeric: true })}</td>
            <td data-l="Stop %">{cell(H.stop_pct, v => setHeavy({ stop_pct: num(v) }), { numeric: true, placeholder: '70' })}</td>
            <td data-l="Change plate">{cell(H.change_plate, v => setHeavy({ change_plate: num(v) }), { numeric: true, placeholder: '10' })}</td>
            <td data-l="½ chains">{cell(H.chain_half, v => setHeavy({ chain_half: num(v) }), { numeric: true })}</td>
            <td data-l="⅝ chains">{cell(H.chain_5_8, v => setHeavy({ chain_5_8: num(v) }), { numeric: true })}</td>
            <td data-l="Chains">{ro ? (H.chains_on === false ? 'off' : 'on') : <input type="checkbox" checked={H.chains_on !== false} onChange={e => setHeavy({ chains_on: e.target.checked })} aria-label="Chains on" />}</td>
          </>}
          <td data-l="Rest s">{cell(H.rest_s, v => setHeavy({ rest_s: num(v) }), { numeric: true, placeholder: isDl ? '180' : '100' })}</td>
        </tr></tbody>
      </table></div>
      {isDl && H.cycle && <p className="small muted">Week-by-week pulls, back-offs and flywheel sets are on Config → Deadlift cycle.</p>}
      {isDl && !H.cycle && <p className="small muted">Standard deadlift: warm-ups in sets of 3 up to the top set, one top set of max reps to technical failure, then any back-offs and flywheel sets below.</p>}
      {isDl && !H.cycle && (
        <div className="tablewrap"><table className="sheet cfg plantable">
          <thead><tr>
            <th data-tip="Top-set weight (about a 5-rep max). Blank = the lifter's planned top. The set goes to technical failure.">Top lb</th>
            <th data-tip="Back-offs off the top set, written sets×reps @ % (e.g. 3×3 @ 60%). Blank = none.">Back-off</th>
            <th data-tip="Exercise for the back-offs. Blank = deadlift.">Back-off exercise</th>
            <th data-tip="Flywheel deadlift sets after the pulls.">Flywheel</th>
            <th>Back-off note</th>
          </tr></thead>
          <tbody><tr>
            <td data-l="Top lb">{cell(H.top_lb, v => setHeavy({ top_lb: num(v) }), { numeric: true })}</td>
            <td data-l="Back-off">{cell(H.backoff, v => setHeavy({ backoff: v.trim() || undefined }), { wide: true, placeholder: 'e.g. 3×3 @ 60%' })}</td>
            <td data-l="Back-off exercise"><ExSel value={H.backoff_exercise ?? 'Deadlift'} onChange={v => setHeavy({ backoff_exercise: v === 'Deadlift' ? undefined : v })} /></td>
            <td data-l="Flywheel">{cell(H.flywheel_sets, v => setHeavy({ flywheel_sets: num(v) }), { numeric: true, placeholder: '0' })}</td>
            <td className="wrapcell" data-l="Back-off note">{cell(H.backoff_setup, v => setHeavy({ backoff_setup: v || undefined }), { wide: true })}</td>
          </tr></tbody>
        </table></div>
      )}

      <h3><T tip="Speed work done around the heavy sets. Blank = no speed this day.">Speed</T>
        {!ro && <select className="mini inline" value={s.speed?.lift ?? ''} onChange={e => setSpeed(e.target.value ? speedItems : [], { lift: e.target.value || undefined })} aria-label="Speed lift">
          <option value="">none</option><option value="bench">bench</option><option value="squat">squat</option>
        </select>}
        {ro && s.speed?.lift ? <span className="cap muted small"> · {s.speed.lift}</span> : null}
      </h3>
      {s.speed && (
        <div className="tablewrap"><table className="sheet cfg plantable">
          <thead><tr>
            <th className="stick">Exercise</th><th data-tip="Sets per session (when speed runs between heavy sets, it follows the heavy set count instead).">Sets</th>
            <th data-tip="Target reps per set.">Reps</th><th data-tip="Load in lb (bar or implement).">lb</th>
            <th data-tip="Band colour, if banded.">Band</th><th data-tip="Bands per side.">/side</th><th data-tip="Cue shown with the exercise.">Rule</th><th />
          </tr></thead>
          <tbody>{speedItems.map((it, i) => {
            const set = (patch: any) => setSpeed(speedItems.map((x, j) => j === i ? clean({ ...x, ...patch }) : x))
            return (
              <tr key={i}>
                <td className="stick"><ExSel value={it.name} onChange={v => set({ name: v })} /></td>
                <td data-l="Sets">{cell(it.sets, v => set({ sets: num(v) }), { numeric: true })}</td>
                <td data-l="Reps">{cell(it.reps, v => set({ reps: num(v) }), { numeric: true })}</td>
                <td data-l="lb">{cell(it.load_lb, v => set({ load_lb: num(v) }), { numeric: true })}</td>
                <td data-l="Band">{ro ? (it.band ?? '') : <select className="mini" value={String(it.band ?? '').split(' ')[0]} onChange={e => set({ band: e.target.value || undefined, bands_per_side: e.target.value ? it.bands_per_side ?? 1 : undefined })}>
                  {BANDS.map(b => <option key={b} value={b}>{b || '—'}</option>)}</select>}</td>
                <td data-l="/side">{cell(it.bands_per_side, v => set({ bands_per_side: num(v) }), { numeric: true })}</td>
                <td className="wrapcell" data-l="Rule">{cell(it.rule, v => set({ rule: v || undefined }), { wide: true })}</td>
                <td>{!ro && <button className="x" onClick={() => setSpeed(speedItems.filter((_, j) => j !== i))} aria-label="Remove" data-tip="Remove from this day's speed work" data-pos="right">×</button>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}
      {!ro && s.speed && <button className="ghost small" onClick={() => setSpeed([...speedItems, { name: exOptions[0] ?? '', sets: 5, reps: 5 }])}>+ speed exercise</button>}

      <h3><T tip="Accessory work after the heavy sets. Each session can swap or add exercises; this is the default list.">Support</T>
        {ro ? <span className="muted small"> · {s.support?.group}</span> : (
          <input className="mini inline groupname" defaultValue={s.support?.group ?? ''} key={s.support?.group ?? ''} placeholder="group" aria-label="Support group name"
            onBlur={e => e.target.value.trim() !== (s.support?.group ?? '') && setSupport(supItems, { group: e.target.value.trim() })} />
        )}
      </h3>
      <div className="tablewrap"><table className="sheet cfg plantable">
        <thead><tr>
          <th className="stick">Exercise</th><th data-tip="F = to failure · TF = technical failure · DS×n = n drops · ST = strip · RP = rest-pause · RTR = run the rack.">Scheme</th>
          <th data-tip="Default start weight (blank = choose on the day).">Start</th><th data-tip="Weight removed each drop.">Step</th><th data-tip="Number of drops.">Drops</th><th data-tip="Sets of this exercise per session by default. The Log can raise or lower it for one session.">Max sets</th><th>Note</th><th />
        </tr></thead>
        <tbody>{supItems.map((it, i) => {
          const set = (patch: any) => setSupport(supItems.map((x, j) => j === i ? clean({ ...x, ...patch }) : x))
          return (
            <tr key={i}>
              <td className="stick"><ExSel value={it.name} onChange={v => set({ name: v })} /></td>
              <td data-l="Scheme">{ro ? it.scheme : <SchemePicker value={it.scheme ?? ''} options={SCHEMES} onChange={v => set({ scheme: v })} />}</td>
              <td data-l="Start">{cell(it.start_lb, v => set({ start_lb: num(v) }), { numeric: true })}</td>
              <td data-l="Step">{cell(it.step_lb, v => set({ step_lb: num(v) }), { numeric: true })}</td>
              <td data-l="Drops">{cell(it.drops, v => set({ drops: num(v) }), { numeric: true })}</td>
              <td data-l="Max sets">{cell(it.max_sets, v => set({ max_sets: num(v) }), { numeric: true, placeholder: '1' })}</td>
              <td className="wrapcell" data-l="Note">{cell(it.note, v => set({ note: v || undefined }), { wide: true })}</td>
              <td className="nowrap">{!ro && <>
                <button className="ghost small" disabled={i === 0} onClick={() => { const a = [...supItems];[a[i - 1], a[i]] = [a[i], a[i - 1]]; setSupport(a) }} aria-label="Move up" data-tip="Move up" data-pos="right">↑</button>
                <button className="x" onClick={() => setSupport(supItems.filter((_, j) => j !== i))} aria-label="Remove" data-tip="Remove from this day's support" data-pos="right">×</button>
              </>}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
      {!ro && <button className="ghost small" onClick={() => setSupport([...supItems, { name: exOptions[0] ?? '', scheme: 'F + DS×2', drops: 2 }])}>+ support exercise</button>}
    </section>
  )
}

/** Drops undefined/empty keys so the stored plan stays tidy. */
function clean(o: any) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))))
}
