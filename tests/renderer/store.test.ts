import { beforeEach, describe, expect, it } from 'vitest'
import type { Workspace, WorkspaceEntry } from '../../src/shared/types'
import { useApp } from '../../src/renderer/store'

beforeEach(() => { useApp.setState({ view: 'sessions', repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, openError: null, codeRequest: null }) })

describe('openInCode', () => {
  it('carries the column of a definition', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'code', 42, 7)
    expect(useApp.getState().codeRequest).toMatchObject({ line: 42, column: 7 })
  })

  it('carries the line to reveal', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'code', 42)
    expect(useApp.getState().codeRequest).toMatchObject({ path: 'src/a.ts', mode: 'code', line: 42 })
    useApp.getState().openInCode('/wt', 'src/a.ts', 'diff')
    expect(useApp.getState().codeRequest?.line).toBeUndefined()
  })

  it('opens the Code view on a file, and the request is gone once consumed', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'diff')
    const { codeRequest, view, worktree } = useApp.getState()
    expect(view).toBe('code')
    expect(worktree).toBe('/wt')
    expect(codeRequest).toMatchObject({ cwd: '/wt', path: 'src/a.ts', mode: 'diff' })

    useApp.getState().clearCodeRequest(codeRequest!.seq)
    expect(useApp.getState().codeRequest).toBeNull()
  })

  it('does not clear a newer request when an old one is acknowledged', () => {
    useApp.getState().openInCode('/wt', 'a', 'code')
    const first = useApp.getState().codeRequest!.seq
    useApp.getState().openInCode('/wt', 'b', 'code')
    useApp.getState().clearCodeRequest(first)
    expect(useApp.getState().codeRequest?.path).toBe('b')
  })
})

describe('setWorktrees with orphans', () => {
  const main = { path: '/main', branch: 'main', head: 'h', isMain: true }
  const gone = { path: '/gone', branch: 'feat', head: 'h', isMain: false, sessions: 1, terminals: 0 }

  it('keeps an orphan selected while it is reachable, and falls back once it is not', () => {
    useApp.setState({ worktree: '/gone', worktrees: [main], orphans: [] })
    useApp.getState().setOrphans([gone])
    useApp.getState().setWorktrees([main])
    expect(useApp.getState().worktree).toBe('/gone')

    useApp.getState().setOrphans([])
    useApp.getState().setWorktrees([main])
    expect(useApp.getState().worktree).toBe('/main')
  })

  it('a new repo starts without orphans', () => {
    useApp.setState({ repo: '/main', orphans: [gone] })
    useApp.getState().setWorkspace({ root: '/other', truncated: false, entries: [entry('/other', '/other')] })
    expect(useApp.getState().orphans).toEqual([])
  })
})

function entry(repo: string, path: string, group: WorkspaceEntry['group'] = 'main'): WorkspaceEntry {
  return { repo, repoName: repo.slice(1), group, worktree: { path, branch: 'b', head: 'h', isMain: group === 'main' || group === 'space' } }
}

