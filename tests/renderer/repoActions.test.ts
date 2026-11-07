import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Workspace, WorkspaceEntry } from '../../src/shared/types'
import { selectRepoFlow } from '../../src/renderer/shell/repoActions'
import { useApp } from '../../src/renderer/store'

const entry = (path: string, isMain = true): WorkspaceEntry =>
  ({ repo: '/ws', repoName: 'ws', group: isMain ? 'main' : 'other', worktree: { path, branch: 'b', head: 'h', isMain } })
const scan = (...entries: WorkspaceEntry[]): Workspace => ({ root: '/ws', entries, truncated: false, failed: [] })

function stubCanopy(workspace: Workspace): void {
  vi.stubGlobal('window', { canopy: { selectRepo: async (p: string) => p, scanWorkspace: async () => workspace } })
}

beforeEach(() => { useApp.setState({ repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, openError: null }) })
afterEach(() => { vi.unstubAllGlobals() })

test('entering the open folder again clears the last message', async () => {
  stubCanopy(scan(entry('/ws')))
  useApp.getState().setWorkspace(scan(entry('/ws')))
  useApp.getState().setOpenError('/autre : illisible')
  await selectRepoFlow('/ws')
  expect(useApp.getState().openError).toBeNull()
})
