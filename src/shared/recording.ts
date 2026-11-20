import type { UserContent } from './types'

/** Recording stops by itself here. */
export const MAX_RECORDING_MS = 120_000
export const MAX_RECORDING_FRAMES = 20
/** Beyond this long side the API downsizes the image without gaining detail. */
export const MAX_FRAME_SIDE = 1568
export const AFTER_CLICK_MS = 500
/** API limit, counting images and every recording frame together. */
export const MAX_IMAGES_PER_MESSAGE = 100
/** Base64 characters a message may carry: under the API's 32 MB request limit, with room for the text. */
export const MAX_REQUEST_BASE64 = 30 * 1024 * 1024

export type FrameReason = 'start' | 'end' | 'before-click' | 'after-click' | 'change'

export interface RecordingFrame {
  /** Milliseconds from the start of the recording. */
  t: number
  reason: FrameReason
  /** Pixels of the image. */
  click?: { x: number; y: number }
  /** image/jpeg */
  base64: string
}

export interface Recording {
  durationMs: number
  width: number
  height: number
  frames: RecordingFrame[]
  /** The click helper could not run or report: frames carry no click. */
  clicksMissing: boolean
  /** Every click made in the zone, double-clicks counted once: some may have no frame. */
  clickCount?: number
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1).replace('.', ',')

function describe(f: RecordingFrame): string {
  const at = f.click ? ` en (${f.click.x}, ${f.click.y})` : ''
  switch (f.reason) {
    case 'start': return 'début'
    case 'end': return 'fin'
    case 'before-click': return `avant clic${at}`
    case 'after-click': return `après clic${at}`
    case 'change': return "l'écran change"
  }
}

/** Clicks the frames show: a pair counts once, a click left with one frame too. */
export function shownClicks(r: Recording): number {
  const count = (reason: FrameReason): number => r.frames.filter((f) => f.reason === reason).length
  return Math.max(count('before-click'), count('after-click'))
}

const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`

/** The timeline Claude reads before the frames; the tags let the UI recognise it in a transcript. */
export function recordingNote(r: Recording): string {
  const head = `Enregistrement d'écran de ${seconds(r.durationMs)} s (zone ${r.width}×${r.height}), ${r.frames.length} images dans l'ordre.`
  const lines = [
    head,
    ...(r.clicksMissing ? ['Clics non enregistrés.'] : []),
    ...(r.clickCount !== undefined && r.clickCount > shownClicks(r) ? [`${plural(r.clickCount, 'clic')} au total, ${plural(shownClicks(r), 'montré')}.`] : []),
    ...r.frames.map((f, i) => `Image ${i + 1} — t = ${seconds(f.t)} s : ${describe(f)}`)
  ]
  return `<screen-recording frames="${r.frames.length}" duration-ms="${r.durationMs}">${lines.join('\n')}</screen-recording>`
}

const NOTE = /^<screen-recording frames="(\d+)" duration-ms="(\d+)">[\s\S]*<\/screen-recording>$/

export function parseRecordingNote(text: string): { frames: number; durationMs: number } | null {
  const m = NOTE.exec(text.trim())
  return m ? { frames: Number(m[1]), durationMs: Number(m[2]) } : null
}

export const isRecordingNote = (text: string): boolean => parseRecordingNote(text) !== null

export const countImages = (c: Pick<UserContent, 'images' | 'recordings'>): number =>
  (c.images?.length ?? 0) + (c.recordings ?? []).reduce((n, r) => n + r.frames.length, 0)

/** What the attachments weigh in the request, images, recording frames and documents together. */
export const requestBase64Length = (c: Pick<UserContent, 'images' | 'recordings' | 'documents'>): number =>
  (c.images ?? []).reduce((n, i) => n + i.base64.length, 0) +
  (c.recordings ?? []).reduce((n, r) => n + r.frames.reduce((m, f) => m + f.base64.length, 0), 0) +
  (c.documents ?? []).reduce((n, d) => n + d.base64.length, 0)
