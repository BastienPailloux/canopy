import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerPrIpc, parsePrAction, parseCleanupRequest } from '../../../src/main/github/prIpc'
import type { PrAction } from '../../../src/shared/pr'
import type { PrGateway } from '../../../src/main/github/gateway'

const valid: PrAction[] = [
  { type: 'comment', body: 'hi' },
  { type: 'reply', commentId: 12, body: 'hi\n— Claude via Canopy' },
  { type: 'resolve', threadId: 'PRRT_kwDOabc-1', resolved: true },
  { type: 'review', event: 'APPROVE', body: '' },
  { type: 'review', event: 'REQUEST_CHANGES', body: 'no' },
  { type: 'editBody', body: 'new' },
  { type: 'draft', draft: true },
  { type: 'close' }, { type: 'reopen' },
  { type: 'reviewers', add: ['camille-r', 'acme/core', 'copilot', 'dependabot[bot]'], remove: ['theo'] },
  { type: 'assignees', add: ['basti'], remove: [] },
  { type: 'labels', add: ['feature', 'good first issue'], remove: ['api'] },
  { type: 'viewed', path: 'src/routes/products.ts', viewed: true },
  { type: 'rerun', runId: 5, jobId: 7 },
  { type: 'rerun', runId: 5, jobId: null },
  { type: 'updateBranch' },
  { type: 'merge', method: 'squash', subject: 'feat: x (#87)', body: '' },
  { type: 'merge', method: 'rebase', subject: '', body: '' },
  { type: 'autoMerge', enable: true, method: 'merge', subject: 's', body: 'b' },
  { type: 'autoMerge', enable: false, method: 'squash', subject: '', body: '' },
  { type: 'revert' },
  { type: 'deleteRemoteBranch', branch: 'feat/x' },
]

describe('parsePrAction', () => {
  it('accepts each valid action unchanged', () => {
    for (const a of valid) expect(parsePrAction(a)).toEqual(a)
  })

  it('refuses a relative path, a non-integer number, a body over 65536, a login with a space, a label with a newline, a path with ..', () => {
    const bad: unknown[] = [
      { type: 'viewed', path: '/abs/x.ts', viewed: true },
      { type: 'viewed', path: 'a/../b.ts', viewed: true },
      { type: 'viewed', path: '', viewed: true },
      { type: 'reply', commentId: 1.5, body: 'x' },
      { type: 'reply', commentId: 0, body: 'x' },
      { type: 'rerun', runId: -1, jobId: null },
      { type: 'rerun', runId: 1, jobId: 2.5 },
      { type: 'comment', body: 'x'.repeat(65_537) },
      { type: 'comment', body: 5 },
      { type: 'reviewers', add: ['a b'], remove: [] },
      { type: 'assignees', add: [], remove: ['a/b'] },
      { type: 'labels', add: ['a\nb'], remove: [] },
      { type: 'labels', add: [''], remove: [] },
      { type: 'labels', add: ['x'.repeat(51)], remove: [] },
      { type: 'resolve', threadId: 'bad id', resolved: true },
      { type: 'merge', method: 'octopus', subject: 's', body: '' },
      { type: 'merge', method: 'squash', subject: '', body: '' },
      { type: 'autoMerge', enable: true, method: 'merge', subject: '', body: '' },
      { type: 'review', event: 'REQUEST_CHANGES', body: '' },
      { type: 'deleteRemoteBranch', branch: '-x' },
      { type: 'deleteRemoteBranch', branch: '' },
      { type: 'nope' },
      { type: 'close', extra: 1 },
      'close',
      null,
    ]
    for (const b of bad) expect(() => parsePrAction(b), JSON.stringify(b)).toThrow('Action invalide')
  })
})

describe('fixture', () => {
  it('only holds logins the IPC accepts', () => {
    const f = JSON.parse(readFileSync(join(__dirname, '../../fixtures/gh/pr.json'), 'utf8'))
    const logins: string[] = [...f.detail.reviewers.map((r: { login: string }) => r.login), ...f.detail.assignees, ...f.options.assignable, ...f.options.suggested.map((r: { login: string }) => r.login)]
    expect(logins.length).toBeGreaterThan(0)
    for (const l of logins) expect(() => parsePrAction({ type: 'reviewers', add: [l], remove: [] }), l).not.toThrow()
  })
})

