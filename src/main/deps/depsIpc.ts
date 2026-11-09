import { isAbsolute } from 'node:path'
import type { AppStore } from '../appStore'
import { git } from '../git/exec'
import { mainWorktreeRoot } from '../git/worktrees'
import { clearSharedReads } from '../git/sharedReads'
import { startTicketBranch, type LaunchDeps } from '../tickets/launch'
import { parseLaunchTarget } from '../tickets/ticketIpc'
import { findRepos } from '../workspace'
import type { DepsService } from './service'

type Entries = { entry: string; repos: string[] }[]

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isRepo = (dir: string): Promise<boolean> =>
  git(dir, ['rev-parse', '--git-dir']).then(() => true, () => false)

/** The main roots behind each recent entry: the repo itself, or the repos a folder holds. A failing entry holds none. */
export async function listDepsRepos(recent: string[]): Promise<Entries> {
  return Promise.all(recent.map(async (entry) => {
    try {
      if (await isRepo(entry)) return { entry, repos: [await mainWorktreeRoot(entry)] }
      const found = await findRepos(entry)
      return { entry, repos: [...new Set(await Promise.all(found.repos.map((r) => mainWorktreeRoot(r))))] }
    } catch {
      return { entry, repos: [] }
    }
  }))
}

export interface DepsIpcDeps {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => void
  service: DepsService
  store: Pick<AppStore, 'recentRepos'>
  launch: LaunchDeps
}

export interface DepsIpcHooks {
  /** After a recent repo was added: checks the repos nobody checked yet. */
  onRecentReposChanged(): Promise<void>
}

export function registerDepsIpc(d: DepsIpcDeps): DepsIpcHooks {
  const { service } = d
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => { d.handle(`deps:${name}`, fn) }
  const logFailure = (msg: string) => (e: unknown): void => { console.error(msg, e) }
  /** A recent entry stands for its repos, so it is passed as is. */
  const pathArg = async (p: string): Promise<string> => d.store.recentRepos.includes(p) ? p : mainWorktreeRoot(p)

  handle('report', async (repo) => { assertPath(repo); return service.report(await mainWorktreeRoot(repo)) })
  handle('recheck', async (repo) => { assertPath(repo); return service.recheck(await mainWorktreeRoot(repo)) })
  handle('critical', async (path, except) => {
    assertPath(path)
    if (except !== undefined) assertPath(except)
    return service.critical(await pathArg(path), except === undefined ? undefined : await pathArg(except))
  })
  handle('banner', async (repo) => { assertPath(repo); return service.bannerFor(await mainWorktreeRoot(repo)) })
  handle('dismissBanner', async (repo) => { assertPath(repo); service.dismissBanner(await mainWorktreeRoot(repo)) })
  handle('launch', async (repo, req) => {
    assertPath(repo)
    if (!isObject(req)) throw new Error('Lancement invalide')
    if (typeof req.branch !== 'string') throw new Error('Branche invalide')
    const target = parseLaunchTarget(req.target)
    const root = await mainWorktreeRoot(repo)
    try {
      return { worktree: await startTicketBranch(d.launch, root, req.branch, target) }
    } finally {
      clearSharedReads()
    }
  })

  return {
    async onRecentReposChanged() {
      const list = await listDepsRepos(d.store.recentRepos)
      for (const repo of new Set(list.flatMap((e) => e.repos))) {
        if (service.report(repo) === null && !service.checking(repo)) await service.recheck(repo).catch(logFailure(`deps: check failed for ${repo}`))
      }
    }
  }
}
