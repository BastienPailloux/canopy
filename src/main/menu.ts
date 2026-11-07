export interface MenuOptions {
  isPackaged: boolean
  /** ⌘W: what it does is the page's call, since only the page knows what a tab holds. */
  onCloseTab: () => void
}

/**
 * The default menu makes ⌘W close the window, which quits, and ⌘R reload the page, which loses every draft.
 * Reload and the dev tools only exist in development.
 */
export function menuTemplate(o: MenuOptions): Electron.MenuItemConstructorOptions[] {
  const development: Electron.MenuItemConstructorOptions[] = o.isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
  return [
    {
      label: 'Canopy',
      submenu: [
        { role: 'about', label: 'À propos de Canopy' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer Canopy' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter Canopy' }
      ]
    },
    {
      label: 'Fichier',
      submenu: [{ id: 'close-tab', label: "Fermer l'onglet", accelerator: 'CmdOrCtrl+W', click: () => o.onCloseTab() }]
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
    {
      label: 'Fenêtre',
      submenu: [{ role: 'minimize', label: 'Réduire' }, { role: 'zoom', label: 'Agrandir' }]
    }
  ]
}
