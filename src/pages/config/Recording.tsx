import { useState } from 'react'
import { supabase } from '../../supabase'
import { localDate } from '../../lib/load'
import { readRecording, unpack, type FoundSet, type Reading } from '../../lib/reread'
import { T } from '../today/shared'

const IN = 39.37
interface Row extends FoundSet { who: string; lift: string; logged: { set_index: number; reps: number | null } | null }
type Piece = { source: string; from_at: string; to_at: string; session_id: string | null; lifter_id: string | null; label: string | null; data: string }

/**
 * The workout's recording, read again. Every phone and Tindeq reading of a workout is saved as it happens; this runs the
 * bar reader over a day's recording and lists every set it finds, beside what was logged at the time, so a set Max missed
 * or miscounted can still be seen. The list is also saved (settings key "reread:<date>") so it can be looked at from outside.
 */
export default function Recording() {
  const [date, setDate] = useState(localDate())
  const [busy, setBusy] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function read() {
    setBusy('Loading the recording…'); setErr(null); setRows(null); setInfo(null)
    try {
      const from = new Date(date + 'T00:00:00'), to = new Date(from.getTime() + 86_400_000)
      const pieces: Piece[] = []
      for (let at = 0; ; at += 40) {
        const { data, error } = await supabase.from('raw_chunks').select('source,from_at,to_at,session_id,lifter_id,label,data')
          .gte('from_at', from.toISOString()).lt('from_at', to.toISOString()).order('from_at').range(at, at + 39)
        if (error) throw new Error(error.message)
        pieces.push(...(data as Piece[]))
        setBusy(`Loading the recording… ${pieces.length} pieces`)
        if (!data || data.length < 40) break
      }
      if (!pieces.length) { setInfo('Nothing was recorded that day. Recording runs while a workout is started on Log, or while testing here.'); setBusy(''); return }
      // Whose workout each stretch was, and that lift's range of motion.
      const ids = [...new Set(pieces.map(p => p.session_id).filter(Boolean))] as string[]
      const { data: sess } = ids.length ? await supabase.from('sessions').select('id,primary_lift,planned,lifter_id').in('id', ids) : { data: [] as any[] }
      const { data: logged } = ids.length ? await supabase.from('sets').select('session_id,set_index,reps,setup,created_at,block').in('session_id', ids).eq('block', 'primary') : { data: [] as any[] }
      const tq: Reading[] = pieces.filter(p => p.source === 'tindeq').flatMap(unpack)
      // Stretches: the phone's pieces in time order, cut wherever the lifter (session) changes.
      const out: Row[] = []
      let cur: { key: string; p: Piece; imu: Reading[] } | null = null
      const done = () => {
        if (!cur) return
        const s = (sess ?? []).find((x: any) => x.id === cur!.p.session_id)
        const lift = String(s?.primary_lift ?? ''), rom = Number(s?.planned?.snap?.plan?.rom_in) || null
        const found = readRecording(cur.imu, tq, { rom_m: rom ? rom * 0.0254 : null, topStart: !/deadlift/i.test(lift), set_gap_s: /squat/i.test(lift) ? 12 : 6 })
        for (const f of found) {
          // Logged at the time? A sensor-logged set carries the moment its last rep ended; a typed one only when it was saved.
          const m = (logged ?? []).filter((x: any) => x.session_id === cur!.p.session_id).map((x: any) => ({ x, d: Math.abs(new Date(x.setup?.ended_at ?? x.created_at).getTime() - f.to) })).sort((a: any, b: any) => a.d - b.d)[0]
          out.push({ ...f, who: cur.p.label ?? '', lift, logged: !f.ignored && m && m.d < 25_000 ? { set_index: m.x.set_index, reps: m.x.reps } : null })
        }
        cur = null
      }
      for (const p of pieces.filter(x => x.source === 'imu')) {
        const key = p.session_id ?? p.label ?? ''
        if (!cur || cur.key !== key) { done(); cur = { key, p, imu: [] } }
        cur.imu.push(...unpack(p))
      }
      done()
      setRows(out)
      const sets = out.filter(r => !r.ignored)
      setInfo(`${pieces.length} pieces · ${Math.round(pieces.filter(p => p.source === 'imu').reduce((t, p) => t + (new Date(p.to_at).getTime() - new Date(p.from_at).getTime()), 0) / 60000)} min of bar readings · ${sets.length} sets found, ${sets.filter(r => !r.logged).length} not logged at the time`)
      await supabase.from('settings').upsert({ key: 'reread:' + date, value: out.map(r => ({ at: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), who: r.who, lift: r.lift, reps: r.reps.length, ignored: r.ignored, mps: r.reps.map(x => x.mean_mps), travel_m: r.reps.map(x => x.raw_rom_m ?? x.rom_m), help: r.help, logged: r.logged })) })
    } catch (e: any) { setErr(e?.message ?? String(e)) }
    setBusy('')
  }

  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return (
    <section className="card recording">
      <h2><T tip="Every reading from the phone on the bar and the Tindeq is saved for the whole of a workout. Reading it again runs the bar reader over that record and lists every set it finds, next to what was logged at the time: a set Max missed or miscounted during the workout shows up here.">Recording</T></h2>
      <div className="metrorow">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <button type="button" className="primary" disabled={!!busy} onClick={read}>{busy || 'Read the recording'}</button>
      </div>
      {err && <p className="small err">{err}</p>}
      {info && <p className="small muted">{info}</p>}
      {rows && rows.length > 0 && (
        <div className="tablewrap"><table className="sheet cfg rereads">
          <thead><tr>
            <th>Time</th><th>Who</th><th><T tip="Reps the reader finds in the recording now.">Reps</T></th>
            <th><T tip="Bar speed of the first and last rep (scaled to the lifter's range of motion), and how far the fastest rep travelled on the sensor.">Speed</T></th>
            <th><T tip="The spotter line's tension while the bar went up on each rep: the help the lifter got, rep by rep.">Help per rep (lb)</T></th>
            <th><T tip="What was logged for this set during the workout. 'not logged' means Max did not log it then; a different rep count means it was logged or corrected to something else.">Logged then</T></th>
          </tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={r.ignored ? 'muted' : r.logged ? '' : 'missed'}>
              <td>{time(r.from)}</td><td>{r.who} {r.lift}</td>
              <td>{r.ignored ? <span data-tip="The bar moved, but not far enough to be the lift (a plate change, or the bar being shifted).">not a set</span> : <b>{r.reps.length}</b>}</td>
              <td>{r.reps.length ? `${r.reps[0].mean_mps.toFixed(2)} → ${r.reps[r.reps.length - 1].mean_mps.toFixed(2)} m/s · ${(Math.max(...r.reps.map(x => x.raw_rom_m ?? x.rom_m)) * IN).toFixed(0)} in` : ''}</td>
              <td>{r.help ? r.help.map(h => h.toFixed(0)).join(', ') : r.ignored ? '' : <span className="muted">no Tindeq</span>}</td>
              <td>{r.ignored ? '' : r.logged ? <>set {r.logged.set_index}{r.logged.reps !== r.reps.length ? <b className="err"> · {r.logged.reps ?? '?'} reps</b> : ' ✓'}</> : <b className="err">not logged</b>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  )
}
