import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StartSessionOptions } from '../../shared/api'
import { countImages, MAX_IMAGES_PER_MESSAGE, MAX_RECORDING_FRAMES, MAX_RECORDING_MS } from '../../shared/recording'
import { IMAGE_TYPES, MAX_DOCUMENT_BASE64, MAX_DOCUMENT_BYTES, SESSION_MODES } from '../../shared/sessionOptions'
import type { PermissionDecision, UserContent } from '../../shared/types'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') throw new Error('Identifiant invalide')
}

export function assertMode(mode: unknown): asserts mode is PermissionMode {
  if (!SESSION_MODES.some((m) => m.value === mode)) throw new Error('Mode invalide')
}

/** Bytes a base64 string decodes to: its length alone lets a few too many through. */
const decodedLength = (base64: string): number =>
  Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)

const isPositiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0

const FRAME_REASONS = ['start', 'end', 'before-click', 'after-click', 'change']
const isTime = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

const isFrame = (f: unknown): boolean => isRecord(f) && typeof f.base64 === 'string' && isTime(f.t) &&
  FRAME_REASONS.includes(f.reason as string) &&
  (f.click === undefined || (isRecord(f.click) && isNumber(f.click.x) && isNumber(f.click.y)))

const isRecording = (r: unknown): boolean => isRecord(r) &&
  Array.isArray(r.frames) && r.frames.length > 0 && r.frames.length <= MAX_RECORDING_FRAMES &&
  r.frames.every(isFrame) &&
  isTime(r.durationMs) && (r.durationMs as number) <= MAX_RECORDING_MS + 5000 &&
  isPositiveInt(r.width) && isPositiveInt(r.height) && typeof r.clicksMissing === 'boolean'

export function assertContent(c: unknown): asserts c is UserContent {
  const valid = isRecord(c) && typeof c.text === 'string' && (c.images === undefined || (
    Array.isArray(c.images) &&
    c.images.every((i) => isRecord(i) && IMAGE_TYPES.includes(i.mediaType as string) && typeof i.base64 === 'string')
  )) && (c.recordings === undefined || (
    Array.isArray(c.recordings) && c.recordings.every(isRecording)
  )) && (c.documents === undefined || (
    Array.isArray(c.documents) &&
    c.documents.every((d) => isRecord(d) && typeof d.name === 'string' && d.name !== '' &&
      typeof d.base64 === 'string' && d.base64.length <= MAX_DOCUMENT_BASE64 && decodedLength(d.base64) <= MAX_DOCUMENT_BYTES)
  ))
  if (!valid || countImages(c as Pick<UserContent, 'images' | 'recordings'>) > MAX_IMAGES_PER_MESSAGE) throw new Error('Message invalide')
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
