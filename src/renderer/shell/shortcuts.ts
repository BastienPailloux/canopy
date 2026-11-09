import { SHORTCUTS, shortcutEnabled, type ShortcutId } from '../../shared/shortcuts'
import { newTab, requestComposerFocus } from '../sessions/sessionStore'
import type { Workspace, Worktree } from '../../shared/types'
import { useApp, type AppDialog, type View } from '../store'
import { groupEntries } from './workspaceList'

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

/**
 * The worktrees ⌃⇥ walks: those of `repo` in the sidebar's order, without the space entry. The live list says what
 * exists; what it has that the last scan has not seen yet comes last.
 */
export function worktreeCycle(workspace: Workspace | null, repo: string, live: Worktree[]): string[] {
  const exists = new Set(live.map((w) => w.path))
  const shown = (workspace ? groupEntries(workspace) : []).flatMap((s) => s.entries)
    .filter((e) => e.repo === repo && e.group !== 'space' && exists.has(e.worktree.path))
    .map((e) => e.worktree.path)
  return [...new Set([...shown, ...live.map((w) => w.path)])]
}

export interface ShortcutDeps {
  /** A dialog is in front: nothing may change behind it. */
  modalOpen: () => boolean
  newTab: (cwd: string) => string
}

const VIEWS: Partial<Record<ShortcutId, View>> = { 'view-sessions': 'sessions', 'view-code': 'code', 'view-tickets': 'tickets', 'view-mockups': 'mockups', 'view-deps': 'deps' }

/** The screens with the worktree sidebar; elsewhere the app shows the dialogs the sidebar would. */
export const showsSidebar = (view: View): boolean => view === 'sessions' || view === 'code'
const DIALOGS: Partial<Record<ShortcutId, AppDialog>> = { 'new-worktree': 'new-worktree', 'new-ticket': 'new-ticket', help: 'shortcuts' }

/** Carries out a shortcut from the app menu on what the page shows. */
export function runShortcut(id: ShortcutId, deps: ShortcutDeps): void {
  const app = useApp.getState()
  // The one exception to the modal rule: the help shortcut closes the help it opened.
  if (id === 'help' && app.dialog === 'shortcuts') { app.setDialog(null); return }
  if (deps.modalOpen()) return
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
    const next = nextWorktree(app.repo === null ? [] : worktreeCycle(app.workspace, app.repo, app.worktrees), worktree, id === 'worktree-next' ? 1 : -1)
    if (next) app.setWorktree(next)
  } else if (id === 'new-session') {
    deps.newTab(worktree)
    app.setView('sessions')
  } else if (id === 'dictation') {
    app.setView('sessions')
    // The composer starts dictation once it holds the focus: before that, macOS would dictate into nothing.
    requestComposerFocus(worktree, true)
  }
}

const isShortcutId = (v: unknown): v is ShortcutId => SHORTCUTS.some((s) => s.id === v)

/** Listens to the shortcuts of the app menu. */
export function connectShortcuts(): () => void {
  const deps: ShortcutDeps = {
    modalOpen: () => document.querySelector('[aria-modal="true"]') !== null,
    newTab
  }
  return window.canopy.on('menu:shortcut', (id) => { if (isShortcutId(id)) runShortcut(id, deps) })
}
