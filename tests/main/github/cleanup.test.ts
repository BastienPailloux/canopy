import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { cleanupAfterMerge, deleteMergedBranch } from '../../../src/main/github/cleanup'
import type { PrGateway } from '../../../src/main/github/gateway'
import type { BranchPrState } from '../../../src/main/git/pr'
import type { PrAction } from '../../../src/shared/pr'
import { createRepo, type TestRepo } from '../../helpers/repo'

const run = promisify(execFile)
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = async (cwd: string, args: string[]): Promise<string> => (await run('git', args, { cwd, env: ENV })).stdout.trim()
const commit = async (cwd: string, file: string): Promise<string> => {
  await writeFile(join(cwd, file), `${file}\n`)
  await git(cwd, ['add', '--', file])
  await git(cwd, ['commit', '-q', '-m', file])
  return git(cwd, ['rev-parse', 'HEAD'])
}
const branchExists = (cwd: string, b: string): Promise<boolean> =>
  git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true, () => false)

let repo: TestRepo
let wt: string
let headOid: string
let store: AppStore
let storeDir: string
let acts: PrAction[]
let states: Map<string, BranchPrState> | null
let remoteFails: boolean

const gateway = (): PrGateway => ({
  find: async () => null,
  view: async () => { throw new Error('unused') },
  options: async () => ({ labels: [], assignable: [], suggested: [] }),
  failedLog: async () => '',
  branchStates: async () => states,
  act: async (_cwd, _n, a) => {
    acts.push(a)
    if (remoteFails && a.type === 'deleteRemoteBranch') throw new Error('GitHub (gh) : Reference update failed (protected)')
    return { ok: true }
  },
})
const deps = () => ({ gateway: gateway(), store, trusted: false })
const req = () => ({ number: 87, branch: 'feat/x', headOid })

beforeEach(async () => {
  repo = await createRepo({ remote: true })
  wt = join(dirname(repo.path), 'wt')
  await git(repo.path, ['worktree', 'add', '-q', '-b', 'feat/x', wt])
  headOid = await commit(wt, 'x.txt')
  storeDir = await mkdtemp(join(tmpdir(), 'canopy-cleanup-store-'))
  store = new AppStore(join(storeDir, 'state.json'))
  acts = []
  states = new Map()
  remoteFails = false
})
afterEach(async () => {
  await repo.cleanup()
  await rm(storeDir, { recursive: true, force: true })
})

describe('cleanupAfterMerge', () => {
  it('dirty worktree: merge kept, nothing touched locally', async () => {
    await writeFile(join(wt, 'wip.txt'), 'wip\n')
    store.recordBranch(wt, 'feat/y')
    await git(repo.path, ['branch', 'feat/y', 'main'])
    store.recordBranch(wt, 'feat/x')
    expect(await cleanupAfterMerge(wt, req(), deps())).toEqual({ kind: 'dirty', files: 1 })
    expect(acts).toEqual([])
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('switches to the most recent open branch and deletes the merged one', async () => {
    await git(repo.path, ['branch', 'feat/old', 'main'])
    await git(repo.path, ['branch', 'feat/y', 'main'])
    await git(repo.path, ['branch', 'feat/done', 'main'])
    for (const b of ['feat/old', 'feat/y', 'feat/done', 'feat/x']) store.recordBranch(wt, b)
    states = new Map<string, BranchPrState>([['feat/done', 'merged'], ['feat/y', 'open'], ['feat/x', 'merged']])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({
      kind: 'switched', branch: 'feat/y',
      steps: [{ step: 'remote', ok: true }, { step: 'switch', ok: true }, { step: 'local', ok: true }]
    })
    expect(acts).toEqual([{ type: 'deleteRemoteBranch', branch: 'feat/x' }])
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/y')
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
    expect(store.branchHistory(wt).at(-1)).toBe('feat/y')
  })

  it('without gh, a branch counts as in progress, never as merged', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    states = null
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'feat/y' })
  })

  it('proposes removal when no branch is left', async () => {
    store.recordBranch(wt, 'feat/x')
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'proposeRemoval', steps: [{ step: 'remote', ok: true }] })
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('stops after a failed switch, keeps the local branch', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    // A lock left by another git process: git refuses to write the index.
    const gitDir = await git(wt, ['rev-parse', '--absolute-git-dir'])
    await writeFile(join(gitDir, 'index.lock'), '')
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') return
    expect(out.steps[0]).toEqual({ step: 'remote', ok: true })
    expect(out.steps[1]).toMatchObject({ step: 'switch', ok: false })
    expect(out.steps[1].message).toBeTruthy()
    expect(out.steps).toHaveLength(2)
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('keeps a local branch with commits beyond the PR head', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    await commit(wt, 'later.txt')
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({
      kind: 'switched', branch: 'feat/y',
      steps: [
        { step: 'remote', ok: true }, { step: 'switch', ok: true },
        { step: 'local', ok: false, message: 'La branche locale a des commits absents de la PR : conservée' }
      ]
    })
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('main checkout falls back to the base and fast-forwards it', async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    await git(repo.path, ['branch', '-D', 'feat/x'])
    // origin/main moves ahead of the local main
    const ahead = await commit(repo.path, 'upstream.txt')
    await git(repo.path, ['push', '-q', 'origin', 'main'])
    await git(repo.path, ['reset', '-q', '--hard', 'HEAD~1'])
    await git(repo.path, ['switch', '-q', '-c', 'feat/x'])
    headOid = await commit(repo.path, 'x.txt')
    store.recordBranch(repo.path, 'main')
    store.recordBranch(repo.path, 'feat/x')
    const out = await cleanupAfterMerge(repo.path, req(), deps())
    expect(out).toEqual({
      kind: 'switched', branch: 'main',
      steps: [{ step: 'remote', ok: true }, { step: 'switch', ok: true }, { step: 'update', ok: true }, { step: 'local', ok: true }]
    })
    expect(await git(repo.path, ['branch', '--show-current'])).toBe('main')
    expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(ahead)
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })

  it('a protected remote branch is reported, cleanup goes on', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    remoteFails = true
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'feat/y' })
    if (out.kind !== 'switched') return
    expect(out.steps[0]).toEqual({ step: 'remote', ok: false, message: 'GitHub (gh) : Reference update failed (protected)' })
    expect(out.steps.slice(1)).toEqual([{ step: 'switch', ok: true }, { step: 'local', ok: true }])
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })
})

describe('deleteMergedBranch', () => {
  it('never deletes a branch checked out in a worktree', async () => {
    const step = await deleteMergedBranch(repo.path, 'feat/x', headOid)
    expect(step).toMatchObject({ step: 'local', ok: false })
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('deletes the branch once no worktree holds it and its tip is the PR head', async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    expect(await deleteMergedBranch(repo.path, 'feat/x', headOid)).toEqual({ step: 'local', ok: true })
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })
})
