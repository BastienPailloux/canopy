import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { IMAGE_TYPES } from '../../shared/sessionOptions'
import type { Stash, StashedBuffer, StashedTab, UserImage } from '../../shared/update'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isString = (v: unknown): v is string => typeof v === 'string'

function parseImage(i: unknown): UserImage {
  if (!isRecord(i) || !IMAGE_TYPES.includes(i.mediaType as string) || !isString(i.base64)) throw new Error('Image invalide')
  return { mediaType: i.mediaType as string, base64: i.base64 }
}

function parseBuffer(b: unknown): StashedBuffer {
  if (!isRecord(b) || !isString(b.cwd) || !isString(b.path) || !isString(b.text) || !isString(b.version)) {
    throw new Error('Tampon invalide')
  }
  return { cwd: b.cwd, path: b.path, text: b.text, version: b.version }
}

function parseTab(t: unknown): StashedTab {
  if (!isRecord(t) || !isString(t.cwd) || !isString(t.title) || typeof t.interrupted !== 'boolean') {
    throw new Error('Onglet invalide')
  }
  if (t.sessionId !== undefined && !isString(t.sessionId)) throw new Error('Onglet invalide')
  const { draft } = t
  if (!isRecord(draft) || !isString(draft.text) || !Array.isArray(draft.images)) throw new Error('Brouillon invalide')
  return {
    cwd: t.cwd,
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId as string } : {}),
    title: t.title,
    draft: { text: draft.text, images: draft.images.map(parseImage) },
    interrupted: t.interrupted
  }
}

/** Validates the whole stash. One invalid entry rejects it all: the format is ours, so a bad entry means a bad file. */
export function parseStash(raw: unknown): Stash {
  if (!isRecord(raw) || raw.format !== 1) throw new Error('Format de mise de côté inconnu')
  if (!Array.isArray(raw.buffers) || !Array.isArray(raw.tabs)) throw new Error('Mise de côté invalide')
  return { format: 1, buffers: raw.buffers.map(parseBuffer), tabs: raw.tabs.map(parseTab) }
}

/** Writes the stash atomically, like `AppStore.save`: a crash leaves the old file or none, never half of one. */
export function writeStash(file: string, s: Stash): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  // The stash holds whole unsaved files, secrets included: owner only.
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Reads, validates and removes the stash, whatever it holds. Null when absent or invalid. */
export function takeStash(file: string): Stash | null {
  try {
    return parseStash(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  } finally {
    rmSync(file, { force: true })
  }
}
