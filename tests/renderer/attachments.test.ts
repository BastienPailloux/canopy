import { describe, expect, it } from 'vitest'
import { imageLimitError, recordingLabel, sortFiles } from '../../src/renderer/sessions/attachments'
import type { Recording, RecordingFrame } from '../../src/shared/recording'
import { MAX_REQUEST_BASE64 } from '../../src/shared/recording'
import { MAX_DOCUMENT_BYTES } from '../../src/shared/sessionOptions'

const file = (name: string, type: string, size = 10) => ({ name, type, size })

describe('sortFiles', () => {
  it('puts images and PDFs apart, in order', () => {
    const a = file('a.png', 'image/png')
    const b = file('spec.pdf', 'application/pdf')
    const c = file('b.webp', 'image/webp')
    expect(sortFiles([a, b, c])).toEqual({ images: [a, c], documents: [b], error: null })
  })

  it('refuses other types and says what is accepted', () => {
    const r = sortFiles([file('a.svg', 'image/svg+xml'), file('notes.txt', 'text/plain')])
    expect(r.images).toEqual([])
    expect(r.documents).toEqual([])
    expect(r.error).toBe('Seuls les PDF et les images PNG, JPEG, GIF et WebP sont acceptés.')
  })

  it('refuses a PDF over the limit, by name', () => {
    const big = file('gros.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1)
    const ok = file('petit.pdf', 'application/pdf')
    expect(sortFiles([big, ok])).toEqual({ images: [], documents: [ok], error: '« gros.pdf » dépasse 32 Mo, la limite de Claude.' })
  })
})

const frame = (reason: RecordingFrame['reason']): RecordingFrame => ({ t: 0, reason, base64: 'x' })
const recording = (frames: RecordingFrame[], over: Partial<Recording> = {}): Recording =>
  ({ durationMs: 14_200, width: 10, height: 10, frames, clicksMissing: false, ...over })
const image = { mediaType: 'image/png', base64: 'x' }

describe('imageLimitError', () => {
  it('lets 100 images through, counting the recording frames', () => {
    const draft = { text: '', images: Array(98).fill(image), recordings: [recording([frame('start'), frame('end')])] }
    expect(imageLimitError(draft)).toBeNull()
  })

  it('blocks the 101st and says how many there are', () => {
    const draft = { text: '', images: Array(99).fill(image), recordings: [recording([frame('start'), frame('end')])] }
    expect(imageLimitError(draft)).toBe("Trop d'images pour un seul message (101 / 100) : retire une pièce jointe.")
  })

  it('lets a draft of exactly the request size through', () => {
    const draft = { text: '', images: [{ mediaType: 'image/png', base64: 'A'.repeat(MAX_REQUEST_BASE64 - 4) }], documents: [{ name: 'a.pdf', base64: 'AAAA' }] }
    expect(imageLimitError(draft)).toBeNull()
  })

  it('blocks a draft over the request size and says how heavy it is, rounded up to the Mo', () => {
    const draft = { text: '', images: [{ mediaType: 'image/png', base64: 'A'.repeat(MAX_REQUEST_BASE64) }], recordings: [recording([frame('start')])] }
    expect(imageLimitError(draft)).toBe('Pièces jointes trop lourdes pour un seul message (31 Mo / 30 Mo) : retire une pièce jointe.')
  })
})

describe('recordingLabel', () => {
  it('counts each click once, by its after-click frame', () => {
    const frames = [frame('start'), frame('before-click'), frame('after-click'), frame('before-click'), frame('after-click'), frame('end')]
    expect(recordingLabel(recording(frames))).toBe('14 s · 2 clics')
  })

  it('says 1 clic, and falls back to the before-click frames', () => {
    expect(recordingLabel(recording([frame('before-click')]))).toBe('14 s · 1 clic')
    expect(recordingLabel(recording([frame('start')]))).toBe('14 s · 0 clic')
  })

  it('counts every click when the recording says how many there were', () => {
    expect(recordingLabel(recording([frame('before-click'), frame('after-click')], { clickCount: 6 }))).toBe('14 s · 6 clics')
  })

  it('says when the clicks were not recorded', () => {
    expect(recordingLabel(recording([frame('start')], { clicksMissing: true }))).toBe('14 s · clics non enregistrés')
  })
})
