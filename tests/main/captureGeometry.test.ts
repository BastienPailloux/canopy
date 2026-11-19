import { expect, test } from 'vitest'
import { clampRegion, fitSize, panelPosition, regionInStream, toImagePoint, type DisplayInfo } from '../../src/shared/captureGeometry'

const main: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
const second: DisplayInfo = { id: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }

test('clampRegion normalizes a drag made backwards', () => {
  expect(clampRegion({ x: 500, y: 400, width: -400, height: -300 }, main)).toEqual({ x: 100, y: 100, width: 400, height: 300 })
})

test('clampRegion clamps a drag overflowing the display', () => {
  expect(clampRegion({ x: 100, y: 100, width: 1900, height: 200 }, main)).toEqual({ x: 100, y: 100, width: 1340, height: 200 })
})

test('clampRegion treats a tiny drag as a click on the whole display', () => {
  expect(clampRegion({ x: 300, y: 300, width: 2, height: 2 }, main)).toEqual(main.bounds)
})

test('regionInStream converts points to stream pixels', () => {
  const region = { x: 100, y: 100, width: 400, height: 300 }
  expect(regionInStream(region, main, { width: 2880, height: 1800 })).toEqual({ x: 200, y: 200, width: 800, height: 600 })
})

test('regionInStream is relative to the display origin', () => {
  const region = { x: 1540, y: 100, width: 400, height: 300 }
  expect(regionInStream(region, second, { width: 2880, height: 1800 }).x).toBe(200)
})

test('fitSize downscales to the max side and never upscales', () => {
  expect(fitSize(3024, 1964)).toEqual({ width: 1568, height: 1018 })
  expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
})

test('toImagePoint maps a click into image pixels, null outside', () => {
  const region = { x: 100, y: 100, width: 400, height: 300 }
  expect(toImagePoint({ x: 300, y: 250 }, region, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 })
  expect(toImagePoint({ x: 50, y: 250 }, region, { width: 800, height: 600 })).toBeNull()
})

test('panelPosition goes below, then above, then in the corner', () => {
  const panel = { width: 300, height: 100 }
  expect(panelPosition({ x: 100, y: 100, width: 400, height: 300 }, main, panel)).toEqual({ x: 100, y: 412 })
  expect(panelPosition({ x: 100, y: 500, width: 400, height: 360 }, main, panel)).toEqual({ x: 100, y: 388 })
  expect(panelPosition(main.bounds, main, panel)).toEqual({ x: 1128, y: 788 })
})
