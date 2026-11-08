import { mainWorktreeRoot } from '../git/worktrees'
import { startTicketBranch, type LaunchDeps } from '../tickets/launch'
import type { LinearIssue, LinearLaunchRequest } from '../../shared/linear'
import type { LinearClient } from './client'

export type { LinearLaunchRequest } from '../../shared/linear'

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/

/**
 * Creates the branch of a Linear issue like a local launch does, then links the issue to it in Canopy's own state.
 * The issue is read first, so an unknown one fails before any git work. Nothing is written in Linear.
 */
export async function launchLinear(
  deps: LaunchDeps & { linear: Pick<LinearClient, 'issueBrief'> },
  repo: string,
  req: LinearLaunchRequest,
): Promise<{ worktree: string; issue: LinearIssue }> {
  if (!ID_RE.test(req.id)) throw new Error(`Identifiant Linear invalide : "${req.id}"`)
  const root = await mainWorktreeRoot(repo)
  const issue = await deps.linear.issueBrief(req.id)
  const worktree = await startTicketBranch(deps, root, req.branch, req.target)
  deps.store.setLinearLink(root, req.id, { branch: req.branch, worktree, base: req.target.base })
  return { worktree, issue }
}
