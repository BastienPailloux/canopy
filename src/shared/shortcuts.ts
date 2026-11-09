export type ShortcutId =
  | 'view-sessions' | 'view-code' | 'view-tickets' | 'view-mockups'
  | 'worktree-next' | 'worktree-previous'
  | 'new-worktree' | 'new-session' | 'new-ticket' | 'dictation'
  | 'help'

/** A global shortcut: an app menu entry, so that it fires before Monaco or xterm can take the keys. */
export interface Shortcut {
  id: ShortcutId
  /** Electron accelerator syntax. */
  accelerator: string
  label: string
  /** The app menu it sits in. */
  menu: 'go' | 'file' | 'help'
  /** What must be active for it to do anything; its menu entry is greyed otherwise. */
  needs: 'repo' | 'worktree' | null
}

/** One table for the menu and the help list, so that the two never disagree. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'view-sessions', accelerator: 'CmdOrCtrl+1', label: 'Sessions', menu: 'go', needs: 'repo' },
  { id: 'view-code', accelerator: 'CmdOrCtrl+2', label: 'Code', menu: 'go', needs: 'repo' },
  { id: 'view-tickets', accelerator: 'CmdOrCtrl+3', label: 'Tickets', menu: 'go', needs: 'repo' },
  { id: 'view-mockups', accelerator: 'CmdOrCtrl+4', label: 'Maquettes', menu: 'go', needs: 'repo' },
  { id: 'worktree-next', accelerator: 'Ctrl+Tab', label: 'Worktree suivant', menu: 'go', needs: 'worktree' },
  { id: 'worktree-previous', accelerator: 'Ctrl+Shift+Tab', label: 'Worktree précédent', menu: 'go', needs: 'worktree' },
  { id: 'new-worktree', accelerator: 'CmdOrCtrl+Shift+N', label: 'Nouveau worktree…', menu: 'file', needs: 'repo' },
  { id: 'new-session', accelerator: 'CmdOrCtrl+T', label: 'Nouvelle session', menu: 'file', needs: 'worktree' },
  { id: 'new-ticket', accelerator: 'CmdOrCtrl+Shift+T', label: 'Nouveau ticket…', menu: 'file', needs: 'repo' },
  { id: 'dictation', accelerator: 'CmdOrCtrl+Shift+D', label: 'Dicter un message', menu: 'file', needs: 'worktree' },
  { id: 'help', accelerator: 'CmdOrCtrl+Shift+H', label: 'Raccourcis clavier', menu: 'help', needs: null }
]

const GLYPHS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', CmdOrCtrl: '⌘', Cmd: '⌘', Tab: '⇥', Enter: '↵' }
// macOS writes modifiers in this order whatever order the accelerator uses.
const ORDER = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl', 'Cmd']

/** An accelerator as macOS shows it: `CmdOrCtrl+Shift+N` → `⇧⌘N`. */
export function displayKeys(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return [...mods, key].map((p) => GLYPHS[p] ?? p).join('')
}

/** What is active in the page, as far as the shortcuts care. */
export interface ShortcutContext { repo: boolean; worktree: boolean }

export function shortcutEnabled(s: Shortcut, ctx: ShortcutContext): boolean {
  return s.needs === null || ctx[s.needs]
}

/**
 * ⌃⇥ and ⌃⇧⇥ in the terminal: xterm would send them to the shell and cancel the event, and then the menu never sees
 * them. The ⌘ shortcuts need nothing: xterm lets ⌘ combinations through.
 */
export function leftToMenu(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey
}
