import { expect, test } from 'vitest'
import { parseCaptureClick } from '../../src/shared/capture'

test('parseCaptureClick keeps a click of finite numbers, and its fields only', () => {
  expect(parseCaptureClick({ t: 1, x: -2.5, y: 3, extra: 'x' })).toEqual({ t: 1, x: -2.5, y: 3 })
})

test.each([
  ['null', null],
  ['an array', [1, 2, 3]],
  ['a missing field', { t: 1, x: 2 }],
  ['a string', { t: '1', x: 2, y: 3 }],
  ['NaN', { t: 1, x: NaN, y: 3 }],
  ['Infinity', { t: 1, x: 2, y: Infinity }]
])('parseCaptureClick refuses %s', (_name, v) => {
  expect(parseCaptureClick(v)).toBeNull()
})
