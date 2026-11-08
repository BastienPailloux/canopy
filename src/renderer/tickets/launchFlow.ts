import { linearLaunchPrompt, type LinearLaunchRequest } from '../../shared/linear'
import { branchSlug, launchPrompt, type LaunchRequest, type Ticket } from '../../shared/tickets'
import { askClaude } from '../sessions/sessionStore'
import { useApp } from '../store'

/** `<type>/<slug of the title>`, `feat` unless told otherwise. */
export function defaultBranchName(t: Ticket, type?: string): string {
  return `${type ?? 'feat'}/${branchSlug(t.title)}`
}

/**
 * The worktree list of `repo` and the open folder read again, the way `useWorktrees` does after a creation: the
 * worktree list is not mounted on the Tickets screen. A failed read is left to its next poll: the launch did happen.
 */
async function rescan(repo: string): Promise<void> {
  const list = await window.canopy.listWorktrees(repo).catch(() => null)
  if (list && useApp.getState().repo === repo) useApp.getState().setWorktrees(list)
  const root = useApp.getState().workspace?.root
  if (!root) return
  const scan = await window.canopy.scanWorkspace(root).catch(() => null)
  if (scan && useApp.getState().workspace?.root === scan.root) useApp.getState().setWorkspace(scan)
}

/**
 * Launches the ticket, then shows Sessions on its worktree (unless the open repo changed meanwhile) and, if asked,
 * sends the launch prompt, built from the ticket as the launch left it on disk, to Claude there. A failed launch
 * rejects with git's message and leaves the screen as it was.
 */
export async function runLaunch(repo: string, req: LaunchRequest, o: { startClaude: boolean }): Promise<void> {
  const before = useApp.getState().repo
  const result = await window.canopy.launchTicket(repo, req)
  await showLaunched(repo, before, result.worktree)
  if (o.startClaude) askClaude(result.worktree, launchPrompt(result.ticket))
}

/** Like `runLaunch` for a Linear issue: nothing is written in Linear, and the session is told to expect its MCP. */
export async function runLinearLaunch(repo: string, req: LinearLaunchRequest, o: { startClaude: boolean }): Promise<void> {
  const before = useApp.getState().repo
  const result = await window.canopy.linearLaunch(repo, req)
  await showLaunched(repo, before, result.worktree)
  if (o.startClaude) askClaude(result.worktree, linearLaunchPrompt(result.issue), { expectLinear: true })
}

async function showLaunched(repo: string, before: string | null, worktree: string): Promise<void> {
  await rescan(repo)
  if (useApp.getState().repo === before) {
    const app = useApp.getState()
    app.setWorktree(worktree)
    app.setView('sessions')
  }
}
