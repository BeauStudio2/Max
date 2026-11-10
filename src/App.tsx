import { useEffect, useState } from 'react'
import type { Session as AuthSession } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { StoreProvider, useStore } from './lib/store'
import SignIn from './pages/SignIn'
import Today from './pages/Today'
import History from './pages/History'
import Plan from './pages/Plan'
import Profile from './pages/Profile'
import Config from './pages/Config'

type Tab = 'today' | 'history' | 'profile' | 'plan' | 'config'
const TABS: { id: Tab; label: string; coach?: boolean }[] = [
  { id: 'today', label: 'Log' },
  { id: 'history', label: 'History' },
  { id: 'profile', label: 'Profile' },
  { id: 'plan', label: 'Plan' },
  { id: 'config', label: 'Config' },
]

export default function App() {
  const [auth, setAuth] = useState<AuthSession | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuth(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setAuth(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (auth === undefined) return <div className="center muted">Loading…</div>
  if (!auth) return <SignIn />
  return <StoreProvider auth={auth}><Shell /></StoreProvider>
}

function Shell() {
  const { isCoach, myLifter, lifters, auth } = useStore()
  const initial = (location.hash.slice(1) as Tab) || 'today'
  const [tab, setTab] = useState<Tab>(TABS.some(t => t.id === initial) ? initial : 'today')
  const [lifterId, setLifterId] = useState<string>(myLifter?.id ?? lifters[0]?.id ?? '')

  useEffect(() => { history.replaceState(null, '', '#' + tab) }, [tab])

  const visible = TABS.filter(t => !t.coach || isCoach)
  const canPick = isCoach && lifters.length > 1
  const noAccess = !isCoach && !myLifter

  return (
    <div className="app">
      <header className="top">
        <div className="brand">MAX</div>
        {canPick ? (
          <select className="lifter" value={lifterId} onChange={e => setLifterId(e.target.value)} aria-label="Lifter">
            {lifters.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : <div className="lifter-name">{myLifter?.name ?? ''}</div>}
      </header>

      <main>
        {noAccess ? (
          <div className="card">
            <h2>Almost in</h2>
            <p>You are signed in as <b>{auth.user.email}</b>, but your account is not linked to a lifter yet.
              Ask Beau to link you in Config, then reload.</p>
          </div>
        ) : (
          <>
            {tab === 'today' && <Today lifterId={lifterId} />}
            {tab === 'history' && <History lifterId={lifterId} />}
            {tab === 'profile' && <><Profile lifterId={lifterId} /><Account email={auth.user.email ?? ''} /></>}
            {tab === 'plan' && <Plan lifterId={lifterId} />}
            {tab === 'config' && <Config />}
          </>
        )}
      </main>

      <nav className="tabs">
        {visible.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
    </div>
  )
}

export function Account({ email }: { email: string }) {
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  async function change(e: React.FormEvent) {
    e.preventDefault()
    const { error } = await supabase.auth.updateUser({ password: pw })
    setMsg(error ? error.message : 'Password changed.')
    if (!error) setPw('')
  }
  return (
    <div className="account card">
      <h2>Account</h2>
      <p className="small muted">Signed in as {email}</p>
      <form className="row" onSubmit={change}>
        <label className="grow">New password
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} minLength={6} required autoComplete="new-password" />
        </label>
        <button className="primary inline">Change</button>
      </form>
      {msg && <p className="small">{msg}</p>}
      <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  )
}
