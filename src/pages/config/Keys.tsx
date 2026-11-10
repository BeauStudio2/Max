import { useState } from 'react'
import { apiKeys, SERVICES, useKeys } from '../../lib/keys'
import { DelBtn, T } from '../today/shared'

const mask = (k: string) => (k.length > 8 ? k.slice(0, 4) + '•'.repeat(8) + k.slice(-4) : '•'.repeat(k.length))

/** Config → API keys: keys for outside services, kept on this laptop only. */
export default function Keys() {
  const keys = useKeys()
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [edit, setEdit] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const rows = [...SERVICES.map(s => ({ id: s.id, name: s.name, service: s })), ...keys.filter(k => !SERVICES.some(s => s.id === k.id)).map(k => ({ id: k.id, name: k.name, service: undefined }))]

  async function test(id: string) {
    const s = SERVICES.find(x => x.id === id), key = apiKeys.get(id)
    if (!s?.test || !key) return
    setStatus(x => ({ ...x, [id]: { ok: true, text: 'testing…' } }))
    try { const text = await s.test(key); setStatus(x => ({ ...x, [id]: { ok: true, text } })) }
    catch (e: any) { setStatus(x => ({ ...x, [id]: { ok: false, text: e?.message ?? String(e) } })) }
  }
  const input = (id: string, name: string) => (
    <input type="password" autoComplete="off" autoFocus placeholder="paste key" defaultValue={apiKeys.get(id)}
      onBlur={e => { apiKeys.set(id, name, e.target.value); setEdit(null); if (e.target.value.trim()) test(id) }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEdit(null) }} />
  )

  return (
    <section className="card keys" id="keys">
      <h2><T tip="Keys for outside services Max uses. They are kept only in this browser on this laptop, never in Max's database, so each laptop needs its own." pos="right">API keys</T></h2>
      <div className="tablewrap"><table className="sheet cfg">
        <thead><tr><th className="stick">Service</th><th>Key</th><th>Status</th><th className="c-del" /></tr></thead>
        <tbody>
          {rows.map(r => {
            const key = keys.find(k => k.id === r.id)?.key ?? '', st = status[r.id]
            return (
              <tr key={r.id}>
                <td className="stick">{r.service ? <T tip={r.service.where} pos="right">{r.name}</T> : r.name}</td>
                <td>{edit === r.id ? input(r.id, r.name)
                  : <button className="linkish keyval" onClick={() => setEdit(r.id)} data-tip={key ? 'Replace this key' : 'Add a key'} data-pos="center">{key ? mask(key) : 'add key'}</button>}</td>
                <td className="small">{st ? <span className={st.ok ? 'up' : 'err'}>{st.text}</span>
                  : key && r.service?.test ? <button className="ghost small" onClick={() => test(r.id)}>Test</button> : key ? <span className="muted">saved</span> : ''}</td>
                <td className="c-del">{key && <DelBtn tip="Remove this key from this laptop" onConfirm={() => { apiKeys.remove(r.id); setStatus(x => { const { [r.id]: _, ...rest } = x; return rest }) }} />}</td>
              </tr>
            )
          })}
          {adding && <NewKey onDone={() => setAdding(false)} />}
        </tbody>
      </table></div>
      {!adding && <button className="ghost small" onClick={() => setAdding(true)} data-tip="Add a key for another service. Max uses it once a feature for that service is built." data-pos="right">+ Add key</button>}
    </section>
  )
}

function NewKey({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const save = () => { const n = name.trim(); if (n && key.trim()) apiKeys.set(n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), n, key); onDone() }
  return (
    <tr>
      <td className="stick"><input autoFocus placeholder="Service name" value={name} onChange={e => setName(e.target.value)} /></td>
      <td><input type="password" autoComplete="off" placeholder="paste key" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} /></td>
      <td><button className="primary small" onClick={save} disabled={!name.trim() || !key.trim()}>Save</button> <button className="ghost small" onClick={onDone}>Cancel</button></td>
      <td />
    </tr>
  )
}
