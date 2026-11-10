import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { cleanupAfterMerge, deleteMergedBranch, deleteLocalAfterMerge, updateBase } from '../../../src/main/github/cleanup'
import type { PrGateway } from '../../../src/main/github/gateway'
import type { BranchPrState } from '../../../src/main/git/pr'
import type { PrAction, PrDetail, PrState, PrSummary } from '../../../src/shared/pr'
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
/** What GitHub says of PR 87; `ghHead` null: the PR's head as committed in beforeEach. */
let ghState: PrState
let ghHead: string | null
let trusted: boolean
/** The latest PR of feat/x as `find` returns it; null: #87 in `ghState`. */
let latest: PrSummary | null
/** The remote tip of feat/x; null: the merged head. An Error: unreadable. */
let remoteTip: string | Error | null
/** The latest PR of other branches as `find` returns it. */
let finds: Map<string, PrSummary>

const gateway = (): PrGateway => ({
  find: async (_cwd, b) => (b === 'feat/x' ? latest ?? { number: 87, state: ghState, title: 't', url: 'u' } : finds.get(b) ?? null),
  remoteTip: async () => {
    if (remoteTip instanceof Error) throw remoteTip
    return remoteTip ?? ghHead ?? headOid
  },
  view: async (_cwd, n) => ({ number: n, state: ghState, head: 'feat/x', headOid: ghHead ?? headOid } as PrDetail),
  options: async () => ({ labels: [], assignable: [], suggested: [] }),
  failedLog: async () => '',
  branchStates: async () => states,
  act: async (_cwd, _n, a) => {
    acts.push(a)
    if (remoteFails && a.type === 'deleteRemoteBranch') throw new Error('GitHub (gh) : Reference update failed (protected)')
    return { ok: true }
  },
})
const deps = () => ({ gateway: gateway(), store, trusted })
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
  ghState = 'merged'
  ghHead = null
  trusted = false
  latest = null
  remoteTip = null
  finds = new Map()
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
    trusted = true
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

describe('cleanupAfterMerge remote branch', () => {
  it('a remote branch that received commits after the merge is kept', async () => {
    store.recordBranch(wt, 'feat/x')
    remoteTip = 'a'.repeat(40)
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'proposeRemoval', steps: [{ step: 'remote', ok: false, message: 'Branche distante conservée : elle a reçu des commits après le merge' }] })
    expect(acts).toEqual([])
  })

  it('an unreadable remote tip keeps the branch', async () => {
    store.recordBranch(wt, 'feat/x')
    remoteTip = new Error('GitHub (gh) : hors ligne')
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'proposeRemoval', steps: [{ step: 'remote', ok: false }] })
    expect(acts).toEqual([])
  })

  it('a remote branch at the merged head is deleted', async () => {
    store.recordBranch(wt, 'feat/x')
    await cleanupAfterMerge(wt, req(), deps())
    expect(acts).toEqual([{ type: 'deleteRemoteBranch', branch: 'feat/x' }])
  })
})

describe('cleanupAfterMerge next branch', () => {
  it('a branch beyond the listed PRs is looked up on its own: merged, it is not chosen', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    await git(repo.path, ['branch', 'feat/old', 'main'])
    for (const b of ['feat/y', 'feat/old', 'feat/x']) store.recordBranch(wt, b)
    // feat/old's PR is older than the 200 the repo-wide list returns
    states = new Map<string, BranchPrState>([['feat/y', 'open'], ['feat/x', 'merged']])
    finds.set('feat/old', { number: 3, state: 'merged', title: 't', url: 'u' })
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'feat/y' })
  })

  it('a branch with no PR at all stays in progress', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    await git(repo.path, ['branch', 'feat/new', 'main'])
    for (const b of ['feat/y', 'feat/new', 'feat/x']) store.recordBranch(wt, b)
    states = new Map<string, BranchPrState>([['feat/y', 'open'], ['feat/x', 'merged']])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'feat/new' })
  })
})

