import { realpath } from 'node:fs/promises'
import type { CleanupOutcome, CleanupRequest, CleanupStep } from '../../shared/pr'
import type { AppStore } from '../appStore'
import { git } from '../git/exec'
import { cachedBaseRef } from '../git/sharedReads'
import { currentBranch, dirtyCount, hasSetAsideFor, switchBranch } from '../git/switchBranch'
import { hasRef, listWorktrees } from '../git/worktrees'
import type { BranchPrState } from '../git/pr'
import type { PrGateway } from './gateway'

export interface NextBranchInput {
  /** Branches checked out in the worktree, most recent last. */
  history: string[]
  current: string
  locals: Set<string>
  base: string | null
  heldElsewhere: Set<string>
  prState: (branch: string) => 'open' | 'merged' | 'closed' | null
}

/** The branch a worktree goes back to once its PR is merged: the latest one still being worked on. */
export function nextBranch(o: NextBranchInput): string | null {
  for (let i = o.history.length - 1; i >= 0; i--) {
    const b = o.history[i]
    if (b === o.current || !o.locals.has(b) || b === o.base || o.heldElsewhere.has(b)) continue
    const state = o.prState(b)
    if (state === null || state === 'open') return b
  }
  return null
}

const KEPT_AHEAD = 'La branche locale a des commits absents de la PR : conservée'
const KEPT_HELD = 'La branche est encore ouverte dans un worktree : conservée'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Deletes the local `branch` of a merged PR. A squash or rebase leaves it unmerged for git, so `-D`, but only while
 * its tip is the PR's head: nothing local is lost. Never a branch open in a worktree.
 */
export async function deleteMergedBranch(repo: string, branch: string, headOid: string): Promise<CleanupStep> {
  try {
    if ((await listWorktrees(repo)).some((w) => w.branch === branch)) return { step: 'local', ok: false, message: KEPT_HELD }
    const tip = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [1] })).trim()
    // already gone: nothing to do
    if (tip === '') return { step: 'local', ok: true }
    if (tip !== headOid) return { step: 'local', ok: false, message: KEPT_AHEAD }
    await git(repo, ['branch', '-D', '--', branch])
    return { step: 'local', ok: true }
  } catch (e) {
    return { step: 'local', ok: false, message: messageOf(e) }
  }
}

export interface CleanupDeps {
  gateway: PrGateway
  store: AppStore
  /** The repo config was approved: its hooks and filters may run on the switch. */
  trusted: boolean
}

/** The base as a local branch name, and its remote ref when it has one (`origin/main`). */
async function baseOf(cwd: string): Promise<{ local: string; remote: string | null } | null> {
  const b = await cachedBaseRef(cwd).catch(() => null)
  if (b === null) return null
  if (await hasRef(cwd, `refs/remotes/${b.ref}`)) return { local: b.ref.slice(b.ref.indexOf('/') + 1), remote: b.ref }
  return { local: b.ref, remote: null }
}

/**
 * Brings the base checked out in `cwd` up to its remote one; only a fast-forward, the worktree being clean.
 * Not for an unapproved repo: a fetch and a merge run its config (hooks, filters, remote helpers).
 */
export async function updateBase(cwd: string, remote: string, trusted: boolean): Promise<CleanupStep> {
  if (!trusted) return { step: 'update', ok: false, message: "Base non mise à jour : la configuration du dépôt n'est pas approuvée" }
  const name = remote.slice(0, remote.indexOf('/'))
  if (name === '' || name.startsWith('-')) return { step: 'update', ok: false, message: `Dépôt distant invalide : « ${name} »` }
  try {
    await git(cwd, ['fetch', '--quiet', '--', name], { trusted })
    await git(cwd, ['merge', '--ff-only', '--quiet', `refs/remotes/${remote}`], { trusted })
    return { step: 'update', ok: true }
  } catch (e) {
    return { step: 'update', ok: false, message: messageOf(e) }
  }
}

