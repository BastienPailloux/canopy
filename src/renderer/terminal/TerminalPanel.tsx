import '@xterm/xterm/css/xterm.css'
import { useEffect, useMemo, useRef } from 'react'
import type { TerminalInfo } from '../../shared/api'
import { closeTerminal, loadTerminals, newShell, restartService, selectTerminal, sendLogs, setTerminalsOpen, stopTerminal, useTerminals } from './terminalStore'
import { attachView } from './terminalViews'
import './terminal.css'

function stateOf(t: TerminalInfo): { text: string; tone: 'run' | 'ok' | 'fail' } {
  if (t.running) return { text: 'en cours', tone: 'run' }
  return t.exitCode === 0 ? { text: 'terminé', tone: 'ok' } : { text: `code ${t.exitCode ?? '?'}`, tone: 'fail' }
}

/** A terminal appearing, a service restarting, must not take the keys of someone typing in the composer. */
function typingElsewhere(el: Element | null): boolean {
  return el !== null && ['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName) && !el.closest('.xterm')
}

/** The screen of the selected terminal, resized with its box. */
function Screen(props: { id: string }): React.JSX.Element {
  const { id } = props
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const view = attachView(id, el)
    const fit = (): void => {
      if (el.clientWidth > 0 && el.clientHeight > 0) view.fit.fit()
    }
    fit()
    if (!typingElsewhere(document.activeElement)) view.term.focus()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [id])

  return <div className="term-screen" ref={host} data-testid="terminal-screen" />
}

function ServiceLinks(props: { terms: TerminalInfo[] }): React.JSX.Element[] {
  const services = props.terms.filter((t) => t.port !== undefined)
  return services.map((t) => {
    const url = `http://localhost:${t.port}`
    return (
      <a key={t.id} className="term-link" href={url} data-testid="terminal-link" data-running={t.running}
        title={`Ouvrir ${t.label} dans le navigateur`}
        onClick={(e) => { e.preventDefault(); void window.canopy.openExternal(url).catch(() => undefined) }}>
        <span className="dot" aria-hidden="true" />
        {services.length > 1 ? `${t.label} · ` : ''}localhost:{t.port} ↗
      </a>
    )
  })
}

export function TerminalPanel(props: { cwd: string }): React.JSX.Element | null {
  const { cwd } = props
  const open = useTerminals((s) => s.open)
  const allTerms = useTerminals((s) => s.terms)
  const activeId = useTerminals((s) => s.active[cwd])
  const notice = useTerminals((s) => s.notices[cwd])
  const terms = useMemo(() => Object.values(allTerms).filter((t) => t.cwd === cwd), [allTerms, cwd])
  const active = activeId ? allTerms[activeId] : undefined
  const loaded = useRef<string | null>(null)

  // Opening a worktree's panel with nothing in it starts a shell, once the running ones are known.
  useEffect(() => {
    if (!open || loaded.current === cwd) return
    loaded.current = cwd
    void loadTerminals(cwd).then(() => {
      if (!Object.values(useTerminals.getState().terms).some((t) => t.cwd === cwd)) void newShell(cwd)
    })
  }, [open, cwd])

  if (!open) return null
  return (
    <section className="terminal" aria-label="Terminal du worktree">
      <div className="term-bar">
        <div role="tablist" aria-label="Terminaux" className="term-tabs">
          {terms.map((t) => {
            const st = stateOf(t)
            return (
              <div key={t.id} className="term-tab" data-tone={st.tone}>
                <button role="tab" aria-selected={t.id === activeId} onClick={() => selectTerminal(cwd, t.id)}>
                  <span className="dot" aria-hidden="true" />
                  {t.label}
                  <span className="state">{st.text}</span>
                </button>
                <button className="close" aria-label={`Fermer ${t.label}`} onClick={() => closeTerminal(t.id)}>×</button>
              </div>
            )
          })}
          <button className="term-new" aria-label="Nouveau terminal" onClick={() => void newShell(cwd)}>+</button>
        </div>
        <div className="term-actions">
          <ServiceLinks terms={terms} />
          {active?.kind === 'service' && <button onClick={() => void restartService(active.id)}>Redémarrer</button>}
          {active?.running && <button onClick={() => stopTerminal(active.id)}>Arrêter</button>}
          {active && <button onClick={() => void sendLogs(active.id)}>Envoyer les logs à Claude</button>}
          <button className="icon" aria-label="Masquer le terminal" onClick={() => setTerminalsOpen(false)}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
      </div>
      {notice && <p className="term-notice" role="alert">{notice}</p>}
      {active ? <Screen key={active.id} id={active.id} /> : <div className="term-screen" />}
    </section>
  )
}
