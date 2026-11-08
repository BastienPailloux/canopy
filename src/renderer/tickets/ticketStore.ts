import { create } from 'zustand'
import { STATUS_ORDER, type Ticket, type TicketListEntry, type TicketStatus } from '../../shared/tickets'
import { useApp } from '../store'

interface TicketsState {
  /** The repo the entries belong to (as given to the main process). */
  repo: string | null
  entries: TicketListEntry[]
  error: string | null
}

export const useTickets = create<TicketsState>(() => ({ repo: null, entries: [], error: null }))

/** Tickets not done; files that could not be read are not tickets. */
export function openCount(entries: TicketListEntry[]): number {
  return entries.filter((e) => e.kind === 'ticket' && e.ticket.status !== 'done').length
}

/** Tickets by status in STATUS_ORDER, empty groups dropped. `filter` keeps one status. */
export function groupByStatus(entries: TicketListEntry[], filter: 'all' | TicketStatus): { status: TicketStatus; tickets: Ticket[] }[] {
  const tickets = entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : []))
  return STATUS_ORDER
    .filter((status) => filter === 'all' || filter === status)
    .map((status) => ({ status, tickets: tickets.filter((t) => t.status === status) }))
    .filter((g) => g.tickets.length > 0)
}

/** Keeps `useTickets` on the active repo: loads its tickets, watches them and reloads on change. Returns the stop function. */
export function connectTickets(): () => void {
  let current: string | null = null

  const load = async (repo: string): Promise<void> => {
    try {
      const entries = await window.canopy.listTickets(repo)
      if (current === repo) useTickets.setState({ repo, entries, error: null })
    } catch (e) {
      if (current === repo) useTickets.setState({ repo, entries: [], error: e instanceof Error ? e.message : String(e) })
    }
  }

  const follow = (repo: string | null): void => {
    if (repo === current) return
    current = repo
    useTickets.setState({ repo, entries: [], error: null })
    if (!repo) return
    void load(repo)
    void window.canopy.watchTickets(repo).catch((e: unknown) => {
      if (current === repo) useTickets.setState({ error: e instanceof Error ? e.message : String(e) })
    })
  }

  // `tickets:changed` carries the main root, which may differ from the repo path we follow: reload whatever is followed.
  const off = window.canopy.on('tickets:changed', () => { if (current) void load(current) })
  follow(useApp.getState().repo)
  const unsub = useApp.subscribe((s, prev) => { if (s.repo !== prev.repo) follow(s.repo) })
  return () => { off(); unsub(); current = null }
}
