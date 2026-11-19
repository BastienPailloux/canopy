import { describe, expect, it } from 'vitest'
import { panelPlacement, parseDrag, parseWorkerResult } from '../../../src/main/capture/pageMessages'
import type { DisplayInfo } from '../../../src/shared/captureGeometry'

const main: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
const side: DisplayInfo = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
const panel = { width: 220, height: 44 }
const frame = { t: 0, reason: 'start', base64: 'AAAA' }
const recording = { durationMs: 1000, width: 10, height: 10, frames: [frame], clicksMissing: false }

describe('parseDrag', () => {
  it('keeps a finite drag and drops any other field', () => {
    expect(parseDrag({ x: 1, y: 2, width: -30, height: 40, extra: 1 })).toEqual({ x: 1, y: 2, width: -30, height: 40 })
  })

  it('reads anything else as a cancel', () => {
    expect(parseDrag(null)).toBeNull()
    expect(parseDrag({ x: 1, y: 2, width: Number.NaN, height: 4 })).toBeNull()
    expect(parseDrag({ x: '1', y: 2, width: 3, height: 4 })).toBeNull()
    expect(parseDrag({ x: 1e9, y: 2, width: 3, height: 4 })).toBeNull()
    expect(parseDrag([1, 2, 3, 4])).toBeNull()
  })
})

describe('parseWorkerResult', () => {
  it('accepts each kind of result', () => {
    expect(parseWorkerResult({ kind: 'started' })).toEqual({ kind: 'started' })
    expect(parseWorkerResult({ kind: 'image', base64: 'AAAA' })).toEqual({ kind: 'image', base64: 'AAAA' })
    expect(parseWorkerResult({ kind: 'recording', recording })).toEqual({ kind: 'recording', recording })
    expect(parseWorkerResult({ kind: 'error', message: 'flux' })).toEqual({ kind: 'error', message: 'flux' })
  })

  it('turns a malformed result into an error', () => {
    const invalid = { kind: 'error', message: 'Réponse de capture invalide' }
    expect(parseWorkerResult({ kind: 'image', base64: 3 })).toEqual(invalid)
    expect(parseWorkerResult({ kind: 'image', base64: 'not base64!' })).toEqual(invalid)
    expect(parseWorkerResult({ kind: 'recording', recording: { ...recording, frames: [] } })).toEqual(invalid)
    expect(parseWorkerResult({ kind: 'recording', recording: { ...recording, frames: [{ ...frame, base64: '<script>' }] } })).toEqual(invalid)
    expect(parseWorkerResult({ kind: 'other' })).toEqual(invalid)
    expect(parseWorkerResult(undefined)).toEqual(invalid)
  })

  it('caps the length of an error message', () => {
    const r = parseWorkerResult({ kind: 'error', message: 'x'.repeat(5000) })
    expect(r.kind === 'error' && r.message.length).toBe(500)
  })
})

describe('panelPlacement', () => {
  const region = { x: 100, y: 100, width: 400, height: 300 }

  it('puts the panel below the region when it fits', () => {
    expect(panelPlacement(region, main, [main], panel, false)).toEqual({ x: 100, y: 412 })
  })

  it('may cover the region when the panel is hidden from capture', () => {
    expect(panelPlacement(main.bounds, main, [main], panel, true)).toEqual({ x: 1440 - 220 - 12, y: 900 - 44 - 12 })
  })

  it('moves the panel to another display when it would cover the region', () => {
    expect(panelPlacement(main.bounds, main, [main, side], panel, false)).toEqual({ x: 1440 + 1920 - 220 - 12, y: 1080 - 44 - 12 })
    const almostFull = { x: 0, y: 20, width: 1440, height: 870 }
    expect(panelPlacement(almostFull, main, [side, main], panel, false)).toEqual({ x: 1440 + 1920 - 220 - 12, y: 1080 - 44 - 12 })
  })

  it('opens no panel when no display has room outside the region', () => {
    expect(panelPlacement(main.bounds, main, [main], panel, false)).toBeNull()
  })
})
