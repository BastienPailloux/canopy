import { expect, test } from 'vitest'
import { displayKeys, leftToMenu, SHORTCUTS, shortcutEnabled, type Shortcut } from '../../src/shared/shortcuts'

test('every accelerator is unique', () => {
  expect(new Set(SHORTCUTS.map((s) => s.accelerator)).size).toBe(SHORTCUTS.length)
})

test('displayKeys renders macOS glyphs', () => {
  expect(displayKeys('CmdOrCtrl+Shift+N')).toBe('⇧⌘N')
  expect(displayKeys('Ctrl+Tab')).toBe('⌃⇥')
  expect(displayKeys('Ctrl+Shift+Tab')).toBe('⌃⇧⇥')
  expect(displayKeys('CmdOrCtrl+1')).toBe('⌘1')
})

test('no shortcut takes a key the code editor or macOS already uses', () => {
  const taken = ['CmdOrCtrl+/', 'CmdOrCtrl+Shift+3', 'CmdOrCtrl+Shift+4', 'CmdOrCtrl+Shift+5', 'CmdOrCtrl+K', 'CmdOrCtrl+P', 'CmdOrCtrl+Shift+F', 'CmdOrCtrl+W', 'CmdOrCtrl+D', 'CmdOrCtrl+Shift+K']
  for (const s of SHORTCUTS) expect(taken).not.toContain(s.accelerator)
})

test('shortcutEnabled follows what the shortcut needs', () => {
  const s = (needs: Shortcut['needs']): Shortcut => ({ id: 'help', accelerator: 'X', label: 'x', menu: 'help', needs })
  expect(shortcutEnabled(s(null), { repo: false, worktree: false })).toBe(true)
  expect(shortcutEnabled(s('repo'), { repo: true, worktree: false })).toBe(true)
  expect(shortcutEnabled(s('repo'), { repo: false, worktree: false })).toBe(false)
  expect(shortcutEnabled(s('worktree'), { repo: true, worktree: false })).toBe(false)
  expect(shortcutEnabled(s('worktree'), { repo: true, worktree: true })).toBe(true)
})

test('the terminal leaves ⌃⇥ and ⌃⇧⇥ to the menu, and keeps other control keys', () => {
  const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) =>
    ({ key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods })
  expect(leftToMenu(key('Tab', { ctrlKey: true }))).toBe(true)
  expect(leftToMenu(key('Tab', { ctrlKey: true, shiftKey: true }))).toBe(true)
  expect(leftToMenu(key('Tab'))).toBe(false)
  expect(leftToMenu(key('c', { ctrlKey: true }))).toBe(false)
  expect(leftToMenu(key('Tab', { ctrlKey: true, altKey: true }))).toBe(false)
})
