import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../supabase'
import { useStore } from '../../lib/store'
import { imu, useImu } from '../../lib/imuLink'
import { BarTracker, calibrate, dropUnrack, type BarRep } from '../../lib/imu'
import { sensor } from '../../lib/tindeq'
import { useSensor } from '../../lib/useSensor'
import { findPulses } from '../../lib/creatine'
import { camera } from '../../lib/camera'
import { speak } from '../../lib/voice'
import CamPanel from '../today/CamPanel'
import { DelBtn, T } from '../today/shared'
import { CellText } from '../today/Sheet'

type Lift = 'bench' | 'squat' | 'deadlift'
const LIFTS: { key: Lift; label: string }[] = [{ key: 'bench', label: 'Bench' }, { key: 'squat', label: 'Squat' }, { key: 'deadlift', label: 'Deadlift' }]
interface TestRow {
  id: string; lifter_id: string; lift: Lift; weight_lb: number | null; spotter: boolean
  sensor_reps: number | null; true_reps: number | null
  reps: { list: { mean_mps: number; peak_mps: number; rom_m: number; raw_rom_m?: number; dur_s: number }[]; unrack: boolean; trace: number[]; seconds: number } | null
  tindeq: { n: number; mean_lb: number; peak_lb: number; resting_lb?: number | null; pulls: { mean: number; dur: number }[] } | null
  clip: { files?: { path: string }[]; station?: string | null } | null
  note: string | null; created_at: string
}
const COLS = 'id,lifter_id,lift,weight_lb,spotter,sensor_reps,true_reps,reps,tindeq,clip,note,created_at'
const r3 = (x: number) => Math.round(x * 1000) / 1000
const IN = 39.37

/** The reps a saved stretch of raw readings gives with the rep reader as it is now. */
function reread(raw: { t: number[]; a: number[] }, rom: number | null, topStart: boolean): BarRep[] {
  const out: BarRep[] = []
  const tr = new BarTracker({ set: s => out.push(...dropUnrack(s.reps, rom, topStart).reps) })
  tr.setTopStart(topStart)
  // A few still seconds before and after, so the reader starts and ends at rest.
  const dt = raw.t.length > 1 ? (raw.t[raw.t.length - 1] - raw.t[0]) / (raw.t.length - 1) : 0.01
  for (let k = 300; k > 0; k--) tr.push({ t: raw.t[0] - k * dt, a: 0 })
  raw.t.forEach((t, i) => tr.push({ t, a: raw.a[i] }))
  const end = raw.t[raw.t.length - 1]
  for (let k = 1; k <= Math.round(15 / dt); k++) tr.push({ t: end + k * dt, a: 0 })
  tr.flush()
  return calibrate(out, rom)
}

