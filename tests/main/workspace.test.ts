import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findRepos, parseRepoBase, resolveOpenedFolder, scanWorkspace } from '../../src/main/workspace'

vi.mock('../../src/main/git/worktrees', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/git/worktrees')>()
  return {
    ...orig,
    listWorktrees: (repo: string) =>
      repo.endsWith('broken-list') ? Promise.reject(new Error('worktree list failed')) : orig.listWorktrees(repo)
  }
})

const run = promisify(execFile)
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd: string, args: string[]): Promise<unknown> => run('git', args, { cwd, env: ENV })

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'canopy-ws-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function mkRepo(rel: string, commit = false): Promise<string> {
  const p = join(root, rel)
  await mkdir(p, { recursive: true })
  await git(p, ['init', '-q', '-b', 'main'])
  if (commit) await git(p, ['commit', '-q', '--allow-empty', '-m', 'init'])
  return p
}

describe('findRepos', () => {
  it('finds repos up to depth 6', async () => {
    const a = await mkRepo('a')
    const b = await mkRepo('x/b')
    const c = await mkRepo('1/2/3/4/c')
    await mkRepo('1/2/3/4/5/6/d')
    const { repos, truncated } = await findRepos(root)
    expect([...repos].sort()).toEqual([a, b, c].sort())
    expect(truncated).toBe(false)
  })

  it('finds a repo at depth 6', async () => {
    const d = await mkRepo('1/2/3/4/5/d')
    expect((await findRepos(root)).repos).toEqual([d])
  })

  it('skips ignored and hidden folders', async () => {
    await mkRepo('node_modules/x')
    await mkRepo('dist/x')
    await mkRepo('vendor/x')
    await mkRepo('build/x')
    await mkRepo('.cache/x')
    expect((await findRepos(root)).repos).toEqual([])
  })

  it('does not descend into a found repo', async () => {
    const a = await mkRepo('a')
    await mkRepo('a/inner')
    expect((await findRepos(root)).repos).toEqual([a])
  })

  it('survives a symlink loop', async () => {
    const r = await mkRepo('r')
    await mkdir(join(root, 'a'))
    await symlink('..', join(root, 'a', 'b'))
    expect((await findRepos(root)).repos).toEqual([r])
  })

  it('stops at the repo limit', async () => {
    const names = Array.from({ length: 201 }, (_, i) => `r${i}`)
    for (let i = 0; i < names.length; i += 20) await Promise.all(names.slice(i, i + 20).map((n) => mkRepo(n)))
    const { repos, truncated } = await findRepos(root)
    expect(repos).toHaveLength(200)
    expect(truncated).toBe(true)
  }, 60000)

  it('reports a linked worktree under .worktrees as its main repo only', async () => {
    const foxy = await mkRepo('foxy-app')
    const api = await mkRepo('foxy-app/api', true)
    await git(api, ['worktree', 'add', '-q', '-b', 'f', join(foxy, '.worktrees', 'f', 'api')])
    const { repos } = await findRepos(foxy)
    expect([...repos].sort()).toEqual([api, foxy].sort())
  })
})

