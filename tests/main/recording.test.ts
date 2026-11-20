import { expect, test } from 'vitest'
import { countImages, isRecordingNote, MAX_REQUEST_BASE64, requestBase64Length, parseRecordingNote, recordingNote, type Recording } from '../../src/shared/recording'

const frame = (t: number, reason: Recording['frames'][number]['reason'], click?: { x: number; y: number }) =>
  ({ t, reason, ...(click ? { click } : {}), base64: 'AAAA' })

const r4: Recording = {
  durationMs: 14200, width: 1280, height: 800, clicksMissing: false,
  frames: [frame(0, 'start'), frame(3900, 'before-click', { x: 812, y: 340 }), frame(4400, 'after-click', { x: 812, y: 340 }), frame(6100, 'change')]
}

test('recordingNote lists the frames as a timeline', () => {
  expect(recordingNote(r4)).toBe(
    `<screen-recording frames="4" duration-ms="14200">Enregistrement d'écran de 14,2 s (zone 1280×800), 4 images dans l'ordre.
Image 1 — t = 0,0 s : début
Image 2 — t = 3,9 s : avant clic en (812, 340)
Image 3 — t = 4,4 s : après clic en (812, 340)
Image 4 — t = 6,1 s : l'écran change</screen-recording>`
  )
})

test('an end frame reads fin', () => {
  expect(recordingNote({ ...r4, frames: [frame(0, 'start'), frame(2000, 'end')] })).toContain('Image 2 — t = 2,0 s : fin')
})

test('missing clicks are flagged right after the first line', () => {
  const lines = recordingNote({ ...r4, clicksMissing: true }).split('\n')
  expect(lines[1]).toBe('Clics non enregistrés.')
  expect(lines[2]).toBe('Image 1 — t = 0,0 s : début')
})

test('a click count above the clicks shown is told after the first line', () => {
  const lines = recordingNote({ ...r4, clickCount: 5 }).split('\n')
  expect(lines[1]).toBe('5 clics au total, 1 montré.')
  expect(lines[2]).toBe('Image 1 — t = 0,0 s : début')
  const two = { ...r4, clickCount: 4, frames: [...r4.frames, frame(7000, 'before-click', { x: 1, y: 1 }), frame(7500, 'after-click', { x: 1, y: 1 })] }
  expect(recordingNote(two).split('\n')[1]).toBe('4 clics au total, 2 montrés.')
})

test('a click count equal to the clicks shown adds nothing', () => {
  expect(recordingNote({ ...r4, clickCount: 1 })).toBe(recordingNote(r4))
})

test('parseRecordingNote reads back the frame count and duration', () => {
  expect(parseRecordingNote(recordingNote(r4))).toEqual({ frames: 4, durationMs: 14200 })
  expect(parseRecordingNote('hello')).toBeNull()
})

test('isRecordingNote matches the whole text only', () => {
  expect(isRecordingNote(`\n ${recordingNote(r4)} \n`)).toBe(true)
  expect(isRecordingNote(`avant ${recordingNote(r4)}`)).toBe(false)
  expect(isRecordingNote(`${recordingNote(r4)} après`)).toBe(false)
})

test('countImages adds images and every recording frame', () => {
  const r3 = { ...r4, frames: r4.frames.slice(0, 3) }
  const img = { mediaType: 'image/png', base64: 'AAAA' }
  expect(countImages({ images: [img, img], recordings: [r4, r3] })).toBe(9)
  expect(countImages({})).toBe(0)
})

test('requestBase64Length adds images, recording frames and documents', () => {
  const img = { mediaType: 'image/png', base64: 'AAAA' }
  expect(requestBase64Length({ images: [img], recordings: [r4], documents: [{ name: 'a.pdf', base64: 'AAAAAAAA' }] })).toBe(4 + 16 + 8)
  expect(requestBase64Length({})).toBe(0)
  expect(MAX_REQUEST_BASE64).toBe(30 * 1024 * 1024)
})
