import { create } from 'zustand'
import type { Mockup } from '../../shared/mockups'
import type { Ticket } from '../../shared/tickets'
import type { Worktree } from '../../shared/types'
import { ensureTab, setDraftText, useSessions } from '../sessions/sessionStore'
import { useApp } from '../store'

interface MockupsState {
  /** The repo the list belongs to (as given to the main process). */
  repo: string | null
  list: Mockup[]
  /** The registry could not be read (it is then never written), or the read failed. */
  error: string | null
  /** False after a repo switch until its first read answers: an empty list then means nothing yet. */
  loaded: boolean
}

export const useMockups = create<MockupsState>(() => ({ repo: null, list: [], error: null, loaded: false }))

export type MockupFilter = 'all' | 'worktree' | 'noTicket'

/** What the filters need to know besides the mockups. */
export interface FilterContext {
  tickets: Ticket[]
  /** Branch of the active worktree, null if detached or none. */
  branch: string | null
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The mockup's ticket if it still exists and is not archived: else the mockup behaves as if it had none. */
export function linkedTicket(m: Pick<Mockup, 'ticket'>, tickets: Ticket[]): Ticket | undefined {
  if (!m.ticket) return undefined
  const t = tickets.find((x) => x.id === m.ticket)
  return t && !t.archived ? t : undefined
}

/** `all`; `worktree`: linked ticket on the active worktree's branch; `noTicket`: no live ticket. */
export function filterMockups(list: Mockup[], filter: MockupFilter, ctx: FilterContext): Mockup[] {
  if (filter === 'all') return list
  if (filter === 'noTicket') return list.filter((m) => !linkedTicket(m, ctx.tickets))
  return list.filter((m) => {
    const t = linkedTicket(m, ctx.tickets)
    return !!t?.branch && ctx.branch !== null && t.branch === ctx.branch
  })
}

/** The worktree checked out on the ticket's branch, if any. */
export function ticketWorktree(t: Ticket | undefined, worktrees: Worktree[]): Worktree | null {
  if (!t?.branch) return null
  return worktrees.find((w) => w.branch === t.branch) ?? null
}

/** Where « Joindre à la session en cours » writes: the worktree of the linked branch, else the active one. */
export function sessionTarget(t: Ticket | undefined, worktrees: Worktree[], active: string | null): string | null {
  return ticketWorktree(t, worktrees)?.path ?? active
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** « il y a 2 h », « hier »… from an ISO date; empty for a date that cannot be read. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = now - at
  if (diff < MINUTE) return 'à l’instant'
  if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`
  if (diff < DAY) return `il y a ${Math.floor(diff / HOUR)} h`
  const days = Math.floor(diff / DAY)
  if (days === 1) return 'hier'
  if (days < 7) return `il y a ${days} j`
  if (days < 30) return `il y a ${Math.floor(days / 7)} sem.`
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`
  const years = Math.floor(days / 365)
  return `il y a ${years} ${years > 1 ? 'ans' : 'an'}`
}

/** Shows what main answered at once, before the `mockups:changed` reload brings it. */
export function upsertMockup(repo: string, m: Mockup): void {
  useMockups.setState((s) => {
    if (s.repo !== repo) return s
    const i = s.list.findIndex((x) => x.id === m.id)
    return { list: i < 0 ? [...s.list, m] : s.list.map((x, j) => (j === i ? m : x)) }
  })
}

export function dropMockup(repo: string, id: string): void {
  useMockups.setState((s) => (s.repo === repo ? { list: s.list.filter((m) => m.id !== id) } : s))
}

/**
 * Keeps `useMockups` on the active repo: loads its mockups, watches them and reloads on change. Returns the stop function.
 * Only the latest read applies. An unreadable registry empties the list and reports why; a failed read keeps the list.
 */
export function connectMockups(): () => void {
  let current: string | null = null
  let seq = 0

  const load = async (repo: string): Promise<void> => {
    const mine = ++seq
    const latest = (): boolean => current === repo && seq === mine
    try {
      const r = await window.canopy.listMockups(repo)
      if (!latest()) return
      useMockups.setState(r.kind === 'ok'
        ? { repo, list: r.mockups, error: null, loaded: true }
        : { repo, list: [], error: r.error, loaded: true })
    } catch (e) {
      if (latest()) useMockups.setState({ error: message(e), loaded: true })
    }
  }

  const follow = (repo: string | null): void => {
    if (repo === current) return
    current = repo
    seq++
    useMockups.setState({ repo, list: [], error: null, loaded: false })
    if (!repo) return
    void load(repo)
    // A change between that read and the watch starting would be missed: read again once it watches.
    window.canopy.watchMockups(repo).then(
      () => { if (current === repo) void load(repo) },
      (e: unknown) => { if (current === repo) useMockups.setState({ error: message(e) }) }
    )
  }

  const off = window.canopy.on('mockups:changed', () => { if (current) void load(current) })
  follow(useApp.getState().repo)
  const unsub = useApp.subscribe((s, prev) => { if (s.repo !== prev.repo) follow(s.repo) })
  return () => { off(); unsub(); current = null; seq++ }
}

/** Adds `line` to the draft of `cwd`'s selected session, then shows it in Sessions. */
export function attachToSession(cwd: string, line: string): void {
  ensureTab(cwd)
  const { active, tabs } = useSessions.getState()
  const tab = tabs[active[cwd]]
  if (tab) {
    const before = tab.draft.text.replace(/\s+$/, '')
    setDraftText(tab.id, before === '' ? line : `${before}\n${line}`)
  }
  const app = useApp.getState()
  app.setWorktree(cwd)
  app.setView('sessions')
}

/**
 * Opens Tickets on the launch panel of the mockup's ticket. Without a live ticket, creates one in Backlog titled like
 * the mockup and links it first. Rejects with main's message; does not navigate if the repo changed meanwhile.
 */
export async function launchFromMockup(repo: string, m: Mockup, ticket: Ticket | undefined): Promise<void> {
  let id = ticket?.id
  if (!id) {
    const t = await window.canopy.createTicket(repo, {
      title: m.title, description: '', status: 'backlog', priority: 'none', labels: [], subtasks: []
    })
    upsertMockup(repo, await window.canopy.patchMockup(repo, m.id, { ticket: t.id }))
    id = t.id
  }
  if (useApp.getState().repo !== repo) return
  const app = useApp.getState()
  app.setSelectedTicket(id)
  app.setOpenTicket(null)
  app.setView('tickets')
}