describe('scanWorkspace', () => {
  it('groups feature and other worktrees of a nested repo', async () => {
    const api = await mkRepo('api', true)
    await git(api, ['worktree', 'add', '-q', '-b', 'f', join(root, '.worktrees', 'f', 'api')])
    await git(api, ['worktree', 'add', '-q', '-b', 'x', join(root, 'api-wt-x')])
    const ws = await scanWorkspace(root)
    const got = ws.entries.map((e) => `${e.group}:${e.feature ?? ''}`).sort()
    expect(got).toEqual(['feature:f', 'main:', 'other:'])
    expect(ws.entries.filter((e) => e.repo === api)).toHaveLength(3)
  })

  it('puts the root repo in the space group when repos are nested', async () => {
    const foxy = await mkRepo('', true)
    const api = await mkRepo('api', true)
    const ws = await scanWorkspace(root)
    const by = Object.fromEntries(ws.entries.map((e) => [e.repo, e.group]))
    expect(by).toEqual({ [foxy]: 'space', [api]: 'main' })
  })

  it('treats a root repo without nested repos as a single main entry', async () => {
    const foxy = await mkRepo('', true)
    await git(foxy, ['worktree', 'add', '-q', '-b', 'x', join(foxy, '.worktrees', 'x')])
    const ws = await scanWorkspace(root)
    expect(ws.entries.map((e) => e.group).sort()).toEqual(['main', 'other'])
  })

  it('ignores a repo whose worktrees cannot be listed', async () => {
    await mkRepo('good', true)
    await mkRepo('broken-list', true)
    const ws = await scanWorkspace(root)
    expect(ws.entries.map((e) => e.repoName)).toEqual(['good'])
  })

  it('keeps showing the main repo of a linked worktree that lies outside the folder', async () => {
    const api = await mkRepo('api', true)
    const inside = join(root, 'ws')
    await mkdir(inside)
    await git(api, ['worktree', 'add', '-q', '-b', 'f', join(inside, 'api')])
    const ws = await scanWorkspace(inside)
    expect(ws.entries.map((e) => e.repo)).toEqual([api, api])
  })

  it('returns the real root', async () => {
    await mkRepo('a', true)
    const link = join(tmpdir(), `canopy-ws-link-${Date.now()}`)
    await symlink(root, link)
    try {
      expect((await scanWorkspace(link)).root).toBe(root)
    } finally {
      await rm(link, { force: true })
    }
  })
})

describe('resolveOpenedFolder', () => {
  it('keeps a non-git parent holding repos', async () => {
    await mkRepo('a')
    await mkRepo('b')
    expect(await resolveOpenedFolder(root)).toBe(root)
  })

  it('keeps a parent holding a single repo', async () => {
    await mkRepo('a')
    expect(await resolveOpenedFolder(root)).toBe(root)
  })

  it('keeps a repo holding nested repos', async () => {
    await mkRepo('', true)
    await mkRepo('sub/x')
    expect(await resolveOpenedFolder(root)).toBe(root)
  })

  it('resolves a subfolder of a repo to the repo root', async () => {
    const repo = await mkRepo('r', true)
    await mkdir(join(repo, 'src/deep'), { recursive: true })
    expect(await resolveOpenedFolder(join(repo, 'src/deep'))).toBe(repo)
    expect(await resolveOpenedFolder(repo)).toBe(repo)
  })

  it('rejects an empty folder', async () => {
    await expect(resolveOpenedFolder(root)).rejects.toThrow('Aucun repo git dans ce dossier')
  })
})

describe('parseRepoBase', () => {
  it('takes a branch name, or null to forget', () => {
    expect(parseRepoBase('develop')).toBe('develop')
    expect(parseRepoBase(null)).toBeNull()
  })

  it('rejects anything else, undefined included', () => {
    for (const bad of [undefined, 3, {}, ['develop']]) expect(() => parseRepoBase(bad)).toThrow('Branche invalide')
  })
})

describe('what a scan could not read', () => {
  it('names a repo whose worktrees cannot be listed', async () => {
    const a = await mkRepo('a', true)
    const broken = await mkRepo('broken-list', true)
    const scan = await scanWorkspace(root)
    expect(scan.failed).toEqual([broken])
    expect(scan.entries.map((e) => e.repo)).toEqual([a])
  })

  it('names a folder git cannot read as a repo', async () => {
    const bad = join(root, 'bad')
    await mkdir(bad)
    await writeFile(join(bad, '.git'), 'not a git link\n')
    expect((await scanWorkspace(root)).failed).toEqual([bad])
  })

  it('names a folder it has no right to read', async () => {
    const locked = join(root, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      expect((await scanWorkspace(root)).failed).toEqual([locked])
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('a linked worktree whose repo was deleted is gone, not unread', async () => {
    const a = await mkRepo('a', true)
    await git(a, ['worktree', 'add', '-q', '-b', 'x', join(root, 'left')])
    await rm(a, { recursive: true, force: true })
    expect(await scanWorkspace(root)).toMatchObject({ entries: [], failed: [] })
  })

  it('a clean scan has nothing failed', async () => {
    await mkRepo('a', true)
    expect((await scanWorkspace(root)).failed).toEqual([])
  })

  it('a folder that is gone is an empty scan, not an error', async () => {
    const gone = join(root, 'gone')
    expect(await scanWorkspace(gone)).toEqual({ root: gone, entries: [], truncated: false, failed: [] })
  })
})
