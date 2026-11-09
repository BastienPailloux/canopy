import { describe, expect, it } from 'vitest'
import { registerPrIpc, parsePrAction } from '../../../src/main/github/prIpc'
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
    registerPrIpc({ handle: (n, f) => { handlers.set(n, f) }, gateway, currentBranch: async () => branch, onPrStateChanged: (cwd) => { changed.push(cwd) } })
    return { call: (n: string, ...a: unknown[]) => handlers.get(n)!(...a), calls, changed }
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
