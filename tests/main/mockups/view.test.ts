import { describe, expect, it } from 'vitest'
import { allowedInView, clampBounds, MockupViewManager, mockupViewOverride, navigationAction, parseBounds } from '../../../src/main/mockups/view'

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

describe('allowedInView', () => {
  it('keeps claude.ai and its login pages, over https only', () => {
    for (const u of ['https://claude.ai/artifact/x', 'https://www.claude.ai/', 'https://console.anthropic.com/',
      'https://a.claudeusercontent.com/f', 'https://accounts.google.com/o/oauth2', 'https://appleid.apple.com/auth', 'https://CLAUDE.AI/']) {
      expect(allowedInView(u), u).toBe(true)
    }
  })

  it('sends the rest to the browser', () => {
    for (const u of ['http://claude.ai/', 'https://claude.ai.evil.com/', 'https://evilclaude.ai/', 'https://anthropic.com.evil.com/',
      'https://evilanthropic.com/', 'https://google.com/', 'https://x.accounts.google.com/', 'https://user:pw@claude.ai/',
      'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'not a url']) {
      expect(allowedInView(u), u).toBe(false)
    }
  })
})

describe('navigationAction', () => {
  const claude = `https://claude.ai/artifact/${SHORT}`
  const away = 'https://example.com/page'

  it('a main-frame link off claude.ai is cancelled and opened in the browser', () => {
    expect(navigationAction({ kind: 'navigate', isMainFrame: true, url: away })).toBe('external')
    expect(navigationAction({ kind: 'navigate', isMainFrame: true, url: claude })).toBe('allow')
  })

  it('a main-frame redirect off claude.ai is only cancelled: no browser without a gesture', () => {
    expect(navigationAction({ kind: 'redirect', isMainFrame: true, url: away })).toBe('cancel')
    expect(navigationAction({ kind: 'redirect', isMainFrame: true, url: 'http://claude.ai/' })).toBe('cancel')
    expect(navigationAction({ kind: 'redirect', isMainFrame: true, url: claude })).toBe('allow')
  })

  it('subframes are left alone', () => {
    expect(navigationAction({ kind: 'navigate', isMainFrame: false, url: away })).toBe('allow')
    expect(navigationAction({ kind: 'redirect', isMainFrame: false, url: away })).toBe('allow')
  })
})
