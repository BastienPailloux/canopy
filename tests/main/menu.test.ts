import { expect, test, vi } from 'vitest'
import { menuTemplate } from '../../src/main/menu'
import { SHORTCUTS } from '../../src/shared/shortcuts'

type Item = Electron.MenuItemConstructorOptions
const flatten = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flatten((i.submenu ?? []) as Item[])])
const items = (isPackaged: boolean, onCloseTab = vi.fn(), onInstallCli = vi.fn(), onShortcut = vi.fn()): Item[] =>
  flatten(menuTemplate({ isPackaged, onCloseTab, onInstallCli, onShortcut }))

test('nothing closes the window or quits on ⌘W: it goes to the tab flow', () => {
  const onCloseTab = vi.fn()
  const all = items(true, onCloseTab)
  expect(all.some((i) => i.role === 'close')).toBe(false)
  const close = all.filter((i) => i.accelerator === 'CmdOrCtrl+W')
  expect(close).toHaveLength(1)
  ;(close[0].click as () => void)()
  expect(onCloseTab).toHaveBeenCalledOnce()
})

test('a packaged build cannot reload: drafts live in the page', () => {
  const all = items(true)
  for (const role of ['reload', 'forceReload', 'toggleDevTools']) expect(all.some((i) => i.role === role)).toBe(false)
})

test('development keeps reload and the dev tools', () => {
  const roles = items(false).map((i) => i.role)
  expect(roles).toContain('reload')
  expect(roles).toContain('toggleDevTools')
})

test('editing shortcuts stay, or copy and paste would stop working', () => {
  const roles = items(true).map((i) => i.role)
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit']) expect(roles).toContain(role)
})

test('installing the canopy command is offered by a packaged build only', () => {
  const onInstallCli = vi.fn()
  const install = items(true, vi.fn(), onInstallCli).filter((i) => i.label === 'Installer la commande canopy')
  expect(install).toHaveLength(1)
  ;(install[0].click as () => void)()
  expect(onInstallCli).toHaveBeenCalledOnce()
  expect(items(false).some((i) => i.label === 'Installer la commande canopy')).toBe(false)
})

test('each shortcut is a menu item that reports its id', () => {
  const onShortcut = vi.fn()
  const all = items(true, vi.fn(), vi.fn(), onShortcut)
  for (const s of SHORTCUTS) {
    const found = all.filter((i) => i.id === `shortcut:${s.id}`)
    expect(found).toHaveLength(1)
    expect(found[0].accelerator).toBe(s.accelerator)
    expect(found[0].label).toBe(s.label)
    ;(found[0].click as () => void)()
    expect(onShortcut).toHaveBeenLastCalledWith(s.id)
  }
})

test('the go menu is labelled Aller and holds the screens and worktrees', () => {
  const top = menuTemplate({ isPackaged: true, onCloseTab: vi.fn(), onInstallCli: vi.fn(), onShortcut: vi.fn() })
  const go = top.find((i) => i.label === 'Aller')
  expect((go?.submenu as Item[]).map((i) => i.id).filter(Boolean)).toEqual(SHORTCUTS.filter((s) => s.menu === 'go').map((s) => `shortcut:${s.id}`))
})

test('the help menu holds the shortcut list', () => {
  const top = menuTemplate({ isPackaged: true, onCloseTab: vi.fn(), onInstallCli: vi.fn(), onShortcut: vi.fn() })
  const help = top.find((i) => i.role === 'help')
  expect(help?.label).toBe('Aide')
  expect((help?.submenu as Item[]).some((i) => i.id === 'shortcut:help')).toBe(true)
})
