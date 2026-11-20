import { describe, expect, it } from 'vitest'
import { sanitizeForLog } from '../../scripts/linear/sanitizeLog.ts'

describe('sanitizeForLog', () => {
  it('keeps ordinary text', () => {
    expect(sanitizeForLog('fetch failed: 401 Unauthorized')).toBe('fetch failed: 401 Unauthorized')
  })

  it('neutralises newlines so a remote message cannot forge log lines', () => {
    expect(sanitizeForLog('boom\nRESTORED: description identical to original\r')).toBe('boom RESTORED: description identical to original ')
  })

  it('neutralises ANSI escapes and C1 controls', () => {
    expect(sanitizeForLog('\u001b[2J\u001b]0;pwned\u0007x\u009b')).toBe(' [2J ]0;pwned x ')
  })

  it('stringifies non-string values', () => {
    expect(sanitizeForLog(42)).toBe('42')
    expect(sanitizeForLog(undefined)).toBe('undefined')
  })
})
