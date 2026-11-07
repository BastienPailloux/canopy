import { useEffect, useRef, useState } from 'react'
import { closeTab, newTab, openSession, selectTab, syncWorktree, useSessions, type SessionTab, type TabState } from './sessionStore'

const STATE_LABELS: Record<TabState, string> = {
  draft: 'brouillon',
  running: 'en cours',
  waiting: 'attend ta réponse',
  idle: 'prête',
  stopped: 'terminée',
  error: 'erreur'
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' })

/** Past sessions of the worktree that have no tab. */
function ResumeMenu(props: { cwd: string; tabs: SessionTab[] }): React.JSX.Element {
  const { cwd, tabs } = props
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const summaries = useSessions((s) => s.summaries[cwd])
  const past = (summaries ?? []).filter((s) => !tabs.some((t) => t.sessionId === s.sessionId))

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="resume" ref={root}>
      <button className="tab-action" aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open) void syncWorktree(cwd) }}>
        Reprendre
      </button>
      {open && (
        <div className="menu" role="menu">
          {past.length === 0 && <span className="muted resume-empty">Aucune autre session dans ce worktree.</span>}
          {past.map((s) => (
            <button key={s.sessionId} role="menuitem" onClick={() => { setOpen(false); void openSession(cwd, s) }}>
              <span className="resume-title">{s.title || s.sessionId}</span>
              <span className="muted">{dateFormat.format(s.lastModified)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SessionTabs(props: { cwd: string; tabs: SessionTab[]; activeId?: string }): React.JSX.Element {
  const { cwd, tabs, activeId } = props
  return (
    <div className="session-tabs">
      <div role="tablist" aria-label="Sessions du worktree" className="session-tablist">
        {tabs.map((t) => (
          <div key={t.id} className="session-tab" data-state={t.state}>
            <button role="tab" aria-selected={t.id === activeId} onClick={() => selectTab(cwd, t.id)}>
              <span className="dot" aria-hidden="true" />
              <span className="label">{t.title}</span>
              <span className="state" data-testid="session-state">{STATE_LABELS[t.state]}</span>
            </button>
            <button className="close" aria-label={`Fermer ${t.title}`} title="Arrête la session et ferme l'onglet" onClick={() => closeTab(t.id)}>×</button>
          </div>
        ))}
      </div>
      <button className="tab-action" onClick={() => newTab(cwd)}>+ Nouvelle session</button>
      <ResumeMenu cwd={cwd} tabs={tabs} />
    </div>
  )
}
