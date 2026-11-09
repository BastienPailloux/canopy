import { expect, test } from 'vitest'
import { displayKeys, SHORTCUTS } from '../../src/shared/shortcuts'

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
