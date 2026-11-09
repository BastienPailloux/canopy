import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { listDepsRepos, registerDepsIpc } from '../../../src/main/deps/depsIpc'
import { createDepsService, type DepsService } from '../../../src/main/deps/service'
import { TicketStore } from '../../../src/main/tickets/store'
import type { DepsReport } from '../../../src/shared/deps'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { execFileSync } from 'node:child_process'

let repo: TestRepo
let root: string
let store: AppStore
let service: DepsService
let handlers: Map<string, (...args: unknown[]) => unknown>
let hooks: ReturnType<typeof registerDepsIpc>
let check: ReturnType<typeof vi.fn<(r: string, p: DepsReport | null) => Promise<DepsReport>>>
let events: string[]

const reportOf = (path: string): DepsReport => ({ repo: path, checkedAt: 1, units: [], entries: [], errors: [] } as unknown as DepsReport)
const call = (name: string, ...args: unknown[]): Promise<unknown> => {
  const fn = handlers.get(`deps:${name}`)
  if (!fn) throw new Error(`no handler deps:${name}`)
  return Promise.resolve().then(() => fn(...args))
}

beforeEach(async () => {
  repo = await createRepo({ dirName: 'app' })
  root = await realpath(repo.path)
  const dir = await mkdtemp(join(tmpdir(), 'canopy-deps-ipc-'))
  store = new AppStore(join(dir, 'state.json'))
  store.addRecentRepo(root)
  events = []
  check = vi.fn(async (r: string) => reportOf(r))
  service = createDepsService({
    check, repos: () => listDepsRepos(store.recentRepos), file: join(dir, 'deps.json'), now: () => 1,
    setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: (() => undefined) as typeof clearInterval,
    broadcast: (e) => { events.push(e) }, log: () => undefined
  })
  handlers = new Map()
  hooks = registerDepsIpc({
    handle: (name, fn) => { handlers.set(name, fn) }, service, store,
    launch: { tickets: new TicketStore(), store, activity: () => 'idle', sessions: () => 0, trusted: async () => false }
  })
})
afterEach(async () => { await repo.cleanup() })

describe('deps ipc', () => {
  it.each(['report', 'recheck', 'banner', 'dismissBanner', 'critical', 'launch'])('refuses a relative path for %s', async (name) => {
    await expect(call(name, 'relative/path', { branch: 'x', target: { kind: 'new', base: 'main' } })).rejects.toThrow('Chemin invalide')
    await expect(call(name, 42)).rejects.toThrow('Chemin invalide')
  })

  it('refuses a relative except', async () => {
    await expect(call('critical', root, 'rel')).rejects.toThrow('Chemin invalide')
  })

  it('answers a worktree with the report of the main checkout', async () => {
    await service.recheck(root)
    const wt = join(root, '.worktrees', 'wt')
    execFileSync('git', ['worktree', 'add', '-b', 'wt', wt], { cwd: root })
    expect(await call('report', wt)).toMatchObject({ repo: root })
  })

  it('launches a branch in a new worktree', async () => {
    const res = await call('launch', root, { branch: 'fix/deps', target: { kind: 'new', base: 'main' } }) as { worktree: string }
    expect(res.worktree).toContain('fix-deps')
    expect(execFileSync('git', ['branch', '--list', 'fix/deps'], { cwd: root, encoding: 'utf8' })).toContain('fix/deps')
  })

  it('refuses an invalid branch name', async () => {
    await expect(call('launch', root, { branch: 'bad name', target: { kind: 'new', base: 'main' } })).rejects.toThrow('Nom de branche invalide : "bad name"')
  })

  it('refuses a malformed launch request', async () => {
    await expect(call('launch', root, { branch: 'x', target: { kind: 'other', base: 'main' } })).rejects.toThrow('Cible invalide')
    await expect(call('launch', root, null)).rejects.toThrow('Lancement invalide')
  })

  it('lists a folder of repos as the repos it holds', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'canopy-deps-folder-'))
    await mkdir(join(folder, 'a'))
    execFileSync('git', ['init', '-q', join(folder, 'a')])
    const list = await listDepsRepos([root, folder, '/nonexistent/x'])
    expect(list[0]).toEqual({ entry: root, repos: [root] })
    expect(list[1].repos.map((r) => r.endsWith('/a'))).toEqual([true])
    expect(list[2]).toEqual({ entry: '/nonexistent/x', repos: [] })
  })

  it('rechecks every repo on demand and when a recent repo is added', async () => {
    await hooks.recheckAll()
    expect(check).toHaveBeenCalledTimes(1)
    const other = await createRepo({ dirName: 'other' })
    store.addRecentRepo(await realpath(other.path))
    await hooks.onRecentReposChanged()
    expect(check.mock.calls.map((c) => c[0])).toContain(await realpath(other.path))
    expect(check).toHaveBeenCalledTimes(2)
    await other.cleanup()
  })
})
