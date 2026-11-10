import { isAbsolute } from 'node:path'
import { MAX_PR_BODY, type AutoMergeEntry, type CleanupRequest, type MergeMethod, type PrAction } from '../../shared/pr'
import type { AppStore } from '../appStore'
import { clearSharedReads } from '../git/sharedReads'
import type { AutoMergeWatch } from './autoMergeWatch'
import { cleanupAfterMerge, deleteLocalAfterMerge } from './cleanup'
import { isGhUnavailable, type PrGateway } from './gateway'

const bad = (): Error => new Error('Action invalide')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

const NODE_ID_RE = /^[A-Za-z0-9_=-]{1,100}$/
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/
const TEAM_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const MAX_LABEL = 50
const MAX_SUBJECT = 256
const MAX_LIST = 100
const METHODS: MergeMethod[] = ['squash', 'merge', 'rebase']

const body = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > MAX_PR_BODY) throw bad()
  return v
}
const text = (v: unknown): string => {
  const s = body(v)
  if (s.trim() === '') throw bad()
  return s
}
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw bad()
  return v
}
/** A branch name goes to `gh` and to a URL: never one that could pass for a flag. */
export const isBranchName = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 255 && !v.startsWith('-') && !/[\0\r\n]/.test(v)

function logins(v: unknown, teams: boolean): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) throw bad()
  return v.map((l) => {
    if (typeof l !== 'string' || !(LOGIN_RE.test(l) || (teams && TEAM_RE.test(l)))) throw bad()
    return l
  })
}
function labels(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) throw bad()
  return v.map((l) => {
    if (typeof l !== 'string' || l === '' || l.length > MAX_LABEL || /[\r\n\0]/.test(l)) throw bad()
    return l
  })
}
function relPath(v: unknown): string {
  if (typeof v !== 'string' || v === '' || v.length > 4096 || isAbsolute(v) || v.includes('\0') || v.split(/[\\/]/).includes('..')) throw bad()
  return v
}
function method(v: unknown): MergeMethod {
  if (!METHODS.includes(v as MergeMethod)) throw bad()
  return v as MergeMethod
}
/** A full commit id: GitHub merges only at it, and it never reads as a flag. */
function oid(v: unknown): string {
  if (typeof v !== 'string' || !OID_RE.test(v)) throw bad()
  return v
}
/** Rebase takes no commit message, so its subject is ignored; the others cannot go without one. */
function subjectFor(m: MergeMethod, v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_SUBJECT || /[\r\n\0]/.test(v)) throw bad()
  if (m !== 'rebase' && v.trim() === '') throw bad()
  return v
}

/** Checks a `PrAction` from the renderer; an unknown type or key, or any out-of-range value, is refused. */
export function parsePrAction(raw: unknown): PrAction {
  if (!isObject(raw)) throw bad()
  const only = (...keys: string[]): void => {
    if (Object.keys(raw).some((k) => k !== 'type' && !keys.includes(k)) || keys.some((k) => !(k in raw))) throw bad()
  }
  switch (raw.type) {
    case 'comment': only('body'); return { type: 'comment', body: text(raw.body) }
    case 'reply':
      only('commentId', 'body')
      if (!isPosInt(raw.commentId)) throw bad()
      return { type: 'reply', commentId: raw.commentId, body: text(raw.body) }
    case 'resolve':
      only('threadId', 'resolved')
      if (typeof raw.threadId !== 'string' || !NODE_ID_RE.test(raw.threadId)) throw bad()
      return { type: 'resolve', threadId: raw.threadId, resolved: bool(raw.resolved) }
    case 'review':
      only('event', 'body')
      if (raw.event !== 'APPROVE' && raw.event !== 'REQUEST_CHANGES') throw bad()
      // GitHub refuses a change request without a body
      return { type: 'review', event: raw.event, body: raw.event === 'REQUEST_CHANGES' ? text(raw.body) : body(raw.body) }
    case 'editBody': only('body'); return { type: 'editBody', body: body(raw.body) }
    case 'draft': only('draft'); return { type: 'draft', draft: bool(raw.draft) }
    case 'close': only(); return { type: 'close' }
    case 'reopen': only(); return { type: 'reopen' }
    case 'reviewers': only('add', 'remove'); return { type: 'reviewers', add: logins(raw.add, true), remove: logins(raw.remove, true) }
    case 'assignees': only('add', 'remove'); return { type: 'assignees', add: logins(raw.add, false), remove: logins(raw.remove, false) }
    case 'labels': only('add', 'remove'); return { type: 'labels', add: labels(raw.add), remove: labels(raw.remove) }
    case 'viewed': only('path', 'viewed'); return { type: 'viewed', path: relPath(raw.path), viewed: bool(raw.viewed) }
    case 'rerun':
      only('runId', 'jobId')
      if (!isPosInt(raw.runId) || !(raw.jobId === null || isPosInt(raw.jobId))) throw bad()
      return { type: 'rerun', runId: raw.runId, jobId: raw.jobId }
    case 'updateBranch': only(); return { type: 'updateBranch' }
    case 'merge': {
      only('method', 'subject', 'body', 'headOid')
      const m = method(raw.method)
      return { type: 'merge', method: m, subject: subjectFor(m, raw.subject), body: body(raw.body), headOid: oid(raw.headOid) }
    }
    case 'autoMerge': {
      only('enable', 'method', 'subject', 'body', 'headOid')
      const m = method(raw.method)
      const enable = bool(raw.enable)
      // disabling needs no message
      return { type: 'autoMerge', enable, method: m, subject: enable ? subjectFor(m, raw.subject) : '', body: body(raw.body), headOid: oid(raw.headOid) }
    }
    case 'revert': only(); return { type: 'revert' }
    case 'deleteRemoteBranch':
      only('branch')
      if (!isBranchName(raw.branch)) throw bad()
      return { type: 'deleteRemoteBranch', branch: raw.branch }
    default: throw bad()
  }
}

