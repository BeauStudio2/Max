import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store'
import { round } from '../../lib/load'
import type { SetRow } from '../../lib/types'
import { ExercisePicker, type Api } from './shared'

type Kind = 'throw' | 'bandbench' | 'jump' | 'generic'
const kindOf = (name: string): Kind => {
  const n = name.toLowerCase()
  if (n.includes('throw')) return 'throw'
  if (n.includes('banded bench')) return 'bandbench'
  if (n.includes('jump')) return 'jump'
  return 'generic'
}

export default function SpeedBlock({ item, sets, api, exerciseName, onExercise, extraSetup }: { item: any; sets: SetRow[]; api: Api; exerciseName: string; onExercise: (n: string) => void; extraSetup?: () => Record<string, any> }) {
  const { equipment } = useStore()
  const bands = equipment.filter(e => e.kind === 'band')
  const kind = kindOf(exerciseName)
  const exerciseId = api.exId(exerciseName)
  const sorted = [...sets].sort((a, b) => a.set_index - b.set_index)
  const last = sorted.at(-1)
  const ls = last?.setup ?? {}
  const defaultBand = bands.find(b => item.band && b.name.toLowerCase().includes(String(item.band).split(' ')[0].toLowerCase()))?.name ?? ''

  const [load, setLoad] = useState('')
  const [band, setBand] = useState('')
  const [nb, setNb] = useState('')
  const [reps, setReps] = useState('')
  const [hits, setHits] = useState('')
  const [string, setString] = useState('')
  useEffect(() => {
    setLoad(String(last?.weight_lb ?? item.load_lb ?? (kind === 'bandbench' ? 22 : '')))
    setBand(ls.band ?? defaultBand); setNb(String(ls.bands ?? (item.bands_per_side ? item.bands_per_side * 2 : kind === 'bandbench' ? 2 : '')))
    setString(ls.string_in?.toString() ?? ''); setReps(''); setHits('')
  }, [last?.id, item.name])

  const bandEq = bands.find(b => b.name === band)
  const lockout = bandEq && nb ? Number(bandEq.props?.one_band_lockout_lb ?? 0) * Number(nb) : null

  async function log() {
    if (!exerciseId || reps === '') return
    const setup: Record<string, any> = { slot: item.name, ...(extraSetup?.() ?? {}) }
    if (kind === 'throw') setup.bell_reps_of = 7
    if (kind === 'bandbench' || kind === 'jump') Object.assign(setup, { band: band || null, bands: nb ? Number(nb) : null, lockout_lb: lockout, chest_lb: kind === 'bandbench' ? 0 : null })
    if (kind === 'bandbench') Object.assign(setup, { bell_hits: hits ? Number(hits) : null, string_in: string ? Number(string) : null })
    await api.addSet({
      exercise_id: exerciseId, block: 'speed', set_index: (last?.set_index ?? 0) + 1,
      weight_lb: load ? Number(load) : null, total_bottom_lb: null, total_top_lb: null, reps: Number(reps),
      assisted: false, failed: false, setup,
    })
    setReps(''); setHits('')
  }

  const chip = (r: SetRow) => {
    const s = r.setup ?? {}
    if (kind === 'throw') return `${round(r.weight_lb, 1)} · ${r.reps}/7`
    if (kind === 'bandbench') return `${r.reps}${s.bell_hits !== null && s.bell_hits !== undefined ? ` · ${s.bell_hits} bell` : ''}`
    return `${r.weight_lb ? round(r.weight_lb, 1) + '×' : ''}${r.reps}`
  }

  return (
    <div className="sub">
      <div className="row between"><ExercisePicker value={exerciseName} onChange={onExercise} /><span className="small muted setcount">{sorted.length}/{item.sets ?? '?'} sets{item.reps ? ` × ${item.reps}` : ''}</span></div>
      {item.rule && exerciseName === item.name && <p className="small muted">{item.rule}</p>}
      {sorted.length > 0 && (
        <p className="chips">{sorted.map(r => (
          <span key={r.id} className="chip" onClick={() => api.deleteSet(r.id!)} title="Tap to delete">{chip(r)}</span>
        ))}</p>
      )}
      {exerciseId ? (
        <div className="row wrap">
          {kind !== 'jump' && (
            <label className="narrow">{kind === 'bandbench' ? 'Bar lb' : 'Load lb'}<input inputMode="decimal" value={load} onChange={e => setLoad(e.target.value)} /></label>
          )}
          {(kind === 'bandbench' || kind === 'jump') && <>
            <label className="grow">Band
              <select value={band} onChange={e => setBand(e.target.value)}>
                <option value="">none</option>
                {bands.map(b => <option key={b.id} value={b.name}>{b.name.replace('Rogue band ', '')} ({b.props?.one_band_lockout_lb} lb)</option>)}
              </select>
            </label>
            <label className="narrow"># bands<input inputMode="numeric" value={nb} onChange={e => setNb(e.target.value)} /></label>
          </>}
          <label className="narrow">{kind === 'throw' ? 'Bell reps /7' : 'Reps'}<input inputMode="numeric" value={reps} onChange={e => setReps(e.target.value)} placeholder={item.reps ? String(item.reps) : ''} /></label>
          {kind === 'bandbench' && <>
            <label className="narrow">Bell hits<input inputMode="numeric" value={hits} onChange={e => setHits(e.target.value)} /></label>
            <label className="narrow">String in<input inputMode="decimal" value={string} onChange={e => setString(e.target.value)} /></label>
          </>}
          <button className="primary inline" onClick={log} disabled={reps === ''}>Log</button>
        </div>
      ) : <p className="small err">Exercise not set up yet.</p>}
      {lockout !== null && kind === 'bandbench' && <p className="small muted">Bands: 0 lb at chest → {round(lockout)} lb at lockout.</p>}
    </div>
  )
}
