import { realpath } from 'node:fs/promises'
import type { AppStore } from '../appStore'
import { git } from '../git/exec'
import { mostAdvancedBranch } from '../git/refs'
import { cachedBaseRef } from '../git/sharedReads'
import { dirtyCount, startBranchIn } from '../git/switchBranch'
import { createWorktree, hasRef, listWorktrees, mainWorktreeRoot } from '../git/worktrees'
import type { Worktree } from '../../shared/types'
import type { LaunchCandidate, LaunchRequest, LaunchTarget, Ticket, TicketFields } from '../../shared/tickets'
import type { TicketStore } from './store'

export interface LaunchDeps {
  tickets: TicketStore
  store: Pick<AppStore, 'setBranchBase' | 'setLinearLink'>
  activity: (cwd: string) => 'waiting' | 'working' | 'idle'
  sessions: (cwd: string) => number
  /** Whether the repo config at `cwd` was approved: its filters and hooks may run. */
  trusted: (cwd: string) => Promise<boolean>
}

function candidateOf(deps: LaunchDeps, w: Worktree, dirty: number): LaunchCandidate {
  const busy = deps.activity(w.path)
  const reason = w.isMain ? 'main' : busy === 'idle' ? undefined : busy
  return {
    path: w.path, branch: w.branch, free: reason === undefined, ...(reason ? { reason } : {}),
    dirty, sessions: deps.sessions(w.path)
  }
}

/** The repo's worktrees a launch could use, and the branch most ahead of the default one, to stack on. */
export async function launchCandidates(deps: LaunchDeps, repo: string): Promise<{
  worktrees: LaunchCandidate[]
  advanced: { branch: string; ahead: number } | null
}> {
  const root = await mainWorktreeRoot(repo)
  const list = await listWorktrees(root)
  const worktrees = await Promise.all(list.map(async (w) => candidateOf(deps, w, await dirtyCount(w.path).catch(() => 0))))
  const def = await cachedBaseRef(root).catch(() => null)
  const advanced = def ? await mostAdvancedBranch(root, def.ref).catch(() => null) : null
  return { worktrees, advanced }
}

/** A name git accepts for a new local branch, as it is: `--branch` would also expand `@{-1}`. */
async function checkNewBranch(root: string, branch: string): Promise<void> {
  const invalid = new Error(`Nom de branche invalide : "${branch}"`)
  if (branch === '' || branch.startsWith('-')) throw invalid
  const out = await git(root, ['check-ref-format', '--branch', branch]).catch(() => { throw invalid })
  if (out.trim() !== branch) throw invalid
  if (await hasRef(root, `refs/heads/${branch}`)) throw new Error(`La branche "${branch}" existe déjà`)
}

const samePath = async (a: string, b: string): Promise<boolean> =>
  a === b || (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b))

/** The listed worktree at `path`, if a launch may use it now. */
async function freeWorktree(deps: LaunchDeps, root: string, path: string): Promise<Worktree> {
  let found: Worktree | undefined
  for (const w of await listWorktrees(root)) if (await samePath(w.path, path)) found = w
  if (!found) throw new Error(`Worktree inconnu de ce dépôt : ${path}`)
  const c = candidateOf(deps, found, 0)
  if (c.reason === 'main') throw new Error('Le dépôt principal ne peut pas recevoir le lancement')
  if (c.reason === 'working') throw new Error('Une session travaille dans ce worktree')
  if (c.reason === 'waiting') throw new Error('Une session attend une réponse dans ce worktree')
  return found
}

/**
 * The git half of a launch: puts the new branch in a new worktree, or starts it in a free one, and remembers its base
 * when it is not the repo's default. Anything failing before the git work ends writes nothing.
 */
export async function startTicketBranch(deps: LaunchDeps, root: string, branch: string, target: LaunchTarget): Promise<string> {
  await checkNewBranch(root, branch)
  if (target.base === '' || target.base.startsWith('-')) throw new Error(`Branche de départ invalide : "${target.base}"`)

  let worktree: string
  if (target.kind === 'new') {
    const created = await createWorktree(root, {
      name: branch.replace(/\//g, '-'), branch, base: target.base, trusted: await deps.trusted(root)
    })
    worktree = created.path
  } else {
    const w = await freeWorktree(deps, root, target.worktree)
    await startBranchIn(w.path, branch, target.base, { trusted: await deps.trusted(w.path) })
    worktree = w.path
  }

  // Only a base other than the repo's own says the branch is stacked.
  const def = await cachedBaseRef(root).catch(() => null)
  if (target.base !== def?.name && target.base !== def?.ref) deps.store.setBranchBase(root, branch, target.base)
  return worktree
}

/**
 * Puts the ticket's new branch in a new worktree, or starts it in a free one, then links the ticket to it.
 * The base is remembered when it is not the repo's default. Anything failing before the git work ends writes nothing.
 */
export async function launchTicket(deps: LaunchDeps, repo: string, req: LaunchRequest): Promise<{ worktree: string; ticket: Ticket }> {
  const root = await mainWorktreeRoot(repo)
  await deps.tickets.get(root, req.id)
  const worktree = await startTicketBranch(deps, root, req.branch, req.target)

  const changes: Partial<TicketFields> = { branch: req.branch, worktree, base: req.target.base }
  if (req.setInProgress) changes.status = 'in_progress'
  const ticket = await deps.tickets.patch(root, req.id, changes)
  return { worktree, ticket }
}
