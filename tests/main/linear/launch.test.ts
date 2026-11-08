import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { LinearClient, type McpCaller } from '../../../src/main/linear/client'
import { launchLinear } from '../../../src/main/linear/launch'
import type { LaunchDeps } from '../../../src/main/tickets/launch'
import { TicketStore } from '../../../src/main/tickets/store'
import { fakeLinear, type FakeLinear } from '../../helpers/fakeLinear'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { linearLaunchPrompt, type PendingEdit } from '../../../src/shared/linear'

let repo: TestRepo
let store: AppStore
let fake: FakeLinear
let linear: LinearClient
let deps: LaunchDeps & { linear: LinearClient; edits: { pending: () => PendingEdit[] } }
let pending: PendingEdit[]

beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  const dir = await mkdtemp(join(tmpdir(), 'canopy-linear-launch-'))
  store = new AppStore(join(dir, 'state.json'))
  fake = fakeLinear()
  pending = []
  linear = new LinearClient(vi.fn(async (): Promise<McpCaller> => fake), { saveLinearAuth: () => undefined })
  await linear.connect()
  deps = {
    tickets: new TicketStore(), store, linear, edits: { pending: () => pending },
    activity: () => 'idle', sessions: () => 0, trusted: async () => false
  }
})
afterEach(() => repo.cleanup())

const branches = (): string[] =>
  execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo.path }).toString().split('\n').filter(Boolean)

describe('launchLinear', () => {
  it('linear launch links branch and issue', async () => {
    const { worktree, issue } = await launchLinear(deps, repo.path, { id: 'CAN-1', branch: 'feat/can-1', target: { kind: 'new', base: 'main' } })
    expect(issue.id).toBe('CAN-1')
    expect(store.linearLinks(repo.path)).toEqual({ 'CAN-1': { branch: 'feat/can-1', worktree, base: 'main' } })
    expect(branches()).toContain('feat/can-1')
    expect(fake.calls.map((c) => c.name)).not.toContain('save_issue')
    expect(fake.calls.map((c) => c.name)).not.toContain('save_comment')
  })

  it("the prompt takes Bastien's queued title and description over Linear's, and writes nothing to Linear", async () => {
    const linearText = (await linear.issueBrief('CAN-1')).description
    pending = [{
      id: 'CAN-1', change: { title: 'Mon titre en attente', description: { base: linearText, text: 'Ma description en attente' } },
      error: 'Linear injoignable', held: {}, uncertain: false,
    }, { id: 'CAN-2', change: { title: 'Autre ticket' }, error: '', held: {}, uncertain: false }]
    const { issue } = await launchLinear(deps, repo.path, { id: 'CAN-1', branch: 'feat/can-1', target: { kind: 'new', base: 'main' } })
    const prompt = linearLaunchPrompt(issue)
    expect(prompt).toContain('Mon titre en attente')
    expect(prompt).toContain('Ma description en attente')
    if (linearText.trim() !== '') expect(prompt).not.toContain(linearText.trim())
    expect(fake.calls.map((c) => c.name)).not.toContain('save_issue')
  })

  it('failed linear launch stores no link', async () => {
    execFileSync('git', ['branch', 'feat/can-1'], { cwd: repo.path })
    await expect(launchLinear(deps, repo.path, { id: 'CAN-1', branch: 'feat/can-1', target: { kind: 'new', base: 'main' } })).rejects.toThrow()
    expect(store.linearLinks(repo.path)).toEqual({})
  })

  it('rejects a bad id and an unknown issue before any git work', async () => {
    await expect(launchLinear(deps, repo.path, { id: 'nope', branch: 'feat/x', target: { kind: 'new', base: 'main' } })).rejects.toThrow()
    await expect(launchLinear(deps, repo.path, { id: 'CAN-999', branch: 'feat/y', target: { kind: 'new', base: 'main' } })).rejects.toThrow()
    expect(branches()).not.toContain('feat/x')
    expect(branches()).not.toContain('feat/y')
    expect(store.linearLinks(repo.path)).toEqual({})
  })

  it('relaunch replaces the link', async () => {
    await launchLinear(deps, repo.path, { id: 'CAN-1', branch: 'feat/a', target: { kind: 'new', base: 'main' } })
    const second = await launchLinear(deps, repo.path, { id: 'CAN-1', branch: 'feat/b', target: { kind: 'new', base: 'main' } })
    expect(store.linearLinks(repo.path)).toEqual({ 'CAN-1': { branch: 'feat/b', worktree: second.worktree, base: 'main' } })
  })
})
