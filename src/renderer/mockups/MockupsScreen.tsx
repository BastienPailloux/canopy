import { useMemo, useState } from 'react'
import { MOCKUP_STATUS_LABEL, mockupLine, shownStatus, type Mockup } from '../../shared/mockups'
import type { Ticket } from '../../shared/tickets'
import { basename, useApp } from '../store'
import { useTickets } from '../tickets/ticketStore'
import { AddMockupDialog } from './AddMockupDialog'
import { MockupCard, MockupTemplate, TicketRef } from './MockupCard'
import {
  attachToSession, filterMockups, launchFromMockup, linkedTicket, relativeTime, sessionTarget, useMockups, type MockupFilter
} from './mockupStore'

const FILTERS: { id: MockupFilter; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'worktree', label: 'Ce worktree' },
  { id: 'noTicket', label: 'Sans ticket' },
]

const plural = (n: number): string => (n > 1 ? `${n} maquettes liées` : `${n} maquette liée`)

/** The repo's tickets, archived ones included: a mockup linked to one must know it is archived. */
export function useTicketList(): Ticket[] {
  const entries = useTickets((s) => s.entries)
  return useMemo(() => entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : [])), [entries])
}

/** Screen 4: the repo's mockups as cards, and the selected one's detail. */
export function MockupsScreen(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const selectedId = useApp((s) => s.selectedMockup)
  const branch = useApp((s) => s.worktrees.find((w) => w.path === s.worktree)?.branch ?? null)
  const { list, error, loaded } = useMockups()
  const tickets = useTicketList()
  const [filter, setFilter] = useState<MockupFilter>('all')
  const [adding, setAdding] = useState(false)

  const shown = filterMockups(list, filter, { tickets, branch })
  const selected = list.find((m) => m.id === selectedId) ?? null
  const app = useApp.getState()
  const create = (): void => { app.setPendingMockupTicket(null); app.setOpenMockup('new') }
  const addButtons = (
    <>
      <button className="secondary" onClick={() => setAdding(true)}>+ Ajouter un lien</button>
      <button className="primary" onClick={create}>✦ Nouvelle maquette</button>
    </>
  )

  return (
    <div className="mockups-screen">
      <div className="mockups-main">
        <div className="mockups-head">
          <h1>Maquettes</h1>
          <span className="mockups-count">{plural(list.length)} à {basename(repo ?? '')}</span>
          <div className="segmented" role="tablist" aria-label="Filtrer les maquettes">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          {addButtons}
        </div>
        {error && <p className="mockups-error" role="alert">Lecture des maquettes impossible : {error}</p>}
        {!loaded && <p className="mockups-empty">Chargement…</p>}
        {loaded && list.length === 0 && !error && (
          <div className="mockups-empty-state">
            <h2>Aucune maquette pour l’instant</h2>
            <p>
              Ajoute le lien d’une maquette claude.ai, ou fais-en créer une par Claude. Liée à un ticket, elle part avec lui
              quand tu le lances.
            </p>
            <div className="mockups-empty-actions">{addButtons}</div>
          </div>
        )}
        {loaded && list.length > 0 && shown.length === 0 && <p className="mockups-empty">Aucune maquette dans ce filtre.</p>}
        {shown.length > 0 && (
          <div className="mockups-grid">
            {shown.map((m) => {
              const t = linkedTicket(m, tickets)
              return (
                <MockupCard key={m.id} mockup={m} status={shownStatus(m, t)} ticketLive={!!t} when={relativeTime(m.updated)}
                  selected={m.id === selectedId} onSelect={() => app.setSelectedMockup(m.id)}
                  onOpen={() => { app.setSelectedMockup(m.id); app.setOpenMockup(m.id) }} />
              )
            })}
          </div>
        )}
      </div>
      <aside className="mockup-detail" aria-label="Détail de la maquette">
        {selected && repo
          ? <MockupDetail key={selected.id} repo={repo} mockup={selected} tickets={tickets} />
          : <p className="mockup-detail-empty">Clique sur une maquette pour voir son détail.</p>}
      </aside>
      {adding && repo && (
        <AddMockupDialog repo={repo} onAdded={(m) => app.setSelectedMockup(m.id)} onClose={() => setAdding(false)} />
      )}
    </div>
  )
}

function MockupDetail(props: { repo: string; mockup: Mockup; tickets: Ticket[] }): React.JSX.Element {
  const { repo, mockup: m } = props
  const ticket = linkedTicket(m, props.tickets)
  const status = shownStatus(m, ticket)
  const target = useApp((s) => sessionTarget(ticket, s.worktrees, s.worktree))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const app = useApp.getState()

  const launch = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await launchFromMockup(repo, m, ticket)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mockup-detail-preview"><MockupTemplate kind={m.kind} status={status} size="large" /></div>
      <div className="mockup-detail-title">
        <h2>{m.title}</h2>
        <span>Claude Design · {relativeTime(m.updated)}</span>
      </div>
      <dl className="mockup-props">
        <dt>Ticket</dt>
        <dd>
          {ticket
            ? <button className="link mono" title="Ouvrir le ticket" onClick={() => { app.setView('tickets'); app.setOpenTicket(ticket.id) }}>{ticket.id}</button>
            : <TicketRef id={m.ticket} live={false} />}
        </dd>
        <dt>Branche</dt>
        <dd className="mono">{ticket?.branch ?? '—'}</dd>
        <dt>Statut</dt>
        <dd>{MOCKUP_STATUS_LABEL[status]}</dd>
      </dl>
      {error && <p className="mockups-error" role="alert">{error}</p>}
      <div className="mockup-actions">
        <button className="primary" disabled={!target} onClick={() => { if (target) attachToSession(target, mockupLine(m)) }}>
          Joindre à la session en cours
        </button>
        <button className="secondary" disabled={busy} onClick={() => void launch()}>
          {busy ? 'Préparation…' : 'Lancer un worktree depuis la maquette'}
        </button>
        <button className="secondary ghost" onClick={() => app.setOpenMockup(m.id)}>Modifier la maquette</button>
      </div>
    </>
  )
}
