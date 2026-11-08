import { expect, test } from 'vitest'
import { MAX_DOCUMENT_BASE64 } from '../../../src/shared/sessionOptions'
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

test('assertContent accepts PDF documents', () => {
  expect(() => assertContent({ text: '', documents: [{ name: 'doc.pdf', base64: 'AAAA' }] })).not.toThrow()
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
