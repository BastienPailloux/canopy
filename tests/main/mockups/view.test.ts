import { describe, expect, it } from 'vitest'
import { clampBounds, MockupViewManager, mockupViewOverride, parseBounds } from '../../../src/main/mockups/view'

const SHORT = 'WcXTxNhxSWaDL28ttqjZye'

describe('clampBounds', () => {
  it('rounds to integers and clamps at zero', () => {
    expect(clampBounds({ x: 10.4, y: 20.6, width: 300.5, height: 199.49 })).toEqual({ x: 10, y: 21, width: 301, height: 199 })
    expect(clampBounds({ x: -5, y: -0.4, width: -10, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('parseBounds', () => {
  it('accepts finite numbers only', () => {
    expect(parseBounds({ x: 1.2, y: 2, width: 3, height: 4, extra: 'x' })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    for (const raw of [null, {}, { x: 1, y: 2, width: 3 }, { x: NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: Infinity, height: 1 }, { x: '1', y: 0, width: 1, height: 1 }]) {
      expect(() => parseBounds(raw), JSON.stringify(raw)).toThrow(/invalide/)
    }
  })
})

describe('mockupViewOverride', () => {
  it('only in an e2e dev run, when set', () => {
    const e2e = { CANOPY_FAKE_QUERY: '1', CANOPY_MOCKUP_VIEW_URL: 'about:blank' }
    expect(mockupViewOverride({ isPackaged: false, env: e2e })).toBe('about:blank')
    expect(mockupViewOverride({ isPackaged: true, env: e2e })).toBeUndefined()
    expect(mockupViewOverride({ isPackaged: false, env: { CANOPY_MOCKUP_VIEW_URL: 'about:blank' } })).toBeUndefined()
    expect(mockupViewOverride({ isPackaged: false, env: { CANOPY_FAKE_QUERY: '1' } })).toBeUndefined()
  })
})

describe('MockupViewManager.accepts', () => {
  const open = async (): Promise<void> => undefined

  it('canonicalizes mockup urls and refuses the rest', () => {
    const m = new MockupViewManager({ openExternal: open })
    expect(m.accepts(`https://claude.ai/artifact/x-${SHORT}?a=1`)).toBe(`https://claude.ai/artifact/${SHORT}`)
    expect(m.accepts('https://evil.com/')).toBeNull()
    expect(m.accepts('about:blank')).toBeNull()
    expect(m.accepts(42)).toBeNull()
  })

  it('accepts the e2e page when one is set', () => {
    const m = new MockupViewManager({ openExternal: open, override: 'about:blank' })
    expect(m.accepts('about:blank')).toBe('about:blank')
    expect(m.accepts('https://evil.com/')).toBeNull()
  })
})
