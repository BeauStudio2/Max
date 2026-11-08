import { useState } from 'react'
import { supabase } from '../supabase'

export default function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg(error.message)
    } else {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { name }, emailRedirectTo: location.origin },
      })
      if (error) setMsg(error.message)
      else if (!data.session) setMsg('Check your email to confirm, then sign in.')
    }
    setBusy(false)
  }

  async function link() {
    if (!email) { setMsg('Enter your email first.'); return }
    setBusy(true)
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin, shouldCreateUser: false } })
    setMsg(error ? error.message : 'Sign-in link sent. Open it on this device.')
    setBusy(false)
  }

  return (
    <div className="center">
      <form className="card signin" onSubmit={submit}>
        <div className="brand big">MAX</div>
        {mode === 'up' && (
          <label>Name<input value={name} onChange={e => setName(e.target.value)} required autoComplete="name" /></label>
        )}
        <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></label>
        <button className="primary" disabled={busy}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
        {mode === 'in' && <button type="button" className="ghost" onClick={link} disabled={busy}>Email me a sign-in link</button>}
        <button type="button" className="link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null) }}>
          {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
        {msg && <p className="msg">{msg}</p>}
      </form>
    </div>
  )
}
