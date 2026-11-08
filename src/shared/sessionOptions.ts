import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Modes a session may use. `bypassPermissions` is left out: it needs an SDK flag Canopy never sets. */
export const SESSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Mode : demander' },
  { value: 'acceptEdits', label: 'Mode : accepter les edits' },
  { value: 'plan', label: 'Mode : plan' },
  { value: 'dontAsk', label: 'Mode : refuser sans demander' },
  { value: 'auto', label: 'Mode : auto' }
]

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Claude reads PDFs up to 32 MB, about 100 pages. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
export const MAX_DOCUMENT_BASE64 = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4
