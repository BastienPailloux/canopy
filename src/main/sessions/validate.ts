import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StartSessionOptions } from '../../shared/api'
import type { PermissionDecision, UserContent } from '../../shared/types'

// `bypassPermissions` is left out: it needs an SDK flag Canopy never sets.
const MODES: readonly unknown[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] satisfies PermissionMode[]
const IMAGE_TYPES: readonly unknown[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') throw new Error('Identifiant invalide')
}

export function assertMode(mode: unknown): asserts mode is PermissionMode {
  if (!MODES.includes(mode)) throw new Error('Mode invalide')
}

export function assertContent(c: unknown): asserts c is UserContent {
  const valid = isRecord(c) && typeof c.text === 'string' && (c.images === undefined || (
    Array.isArray(c.images) &&
    c.images.every((i) => isRecord(i) && IMAGE_TYPES.includes(i.mediaType) && typeof i.base64 === 'string')
  ))
  if (!valid) throw new Error('Message invalide')
}

/** Keeps known fields only, so nothing else from the renderer reaches `start`. */
export function parseStartOptions(o: unknown): StartSessionOptions {
  if (!isRecord(o)) throw new Error('Options invalides')
  const { content, resumeId, model, mode } = o
  assertContent(content)
  if (resumeId !== undefined && typeof resumeId !== 'string') throw new Error('Identifiant invalide')
  if (model !== undefined) assertId(model)
  if (mode !== undefined) assertMode(mode)
  return {
    content,
    ...(resumeId ? { resumeId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {})
  }
}

export function parseDecision(d: unknown): PermissionDecision {
  if (!isRecord(d)) throw new Error('Décision invalide')
  if (d.allow === false && typeof d.message === 'string') return { allow: false, message: d.message }
  const { always, updatedInput } = d
  const valid = d.allow === true &&
    (always === undefined || typeof always === 'boolean') &&
    (updatedInput === undefined || isRecord(updatedInput))
  if (!valid) throw new Error('Décision invalide')
  return {
    allow: true,
    ...(always !== undefined ? { always } : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {})
  }
}