describe('cleanupAfterMerge checks', () => {
  it('PR still open → nothing touched', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    ghState = 'open'
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'failed', steps: [{ step: 'check', ok: false, message: "La PR #87 n'est pas mergée : rien n'a été nettoyé" }] })
    expect(acts).toEqual([])
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('a PR whose head is another branch → nothing touched', async () => {
    const out = await cleanupAfterMerge(wt, { ...req(), branch: 'feat/other' }, deps())
    expect(out).toMatchObject({ kind: 'failed', steps: [{ step: 'check', ok: false }] })
    expect(acts).toEqual([])
  })

  it('the merged head from GitHub is used for the local deletion', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    // the renderer says some other commit: GitHub's head decides
    const out = await cleanupAfterMerge(wt, { ...req(), headOid: 'f'.repeat(40) }, deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'feat/y' })
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })

  it('a local tip GitHub never merged is kept, whatever the renderer says', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    ghHead = await git(wt, ['rev-parse', 'HEAD~1'])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toMatchObject({ kind: 'switched' })
    if (out.kind === 'switched') expect(out.steps.at(-1)).toEqual({ step: 'local', ok: false, message: 'La branche locale a des commits absents de la PR : conservée' })
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('changes Canopy set aside for the branch count as uncommitted', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    await writeFile(join(wt, 'x.txt'), 'changed\n')
    await git(wt, ['stash', 'push', '-q', '-m', 'canopy:feat/x'])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'dirty', files: 0, setAside: true })
    expect(acts).toEqual([])
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('an old merged PR of a reused branch is not the latest one → nothing touched', async () => {
    await git(repo.path, ['branch', 'feat/y', 'main'])
    for (const b of ['feat/y', 'feat/x']) store.recordBranch(wt, b)
    // #80 merged long ago; the branch was reused for #87, still open
    latest = { number: 87, state: 'open', title: 't', url: 'u' }
    const out = await cleanupAfterMerge(wt, { ...req(), number: 80 }, deps())
    expect(out).toMatchObject({ kind: 'failed', steps: [{ step: 'check', ok: false }] })
    expect(acts).toEqual([])
    expect(await git(wt, ['branch', '--show-current'])).toBe('feat/x')
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('work set aside for the merged branch blocks even once the worktree left it', async () => {
    await writeFile(join(wt, 'x.txt'), 'changed\n')
    await git(wt, ['stash', 'push', '-q', '-m', 'canopy:feat/x'])
    await git(wt, ['switch', '-q', '-c', 'feat/y', 'main'])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'dirty', files: 0, setAside: true })
    expect(acts).toEqual([])
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('work set aside for another branch does not block', async () => {
    await git(wt, ['switch', '-q', '-c', 'feat/y', 'main'])
    await writeFile(join(wt, 'README.md'), 'changed\n')
    await git(wt, ['stash', 'push', '-q', '-m', 'canopy:feat/y'])
    const out = await cleanupAfterMerge(wt, req(), deps())
    expect(out).toEqual({ kind: 'switched', branch: 'feat/y', steps: [{ step: 'remote', ok: true }, { step: 'local', ok: true }] })
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })

  it('an untrusted main checkout switches to the base but does not update it', async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    await git(repo.path, ['branch', '-D', 'feat/x'])
    await commit(repo.path, 'upstream.txt')
    await git(repo.path, ['push', '-q', 'origin', 'main'])
    await git(repo.path, ['reset', '-q', '--hard', 'HEAD~1'])
    const before = await git(repo.path, ['rev-parse', 'HEAD'])
    await git(repo.path, ['switch', '-q', '-c', 'feat/x'])
    headOid = await commit(repo.path, 'x.txt')
    const out = await cleanupAfterMerge(repo.path, req(), deps())
    expect(out).toEqual({
      kind: 'switched', branch: 'main',
      steps: [
        { step: 'remote', ok: true }, { step: 'switch', ok: true },
        { step: 'update', ok: false, message: "Base non mise à jour : la configuration du dépôt n'est pas approuvée" },
        { step: 'local', ok: true }
      ]
    })
    expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('the main checkout reached through a symlink is never proposed for removal', async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    await git(repo.path, ['branch', '-D', 'feat/x'])
    await git(repo.path, ['switch', '-q', '-c', 'feat/x'])
    headOid = await commit(repo.path, 'x.txt')
    const link = join(dirname(repo.path), 'link')
    await symlink(repo.path, link)
    const out = await cleanupAfterMerge(link, req(), deps())
    expect(out).toMatchObject({ kind: 'switched', branch: 'main' })
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

describe('deleteLocalAfterMerge', () => {
  it('asks GitHub: an open PR keeps the branch', async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    ghState = 'open'
    expect(await deleteLocalAfterMerge(gateway(), repo.path, 'feat/x')).toEqual({ step: 'local', ok: false, message: "La PR de cette branche n'est pas mergée : branche conservée" })
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it('keeps a branch with work set aside for it', async () => {
    await writeFile(join(wt, 'x.txt'), 'changed\n')
    await git(wt, ['stash', 'push', '-q', '-m', 'canopy:feat/x'])
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    expect(await deleteLocalAfterMerge(gateway(), repo.path, 'feat/x')).toMatchObject({ step: 'local', ok: false })
    expect(await branchExists(repo.path, 'feat/x')).toBe(true)
  })

  it("deletes at GitHub's merged head", async () => {
    await git(repo.path, ['worktree', 'remove', '--force', wt])
    expect(await deleteLocalAfterMerge(gateway(), repo.path, 'feat/x')).toEqual({ step: 'local', ok: true })
    expect(await branchExists(repo.path, 'feat/x')).toBe(false)
  })
})

describe('updateBase', () => {
  it('refuses a remote name that could pass for a flag', async () => {
    expect(await updateBase(repo.path, '-x/main', true)).toMatchObject({ step: 'update', ok: false })
    expect(await updateBase(repo.path, '/main', true)).toMatchObject({ step: 'update', ok: false })
  })
})
