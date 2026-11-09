import { expect, test } from 'vitest'
import { applyShortcutContext, parseShortcutContext } from '../../src/main/shortcutMenu'
import { SHORTCUTS } from '../../src/shared/shortcuts'

const fakeMenu = (): { items: Record<string, { enabled: boolean }>; getMenuItemById: (id: string) => { enabled: boolean } | null } => {
  const items = Object.fromEntries(SHORTCUTS.map((s) => [`shortcut:${s.id}`, { enabled: true }]))
  return { items, getMenuItemById: (id) => items[id] ?? null }
}

test('without a repo only the help stays enabled', () => {
  const menu = fakeMenu()
  applyShortcutContext(menu, { repo: false, worktree: false })
  expect(Object.entries(menu.items).filter(([, i]) => i.enabled).map(([id]) => id)).toEqual(['shortcut:help'])
})

test('a repo without a worktree greys what needs a worktree', () => {
  const menu = fakeMenu()
  applyShortcutContext(menu, { repo: true, worktree: false })
  const off = Object.entries(menu.items).filter(([, i]) => !i.enabled).map(([id]) => id).sort()
  expect(off).toEqual(['shortcut:dictation', 'shortcut:new-session', 'shortcut:worktree-next', 'shortcut:worktree-previous'])
})

test('no menu, or a missing item, does not throw', () => {
  expect(() => applyShortcutContext(null, { repo: true, worktree: true })).not.toThrow()
  expect(() => applyShortcutContext({ getMenuItemById: () => null }, { repo: true, worktree: true })).not.toThrow()
})

test('a context from the page is taken only as two booleans', () => {
  expect(parseShortcutContext({ repo: true, worktree: false })).toEqual({ repo: true, worktree: false })
  expect(parseShortcutContext({ repo: 'yes', worktree: false })).toBeNull()
  expect(parseShortcutContext(null)).toBeNull()
})
