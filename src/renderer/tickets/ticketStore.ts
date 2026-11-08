import { create } from 'zustand'
import { STATUS_ORDER, type Ticket, type TicketListEntry, type TicketStatus } from '../../shared/tickets'
import { useApp } from '../store'

interface TicketsState {
  /** The repo the entries belong to (as given to the main process). */
  repo: string | null
  entries: TicketListEntry[]
  error: string | null
  /** False after a repo switch until its first read answers: an empty list then means nothing yet. */
  loaded: boolean
}

export const useTickets = create<TicketsState>(() => ({ repo: null, entries: [], error: null, loaded: false }))

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

/**
 * Keeps `useTickets` on the active repo: loads its tickets, watches them and reloads on change. Returns the stop function.
 * Only the latest read applies; a failed reload keeps the entries of the same repo and only reports its error.
 */
export function connectTickets(): () => void {
  let current: string | null = null
  let seq = 0

  const load = async (repo: string): Promise<void> => {
    const mine = ++seq
    const latest = (): boolean => current === repo && seq === mine
    try {
      const entries = await window.canopy.listTickets(repo)
      if (latest()) useTickets.setState({ repo, entries, error: null, loaded: true })
    } catch (e) {
      if (latest()) useTickets.setState({ error: e instanceof Error ? e.message : String(e), loaded: true })
    }
  }

  const follow = (repo: string | null): void => {
    if (repo === current) return
    current = repo
    seq++
    useTickets.setState({ repo, entries: [], error: null, loaded: false })
    if (!repo) return
    void load(repo)
    // A change between that read and the watch starting would be missed: read again once it watches.
    window.canopy.watchTickets(repo).then(
      () => { if (current === repo) void load(repo) },
      (e: unknown) => { if (current === repo) useTickets.setState({ error: e instanceof Error ? e.message : String(e) }) }
    )
  }

  // `tickets:changed` carries the main root, which may differ from the repo path we follow: reload whatever is followed.
  const off = window.canopy.on('tickets:changed', () => { if (current) void load(current) })
  follow(useApp.getState().repo)
  const unsub = useApp.subscribe((s, prev) => { if (s.repo !== prev.repo) follow(s.repo) })
  return () => { off(); unsub(); current = null; seq++ }
}
