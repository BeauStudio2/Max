import { useState } from 'react'
import { supabase } from '../supabase'
import { useStore, templateFor } from '../lib/store'
import type { Template } from '../lib/types'
import { CellText } from './today/Sheet'
import SchemePicker from './today/SchemePicker'
import { T } from './today/shared'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const SCHEMES = ['F', 'TF', 'F + DS×1', 'F + DS×2', 'F + DS×3', 'RTR', 'F + ST×2', '15 to TF + ST×2', 'F + RP×2 (15 s)', '1×F', '3×12–15 TF']
const BANDS = ['', 'Orange', 'Red', 'Blue', 'Green', 'Black', 'Purple', 'Silver']
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

/**
 * The weekly plan: one card per weekday. Sessions inherit from it live — an edit here changes today and every
 * future session of that day, except fields a session edited itself and sessions already past.
 */
export default function Plan({ lifterId }: { lifterId: string }) {
  const { templates, isCoach, reload } = useStore()
  const [err, setErr] = useState<string | null>(null)
  const today = new Date().getDay()

  async function save(t: Template, spec: any, extra: Partial<Template> = {}) {
    setErr(null)
    const { error } = await supabase.from('day_templates').update({ spec, ...extra }).eq('id', t.id)
    if (error) setErr(error.message); else await reload()
  }

  return (
    <div className="stack planpage">
      <p className="small muted">
        <T tip="Each session inherits from its weekday here. Fields a session changed itself, and sessions already past, keep their own values.">How edits apply</T>:
        {' '}changes here flow to today and every future session of that day. A session's own edits and past sessions are left alone.
        {!isCoach && ' The coach edits the plan.'}
      </p>
      {err && <p className="err">{err}</p>}
      {DAYS.map(wd => {
        const t = templateFor(templates, lifterId, wd, '9999-12-31')
        if (!t) return null
        return <DayCard key={t.id} t={t} today={wd === today} ro={!isCoach} save={(spec, extra) => save(t, spec, extra)} />
      })}
    </div>
  )
}

function DayCard({ t, today, ro, save }: { t: Template; today: boolean; ro: boolean; save: (spec: any, extra?: Partial<Template>) => void }) {
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
    <section className={'card dayplan' + (today ? ' today' : '')}>
      <div className="dayhead">
        {ro ? <h2>{t.name}</h2> : <input className="dayname" defaultValue={t.name} key={t.name} aria-label="Day name"
          onBlur={e => e.target.value.trim() && e.target.value !== t.name && save(s, { name: e.target.value.trim() })} />}
        {today && <span className="pill">today</span>}
      </div>
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
            <select className="mini" value={H.lift ?? 'bench'} onChange={e => setHeavy({ lift: e.target.value })}>
              <option value="bench">Bench</option><option value="squat">Squat</option><option value="deadlift">Deadlift (6-week cycle)</option>
            </select>)}</td>
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
      {isDl && <p className="small muted">Week-by-week pulls, back-offs and flywheel sets are on Config → Deadlift cycle.</p>}

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
