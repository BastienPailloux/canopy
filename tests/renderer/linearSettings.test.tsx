import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LinearConnection } from '../../src/shared/linear'
import { LinearSettingsView } from '../../src/renderer/shell/Settings'

const html = (connection: LinearConnection): string => renderToStaticMarkup(<LinearSettingsView connection={connection} />)

describe('LinearSettings', () => {
  it('offline with stored tokens: says why, offers Déconnecter, never « Connecter Linear »', () => {
    const out = html({ state: 'offline', error: 'Linear injoignable : fetch failed', missingTools: [] })
    expect(out).toContain('Linear injoignable : fetch failed')
    expect(out).toContain('Déconnecter')
    expect(out).not.toContain('Connecter Linear')
  })

  it('disconnected offers « Connecter Linear »', () => {
    expect(html({ state: 'disconnected', missingTools: [] })).toContain('Connecter Linear')
  })
})