/** A small picture of the motion: vertical acceleration over the set. */
function Trace({ data }: { data: number[] }) {
  if (!data?.length) return null
  const w = 160, h = 30, max = Math.max(4, ...data.map(Math.abs))
  const pts = data.map((y, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h / 2 - (y / max) * (h / 2 - 1)).toFixed(1)}`).join(' ')
  return <svg className="trace" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true"><line x1="0" y1={h / 2} x2={w} y2={h / 2} /><polyline points={pts} /></svg>
}

/**
 * Config → Test: try the sensors without it being a workout. Pick the person and the lift, put any weight on the bar and
 * lift. Every set the bar sensor sees is saved as a test row (never in the training log, never used for planning or
 * learning) with its raw readings, the Tindeq's pulls and the film. Type what was really done to see sensor against truth.
 * The same screen sets the person's range of motion and start height, registers how the phone lies on each bar, and zeroes
 * the Tindeq.
 */
/** A push counts when the Tindeq reads this much over its resting tension (lb). Measured 11/12: no-push swing reaches 2.7 over; real pushes run 70+. */
const PUSH_OVER_LB = 6

export default function TestBench() {
  const { lifters, isCoach, reload } = useStore()
  const im = useImu(), tq = useSensor()
  const [lifterId, setLifterId] = useState<string>(() => { try { return localStorage.getItem('max.test.lifter') ?? '' } catch { return '' } })
  const [lift, setLift] = useState<Lift>(() => { try { return (localStorage.getItem('max.test.lift') as Lift) || 'bench' } catch { return 'bench' } })
  const [on, setOn] = useState(false)
  const [weight, setWeight] = useState('')
  const [spotter, setSpotter] = useState(false)
  const [say, setSay] = useState(true)
  const [rows, setRows] = useState<TestRow[]>([])
  const [again, setAgain] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<'' | 'busy' | 'done'>('')
  const [orient, setOrient] = useState<Record<string, [number, number, number]>>({})
  const lifter = lifters.find(l => l.id === lifterId) ?? lifters[0]
  const geo = (lifter?.settings?.chain_geometry?.[lift] ?? {}) as { rom_in?: number; hang_in?: number }
  const rom = geo.rom_in ? geo.rom_in * 0.0254 : null
  const live = im.hz > 0 && Date.now() - im.lastAt < 2500

  useEffect(() => { if (!lifterId && lifters[0]) setLifterId(lifters[0].id) }, [lifters.length])
  useEffect(() => { try { localStorage.setItem('max.test.lifter', lifterId); localStorage.setItem('max.test.lift', lift) } catch { /* this visit only */ } }, [lifterId, lift])
  const load = async () => {
    if (!lifter) return
    const { data, error } = await supabase.from('test_sets').select(COLS).eq('lifter_id', lifter.id).eq('lift', lift).order('created_at', { ascending: false }).limit(30)
    if (error) setErr(error.message); else setRows((data as any) ?? [])
  }
  useEffect(() => { load() }, [lifter?.id, lift])
  useEffect(() => { supabase.from('settings').select('value').eq('key', 'bar_orientation').maybeSingle().then(({ data }) => setOrient((data?.value as any) ?? {})) }, [])

  // The Tindeq's readings over the last few minutes, with the laptop's clock, so a set's pulls can be picked out.
  const pulls = useRef<{ lb: number; at: number }[]>([])
  useEffect(() => sensor.onSamples(s => {
    const now = Date.now(), last = s[s.length - 1]?.t ?? 0
    for (const x of s) pulls.current.push({ lb: x.lb, at: now - (last - x.t) * 1000 })
    while (pulls.current.length && pulls.current[0].at < now - 300_000) pulls.current.shift()
  }), [])

  // While testing: the reader is set up for this person and lift, and every set it sees is saved here, not on Log.
  const ctx = useRef({ lifter, lift, weight, spotter }); ctx.current = { lifter, lift, weight, spotter }
  async function saveSet(s: { reps: BarRep[]; unrack?: boolean; started: number; ended: number; at: number; ended_ms: number } | null) {
    const c = ctx.current
    if (!c.lifter) return
    const now = Date.now()
    const from = s ? s.ended_ms - (s.ended - s.started + 8) * 1000 : now - 60_000, to = s ? Math.min(now, s.ended_ms + 6000) : now
    const raw = imu.raw(Math.min(290, (now - from) / 1000 + 4))
    // A small picture of the motion: about 200 points of the acceleration (the largest swing in each slice).
    const trace: number[] = []
    if (raw) { const step = Math.max(1, Math.floor(raw.a.length / 200)); for (let i = 0; i < raw.a.length; i += step) { let m = 0; for (let k = i; k < Math.min(raw.a.length, i + step); k++) if (Math.abs(raw.a[k]) > Math.abs(m)) m = raw.a[k]; trace.push(Math.round(m * 10) / 10) } }
    const tq = pulls.current.filter(p => p.at >= from - 2000 && p.at <= to + 2000)
    // The Tindeq's own readings over the set, 20 a second, so the way it is read can be worked out from real pulls.
    const force: number[] = []
    if (tq.length) { const t0 = tq[0].at; let k = -1, sum = 0, n = 0; for (const p of tq) { const b = Math.floor((p.at - t0) / 50); if (b !== k && n) { force.push(Math.round((sum / n) * 10) / 10); sum = 0; n = 0 } k = b; sum += p.lb; n++ } if (n) force.push(Math.round((sum / n) * 10) / 10) }
    const sorted = [...force].sort((x, y) => x - y)
    // Resting tension: what the line holds with nobody pushing (the hanging weight). The lower of the set's middle value and its first second and a half.
    const lead = force.slice(0, 30).sort((x, y) => x - y)
    const resting = sorted.length ? Math.min(sorted[Math.floor(sorted.length / 2)], lead[Math.floor(lead.length / 2)]) : null
    // A push is force well clear of that: the line swings about 3 lb either side of resting by itself as the bar moves.
    const found = tq.length ? findPulses(tq.map(p => ({ lb: p.lb - (resting ?? 0), t: (p.at - tq[0].at) / 1000 })), PUSH_OVER_LB, 0.25) : []
    const clip = await camera.clip(`test/${c.lifter.id}/${c.lift}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`, { from, to })
    const row = {
      lifter_id: c.lifter.id, lift: c.lift, weight_lb: c.weight.trim() === '' || isNaN(Number(c.weight)) ? null : Number(c.weight), spotter: c.spotter,
      sensor_reps: s ? s.reps.length : 0,
      reps: { list: (s?.reps ?? []).map(x => ({ mean_mps: r3(x.mean_mps), peak_mps: r3(x.peak_mps), rom_m: r3(x.rom_m), dur_s: r3(x.dur_s), ...(x.raw_rom_m != null ? { raw_rom_m: r3(x.raw_rom_m) } : {}) })), unrack: !!s?.unrack, trace, seconds: Math.round((to - from) / 100) / 10 },
      raw, tindeq: force.length ? { resting_lb: resting, force_20hz: force, from: new Date(tq[0].at).toISOString(), n: found.length, mean_lb: found.length ? Math.round((found.reduce((t, x) => t + x.mean, 0) / found.length) * 10) / 10 : 0, peak_lb: Math.round(Math.max(...force) * 10) / 10, pulls: found.map(x => ({ mean: Math.round(x.mean * 10) / 10, dur: Math.round(x.dur * 100) / 100 })) } : null,
      clip: clip.data,
    }
    const { data, error } = await supabase.from('test_sets').insert(row).select(COLS).single()
    if (error) { setErr(`The test set did not save: ${error.message}`); return }
    setErr(null); setRows(prev => [data as any, ...prev])
  }
  useEffect(() => {
    if (!on) return
    imu.listen(); imu.setRom(rom); imu.setTopStart(lift !== 'deadlift'); imu.setGap(lift === 'squat' ? 12 : 6)
    // Taking the set marks it used, so Log doesn't later attach it to a training set.
    return imu.onAnySet(s => { imu.take(); if (say) speak(`${s.reps.length} ${s.reps.length === 1 ? 'rep' : 'reps'}`); saveSet(s) })
  }, [on, rom, lift, say])
  // Reps said as they happen.
  const said = useRef(0)
  useEffect(() => {
    if (!on || !say) { said.current = im.reps.length; return }
    if (im.reps.length > said.current) speak(String(im.reps.length))
    said.current = im.reps.length
  }, [im.reps.length, on, say])

  const patch = async (id: string, p: Partial<TestRow>) => { setRows(prev => prev.map(r => (r.id === id ? { ...r, ...p } : r))); const { error } = await supabase.from('test_sets').update(p).eq('id', id); if (error) setErr(error.message) }
  const remove = async (id: string) => { const { error } = await supabase.from('test_sets').delete().eq('id', id); if (error) setErr(error.message); else setRows(prev => prev.filter(r => r.id !== id)) }
  async function readAgain(r: TestRow) {
    setAgain(a => ({ ...a, [r.id]: '…' }))
    const { data, error } = await supabase.from('test_sets').select('raw').eq('id', r.id).single()
    const raw = (data as any)?.raw
    if (error || !raw?.t?.length) { setAgain(a => ({ ...a, [r.id]: 'no readings saved' })); return }
    const reps = reread(raw, rom, r.lift !== 'deadlift')
    setAgain(a => ({ ...a, [r.id]: `${reps.length} reps${reps.length ? `: ${reps.map(x => x.mean_mps.toFixed(2)).join(' ')}` : ''}` }))
  }
  const saveGeo = async (p: { rom_in?: number | null; hang_in?: number | null }) => {
    if (!lifter) return
    const st = lifter.settings ?? {}, all = st.chain_geometry ?? {}
    const next = Object.fromEntries(Object.entries({ ...(all[lift] ?? {}), ...p }).filter(([, v]) => v !== null && v !== undefined))
    const { error } = await supabase.from('lifters').update({ settings: { ...st, chain_geometry: { ...all, [lift]: next } } }).eq('id', lifter.id)
    if (error) setErr(error.message); else await reload()
  }
  const lastRead = rows.find(r => r.reps?.list?.length)
  const sensorRom = lastRead ? (() => { const v = lastRead.reps!.list.map(x => x.raw_rom_m ?? x.rom_m).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] * IN })() : null
  const registerPhone = async () => {
    if (!im.gravity) return
    const next = { ...orient, [lift]: im.gravity }
    const { error } = await supabase.from('settings').upsert({ key: 'bar_orientation', value: next })
    if (error) setErr(error.message); else setOrient(next)
  }
  const angle = (a: [number, number, number], b: [number, number, number]) => Math.round((Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI)
  const num = (v: string) => (v.trim() === '' || isNaN(Number(v)) ? null : Number(v))

  return (
    <section className="card testbench">
      <h2><T tip="Try the sensors without it being a workout. Pick the person and the lift, put any weight on the bar and lift. Each set the bar sensor sees becomes a row below with what the sensors read; type what you really did to see sensor against truth. Nothing here goes into the training log, the plan or what Max learns. The raw readings are kept so the rep reading can be checked and improved." pos="right">Test</T></h2>
      <div className="planfields testtop">
        <label>Person
          <select value={lifter?.id ?? ''} onChange={e => setLifterId(e.target.value)}>{lifters.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label>Lift
          <select value={lift} onChange={e => setLift(e.target.value as Lift)}>{LIFTS.map(l => <option key={l.key} value={l.key}>Test {l.label.toLowerCase()}</option>)}</select>
        </label>
        <label><T tip="What is on the bar, for the record. Nothing is planned from it.">Weight on the bar (lb)</T>
          <input inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} placeholder="e.g. 135" />
        </label>
        <label className="toggle"><T tip="Turn on when the spotter line (Tindeq) is helping on this set, so the row is marked as a spotter set.">Spotter line</T>
          <button type="button" className={'switch' + (spotter ? ' on' : '')} aria-pressed={spotter} onClick={() => setSpotter(!spotter)}>{spotter ? 'On' : 'Off'}</button>
        </label>
        <label className="toggle"><T tip="Max says each rep's number as she counts it, and the total when the set ends, so a miscount is heard as it happens.">Say the count</T>
          <button type="button" className={'switch' + (say ? ' on' : '')} aria-pressed={say} onClick={() => setSay(!say)}>{say ? 'On' : 'Off'}</button>
        </label>
      </div>
      <div className="sensrow">
        <button type="button" className={(on ? 'ghost' : 'primary') + ' testgo'} onClick={() => setOn(!on)}>{on ? '■ Stop testing' : '▶ Start testing'}</button>
        {on && <span className="small">Lift. A set is saved {lift === 'squat' ? 12 : 6} seconds after its last rep, or when the bar is racked.</span>}
        {on && <button type="button" className="ghost small" disabled={saving !== ''} onClick={() => { setSaving('busy'); const before = imu.get().lastSet?.at; imu.endSet(); setTimeout(async () => { try { if (imu.get().lastSet?.at === before) await saveSet(null) } finally { setSaving('done'); setTimeout(() => setSaving(''), 2500) } }, 300) }} data-tip="Save the last minute as a row now: use it when you lifted and no row appeared, so there is a record of what the sensor missed." data-pos="right">{saving === 'busy' ? 'Saving…' : saving === 'done' ? '✓ Saved' : 'Save what just happened'}</button>}
      </div>
      {err && <p className="small err">{err}</p>}

      <div className="testlive">
        <div>
          <span className="small muted">Phone on the bar</span>
          <div className="metrorow">
            <span className={'dot ' + (live ? 'on' : '')} />
            {live ? <><b className="tlb">{im.velocity >= 0 ? '+' : ''}{im.velocity.toFixed(2)} m/s</b><span className="small muted">{im.hz}/s</span></> : <span className="small">not sending: open Max Bar (or the phone page) and press Start</span>}
            {on && live && <span className="testcount" aria-live="polite">{im.reps.length}</span>}
          </div>
          {on && im.reps.length > 0 && <span className="small">{im.reps.map(r => r.mean_mps.toFixed(2)).join(' · ')} m/s</span>}
        </div>
        <div>
          <span className="small muted">Tindeq</span>
          <div className="metrorow">
            <span className={'dot ' + tq.status} />
            {tq.status === 'on' ? <><b className="tlb">{tq.lb.toFixed(1)} lb</b><span className={'small ' + (tq.hz ? 'muted' : 'err')}>{tq.hz}/s</span><button type="button" className="ghost small" onClick={() => sensor.tare()} data-tip="Zero the reading with the line just taut." data-pos="center">Zero</button></>
              : <button type="button" className="ghost small" disabled={tq.status === 'connecting'} onClick={() => sensor.connect()}>{tq.status === 'connecting' ? 'Connecting…' : 'Connect'}</button>}
          </div>
          {tq.error && <span className="small err">{tq.error}</span>}
        </div>
        <CamPanel />
      </div>

      <h3><T tip="This person's numbers for this lift, used by the bar sensor (speeds are scaled to the range of motion) and by the chain weight. Measure them with a tape: the phone reads distance about a fifth short, so its own reading is shown for comparison, not as the answer." pos="right">Set up {lifter?.name ?? ''} · {LIFTS.find(l => l.key === lift)!.label.toLowerCase()}</T></h3>
      <div className="planfields testcal">
        <label><T tip="How far the bar travels on one full rep, in inches. Bench: chest to lockout.">Range of motion (in)</T>
          {isCoach ? <CellText value={geo.rom_in != null ? String(geo.rom_in) : ''} narrow numeric placeholder="tape" onSave={v => saveGeo({ rom_in: num(v) })} /> : <b>{geo.rom_in ?? '—'}</b>}
        </label>
        <label><T tip="How high the bar is off the floor at the bottom of the rep, in inches (bench: on the chest). With chains hanging straight from the bar, this is how much chain is off the floor at the bottom.">Bar height at the bottom (in)</T>
          {isCoach ? <CellText value={geo.hang_in != null ? String(geo.hang_in) : ''} narrow numeric placeholder="tape" onSave={v => saveGeo({ hang_in: num(v) })} /> : <b>{geo.hang_in ?? '—'}</b>}
        </label>
        <div className="calnote small">
          {sensorRom !== null
            ? <>The phone read <b>{sensorRom.toFixed(1)} in</b> a rep on the last test set{geo.rom_in ? ` (${Math.round((sensorRom / geo.rom_in) * 100)}% of the ${geo.rom_in} in saved)` : ''}.{isCoach && !geo.rom_in && <> <button type="button" className="linkish" onClick={() => saveGeo({ rom_in: Math.round(sensorRom * 10) / 10 })} data-tip="Saves the phone's reading as this person's range of motion. It usually reads short, so a tape measure is better." data-pos="center">Use it</button></>}</>
            : 'Do a test set to see what the phone reads for a rep.'}
        </div>
        <div className="calnote small">
          <T tip="Records how the phone is lying on this lift's bar (which way is up for the phone). Fix the phone to the bar the way you always will, leave the bar racked and still, and press Register. Later this lets Max tell which bar the phone is on. It needs the Max Bar app updated today, or the phone page reloaded." pos="center">Phone on this bar</T>:{' '}
          {im.gravity
            ? <>{orient[lift] ? <>registered, now <b>{angle(orient[lift], im.gravity)}°</b> from it</> : 'not registered'}{' '}{isCoach && <button type="button" className="linkish" onClick={registerPhone}>{orient[lift] ? 'Register again' : 'Register'}</button>}
              {Object.keys(orient).filter(k => k !== lift).map(k => <span key={k} className="muted"> · {k} {angle(orient[k], im.gravity!)}°</span>)}</>
            : <span className="muted">{live ? 'this phone is not reporting how it lies (update the Max Bar app, or reload the phone page)' : 'phone not sending'}{orient[lift] ? ' · registered' : ''}</span>}
        </div>
      </div>

      <h3>Test sets · {lifter?.name ?? ''} · {LIFTS.find(l => l.key === lift)!.label.toLowerCase()}</h3>
      {!rows.length ? <p className="small muted">None yet. Press Start testing and lift.</p> : (
        <div className="tablewrap"><table className="sheet cfg testsets">
          <thead><tr>
            <th className="stick">When</th><th>lb</th><th data-tip="Spotter line in use.">S</th>
            <th data-tip="Reps the bar sensor counted.">Sensor</th><th data-tip="Type the reps you really did.">True</th><th />
            <th data-tip="Average speed up of each rep the sensor read (m/s).">Speeds (m/s)</th>
            <th data-tip="Pulls the Tindeq recorded during the set: how many, and the average of each (lb).">Tindeq</th>
            <th data-tip="The bar's up-and-down acceleration over the set. Each rep is one wave; the tall spike at the end is the bar going into the hooks.">Motion</th>
            <th data-tip="Film saved with the set.">Film</th>
            <th data-tip="Run the saved readings through the rep reader as it is now: shows whether a fix would have read this set right.">Read again</th>
            <th>Note</th><th className="c-del" />
          </tr></thead>
          <tbody>
            {rows.map(r => {
              const ok = r.true_reps == null ? null : r.true_reps === r.sensor_reps
              return (
                <tr key={r.id}>
                  <td className="stick">{new Date(r.created_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td><CellText value={r.weight_lb != null ? String(r.weight_lb) : ''} narrow numeric onSave={v => patch(r.id, { weight_lb: num(v) })} /></td>
                  <td><button type="button" className={'flag s' + (r.spotter ? ' on' : '')} aria-pressed={r.spotter} onClick={() => patch(r.id, { spotter: !r.spotter })}>S</button></td>
                  <td className="num"><b>{r.sensor_reps ?? '—'}</b>{r.reps?.unrack && <span className="sub2" data-tip="The lift-off was recognised and left out.">unrack out</span>}</td>
                  <td className="o-user"><CellText value={r.true_reps != null ? String(r.true_reps) : ''} narrow numeric placeholder="?" onSave={v => patch(r.id, { true_reps: num(v) })} /></td>
                  <td className={'verdict ' + (ok === null ? '' : ok ? 'good' : 'bad')}>{ok === null ? '' : ok ? '✓ match' : `✗ off by ${Math.abs((r.true_reps ?? 0) - (r.sensor_reps ?? 0))}`}</td>
                  <td className="small speeds">{r.reps?.list?.length ? r.reps.list.map(x => x.mean_mps.toFixed(2)).join(' ') : '—'}</td>
                  <td className="small">{r.tindeq ? <>{r.tindeq.n}: {r.tindeq.pulls.map(p => Math.round(p.mean)).join(' ')}{r.tindeq.resting_lb != null && <div className="sub2" data-tip="The tension the line sat at through the set (its middle reading), and the highest it reached.">rest {r.tindeq.resting_lb} · peak {r.tindeq.peak_lb} lb</div>}</> : '—'}</td>
                  <td><Trace data={r.reps?.trace ?? []} /></td>
                  <td className="small">{r.clip?.files?.length ? `✓${r.clip.station ? ` ${r.clip.station}` : ''}` : '—'}</td>
                  <td className="small">{again[r.id] ?? <button type="button" className="linkish" onClick={() => readAgain(r)}>Read again</button>}</td>
                  <td><CellText value={r.note ?? ''} onSave={v => patch(r.id, { note: v.trim() || null })} /></td>
                  <td className="c-del">{isCoach && <DelBtn tip="Delete this test set" onConfirm={() => remove(r.id)} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      )}
    </section>
  )
}
