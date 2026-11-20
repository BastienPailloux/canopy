import { expect, test } from 'vitest'
import { MAX_RECORDING_MS, MAX_REQUEST_BASE64, type Recording } from '../../../src/shared/recording'
import { MAX_DOCUMENT_BASE64, MAX_DOCUMENT_BYTES } from '../../../src/shared/sessionOptions'
import { assertContent, assertMode, parseDecision, parseStartOptions } from '../../../src/main/sessions/validate'

const content = { text: 'hi' }

test('parseStartOptions keeps known fields only', () => {
  expect(parseStartOptions({ content, resumeId: 'abc', model: 'opus', mode: 'plan', trusted: true })).toEqual({
    content, resumeId: 'abc', model: 'opus', mode: 'plan'
  })
})

test('parseStartOptions treats an empty resumeId as absent', () => {
  expect(parseStartOptions({ content, resumeId: '' })).toEqual({ content })
})

test.each([
  ['no options', undefined],
  ['no content', {}],
  ['resumeId', { content, resumeId: 3 }],
  ['model', { content, model: 3 }],
  ['empty model', { content, model: '' }],
  ['mode', { content, mode: 'yolo' }]
])('parseStartOptions rejects an invalid %s', (_name, o) => {
  expect(() => parseStartOptions(o)).toThrow()
})

test('assertContent accepts the allowed image types', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    expect(() => assertContent({ text: '', images: [{ mediaType, base64: 'AAAA' }] })).not.toThrow()
  }
})

test('assertContent accepts PDF documents', () => {
  expect(() => assertContent({ text: '', documents: [{ name: 'doc.pdf', base64: 'AAAA' }] })).not.toThrow()
})

test('assertContent accepts a request of exactly the size limit, and not one character more', () => {
  const half = MAX_REQUEST_BASE64 / 2
  const content = (extra: number) => ({
    text: '',
    images: [{ mediaType: 'image/png', base64: 'A'.repeat(half - 4) }],
    recordings: [{ durationMs: 1000, width: 10, height: 10, clicksMissing: false, frames: [{ t: 0, reason: 'start', base64: 'AAAA' }] }],
    documents: [{ name: 'doc.pdf', base64: 'A'.repeat(half + extra) }]
  })
  expect(() => assertContent(content(0))).not.toThrow()
  expect(() => assertContent(content(4))).toThrow()
})

test('assertContent rejects a PDF one byte over its own limit', () => {
  const over = 'A'.repeat(MAX_DOCUMENT_BASE64)
  expect(Buffer.from(over, 'base64').length).toBe(MAX_DOCUMENT_BYTES + 1)
  expect(() => assertContent({ text: '', documents: [{ name: 'doc.pdf', base64: over }] })).toThrow()
})

test.each([
  ['null', null],
  ['a missing text', {}],
  ['images that are no array', { text: '', images: 'x' }],
  ['a null image', { text: '', images: [null] }],
  ['an unknown image type', { text: '', images: [{ mediaType: 'image/svg+xml', base64: 'AAAA' }] }],
  ['a missing base64', { text: '', images: [{ mediaType: 'image/png' }] }],
  ['documents that are no array', { text: '', documents: 'x' }],
  ['a document with no name', { text: '', documents: [{ base64: 'AAAA' }] }],
  ['a document with no base64', { text: '', documents: [{ name: 'doc.pdf' }] }],
  ['a document over the size limit', { text: '', documents: [{ name: 'doc.pdf', base64: 'A'.repeat(MAX_DOCUMENT_BASE64 + 4) }] }]
])('assertContent rejects %s', (_name, c) => {
  expect(() => assertContent(c)).toThrow()
})

test('assertMode rejects bypassPermissions and unknown modes', () => {
  expect(() => assertMode('acceptEdits')).not.toThrow()
  expect(() => assertMode('bypassPermissions')).toThrow()
  expect(() => assertMode('yolo')).toThrow()
})

test('parseDecision keeps known fields only', () => {
  const updatedInput = { a: 1 }
  expect(parseDecision({ allow: true, always: true, updatedInput, x: 1 })).toEqual({ allow: true, always: true, updatedInput })
  expect(parseDecision({ allow: true })).toEqual({ allow: true })
  expect(parseDecision({ allow: false, message: 'Non', always: true })).toEqual({ allow: false, message: 'Non' })
})

