import { describe, expect, it } from 'vitest'
import { formatPanelTime, panelElapsed } from '../../../src/renderer/capture/panelTime'

describe('formatPanelTime', () => {
  it('shows the elapsed time against the limit', () => {
    expect(formatPanelTime(12_000)).toEqual({ text: '0:12 / 2:00', warning: false })
  })

  it('warns during the last 10 seconds', () => {
    expect(formatPanelTime(110_000)).toEqual({ text: '1:50 / 2:00', warning: true })
    expect(formatPanelTime(109_999).warning).toBe(false)
  })

  it('never goes past the limit', () => {
    expect(formatPanelTime(130_000).text).toBe('2:00 / 2:00')
  })
})

describe('panelElapsed', () => {
  it('stays at 0 until main says the recording started', () => {
    expect(panelElapsed(null, 50_000)).toBe(0)
  })

  it('counts from the start main acknowledged', () => {
    expect(panelElapsed(10_000, 22_000)).toBe(12_000)
  })
})
