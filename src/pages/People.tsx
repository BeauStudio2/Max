import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useStore } from '../lib/store'
import type { Profile } from '../lib/types'

export default function People() {
  const { lifters, reload, auth } = useStore()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [newName, setNewName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at')
    if (error) setErr(error.message)
    setProfiles((data as Profile[]) ?? [])
  }
  useEffect(() => { load() }, [])

  async function link(lifterId: string, userId: string) {
    const { error } = await supabase.from('lifters').update({ user_id: userId || null }).eq('id', lifterId)
    if (error) setErr(error.message); else await reload()
  }
  async function setRole(id: string, role: string) {
    if (id === auth.user.id && role !== 'coach' && !confirm('Remove your own coach access?')) return
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id)
    if (error) setErr(error.message); else load()
  }
  async function addLifter() {
    if (!newName.trim()) return
    const { error } = await supabase.from('lifters').insert({ name: newName.trim() })
    if (error) setErr(error.message); else { setNewName(''); await reload() }
  }

  const label = (p: Profile) => p.display_name || p.id.slice(0, 8)

  return (
    <>
      {err && <p className="err">{err}</p>}
      <section className="card">
        <h2>Lifters and accounts</h2>
        <p className="small muted">Link each lifter to the account they signed up with. A linked account can log and see only that lifter.</p>
        {lifters.map(l => (
          <div key={l.id} className="row between">
            <b>{l.name}</b>
            <select value={l.user_id ?? ''} onChange={e => link(l.id, e.target.value)}>
              <option value="">not linked</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </select>
          </div>
        ))}
        <div className="row">
          <input placeholder="New lifter name" value={newName} onChange={e => setNewName(e.target.value)} />
          <button className="primary inline" onClick={addLifter}>Add</button>
        </div>
      </section>
      <section className="card">
        <h2>Accounts</h2>
        {profiles.map(p => (
          <div key={p.id} className="row between">
            <span>{label(p)}</span>
            <select value={p.role} onChange={e => setRole(p.id, e.target.value)}>
              <option value="lifter">lifter</option><option value="coach">coach</option>
            </select>
          </div>
        ))}
      </section>
    </>
  )
}