const badCleanup = (): Error => new Error('Demande de nettoyage invalide')

/** Checks a `CleanupRequest` from the renderer: `headOid` is a full commit id, the only tip a branch is deleted at. */
export function parseCleanupRequest(raw: unknown, extra: string[] = []): CleanupRequest {
  if (!isObject(raw)) throw badCleanup()
  const keys = ['number', 'branch', 'headOid', ...extra]
  if (Object.keys(raw).some((k) => !keys.includes(k)) || keys.some((k) => !(k in raw))) throw badCleanup()
  if (!isPosInt(raw.number) || !isBranchName(raw.branch) || typeof raw.headOid !== 'string' || !OID_RE.test(raw.headOid)) throw badCleanup()
  return { number: raw.number, branch: raw.branch, headOid: raw.headOid }
}

function parseAutoMerge(raw: unknown): AutoMergeEntry | null {
  if (raw === null) return null
  const req = parseCleanupRequest(raw, ['cleanup'])
  const cleanup = (raw as Record<string, unknown>).cleanup
  if (typeof cleanup !== 'boolean') throw badCleanup()
  return { ...req, cleanup }
}

function assertCwd(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}
function assertNumber(n: unknown): asserts n is number {
  if (!isPosInt(n)) throw new Error('Numéro de PR invalide')
}

export interface PrIpcDeps {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => void
  gateway: PrGateway
  currentBranch: (cwd: string) => Promise<string | null>
  /** After a merge, close or reopen: the open-PR cache of `cwd`'s repo is stale. */
  onPrStateChanged: (cwd: string) => void | Promise<void>
  store: AppStore
  /** Whether the repo config at `cwd` was approved: its hooks may run on the cleanup's switch. */
  trusted: (cwd: string) => Promise<boolean>
  autoMerges: Pick<AutoMergeWatch, 'watch'>
}

const STATE_CHANGING = new Set<PrAction['type']>(['merge', 'close', 'reopen'])

export function registerPrIpc(d: PrIpcDeps): void {
  d.handle('pr:find', async (cwd) => {
    assertCwd(cwd)
    const branch = await d.currentBranch(cwd)
    if (branch === null || !isBranchName(branch)) return null
    // gh missing or logged out: the tab simply has no PR to show. Offline rejects, so the tab keeps what it shows.
    return d.gateway.find(cwd, branch).catch((e: unknown) => {
      if (isGhUnavailable(e)) return null
      throw e
    })
  })
  d.handle('pr:view', (cwd, number) => {
    assertCwd(cwd)
    assertNumber(number)
    return d.gateway.view(cwd, number)
  })
  d.handle('pr:options', (cwd, number) => {
    assertCwd(cwd)
    assertNumber(number)
    return d.gateway.options(cwd, number)
  })
  d.handle('pr:failedLog', (cwd, runId, jobId) => {
    assertCwd(cwd)
    if (!isPosInt(runId) || !isPosInt(jobId)) throw new Error('Identifiant de job invalide')
    return d.gateway.failedLog(cwd, runId, jobId)
  })
  d.handle('pr:act', async (cwd, number, action) => {
    assertCwd(cwd)
    assertNumber(number)
    const a = parsePrAction(action)
    const result = await d.gateway.act(cwd, number, a)
    if (STATE_CHANGING.has(a.type)) await d.onPrStateChanged(cwd)
    return result
  })
  d.handle('pr:cleanup', async (cwd, raw) => {
    assertCwd(cwd)
    const req = parseCleanupRequest(raw)
    try {
      return await cleanupAfterMerge(cwd, req, { gateway: d.gateway, store: d.store, trusted: await d.trusted(cwd) })
    } finally {
      clearSharedReads()
    }
  })
  d.handle('pr:deleteLocalBranch', async (repo, branch) => {
    assertCwd(repo)
    if (!isBranchName(branch)) throw badCleanup()
    try {
      // GitHub, not the renderer, says whether it is merged and at which head
      return await deleteLocalAfterMerge(d.gateway, repo, branch)
    } finally {
      clearSharedReads()
    }
  })
  d.handle('pr:watchAutoMerge', async (cwd, raw) => {
    assertCwd(cwd)
    d.autoMerges.watch(cwd, parseAutoMerge(raw))
  })
}
