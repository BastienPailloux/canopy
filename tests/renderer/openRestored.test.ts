import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Workspace, WorkspaceEntry } from '../../src/shared/types'
import { inWorkspace, openRestored } from '../../src/renderer/update/openRestored'
import { useApp } from '../../src/renderer/store'

const entry = (repo: string, path: string, isMain = true): WorkspaceEntry =>
  ({ repo, repoName: repo, group: isMain ? 'main' : 'other', worktree: { path, branch: 'b', head: 'h', isMain } })
const scan = (root: string, ...entries: WorkspaceEntry[]): Workspace => ({ root, entries, truncated: false, failed: [] })

beforeEach(() => { useApp.setState({ repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, openError: null, codeRequest: null }) })
afterEach(() => { vi.unstubAllGlobals() })

test('a worktree is in the workspace when an entry has its path', () => {
  const ws = scan('/a', entry('/a', '/a'), entry('/a', '/a/wt', false))
  expect(inWorkspace(ws, '/a/wt')).toBe(true)
  expect(inWorkspace(ws, '/b')).toBe(false)
  expect(inWorkspace(null, '/a')).toBe(false)
})

test('a file of another folder opens that folder first', async () => {
  const other = scan('/b', entry('/b', '/b'))
  vi.stubGlobal('window', { canopy: { selectRepo: async (p: string) => p, scanWorkspace: async () => other, lastEntry: async () => null, setLastEntry: async () => undefined } })
  useApp.getState().setWorkspace(scan('/a', entry('/a', '/a')))
  await openRestored('/b', 'src/x.ts')
  expect(useApp.getState().workspace?.root).toBe('/b')
  expect(useApp.getState().worktree).toBe('/b')
  expect(useApp.getState().codeRequest).toMatchObject({ cwd: '/b', path: 'src/x.ts' })
})

test('a file of the open folder opens nothing else', async () => {
  const select = vi.fn()
  vi.stubGlobal('window', { canopy: { selectRepo: select } })
  useApp.getState().setWorkspace(scan('/a', entry('/a', '/a')))
  await openRestored('/a', 'x.ts')
  expect(select).not.toHaveBeenCalled()
  expect(useApp.getState().codeRequest).toMatchObject({ cwd: '/a', path: 'x.ts' })
})
