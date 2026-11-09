import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useApp } from '../../src/renderer/store'
import { connectShortcutContext } from '../../src/renderer/shell/shortcuts'

beforeEach(() => { useApp.setState({ view: 'sessions', repo: null, worktree: null, worktrees: [], orphans: [], workspace: null }) })
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