test.each([
  ['null', null],
  ['a missing allow', {}],
  ['a truthy allow', { allow: 'yes' }],
  ['a non-boolean always', { allow: true, always: 'yes' }],
  ['an updatedInput array', { allow: true, updatedInput: [] }],
  ['a deny without message', { allow: false }]
])('parseDecision rejects %s', (_name, d) => {
  expect(() => parseDecision(d)).toThrow()
})

const rec = (over: Record<string, unknown> = {}): Recording => ({
  durationMs: 5000, width: 800, height: 600, clicksMissing: false,
  frames: [{ t: 0, reason: 'start', base64: 'AAAA' }, { t: 5000, reason: 'end', base64: 'AAAA' }],
  ...over
})
const frames = (n: number) => Array.from({ length: n }, (_, t) => ({ t, reason: 'change' as const, base64: 'AAAA' }))

test('assertContent accepts a valid recording', () => {
  expect(() => assertContent({ text: '', recordings: [rec()] })).not.toThrow()
})

test('assertContent accepts a click count, the largest zone and clicks on its edges', () => {
  const click = (x: number, y: number) => ({ t: 0, reason: 'before-click', click: { x, y }, base64: 'AAAA' })
  expect(() => assertContent({ text: '', recordings: [rec({ clickCount: 0 }), rec({ clickCount: 7 })] })).not.toThrow()
  expect(() => assertContent({ text: '', recordings: [rec({ width: 16384, height: 16384 })] })).not.toThrow()
  expect(() => assertContent({ text: '', recordings: [rec({ frames: [click(0, 0), click(800, 600)] })] })).not.toThrow()
})

test.each([
  ['no frames', rec({ frames: [] })],
  ['too many frames', rec({ frames: frames(21) })],
  ['a frame without base64 string', rec({ frames: [{ t: 0, reason: 'start', base64: 3 }] })],
  ['a frame without numeric t', rec({ frames: [{ t: '0', reason: 'start', base64: 'AAAA' }] })],
  ['a too long duration', rec({ durationMs: MAX_RECORDING_MS + 5001 })],
  ['a zero width', rec({ width: 0 })],
  ['a fractional height', rec({ height: 10.5 })],
  ['an unknown frame reason', rec({ frames: [{ t: 0, reason: 'boom', base64: 'AAAA' }] })],
  ['a non-numeric click', rec({ frames: [{ t: 0, reason: 'start', click: { x: '1', y: 2 }, base64: 'AAAA' }] })],
  ['a click that is not an object', rec({ frames: [{ t: 0, reason: 'start', click: 3, base64: 'AAAA' }] })],
  ['a NaN t', rec({ frames: [{ t: NaN, reason: 'start', base64: 'AAAA' }] })],
  ['an infinite t', rec({ frames: [{ t: Infinity, reason: 'start', base64: 'AAAA' }] })],
  ['a negative t', rec({ frames: [{ t: -1, reason: 'start', base64: 'AAAA' }] })],
  ['a NaN duration', rec({ durationMs: NaN })],
  ['a negative duration', rec({ durationMs: -1 })],
  ['non-boolean clicksMissing', rec({ clicksMissing: 'no' })],
  ['a too wide zone', rec({ width: 16385 })],
  ['a too high zone', rec({ height: 16385 })],
  ['a click left of the image', rec({ frames: [{ t: 0, reason: 'before-click', click: { x: -1, y: 2 }, base64: 'AAAA' }] })],
  ['a click right of the image', rec({ frames: [{ t: 0, reason: 'before-click', click: { x: 801, y: 2 }, base64: 'AAAA' }] })],
  ['a click below the image', rec({ frames: [{ t: 0, reason: 'before-click', click: { x: 1, y: 601 }, base64: 'AAAA' }] })],
  ['a negative click count', rec({ clickCount: -1 })],
  ['a fractional click count', rec({ clickCount: 1.5 })],
  ['an infinite click count', rec({ clickCount: Infinity })],
  ['a non-numeric click count', rec({ clickCount: '3' })]
])('assertContent rejects a recording with %s', (_name, recording) => {
  expect(() => assertContent({ text: '', recordings: [recording] })).toThrow('Message invalide')
})

test('assertContent rejects more than 100 images in a message', () => {
  const images = Array.from({ length: 90 }, () => ({ mediaType: 'image/png', base64: 'AAAA' }))
  expect(() => assertContent({ text: '', images, recordings: [rec({ frames: frames(11) })] })).toThrow('Message invalide')
})
