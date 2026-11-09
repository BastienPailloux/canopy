import { SHORTCUTS, shortcutEnabled, type ShortcutId } from '../../shared/shortcuts'
import { newTab } from '../sessions/sessionStore'
import { useApp, type AppDialog, type View } from '../store'

/** Keeps the main process told of what is active, so that it greys the menu entries that would do nothing. */
export function connectShortcutContext(): () => void {
  let sent = ''
  const report = (): void => {
    const { repo, worktree } = useApp.getState()
    const ctx = { repo: repo !== null, worktree: worktree !== null }
    const key = `${ctx.repo}:${ctx.worktree}`
    if (key === sent) return
    sent = key
    void window.canopy.reportShortcutContext(ctx).catch(() => { sent = '' })
  }
  report()
  return useApp.subscribe(report)
}

/** The worktree `step` away from `current` in `paths`, in a loop; the first one when `current` is not listed. */
export function nextWorktree(paths: string[], current: string | null, step: 1 | -1): string | null {
  if (paths.length === 0) return null
  const at = current === null ? -1 : paths.indexOf(current)
  if (at === -1) return paths[0]
  return paths[(at + step + paths.length) % paths.length]
}

export interface ShortcutDeps {
  /** A dialog is in front: nothing may change behind it. */
  modalOpen: () => boolean
  newTab: (cwd: string) => string
  startDictation: () => void
}

const VIEWS: Partial<Record<ShortcutId, View>> = { 'view-sessions': 'sessions', 'view-code': 'code', 'view-tickets': 'tickets', 'view-mockups': 'mockups' }
const DIALOGS: Partial<Record<ShortcutId, AppDialog>> = { 'new-worktree': 'new-worktree', 'new-ticket': 'new-ticket', help: 'shortcuts' }

/** Carries out a shortcut from the app menu on what the page shows. */
export function runShortcut(id: ShortcutId, deps: ShortcutDeps): void {
  if (deps.modalOpen()) return
  const app = useApp.getState()
  const shortcut = SHORTCUTS.find((s) => s.id === id)
  // The menu greys these, but an accelerator can still arrive before the page has said what is active.
  if (!shortcut || !shortcutEnabled(shortcut, { repo: app.repo !== null, worktree: app.worktree !== null })) return
  const view = VIEWS[id]
  if (view) { app.setView(view); return }
  const dialog = DIALOGS[id]
  if (dialog) { app.setDialog(dialog); return }
  const worktree = app.worktree
  if (worktree === null) return
  if (id === 'worktree-next' || id === 'worktree-previous') {
    const next = nextWorktree(app.worktrees.map((w) => w.path), worktree, id === 'worktree-next' ? 1 : -1)
    if (next) app.setWorktree(next)
  } else if (id === 'new-session') {
    deps.newTab(worktree)
    app.setView('sessions')
  } else if (id === 'dictation') {
    deps.startDictation()
  }
}

const isShortcutId = (v: unknown): v is ShortcutId => SHORTCUTS.some((s) => s.id === v)

/** Listens to the shortcuts of the app menu. */
export function connectShortcuts(): () => void {
  const deps: ShortcutDeps = {
    modalOpen: () => document.querySelector('[aria-modal="true"]') !== null,
    newTab,
    startDictation: () => undefined
  }
  return window.canopy.on('menu:shortcut', (id) => { if (isShortcutId(id)) runShortcut(id, deps) })
}
