import { useEffect, useMemo, useRef, useState } from 'react'
import { PRIORITY_LABEL, ticketKey, type LaunchTarget, type Ticket } from '../../shared/tickets'
import { useMockups } from '../mockups/mockupStore'
import { useApp } from '../store'
import { linearBranchName, type LinearIssue } from '../../shared/linear'
import { defaultBranchName, runLaunch, runLinearLaunch } from './launchFlow'
import { LaunchWhere } from './LaunchWhere'
import type { RepoRefs } from './TicketsScreen'

/** Where and how to launch `ticket`: a new worktree or a free existing one, the branch name, then one click. */
export function LaunchPanel(props: { repo: string; ticket?: Ticket; issue?: LinearIssue; refs: RepoRefs; focus: number }): React.JSX.Element {
  const { repo, refs } = props
  const ticket = props.ticket ?? props.issue
  if (!ticket) throw new Error('LaunchPanel: no ticket')
  const isLinear = props.issue !== undefined
  const [target, setTarget] = useState<LaunchTarget | null>(null)
  const [name, setName] = useState(() => (props.issue ? linearBranchName(props.issue) : defaultBranchName(ticket as Ticket)))
  const [startClaude, setStartClaude] = useState(true)
  const allMockups = useMockups((s) => s.list)
  // A mockup links a local ticket by its ID only: a Linear issue may carry the same ID (CAN-7), so it gets none.
  const mockups = useMemo(() => (isLinear ? [] : allMockups.filter((m) => m.ticket === ticket.id)), [allMockups, isLinear, ticket.id])
  const [joinMockups, setJoinMockups] = useState(true)
  const [inProgress, setInProgress] = useState(props.ticket !== undefined && props.ticket.status !== 'in_progress' && props.ticket.status !== 'in_review')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const launchBtn = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false)
  const branch = name.trim()
  const canLaunch = !busy && target !== null

  const launch = async (): Promise<void> => {
    if (!canLaunch || !target || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      if (isLinear) await runLinearLaunch(repo, { id: ticket.id, branch, target }, { startClaude })
      else await runLaunch(repo, { id: ticket.id, branch, target, setInProgress: inProgress }, { startClaude, mockups: joinMockups ? mockups : [] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      inFlight.current = false
    }
  }
  const latest = useRef(launch)
  latest.current = launch

  // ⌘↵ launches, unless a dialog is in front.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      void latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // "Lancer" on a row: the button takes the focus once it can, once per request.
  const focused = useRef(0)
  useEffect(() => {
    if (props.focus === 0 || focused.current === props.focus || !canLaunch) return
    focused.current = props.focus
    launchBtn.current?.focus()
  }, [props.focus, canLaunch])

  const meta = [PRIORITY_LABEL[ticket.priority], ...ticket.labels].join(' · ')
  const openKey = ticketKey(isLinear ? 'linear' : 'local', ticket.id)
  return (
    <div className="launch">
      <div className="launch-ticket">
        <span className="ticket-id mono">{ticket.id}</span>
        <h2>{ticket.title}</h2>
        <span className="launch-meta">{meta}</span>
        <button className="link" onClick={() => useApp.getState().setOpenTicket(openKey)}>Voir et modifier le ticket</button>
      </div>

      <LaunchWhere repo={repo} refs={refs} branch={name} onBranch={setName} onTarget={setTarget} />

      <section className="launch-checks">
        <label className="check">
          <input type="checkbox" checked={startClaude} onChange={(e) => setStartClaude(e.target.checked)} />
          Démarrer Claude Code avec la description du ticket
        </label>
        {mockups.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={joinMockups && startClaude} disabled={!startClaude} onChange={(e) => setJoinMockups(e.target.checked)} />
            Joindre les maquettes liées ({mockups.length})
          </label>
        )}
        {!isLinear && <label className="check">
          <input type="checkbox" checked={inProgress} onChange={(e) => setInProgress(e.target.checked)} />
          Passer le ticket « En cours »
        </label>}
      </section>

      {error && <p className="launch-error" role="alert">{error}</p>}

      <div className="launch-actions">
        <button ref={launchBtn} className="primary launch-go" disabled={!canLaunch} onClick={() => void launch()}>
          {busy ? 'Lancement…' : <>Lancer <span className="mono">{ticket.id}</span> <kbd>⌘↵</kbd></>}
        </button>
      </div>
    </div>
  )
}
