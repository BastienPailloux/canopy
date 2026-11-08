import { useEffect, useMemo, useState } from 'react'
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, parseTicketKey, type Ticket, type TicketStatus } from '../../shared/tickets'
import type { BaseRef, Worktree } from '../../shared/types'
import { useApp } from '../store'
import { LaunchPanel } from './LaunchPanel'
import { linearActive, refreshLinear, useLinear } from './linearStore'
import { filterRows, groupRows, mergeRows, syncLabel, type Filters, type Row as ListRow } from './listModel'
import { useTickets } from './ticketStore'

type Filter = 'all' | TicketStatus
const FILTERS: Filter[] = ['all', 'todo', 'in_progress', 'backlog']
const FILTERS_LINEAR: Filter[] = ['all', 'todo', 'in_progress', 'in_review', 'backlog']

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
export function linkedWorktree(t: Pick<Ticket, 'branch' | 'worktree'>, refs: RepoRefs): Worktree | null {
  if (!t.branch || !t.worktree || !refs.branches.includes(t.branch) || t.branch.startsWith('origin/')) return null
  return refs.worktrees.find((w) => w.path === t.worktree) ?? null
}

function StatusIcon({ status }: { status: TicketStatus }): React.JSX.Element {
  return <span className="status-icon" data-status={status} aria-hidden="true" />
}

function Row(props: {
  row: ListRow
  badge: boolean
  branch: string | undefined
  selected: boolean
  linked: Worktree | null
  onOpen: () => void
  onLaunch: () => void
  onOpenLinked: (w: Worktree) => void
}): React.JSX.Element {
  const { row, linked } = props
  return (
    <div className="ticket-row" role="row" aria-selected={props.selected} data-testid={row.source === 'local' ? `ticket-${row.id}` : `ticket-linear-${row.id}`} data-source={row.source} title="Ouvrir le ticket"
      tabIndex={0} onClick={props.onOpen}
      onKeyDown={(e) => {
        // Only the row itself: Enter on its Lancer or branch button must do what that button does.
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        props.onOpen()
      }}>
      <span className="ticket-id mono">{row.id}</span>
      <span className="ticket-title" title={row.title}>{row.title}</span>
      {row.statusName && <span className="status-name">{row.statusName}</span>}
      {row.priority !== 'none' && <span className="ticket-priority">{PRIORITY_LABEL[row.priority]}</span>}
      {row.labels.map((l) => <span key={l} className="chip">{l}</span>)}
      {row.pending && <span className="pending-mark" title="Modifications pas encore envoyées à Linear">non envoyé</span>}
      {props.badge && <span className="source-badge" data-source={row.source}>{row.source === 'linear' ? 'Linear' : 'Local'}</span>}
      {linked
        ? (
          <button className="branch-link mono" title={`Ouvrir ${linked.path} dans Sessions`}
            onClick={(e) => { e.stopPropagation(); props.onOpenLinked(linked) }}>{props.branch}</button>
        )
        : (
          <button className="launch-btn" onClick={(e) => { e.stopPropagation(); props.onLaunch() }}>
            <span className="play" aria-hidden="true">▶</span> Lancer
          </button>
        )}
    </div>
  )
}

const DEPARTURE_TEXT = {
  reassigned: 'n’est plus assigné à toi',
  canceled: 'a été annulé',
  missing: 'est introuvable'
} as const

function SyncHeader(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const list = useLinear((s) => s.list)
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  const refresh = async (): Promise<void> => {
    if (!repo || busy) return
    setBusy(true)
    try { await refreshLinear() }
    finally { setBusy(false) }
  }
  const reconnect = (): void => {
    void window.canopy.linearConnect().then((connection) => useLinear.setState({ connection }), () => undefined)
  }
  return (
    <span className="sync-label" data-testid="linear-sync" data-error={list.error !== null || list.expired}>
      {list.expired
        ? <>Connexion Linear expirée — <button className="link" onClick={reconnect}>Reconnecter</button></>
        : syncLabel(list, now)}
      <button className="refresh" aria-label="Rafraîchir Linear" title="Rafraîchir" disabled={busy || list.expired} onClick={() => void refresh()}>⟳</button>
    </span>
  )
}

