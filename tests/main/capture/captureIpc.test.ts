import { describe, expect, it } from 'vitest'
import { captureSettingsUrl, parseCaptureKind, parseTabId } from '../../../src/main/capture/captureIpc'

describe('captureIpc parsing', () => {
  it('accepts the two kinds only', () => {
    expect(parseCaptureKind('screenshot')).toBe('screenshot')
    expect(parseCaptureKind('recording')).toBe('recording')
    for (const k of ['', 'video', null, 1, undefined]) expect(() => parseCaptureKind(k)).toThrow('Capture invalide')
  })

  it('accepts a non-empty tab id up to 200 chars', () => {
    expect(parseTabId('t-1')).toBe('t-1')
    expect(parseTabId('a'.repeat(200))).toBe('a'.repeat(200))
    for (const t of ['', 'a'.repeat(201), null, 3]) expect(() => parseTabId(t)).toThrow('Onglet invalide')
  })
})

describe('captureSettingsUrl', () => {
  it('opens the screen recording pane', () => {
    expect(captureSettingsUrl('screen', 'none')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })

  it('opens the pane of the click permission, Accessibility when none is needed', () => {
    expect(captureSettingsUrl('clicks', 'input-monitoring')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
    expect(captureSettingsUrl('clicks', 'accessibility')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    expect(captureSettingsUrl('clicks', 'none')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  })

  it('refuses anything else', () => {
    expect(() => captureSettingsUrl('mic', 'none')).toThrow('Réglage invalide')
  })
})
