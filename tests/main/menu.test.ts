import { expect, test, vi } from 'vitest'
import { menuTemplate } from '../../src/main/menu'

type Item = Electron.MenuItemConstructorOptions
const flatten = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flatten((i.submenu ?? []) as Item[])])
const items = (isPackaged: boolean, onCloseTab = vi.fn(), onInstallCli = vi.fn()): Item[] =>
  flatten(menuTemplate({ isPackaged, onCloseTab, onInstallCli }))

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