/**
 * The head GitHub merged for PR `number` of `branch`, or why it cannot be trusted to be merged. It must be the branch's
 * latest PR (forks left out): an old merged PR of a reused branch says nothing of the work on it now.
 */
async function mergedHead(gateway: PrGateway, cwd: string, number: number, branch: string): Promise<{ headOid: string } | { message: string }> {
  try {
    const latest = await gateway.find(cwd, branch)
    if (latest === null || latest.number !== number) return { message: `La PR #${number} n'est plus la dernière de la branche ${branch} : rien n'a été nettoyé` }
    const pr = await gateway.view(cwd, number)
    if (pr.number !== number || pr.head !== branch || pr.state !== 'merged') return { message: `La PR #${number} n'est pas mergée : rien n'a été nettoyé` }
    return { headOid: pr.headOid }
  } catch (e) {
    return { message: `État de la PR #${number} illisible : rien n'a été nettoyé (${messageOf(e)})` }
  }
}

/** Once the worktree is removed: deletes `branch` only if GitHub says its latest PR is merged, at that PR's head. */
export async function deleteLocalAfterMerge(gateway: PrGateway, repo: string, branch: string): Promise<CleanupStep> {
  const pr = await gateway.find(repo, branch).catch(() => null)
  if (pr === null || pr.state !== 'merged') return { step: 'local', ok: false, message: "La PR de cette branche n'est pas mergée : branche conservée" }
  const merged = await mergedHead(gateway, repo, pr.number, branch)
  if ('message' in merged) return { step: 'local', ok: false, message: merged.message }
  if (await hasSetAsideFor(repo, branch).catch(() => true)) return { step: 'local', ok: false, message: SET_ASIDE }
  return deleteMergedBranch(repo, branch, merged.headOid)
}

const SET_ASIDE = 'Des modifications mises de côté pour cette branche attendent : branche conservée'

/** Uncommitted files, and changes Canopy set aside for the merged `branch`: either would end up on a deleted branch. */
async function pendingWork(cwd: string, branch: string): Promise<CleanupOutcome | null> {
  const [files, setAside] = await Promise.all([dirtyCount(cwd), hasSetAsideFor(cwd, branch)])
  if (setAside) return { kind: 'dirty', files, setAside: true }
  return files > 0 ? { kind: 'dirty', files } : null
}

const REMOTE_MOVED = 'Branche distante conservée : elle a reçu des commits après le merge'

/**
 * Deletes the remote `branch` only while its tip is the merged head: a delayed cleanup (auto-merge) may run after a
 * collaborator pushed to it, or recreated it. GitHub's ref deletion takes no expected oid, and a lease push would run
 * the repo's hooks: read then delete, a push landing between the two is the residual race.
 */
async function deleteRemoteBranch(gateway: PrGateway, cwd: string, number: number, branch: string, headOid: string): Promise<CleanupStep> {
  try {
    if ((await gateway.remoteTip(cwd, branch)) !== headOid) return { step: 'remote', ok: false, message: REMOTE_MOVED }
    await gateway.act(cwd, number, { type: 'deleteRemoteBranch', branch })
    return { step: 'remote', ok: true }
  } catch (e) {
    return { step: 'remote', ok: false, message: messageOf(e) }
  }
}

/**
 * The PR state of each history branch: the repo-wide list only covers its newest PRs, so a branch missing from it is
 * asked on its own, lazily and most recent first, until one in progress is found. Bounded by the history (50 at most).
 */
async function nextInProgress(gateway: PrGateway, cwd: string, input: Omit<NextBranchInput, 'prState'>, states: Map<string, BranchPrState> | null): Promise<string | null> {
  // gh unavailable: every branch counts as in progress, none as merged
  if (states === null) return nextBranch({ ...input, prState: () => null })
  const known = new Map<string, BranchPrState | null>(states)
  for (;;) {
    const next = nextBranch({ ...input, prState: (b) => known.get(b) ?? null })
    if (next === null || known.has(next)) return next
    // a failed lookup leaves it in progress, never merged
    const pr = await gateway.find(cwd, next).catch(() => null)
    known.set(next, pr === null ? null : pr.state === 'draft' ? 'open' : pr.state)
  }
}