describe('workspace', () => {
  const space = entry('/ws', '/ws', 'space')
  const a = entry('/ws/a', '/ws/a')
  const aFeat = entry('/ws/a', '/ws/.worktrees/f/a', 'feature')
  const b = entry('/ws/b', '/ws/b')
  const ws = (...entries: WorkspaceEntry[]): Workspace => ({ root: '/ws', entries, truncated: false })

  it('opens on the first main entry, not on the parent repo', () => {
    useApp.getState().setWorkspace(ws(space, a, aFeat, b))
    expect(useApp.getState()).toMatchObject({ repo: '/ws/a', worktree: '/ws/a' })
    expect(useApp.getState().worktrees.map((w) => w.path)).toEqual(['/ws/a', '/ws/.worktrees/f/a'])
  })

  it('opens on the first entry when no repo has a main entry', () => {
    useApp.getState().setWorkspace(ws(space))
    expect(useApp.getState()).toMatchObject({ repo: '/ws', worktree: '/ws' })
  })

  it('selectEntry changes the repo, the worktree and the list', () => {
    useApp.getState().setWorkspace(ws(a, aFeat, b))
    useApp.getState().selectEntry(b)
    expect(useApp.getState()).toMatchObject({ repo: '/ws/b', worktree: '/ws/b' })
    expect(useApp.getState().worktrees.map((w) => w.path)).toEqual(['/ws/b'])
  })

  it('selectEntry leaves the per-worktree state of other repos alone', () => {
    useApp.getState().setWorkspace(ws(a, b))
    useApp.getState().setBase('/ws/a', 'develop')
    useApp.getState().selectEntry(b)
    useApp.getState().selectEntry(a)
    expect(useApp.getState().bases).toEqual({ '/ws/a': 'develop' })
  })

  it('selectEntry within the repo keeps its orphans and its fresher list', () => {
    const gone = { path: '/gone', branch: 'x', head: 'h', isMain: false, sessions: 1, terminals: 0 }
    useApp.getState().setWorkspace(ws(a, aFeat))
    useApp.getState().setOrphans([gone])
    const fresh = [a.worktree, aFeat.worktree, { path: '/new', branch: 'n', head: 'h', isMain: false }]
    useApp.getState().setWorktrees(fresh)
    useApp.getState().selectEntry(aFeat)
    expect(useApp.getState()).toMatchObject({ worktree: '/ws/.worktrees/f/a', orphans: [gone], worktrees: fresh })
  })

  it('selectEntry in another repo drops the orphans of the one left', () => {
    useApp.getState().setWorkspace(ws(a, b))
    useApp.getState().setOrphans([{ path: '/gone', branch: 'x', head: 'h', isMain: false, sessions: 1, terminals: 0 }])
    useApp.getState().selectEntry(b)
    expect(useApp.getState().orphans).toEqual([])
  })

  it('a new scan keeps the selection while its entry exists', () => {
    useApp.getState().setWorkspace(ws(a, aFeat, b))
    useApp.getState().selectEntry(aFeat)
    useApp.getState().setWorkspace(ws(entry('/ws/0', '/ws/0'), a, aFeat, b))
    expect(useApp.getState()).toMatchObject({ repo: '/ws/a', worktree: '/ws/.worktrees/f/a' })
  })

  it('a new scan falls back to the first entry when the selected one is gone', () => {
    useApp.getState().setWorkspace(ws(a, b))
    useApp.getState().selectEntry(b)
    useApp.getState().setWorkspace(ws(a))
    expect(useApp.getState()).toMatchObject({ repo: '/ws/a', worktree: '/ws/a' })
    expect(useApp.getState().worktrees.map((w) => w.path)).toEqual(['/ws/a'])
  })

  it('a new scan keeps an orphan selected while its repo is there', () => {
    useApp.getState().setWorkspace(ws(a, aFeat, b))
    useApp.getState().selectEntry(aFeat)
    useApp.getState().setOrphans([{ ...aFeat.worktree, sessions: 1, terminals: 0 }])
    useApp.getState().setWorkspace(ws(a, b))
    expect(useApp.getState()).toMatchObject({ repo: '/ws/a', worktree: '/ws/.worktrees/f/a' })
  })

  it('a folder with one repo behaves as that repo: main worktree first, the list drives the selection', () => {
    const feat = entry('/r', '/r/.worktrees/x', 'other')
    useApp.getState().setWorkspace({ root: '/r', truncated: false, entries: [entry('/r', '/r'), feat] })
    expect(useApp.getState()).toMatchObject({ repo: '/r', worktree: '/r' })
    useApp.getState().setWorktree('/r/.worktrees/x')
    useApp.getState().setWorktrees([entry('/r', '/r').worktree])
    expect(useApp.getState().worktree).toBe('/r')
  })

  it('a scan that finds nothing closes the folder with a message', () => {
    useApp.getState().setWorkspace(ws(a))
    useApp.getState().setWorkspace(ws())
    expect(useApp.getState()).toMatchObject({ repo: null, worktree: null, worktrees: [] })
    expect(useApp.getState().openError).toContain('/ws')
  })

  it('a scan that finds repos clears the last message', () => {
    useApp.getState().setOpenError('nope')
    useApp.getState().setWorkspace(ws(a))
    expect(useApp.getState().openError).toBeNull()
  })
})
