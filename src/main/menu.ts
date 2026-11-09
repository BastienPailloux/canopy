import { SHORTCUTS, type Shortcut, type ShortcutId } from '../shared/shortcuts'

export interface MenuOptions {
  isPackaged: boolean
  /** ⌘W: what it does is the page's call, since only the page knows what a tab holds. */
  onCloseTab: () => void
  /** « Installer la commande canopy »: only offered by a packaged build, the only one that ships the script. */
  onInstallCli: () => void
  /** A global shortcut: the page carries it out, since it holds the state it acts on. */
  onShortcut: (id: ShortcutId) => void
}

/**
 * The default menu makes ⌘W close the window, which quits, and ⌘R reload the page, which loses every draft.
 * Reload and the dev tools only exist in development.
 */
export function menuTemplate(o: MenuOptions): Electron.MenuItemConstructorOptions[] {
  const development: Electron.MenuItemConstructorOptions[] = o.isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
  const shortcuts = (menu: Shortcut['menu']): Electron.MenuItemConstructorOptions[] =>
    SHORTCUTS.filter((s) => s.menu === menu).map((s) => ({ id: `shortcut:${s.id}`, label: s.label, accelerator: s.accelerator, click: () => o.onShortcut(s.id) }))
  return [
    {
      label: 'Canopy',
      submenu: [
        { role: 'about', label: 'À propos de Canopy' },
        ...(o.isPackaged ? [{ label: 'Installer la commande canopy', click: () => o.onInstallCli() }, { type: 'separator' } as const] : []),
        { role: 'hide', label: 'Masquer Canopy' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter Canopy' }
      ]
    },
    {
      label: 'Fichier',
      submenu: [
        ...shortcuts('file'),
        { type: 'separator' },
        { id: 'close-tab', label: "Fermer l'onglet", accelerator: 'CmdOrCtrl+W', click: () => o.onCloseTab() }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Présentation',
      submenu: [
        ...development,
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    { label: 'Aller', submenu: shortcuts('go') },
    {
      label: 'Fenêtre',
      submenu: [{ role: 'minimize', label: 'Réduire' }, { role: 'zoom', label: 'Agrandir' }]
    },
    // The help role lets macOS add its menu search field.
    { role: 'help', label: 'Aide', submenu: shortcuts('help') }
  ]
}
