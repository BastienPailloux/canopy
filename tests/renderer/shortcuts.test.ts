import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useApp } from '../../src/renderer/store'
import { connectShortcutContext, nextWorktree, runShortcut, type ShortcutDeps } from '../../src/renderer/shell/shortcuts'
import { SHORTCUTS } from '../../src/shared/shortcuts'
import type { Worktree } from '../../src/shared/types'

beforeEach(() => { useApp.setState({ view: 'sessions', repo: null, worktree: null, worktrees: [], orphans: [], workspace: null, dialog: null }) })
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
const deps = (over: Partial<ShortcutDeps> = {}): ShortcutDeps => ({ modalOpen: () => false, newTab: vi.fn(() => 'tab'), startDictation: vi.fn(), ...over })
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
  expect(d.startDictation).not.toHaveBeenCalled()
})

it('without a repo nothing throws and no tab opens', () => {
  const d = deps()
  for (const s of SHORTCUTS) expect(() => runShortcut(s.id, d)).not.toThrow()
  expect(d.newTab).not.toHaveBeenCalled()
  expect(useApp.getState().dialog === null || useApp.getState().dialog === 'shortcuts').toBe(true)
})
