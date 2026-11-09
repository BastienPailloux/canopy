import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PrDetail, PrOptions, PrState } from '../../shared/pr'
import type { BranchPrState } from '../git/pr'
import { ghGateway, type PrGateway } from './gateway'

interface Fixture {
  detail: PrDetail
  options: PrOptions
  /** Other branches' PR states, for the cleanup tests. The head's own comes from the PR. */
  branchStates?: Record<string, BranchPrState>
  failedLog?: string
}

export interface FakeGatewayOptions {
  /** `tests/fixtures/gh/pr.json`: a `PrDetail` and its `PrOptions`. */
  file: string
  /** Every action that goes through is appended as one JSON line `{ number, action }`. */
  logFile?: string
  /** While this file exists, every call rejects (checked on each call). */
  failFile?: string
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const BRANCH_STATE: Record<PrState, BranchPrState> = { open: 'open', draft: 'open', merged: 'merged', closed: 'closed' }

/** e2e: one PR held in memory, changed by the actions the tab sends. */
export function fakeGateway(o: FakeGatewayOptions): PrGateway {
  const fixture = JSON.parse(readFileSync(o.file, 'utf8')) as Fixture
  const pr = fixture.detail
  const guard = (): void => {
    if (o.failFile && existsSync(o.failFile)) throw new Error('GitHub (gh) : hors ligne')
  }
  const at = (): string => new Date().toISOString()
  const me = (): { login: string; bot: boolean } => ({ login: pr.viewerLogin, bot: false })

  return {
    async find(_cwd, branch) {
      guard()
      return branch === pr.head ? { number: pr.number, state: pr.state, title: pr.title, url: pr.url } : null
    },
    async view() {
      guard()
      return clone(pr)
    },
    async options() {
      guard()
      return clone(fixture.options)
    },
    async failedLog() {
      guard()
      return fixture.failedLog ?? [
        '✕ products › GET /products/:gtin returns 404 for unknown GTIN',
        'Expected status 404, received 422',
        'at tests/e2e/products.spec.ts:41',
      ].join('\n')
    },
    async branchStates() {
      guard()
      const states = new Map<string, BranchPrState>(Object.entries(fixture.branchStates ?? {}))
      if (!states.has(pr.head)) states.set(pr.head, BRANCH_STATE[pr.state])
      return states
    },
    async act(_cwd, number, a) {
      guard()
      if (o.logFile) appendFileSync(o.logFile, JSON.stringify({ number, action: a }) + '\n')
      switch (a.type) {
        case 'comment':
          pr.timeline.push({ kind: 'comment', at: at(), comment: { id: `IC_${pr.timeline.length}`, databaseId: 9000 + pr.timeline.length, author: me(), body: a.body, createdAt: at() } })
          break
        case 'reply': {
          const t = pr.timeline.flatMap((i) => (i.kind === 'thread' ? [i.thread] : [])).find((th) => th.comments[0]?.databaseId === a.commentId)
          if (!t) throw new Error('GitHub (gh) : fil introuvable')
          t.comments.push({ id: `RC_${a.commentId}_${t.comments.length}`, databaseId: a.commentId * 100 + t.comments.length, author: me(), body: a.body, createdAt: at() })
          break
        }
        case 'resolve': {
          const t = pr.timeline.flatMap((i) => (i.kind === 'thread' ? [i.thread] : [])).find((th) => th.id === a.threadId)
          if (!t) throw new Error('GitHub (gh) : fil introuvable')
          t.resolved = a.resolved
          break
        }
        case 'review':
          pr.timeline.push({ kind: 'review', at: at(), author: me(), state: a.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', body: a.body })
          pr.reviewDecision = a.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED'
          break
        case 'editBody':
          pr.body = a.body
          break
        case 'draft':
          pr.state = a.draft ? 'draft' : 'open'
          break
        case 'close':
          pr.state = 'closed'
          break
        case 'reopen':
          pr.state = 'open'
          break
        case 'reviewers':
          pr.reviewers = pr.reviewers.filter((r) => !a.remove.includes(r.login))
          for (const login of a.add) if (!pr.reviewers.some((r) => r.login === login)) pr.reviewers.push({ login, kind: login.includes('/') ? 'team' : 'user', status: 'pending' })
          break
        case 'assignees':
          pr.assignees = [...pr.assignees.filter((l) => !a.remove.includes(l)), ...a.add.filter((l) => !pr.assignees.includes(l))]
          break
        case 'labels':
          pr.labels = [...pr.labels.filter((l) => !a.remove.includes(l)), ...a.add.filter((l) => !pr.labels.includes(l))]
          break
        case 'viewed': {
          const f = pr.files.find((x) => x.path === a.path)
          if (f) f.viewed = a.viewed
          break
        }
        case 'rerun':
          for (const c of pr.checks) if (c.run && c.run.runId === a.runId && (a.jobId === null ? c.outcome === 'failure' : c.run.jobId === a.jobId)) c.outcome = 'pending'
          break
        case 'updateBranch':
          break
        case 'merge':
          pr.state = 'merged'
          break
        case 'autoMerge':
          pr.autoMerge = a.enable
          break
        case 'revert':
          return { ok: true, url: `https://github.com/${pr.repo.owner}/${pr.repo.name}/pull/999` }
        case 'deleteRemoteBranch':
          break
      }
      return { ok: true }
    },
  }
}

/** `CANOPY_FAKE_GH` (a `pr.json`, with `_LOG` and `_FAIL`) replaces `gh` in an unpackaged app. */
export function selectPrGateway(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): PrGateway {
  const file = o.isPackaged ? undefined : o.env.CANOPY_FAKE_GH
  if (!file) return ghGateway()
  return fakeGateway({ file: resolve(file), logFile: o.env.CANOPY_FAKE_GH_LOG, failFile: o.env.CANOPY_FAKE_GH_FAIL })
}
