import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { SESSION_MODES } from '../../shared/sessionOptions'

const KEY = 'canopy.sessionMode'
const DEFAULT_MODE: PermissionMode = 'auto'

/** The mode a new session starts in: the last one picked in the selector, auto until then. */
export function preferredMode(): PermissionMode {
  try {
    const stored = localStorage.getItem(KEY)
    return SESSION_MODES.find((m) => m.value === stored)?.value ?? DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/** Only the user's own choice: a mode the session switches to by itself (a plan approved) is not a preference. */
export function rememberMode(mode: PermissionMode): void {
  try { localStorage.setItem(KEY, mode) } catch { /* not saved: new sessions keep the previous mode */ }
}
