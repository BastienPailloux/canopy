import { depsLaunchPrompt, type DepEntry } from '../../shared/deps'
import { linearLaunchPrompt, type LinearLaunchRequest } from '../../shared/linear'
import { launchMockupsSection, type Mockup } from '../../shared/mockups'
import { branchSlug, launchPrompt, type LaunchRequest, type LaunchTarget, type Ticket } from '../../shared/tickets'
import { askClaude } from '../sessions/sessionStore'
import { useApp } from '../store'
import { reloadLinearLinks } from './linearStore'
import { useTickets } from './ticketStore'

/** `<type>/<slug of the title>`, `feat` unless told otherwise. */
export function defaultBranchName(t: Ticket, type?: string): string {
  return `${type ?? 'feat'}/${branchSlug(t.title)}`
}

/** The launch prompt of `t`, followed by the list of `mockups` to read when there are any. */
export function launchText(t: Ticket, mockups: Pick<Mockup, 'title' | 'url'>[] = [], parent?: Pick<Ticket, 'id' | 'title'>): string {
  const section = launchMockupsSection(mockups)
  const prompt = launchPrompt(t, parent)
  return section ? `${prompt}\n\n${section}` : prompt
}

/** The parent of `t` as the ticket list shows it; undefined when it has none or the list does not have it. */
function parentOf(t: Ticket): Pick<Ticket, 'id' | 'title'> | undefined {
  if (!t.parent) return undefined
  for (const e of useTickets.getState().entries) if (e.kind === 'ticket' && e.ticket.id === t.parent) return e.ticket
  return undefined
}

/**
 * The worktree list of `repo` and the open folder read again, the way `useWorktrees` does after a creation: the
 * worktree list is not mounted on the Tickets screen. A failed read is left to its next poll: the launch did happen.
 */
export async function rescan(repo: string): Promise<void> {
  const list = await window.canopy.listWorktrees(repo).catch(() => null)
  if (list && useApp.getState().repo === repo) useApp.getState().setWorktrees(list)
  const root = useApp.getState().workspace?.root
  if (!root) return
  const scan = await window.canopy.scanWorkspace(root).catch(() => null)
  if (scan && useApp.getState().workspace?.root === scan.root) useApp.getState().setWorkspace(scan)
}

/**
 * Launches the ticket, then shows Sessions on its worktree (unless the open repo changed meanwhile) and, if asked,
 * sends the launch prompt, built from the ticket as the launch left it on disk plus the `mockups` to join, to Claude
 * there. A failed launch rejects with git's message and leaves the screen as it was.
 */
export async function runLaunch(
  repo: string, req: LaunchRequest, o: { startClaude: boolean; mockups?: Pick<Mockup, 'title' | 'url'>[] }
): Promise<void> {
  const before = useApp.getState().repo
  const result = await window.canopy.launchTicket(repo, req)
  await showLaunched(repo, before, result.worktree)
  if (o.startClaude) askClaude(result.worktree, launchText(result.ticket, o.mockups, parentOf(result.ticket)))
}

/** Like `runLaunch` for a Linear issue: nothing is written in Linear. */
export async function runLinearLaunch(repo: string, req: LinearLaunchRequest, o: { startClaude: boolean }): Promise<void> {
  const before = useApp.getState().repo
  const result = await window.canopy.linearLaunch(repo, req)
  // Main's change event names the issue only when its row changed: the new link is read here.
  void reloadLinearLinks()
  await showLaunched(repo, before, result.worktree)
  if (o.startClaude) askClaude(result.worktree, linearLaunchPrompt(result.issue))
}

/** Like `runLaunch` for a selection of dependencies: nothing is written in the repo, the prompt lists `entries`. */
export async function runDepsLaunch(
  repo: string, req: { branch: string; target: LaunchTarget }, entries: DepEntry[], o: { startClaude: boolean }
): Promise<void> {
  const before = useApp.getState().repo
  const result = await window.canopy.depsLaunch(repo, req)
  await showLaunched(repo, before, result.worktree)
  if (o.startClaude) askClaude(result.worktree, depsLaunchPrompt(entries))
}

/** Shows Sessions on the launched `worktree`, unless the open repo changed since `before` (the repo when the launch began). */
export async function showLaunched(repo: string, before: string | null, worktree: string): Promise<void> {
  await rescan(repo)
  if (useApp.getState().repo === before) {
    const app = useApp.getState()
    app.setWorktree(worktree)
    app.setView('sessions')
  }
}
