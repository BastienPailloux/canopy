import { describe, expect, it, vi, type Mock } from 'vitest'
import { readFileSync } from 'node:fs'
import type { CleanupOutcome, PrDetail } from '../../src/shared/pr'
import { mergeThenFinish, runAfterMerge, type AfterMergeDeps } from '../../src/renderer/pr/afterMerge'

const pr = (): PrDetail => ({ ...(JSON.parse(readFileSync('tests/fixtures/gh/pr.json', 'utf8')) as { detail: PrDetail }).detail, state: 'merged' })

type Fn = Mock<(...args: any[]) => any>
type Mocked = { api: Record<keyof AfterMergeDeps['api'], Fn>; confirmRemoval: Fn }

function deps(outcome: CleanupOutcome, removed = true): Mocked {
  return {
    api: {
      linearIssue: vi.fn(async () => ({ id: 'CAN-5', status: { id: null, name: 'In Review', type: 'started' }, team: { id: 'team-1', name: 'Canopy' } })),
      linearTeamOptions: vi.fn(async () => ({
        statuses: [
          { id: 's-todo', name: 'Todo', type: 'unstarted' },
          { id: 's-done', name: 'Done', type: 'completed' },
          { id: 's-shipped', name: 'Shipped', type: 'completed' }
        ],
        labels: [], users: []
      })),
      linearSave: vi.fn(async () => ({ kind: 'sent', issue: {} })),
      patchTicket: vi.fn(async () => ({})),
      prCleanup: vi.fn(async () => outcome),
      prDeleteLocalBranch: vi.fn(async () => ({ step: 'local', ok: true }))
    },
    confirmRemoval: vi.fn(async () => removed)
  }
}

const base = { cwd: '/repo/.worktrees/gtin', repo: '/repo', isMain: false }

