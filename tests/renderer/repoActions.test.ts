import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Workspace, WorkspaceEntry } from '../../src/shared/types'
import { connectLastEntry, openFromTerminal, selectRepoFlow } from '../../src/renderer/shell/repoActions'
import { useApp } from '../../src/renderer/store'

const entry = (path: string, isMain = true): WorkspaceEntry =>
  ({ repo: '/ws', repoName: 'ws', group: isMain ? 'main' : 'other', worktree: { path, branch: 'b', head: 'h', isMain } })
const scan = (...entries: WorkspaceEntry[]): Workspace => ({ root: '/ws', entries, truncated: false, failed: [] })

const saved: [string, string][] = []

function stubCanopy(workspace: Workspace, last: string | null = null): void {
  vi.stubGlobal('window', {
    canopy: {
      selectRepo: async (p: string) => p,
      scanWorkspace: async () => workspace,
      lastEntry: async () => last,
      setLastEntry: async (root: string, path: string) => { saved.push([root, path]) }
    }
  })
}

beforeEach(() => { saved.length = 0; useApp.setState({ repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, openError: null }) })
afterEach(() => { vi.unstubAllGlobals() })

test('entering the open folder again clears the last message', async () => {
  stubCanopy(scan(entry('/ws')))
  useApp.getState().setWorkspace(scan(entry('/ws')))
  useApp.getState().setOpenError('/autre : illisible')
  await selectRepoFlow('/ws')
  expect(useApp.getState().openError).toBeNull()
})

test('a launch returns to the last entry of the folder', async () => {
  stubCanopy(scan(entry('/ws'), entry('/ws/wt', false)), '/ws/wt')
  await selectRepoFlow('/ws', true)
  expect(useApp.getState().worktree).toBe('/ws/wt')
})

test('a launch whose last entry is gone opens on the default one', async () => {
  stubCanopy(scan(entry('/ws')), '/ws/gone')
  await selectRepoFlow('/ws', true)
  expect(useApp.getState().worktree).toBe('/ws')
})

test('picking a recent folder keeps opening on the default entry', async () => {
  stubCanopy(scan(entry('/ws'), entry('/ws/wt', false)), '/ws/wt')
  await selectRepoFlow('/ws')
  expect(useApp.getState().worktree).toBe('/ws')
})

test('the selected entry is saved for its folder, an orphan is not', () => {
  const entries = [entry('/ws'), entry('/ws/wt', false)]
  stubCanopy(scan(...entries))
  useApp.getState().setWorkspace(scan(...entries))
  const stop = connectLastEntry()
  useApp.getState().selectEntry(entries[1])
  useApp.getState().selectOrphan({ ...entries[0].worktree, path: '/ws/orphan', repo: '/ws', sessions: 1, terminals: 0 })
  stop()
  expect(saved).toEqual([['/ws', '/ws/wt']])
})

test('a folder opened from the terminal returns to its last entry', async () => {
  stubCanopy(scan(entry('/ws'), entry('/ws/wt', false)), '/ws/wt')
  expect(await openFromTerminal('/ws')).toBe(true)
  expect(useApp.getState().worktree).toBe('/ws/wt')
})

test('the last folder asked for stays when an earlier one resolves after it', async () => {
  const release: Record<string, () => void> = {}
  vi.stubGlobal('window', {
    canopy: {
      selectRepo: (p: string) => new Promise<string>((r) => { release[p] = () => r(p) }),
      scanWorkspace: async (f: string) => ({ ...scan(entry(f)), root: f }),
      lastEntry: async () => null,
      setLastEntry: async () => undefined
    }
  })
  const first = selectRepoFlow('/a')
  const second = selectRepoFlow('/b')
  release['/b']()
  await second
  release['/a']()
  await first
  expect(useApp.getState().workspace?.root).toBe('/b')
})