describe('registerPrIpc', () => {
  const setup = (branch: string | null = 'feat/x') => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const calls: unknown[][] = []
    const changed: string[] = []
    const gateway: PrGateway = {
      find: async (cwd, b) => { calls.push(['find', cwd, b]); return null },
      view: async () => { throw new Error('x') },
      options: async () => ({ labels: [], assignable: [], suggested: [] }),
      failedLog: async (cwd, r, j) => { calls.push(['log', cwd, r, j]); return 'l' },
      branchStates: async () => null,
      act: async (cwd, n, a) => { calls.push(['act', cwd, n, a]); return { ok: true } },
    }
    const watched: unknown[][] = []
    const autoMerges = { watch: (cwd: string, e: unknown) => { watched.push([cwd, e]) } }
    registerPrIpc({
      handle: (n, f) => { handlers.set(n, f) }, gateway, currentBranch: async () => branch, onPrStateChanged: (cwd) => { changed.push(cwd) },
      store: {} as never, trusted: async () => false, autoMerges
    })
    return { call: (n: string, ...a: unknown[]) => handlers.get(n)!(...a), calls, changed, watched }
  }

  it('finds by the current branch, null when detached', async () => {
    const s = setup()
    await s.call('pr:find', '/r')
    expect(s.calls[0]).toEqual(['find', '/r', 'feat/x'])
    const d = setup(null)
    expect(await d.call('pr:find', '/r')).toBeNull()
  })

  it('refuses a relative cwd and a bad number', async () => {
    const s = setup()
    await expect(s.call('pr:find', 'rel')).rejects.toThrow('Chemin invalide')
    expect(() => s.call('pr:view', '/r', 1.5)).toThrow('Numéro de PR invalide')
    expect(() => s.call('pr:failedLog', '/r', 1, 0)).toThrow('invalide')
  })

  it('notifies after merge, close and reopen only', async () => {
    const s = setup()
    await s.call('pr:act', '/r', 3, { type: 'comment', body: 'x' })
    expect(s.changed).toEqual([])
    await s.call('pr:act', '/r', 3, { type: 'close' })
    await s.call('pr:act', '/r', 3, { type: 'reopen' })
    await s.call('pr:act', '/r', 3, { type: 'merge', method: 'squash', subject: 's', body: '' })
    expect(s.changed).toEqual(['/r', '/r', '/r'])
  })
})

describe('cleanup IPC', () => {
  const oid = 'a'.repeat(40)
  const req = { number: 87, branch: 'feat/x', headOid: oid }

  it('parses a cleanup request and refuses anything off', () => {
    expect(parseCleanupRequest(req)).toEqual(req)
    expect(parseCleanupRequest({ ...req, headOid: 'b'.repeat(64) })).toEqual({ ...req, headOid: 'b'.repeat(64) })
    const bad: unknown[] = [
      null, { ...req, number: 0 }, { ...req, branch: '-x' }, { ...req, branch: '' }, { ...req, headOid: 'HEAD' },
      { ...req, headOid: 'A'.repeat(40) }, { ...req, extra: 1 }, { number: 1, branch: 'b' },
    ]
    for (const b of bad) expect(() => parseCleanupRequest(b), JSON.stringify(b)).toThrow('Demande de nettoyage invalide')
  })
})

describe('registerPrIpc cleanup handlers', () => {
  const setup = () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const watched: unknown[][] = []
    const gateway = { act: async () => { throw new Error('must not run') } } as unknown as PrGateway
    registerPrIpc({
      handle: (n, f) => { handlers.set(n, f) }, gateway, currentBranch: async () => null, onPrStateChanged: () => {},
      store: {} as never, trusted: async () => false,
      autoMerges: { watch: (cwd, e) => { watched.push([cwd, e]) } }
    })
    return { call: async (n: string, ...a: unknown[]) => handlers.get(n)!(...a), watched }
  }
  const req = { number: 87, branch: 'feat/x', headOid: 'a'.repeat(40) }

  it('refuses a relative path or a bad request before touching git', async () => {
    const s = setup()
    await expect(s.call('pr:cleanup', 'rel', req)).rejects.toThrow('Chemin invalide')
    await expect(s.call('pr:cleanup', '/r', { ...req, headOid: 'x' })).rejects.toThrow('invalide')
    await expect(s.call('pr:deleteLocalBranch', '/r', '-D')).rejects.toThrow('invalide')
    await expect(s.call('pr:deleteLocalBranch', 'rel', 'feat/x')).rejects.toThrow('Chemin invalide')
  })

  it('watches an auto-merge with its box, and stops with null', async () => {
    const s = setup()
    await s.call('pr:watchAutoMerge', '/r', { ...req, cleanup: true })
    await s.call('pr:watchAutoMerge', '/r', null)
    expect(s.watched).toEqual([['/r', { ...req, cleanup: true }], ['/r', null]])
    await expect(s.call('pr:watchAutoMerge', '/r', { ...req, cleanup: 'yes' })).rejects.toThrow('invalide')
    await expect(s.call('pr:watchAutoMerge', '/r', req)).rejects.toThrow('invalide')
  })
})
