import { useEffect, useMemo, useState } from 'react'
import { PRIORITY_LABEL, STATUS_LABEL, type Ticket, type TicketStatus } from '../../shared/tickets'
import type { BaseRef, Worktree } from '../../shared/types'
import { useApp } from '../store'
import { LaunchPanel } from './LaunchPanel'
import { groupByStatus, openCount, useTickets } from './ticketStore'

type Filter = 'all' | 'todo' | 'in_progress' | 'backlog'
const FILTERS: Filter[] = ['all', 'todo', 'in_progress', 'backlog']

/** What the screen and the launch panel read of the repo: its branches, its worktrees, its default base. */
export interface RepoRefs {
  /** Local and remote branches, remote ones as `origin/x`. */
  branches: string[]
  worktrees: Worktree[]
  defaultBase: BaseRef | null
}

const NO_REFS: RepoRefs = { branches: [], worktrees: [], defaultBase: null }

/** Read again whenever the tickets change: a launch changes both. */
export function useRepoRefs(repo: string, stamp: unknown): RepoRefs {
  const [state, setState] = useState<{ repo: string; refs: RepoRefs }>({ repo: '', refs: NO_REFS })
  useEffect(() => {
    if (!repo) return
    let live = true
    void Promise.all([
      window.canopy.codeBranches(repo).catch((): string[] => []),
      window.canopy.listWorktrees(repo).catch((): Worktree[] => []),
      window.canopy.defaultBase(repo).catch(() => null)
    ]).then(([branches, worktrees, defaultBase]) => { if (live) setState({ repo, refs: { branches, worktrees, defaultBase } }) })
    return () => { live = false }
  }, [repo, stamp])
  return state.repo === repo ? state.refs : NO_REFS
}

/** The worktree of the ticket's branch, if that branch is still a local one and its worktree still listed. */
export function linkedWorktree(t: Ticket, refs: RepoRefs): Worktree | null {
  if (!t.branch || !t.worktree || !refs.branches.includes(t.branch) || t.branch.startsWith('origin/')) return null
  return refs.worktrees.find((w) => w.path === t.worktree) ?? null
}

function StatusIcon({ status }: { status: TicketStatus }): React.JSX.Element {
  return <span className="status-icon" data-status={status} aria-hidden="true" />
}

function Row(props: {
  t: Ticket
  selected: boolean
  linked: Worktree | null
  onOpen: () => void
  onLaunch: () => void
  onOpenLinked: (w: Worktree) => void
}): React.JSX.Element {
  const { t, linked } = props
  return (
    <div className="ticket-row" role="row" aria-selected={props.selected} data-testid={`ticket-${t.id}`} title="Ouvrir le ticket" onClick={props.onOpen}>
      <span className="ticket-id mono">{t.id}</span>
      <span className="ticket-title" title={t.title}>{t.title}</span>
      {t.priority !== 'none' && <span className="ticket-priority">{PRIORITY_LABEL[t.priority]}</span>}
      {t.labels.map((l) => <span key={l} className="chip">{l}</span>)}
      {linked
        ? (
          <button className="branch-link mono" title={`Ouvrir ${linked.path} dans Sessions`}
            onClick={(e) => { e.stopPropagation(); props.onOpenLinked(linked) }}>{t.branch}</button>
        )
        : (
          <button className="launch-btn" onClick={(e) => { e.stopPropagation(); props.onLaunch() }}>
            <span className="play" aria-hidden="true">▶</span> Lancer
          </button>
        )}
    </div>
  )
}

/** Screen 3: the repo's tickets by status, and the panel that launches the selected one. */
export function TicketsScreen(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const selectedId = useApp((s) => s.selectedTicket)
  const { entries, error, loaded } = useTickets()
  const [filter, setFilter] = useState<Filter>('all')
  const [doneOpen, setDoneOpen] = useState(false)
  /** The ticket whose launch button must take the focus, numbered so a second click asks again. */
  const [focusReq, setFocusReq] = useState<{ id: string; seq: number } | null>(null)
  const refs = useRepoRefs(repo ?? '', entries)

  const tickets = useMemo(() => entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : [])), [entries])
  const unreadable = entries.flatMap((e) => (e.kind === 'unreadable' ? [e] : []))
  const groups = groupByStatus(entries, filter)
  const count = (f: Filter): number => (f === 'all' ? openCount(entries) : tickets.filter((t) => t.status === f).length)
  const selected = tickets.find((t) => t.id === selectedId) ?? null

  const app = useApp.getState()
  const select = (id: string): void => app.setSelectedTicket(id)
  const openLinked = (w: Worktree): void => {
    app.setWorktree(w.path)
    app.setView('sessions')
  }

  return (
    <div className="tickets-screen">
      <div className="tickets-main">
        <div className="tickets-head">
          <h1>Mes tickets</h1>
          <button className="primary new-ticket" onClick={() => app.setOpenTicket('new')}>+ Nouveau ticket</button>
          <div className="segmented" role="tablist" aria-label="Filtrer les tickets">
            {FILTERS.map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'Tous' : STATUS_LABEL[f]} · {count(f)}
              </button>
            ))}
          </div>
        </div>
        <div className="tickets-list">
          {error && <p className="tickets-error" role="alert">Lecture des tickets impossible : {error}</p>}
          {unreadable.map((u) => (
            <p key={u.file} className="ticket-unreadable" role="status" title={u.error}>Fichier illisible : {u.file}</p>
          ))}
          {!loaded && <p className="tickets-empty">Chargement…</p>}
          {loaded && groups.length === 0 && !error && (
            <p className="tickets-empty">{tickets.length === 0 ? 'Aucun ticket pour l’instant.' : 'Aucun ticket dans ce filtre.'}</p>
          )}
          {groups.map((g) => {
            const done = g.status === 'done'
            const open = !done || doneOpen
            return (
              <section key={g.status} className="ticket-group" role="rowgroup" aria-label={STATUS_LABEL[g.status]}>
                {done
                  ? (
                    <button className="group-head toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
                      <span className="chevron" aria-hidden="true">{doneOpen ? '▾' : '▸'}</span>
                      <StatusIcon status={g.status} />
                      <span className="name">{STATUS_LABEL[g.status]} · {g.tickets.length}</span>
                    </button>
                  )
                  : (
                    <h3 className="group-head">
                      <StatusIcon status={g.status} />
                      <span className="name">{STATUS_LABEL[g.status]}</span>
                      <span className="n">{g.tickets.length}</span>
                    </h3>
                  )}
                {open && g.tickets.map((t) => (
                  <Row key={t.id} t={t} selected={t.id === selectedId} linked={linkedWorktree(t, refs)}
                    onOpen={() => { select(t.id); setFocusReq(null); app.setOpenTicket(t.id) }}
                    onLaunch={() => { select(t.id); setFocusReq((r) => ({ id: t.id, seq: (r?.seq ?? 0) + 1 })) }}
                    onOpenLinked={openLinked} />
                ))}
              </section>
            )
          })}
        </div>
      </div>
      <aside className="launch-panel" aria-label="Lancement">
        {selected && repo
          ? <LaunchPanel key={`${repo}\0${selected.id}`} repo={repo} ticket={selected} refs={refs} focus={focusReq?.id === selected.id ? focusReq.seq : 0} />
          : <p className="launch-empty">Clique sur « Lancer » à côté d’un ticket pour préparer son lancement.</p>}
      </aside>
    </div>
  )
}