/** Screen 3: the repo's tickets by status, and the panel that launches the selected one. */
export function TicketsScreen(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const selectedKey = useApp((s) => s.selectedTicket)
  const { entries, error, loaded } = useTickets()
  const connection = useLinear((s) => s.connection)
  const list = useLinear((s) => s.list)
  const pending = useLinear((s) => s.pending)
  const links = useLinear((s) => s.links)
  const linear = linearActive({ connection, list })
  const [filters, setFilters] = useState<Filters>({ status: 'all', source: 'all', priority: 'all', query: '' })
  const [doneOpen, setDoneOpen] = useState(false)
  /** The ticket whose launch button must take the focus, numbered so a second click asks again. */
  const [focusReq, setFocusReq] = useState<{ id: string; seq: number } | null>(null)
  const refs = useRepoRefs(repo ?? '', entries)

  const tickets = useMemo(() => entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : [])), [entries])
  const unreadable = entries.flatMap((e) => (e.kind === 'unreadable' ? [e] : []))
  const pendingIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending])
  // Without a connection the screen is the local one: no Linear row, whatever a stale cache holds.
  const all = useMemo(() => mergeRows(entries, linear ? list.issues : [], pendingIds), [entries, linear, list.issues, pendingIds])
  const rows = filterRows(all, linear ? filters : { ...filters, source: 'all', priority: 'all', query: '' })
  const groups = groupRows(rows)
  const count = (f: Filter): number => (f === 'all' ? all.filter((r) => r.status !== 'done').length : all.filter((r) => r.status === f).length)
  const parsed = selectedKey ? parseTicketKey(selectedKey) : null
  const selected = parsed?.source === 'local' ? tickets.find((t) => t.id === parsed.id) ?? null : null
  const selectedIssue = parsed?.source === 'linear' ? list.issues.find((i) => i.id === parsed.id) ?? null : null

  const app = useApp.getState()
  const openLinked = (w: Worktree): void => {
    app.setWorktree(w.path)
    app.setView('sessions')
  }
  useEffect(() => { if (!linear && filters.status === 'in_review') setFilters((f) => ({ ...f, status: 'all' })) }, [linear, filters.status])
  const set = (patch: Partial<Filters>): void => setFilters((f) => ({ ...f, ...patch }))
  const tabs = linear ? FILTERS_LINEAR : FILTERS

  return (
    <div className="tickets-screen">
      <div className="tickets-main">
        <div className="tickets-head">
          <h1>Mes tickets</h1>
          <button className="primary new-ticket" onClick={() => app.setOpenTicket('new')}>+ Nouveau ticket</button>
          {linear && <SyncHeader />}
          <div className="segmented" role="tablist" aria-label="Filtrer les tickets">
            {tabs.map((f) => (
              <button key={f} role="tab" aria-selected={filters.status === f} onClick={() => set({ status: f })}>
                {f === 'all' ? 'Tous' : STATUS_LABEL[f]} · {count(f)}
              </button>
            ))}
          </div>
          {linear && (
            <div className="filters-2" data-testid="linear-filters">
              <div className="segmented" role="group" aria-label="Source">
                {(['all', 'linear', 'local'] as const).map((s) => (
                  <button key={s} aria-pressed={filters.source === s} onClick={() => set({ source: s })}>
                    {s === 'all' ? 'Toutes sources' : s === 'linear' ? 'Linear' : 'Local'}
                  </button>
                ))}
              </div>
              <select aria-label="Priorité" value={filters.priority} onChange={(e) => set({ priority: e.target.value as Filters['priority'] })}>
                <option value="all">Priorité : toutes</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
              <input type="search" className="ticket-search" placeholder="Rechercher…" aria-label="Rechercher un ticket" value={filters.query}
                onChange={(e) => set({ query: e.target.value })} />
            </div>
          )}
        </div>
        <div className="tickets-list">
          {error && <p className="tickets-error" role="alert">Lecture des tickets impossible : {error}</p>}
          {unreadable.map((u) => (
            <p key={u.file} className="ticket-unreadable" role="status" title={u.error}>Fichier illisible : {u.file}</p>
          ))}
          {list.departures.map((d) => (
            <p key={d.id} className="departure-notice" role="status">
              <span>{d.id} {DEPARTURE_TEXT[d.reason]}</span>
              <button className="dismiss" aria-label={`Fermer l’avis ${d.id}`} onClick={() => void window.canopy.linearAckDepartures([d.id])}>×</button>
            </p>
          ))}
          {!loaded && <p className="tickets-empty">Chargement…</p>}
          {loaded && groups.length === 0 && !error && (
            <p className="tickets-empty">{all.length === 0 ? 'Aucun ticket pour l’instant.' : 'Aucun ticket dans ce filtre.'}</p>
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
                      <span className="name">{STATUS_LABEL[g.status]} · {g.rows.length}</span>
                    </button>
                  )
                  : (
                    <h3 className="group-head">
                      <StatusIcon status={g.status} />
                      <span className="name">{STATUS_LABEL[g.status]}</span>
                      <span className="n">{g.rows.length}</span>
                    </h3>
                  )}
                {open && g.rows.map((r) => {
                  const link = r.source === 'linear' ? links[r.id] : tickets.find((t) => t.id === r.id)
                  return (
                    <Row key={r.key} row={r} badge={linear} branch={link?.branch} selected={r.key === selectedKey}
                      linked={link ? linkedWorktree(link, refs) : null}
                      onOpen={() => { app.setSelectedTicket(r.key); setFocusReq(null); app.setOpenTicket(r.key) }}
                      onLaunch={() => { app.setSelectedTicket(r.key); setFocusReq((q) => ({ id: r.key, seq: (q?.seq ?? 0) + 1 })) }}
                      onOpenLinked={openLinked} />
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>
      <aside className="launch-panel" aria-label="Lancement">
        {selected && repo
          ? <LaunchPanel key={`${repo}\0${selected.id}`} repo={repo} ticket={selected} refs={refs} focus={focusReq?.id === selectedKey ? focusReq.seq : 0} />
          : selectedIssue && repo
            ? <LaunchPanel key={`${repo}\0linear:${selectedIssue.id}`} repo={repo} issue={selectedIssue} refs={refs} focus={focusReq?.id === selectedKey ? focusReq.seq : 0} />
            : <p className="launch-empty">Clique sur « Lancer » à côté d’un ticket pour préparer son lancement.</p>}
      </aside>
    </div>
  )
}
