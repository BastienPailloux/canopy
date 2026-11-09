import { SHORTCUTS, shortcutEnabled, type ShortcutContext } from '../shared/shortcuts'

interface MenuLike { getMenuItemById(id: string): { enabled: boolean } | null }

/** Greys the shortcut entries that would do nothing in what the page shows. */
export function applyShortcutContext(menu: MenuLike | null, ctx: ShortcutContext): void {
  for (const s of SHORTCUTS) {
    const item = menu?.getMenuItemById(`shortcut:${s.id}`)
    if (item) item.enabled = shortcutEnabled(s, ctx)
  }
}

/** What the page sent, if it is a context: anything else from IPC is dropped. */
export function parseShortcutContext(v: unknown): ShortcutContext | null {
  if (typeof v !== 'object' || v === null) return null
  const { repo, worktree } = v as Record<string, unknown>
  return typeof repo === 'boolean' && typeof worktree === 'boolean' ? { repo, worktree } : null
}