describe('runAfterMerge', () => {
  it('marks the Linear ticket done with the team\'s completed status', async () => {
    const d = deps({ kind: 'switched', branch: 'feat/other', steps: [{ step: 'remote', ok: true }, { step: 'switch', ok: true }, { step: 'local', ok: true }] })
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: { source: 'linear', id: 'CAN-5' } }, d)
    expect(d.api.linearTeamOptions).toHaveBeenCalledWith('team-1')
    // Only the status: never a description.
    expect(d.api.linearSave).toHaveBeenCalledWith('CAN-5', { statusId: 's-done' })
    expect(lines).toContain('CAN-5 passé en Done')
    expect(lines).toContain('Worktree basculé sur feat/other')
    expect(d.api.prCleanup).toHaveBeenCalledWith(base.cwd, { number: 87, branch: 'feat/gtin-lookup', headOid: pr().headOid })
  })

  it('marks a local ticket done through its file', async () => {
    const d = deps({ kind: 'switched', branch: 'feat/other', steps: [] })
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: false, ticket: { source: 'local', id: 'T-3', title: 'x' } }, d)
    expect(d.api.patchTicket).toHaveBeenCalledWith('/repo', 'T-3', { status: 'done' })
    expect(lines).toContain('T-3 passé en Done')
  })

  it('skips cleanup when the box is unchecked', async () => {
    const d = deps({ kind: 'proposeRemoval', steps: [] })
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: false, ticket: null }, d)
    expect(d.api.prCleanup).not.toHaveBeenCalled()
    expect(d.confirmRemoval).not.toHaveBeenCalled()
    expect(d.api.prDeleteLocalBranch).not.toHaveBeenCalled()
    expect(lines).toEqual(['Branche et worktree conservés'])
  })

  it('opens removal on proposeRemoval and deletes the local branch after', async () => {
    const d = deps({ kind: 'proposeRemoval', steps: [{ step: 'remote', ok: true }] })
    const order: string[] = []
    d.confirmRemoval.mockImplementation(async () => { order.push('removal'); return true })
    d.api.prDeleteLocalBranch.mockImplementation(async () => { order.push('local'); return { step: 'local', ok: true } })
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: null }, d)
    expect(d.confirmRemoval).toHaveBeenCalledWith('/repo', base.cwd)
    expect(d.api.prDeleteLocalBranch).toHaveBeenCalledWith('/repo', 'feat/gtin-lookup')
    expect(order).toEqual(['removal', 'local'])
    expect(lines).toEqual(['Branche distante supprimée', 'Worktree supprimé', 'Branche locale supprimée'])
  })

  it('a cancelled removal keeps the local branch', async () => {
    const d = deps({ kind: 'proposeRemoval', steps: [{ step: 'remote', ok: true }] }, false)
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: null }, d)
    expect(d.api.prDeleteLocalBranch).not.toHaveBeenCalled()
    expect(lines).toContain('Worktree et branche locale conservés')
  })

  it('never offers to remove the main checkout', async () => {
    const d = deps({ kind: 'proposeRemoval', steps: [] })
    await runAfterMerge({ ...base, isMain: true, pr: pr(), cleanup: true, ticket: null }, d)
    expect(d.confirmRemoval).not.toHaveBeenCalled()
    expect(d.api.prDeleteLocalBranch).not.toHaveBeenCalled()
  })

  it('reports uncommitted files and does nothing else', async () => {
    const d = deps({ kind: 'dirty', files: 2 })
    expect(await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: null }, d)).toEqual(['2 fichiers non commités : nettoyage local non fait'])
    const one = deps({ kind: 'dirty', files: 1 })
    expect(await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: null }, one)).toEqual(['1 fichier non commité : nettoyage local non fait'])
    const aside = deps({ kind: 'dirty', files: 0, setAside: true })
    expect(await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: null }, aside))
      .toEqual(['Des modifications mises de côté pour cette branche attendent : nettoyage local non fait'])
    expect(d.confirmRemoval).not.toHaveBeenCalled()
  })

  it('lists each failed step with its message, and a ticket failure does not stop the cleanup', async () => {
    const d = deps({ kind: 'failed', steps: [{ step: 'remote', ok: false, message: 'protégée' }, { step: 'switch', ok: false, message: 'conflit' }] })
    d.api.linearIssue.mockRejectedValue(new Error('Linear hors ligne'))
    const lines = await runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: { source: 'linear', id: 'CAN-5' } }, d)
    expect(lines).toEqual(['CAN-5 non passé en Done : Linear hors ligne', 'Branche distante conservée : protégée', 'Bascule impossible : conflit'])
    expect(d.api.prCleanup).toHaveBeenCalled()
  })
})

describe('mergeThenFinish', () => {
  it('a merge GitHub only queued finishes nothing: ticket untouched, no cleanup', async () => {
    const d = deps({ kind: 'switched', branch: 'feat/other', steps: [] })
    const finish = vi.fn(() => runAfterMerge({ ...base, pr: pr(), cleanup: true, ticket: { source: 'linear', id: 'CAN-5' } }, d).then(() => undefined))
    // gh exited 0, the refreshed PR is still open: a merge queue holds it.
    expect(await mergeThenFinish({ merge: async () => true, state: () => 'open', finish })).toBe('queued')
    expect(finish).not.toHaveBeenCalled()
    expect(d.api.linearSave).not.toHaveBeenCalled()
    expect(d.api.prCleanup).not.toHaveBeenCalled()
  })

  it('finishes once the refreshed PR is merged, never after a failed merge', async () => {
    const finish = vi.fn(async () => undefined)
    expect(await mergeThenFinish({ merge: async () => false, state: () => 'merged', finish })).toBe('failed')
    expect(finish).not.toHaveBeenCalled()
    expect(await mergeThenFinish({ merge: async () => true, state: () => 'merged', finish })).toBe('merged')
    expect(finish).toHaveBeenCalledOnce()
  })
})
