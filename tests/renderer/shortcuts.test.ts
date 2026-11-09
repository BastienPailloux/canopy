import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessions } from '../../src/renderer/sessions/sessionStore'
import { useApp } from '../../src/renderer/store'
import { connectShortcutContext, nextWorktree, runShortcut, worktreeCycle, type ShortcutDeps } from '../../src/renderer/shell/shortcuts'
import { SHORTCUTS } from '../../src/shared/shortcuts'
import type { Workspace, WorkspaceEntry, Worktree } from '../../src/shared/types'

beforeEach(() => { useSessions.setState({ focusRequest: null }); useApp.setState({ view: 'sessions', repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, dialog: null }) })
afterEach(() => { vi.unstubAllGlobals() })

it('tells the main process what is active, only when it changes', () => {
  const reportShortcutContext = vi.fn(async () => {})
  vi.stubGlobal('window', { canopy: { reportShortcutContext } })
  const stop = connectShortcutContext()
  expect(reportShortcutContext).toHaveBeenLastCalledWith({ repo: false, worktree: false })
  useApp.setState({ repo: '/r', worktree: '/r' })
  expect(reportShortcutContext).toHaveBeenLastCalledWith({ repo: true, worktree: true })
  useApp.setState({ view: 'code' })
  expect(reportShortcutContext).toHaveBeenCalledTimes(2)
  stop()
})

const wt = (path: string): Worktree => ({ path, branch: path.slice(1), head: 'abc1234', isMain: path === '/a' }) as Worktree
const deps = (over: Partial<ShortcutDeps> = {}): ShortcutDeps => ({ modalOpen: () => false, newTab: vi.fn(() => 'tab'), ...over })
const open = (): void => { useApp.setState({ repo: '/a', worktree: '/a', worktrees: [wt('/a'), wt('/b')] }) }

it('nextWorktree walks the list in a loop', () => {
  expect(nextWorktree(['a', 'b', 'c'], 'b', 1)).toBe('c')
  expect(nextWorktree(['a', 'b', 'c'], 'c', 1)).toBe('a')
  expect(nextWorktree(['a', 'b', 'c'], 'a', -1)).toBe('c')
})

it('nextWorktree goes to the first from a worktree not in the list, and stays put alone', () => {
  expect(nextWorktree(['a', 'b', 'c'], 'gone', 1)).toBe('a')
  expect(nextWorktree([], 'x', 1)).toBeNull()
  expect(nextWorktree(['a'], 'a', 1)).toBe('a')
})

it('view shortcuts switch the screen', () => {
  open()
  const views = { 'view-sessions': 'sessions', 'view-code': 'code', 'view-tickets': 'tickets', 'view-mockups': 'mockups' } as const
  for (const [id, view] of Object.entries(views)) {
    runShortcut(id as keyof typeof views, deps())
    expect(useApp.getState().view).toBe(view)
  }
})

it('worktree-next walks the active repo list only', () => {
  open()
  runShortcut('worktree-next', deps())
  expect(useApp.getState().worktree).toBe('/b')
  expect(useApp.getState().repo).toBe('/a')
  runShortcut('worktree-previous', deps())
  expect(useApp.getState().worktree).toBe('/a')
})

it('new-session opens a tab on the active worktree and shows Sessions', () => {
  open()
  useApp.setState({ view: 'code' })
  const d = deps()
  runShortcut('new-session', d)
  expect(d.newTab).toHaveBeenCalledWith('/a')
  expect(useApp.getState().view).toBe('sessions')
})

it('new-worktree, new-ticket and help open their dialog', () => {
  open()
  const dialogs = { 'new-worktree': 'new-worktree', 'new-ticket': 'new-ticket', help: 'shortcuts' } as const
  for (const [id, dialog] of Object.entries(dialogs)) {
    useApp.setState({ dialog: null })
    runShortcut(id as keyof typeof dialogs, deps())
    expect(useApp.getState().dialog).toBe(dialog)
  }
})

it('nothing happens behind a modal', () => {
  open()
  const d = deps({ modalOpen: () => true })
  for (const s of SHORTCUTS) runShortcut(s.id, d)
  expect(useApp.getState()).toMatchObject({ view: 'sessions', worktree: '/a', dialog: null })
  expect(d.newTab).not.toHaveBeenCalled()
  expect(useSessions.getState().focusRequest ?? null).toBeNull()
})

it('without a repo nothing throws and no tab opens', () => {
  const d = deps()
  for (const s of SHORTCUTS) expect(() => runShortcut(s.id, d)).not.toThrow()
  expect(d.newTab).not.toHaveBeenCalled()
  expect(useApp.getState().dialog === null || useApp.getState().dialog === 'shortcuts').toBe(true)
})

it('dictation shows Sessions and asks the composer for the focus and the dictation', () => {
  open()
  useApp.setState({ view: 'code' })
  runShortcut('dictation', deps())
  expect(useApp.getState().view).toBe('sessions')
  expect(useSessions.getState().focusRequest).toMatchObject({ cwd: '/a', dictate: true })
})

it('worktreeCycle follows the sidebar order of the active repo, without the space, then what only git lists', () => {
  const e = (repo: string, path: string, group: WorkspaceEntry['group'], feature?: string): WorkspaceEntry =>
    ({ repo, repoName: repo.slice(1), worktree: wt(path), group, feature })
  const workspace: Workspace = {
    root: '/ws', truncated: false, failed: [],
    entries: [e('/ws', '/ws', 'space'), e('/a', '/a', 'main'), e('/a', '/a/zed', 'feature', 'zed'), e('/a', '/a/alpha', 'feature', 'alpha'), e('/b', '/b', 'main')]
  }
  // git lists them in another order, and knows one the scan has not seen yet.
  const live = [wt('/a'), wt('/a/zed'), wt('/a/alpha'), wt('/a/new')]
  expect(worktreeCycle(workspace, '/a', live)).toEqual(['/a', '/a/alpha', '/a/zed', '/a/new'])
  expect(worktreeCycle(null, '/a', live)).toEqual(['/a', '/a/zed', '/a/alpha', '/a/new'])
})

it('⇧⌘H closes the help it opened, and only that dialog', () => {
  open()
  useApp.setState({ dialog: 'shortcuts' })
  runShortcut('help', deps({ modalOpen: () => true }))
  expect(useApp.getState().dialog).toBeNull()
  useApp.setState({ dialog: 'new-ticket' })
  runShortcut('help', deps({ modalOpen: () => true }))
  expect(useApp.getState().dialog).toBe('new-ticket')
})