const realOrSelf = (p: string): Promise<string> => realpath(p).catch(() => p)

/**
 * After a merge started from the tab, in the worktree `cwd` of the PR's branch: deletes the remote branch, moves the
 * worktree to the latest branch still in progress (the main checkout falls back to the base) and deletes the local
 * branch. Main checks with GitHub that the PR is merged, and deletes the local branch at GitHub's head, never the
 * renderer's. Uncommitted or set-aside work stops it before anything: it would end up on a branch about to be deleted.
 */
export async function cleanupAfterMerge(cwd: string, req: CleanupRequest, d: CleanupDeps): Promise<CleanupOutcome> {
  const merged = await mergedHead(d.gateway, cwd, req.number, req.branch)
  if ('message' in merged) return { kind: 'failed', steps: [{ step: 'check', ok: false, message: merged.message }] }
  const headOid = merged.headOid
  const pending = await pendingWork(cwd, req.branch)
  if (pending) return pending
  const steps: CleanupStep[] = []
  // a protected branch, or one GitHub already deleted: reported, the rest goes on
  steps.push(await deleteRemoteBranch(d.gateway, cwd, req.number, req.branch, headOid))

  const [top, worktrees, current, base] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']).then((s) => s.trim()), listWorktrees(cwd), currentBranch(cwd), baseOf(cwd)
  ])
  if (current === null) return { kind: 'failed', steps: [...steps, { step: 'switch', ok: false, message: 'HEAD détaché : nettoyage local non fait' }] }
  // The worktree already left the branch: nothing to switch away from.
  if (current !== req.branch) return { kind: 'switched', branch: current, steps: [...steps, await deleteMergedBranch(cwd, req.branch, headOid)] }

  // Real paths: a symlinked checkout must still be known as the main one. Not found: treated as main, never removed.
  const realTop = await realOrSelf(top)
  const reals = await Promise.all(worktrees.map((w) => realOrSelf(w.path)))
  const selfIndex = reals.indexOf(realTop)
  const isMain = selfIndex < 0 || worktrees[selfIndex].isMain
  const heldElsewhere = new Set(worktrees.flatMap((w, i) => (i !== selfIndex && w.branch !== null ? [w.branch] : [])))
  const locals = new Set((await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter((b) => b !== ''))
  const states = await d.gateway.branchStates(cwd).catch(() => null)
  const next = await nextInProgress(d.gateway, cwd, { history: d.store.branchHistory(cwd), current, locals, base: base?.local ?? null, heldElsewhere }, states)

  let target = next
  if (target === null && isMain) {
    if (base === null) return { kind: 'failed', steps: [...steps, { step: 'switch', ok: false, message: 'Branche de base introuvable' }] }
    target = locals.has(base.local) || base.remote === null ? base.local : base.remote
  }
  if (target === null) return { kind: 'proposeRemoval', steps }

  // Files changed since the first check would be set aside on the branch about to be deleted.
  const late = await pendingWork(cwd, req.branch)
  if (late) return late
  try {
    const { conflict } = await switchBranch(cwd, target, { trusted: d.trusted })
    steps.push(conflict
      ? { step: 'switch', ok: true, message: "Les modifications mises de côté pour cette branche n'ont pas pu être réappliquées : elles restent dans le stash" }
      : { step: 'switch', ok: true })
  } catch (e) {
    return { kind: 'failed', steps: [...steps, { step: 'switch', ok: false, message: messageOf(e) }] }
  }
  const now = (await currentBranch(cwd)) ?? target
  d.store.recordBranch(cwd, now)
  if (next === null && base?.remote) steps.push(await updateBase(cwd, base.remote, d.trusted))
  steps.push(await deleteMergedBranch(cwd, req.branch, headOid))
  return { kind: 'switched', branch: now, steps }
}
