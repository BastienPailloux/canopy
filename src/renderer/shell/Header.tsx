import { useState } from 'react'
import { useApp, type View } from '../store'
import { RepoPicker } from './RepoPicker'
import { Settings } from './Settings'

const VIEWS: { id: View; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'code', label: 'Code' }
]

function Logo(): React.JSX.Element {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="0 0 100 100" width="22" height="22">
        <circle cx="31" cy="50" r="17" fill="#6D5BD0" />
        <circle cx="69" cy="50" r="17" fill="#7E6BE0" />
        <circle cx="50" cy="40" r="21" fill="#A78BFA" />
        <path d="M50 84V58M50 72C50 64 36 66 34 58M50 72C50 64 64 66 66 58" stroke="#F4F1FF" strokeWidth="6" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function Header(): React.JSX.Element {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const [settings, setSettings] = useState(false)
  return (
    <header className="header">
      <span className="brand">
        <Logo />
        <span className="wordmark">canopy</span>
      </span>
      <RepoPicker />
      <nav className="nav" aria-label="Vues">
        {VIEWS.map((v) => (
          <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </nav>
      <button className="ctl settings-btn" onClick={() => setSettings(true)}>Réglages</button>
      {settings && <Settings onClose={() => setSettings(false)} />}
    </header>
  )
}
