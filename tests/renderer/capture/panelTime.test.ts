import { describe, expect, it } from 'vitest'
import { formatPanelTime } from '../../../src/renderer/capture/panelTime'

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
