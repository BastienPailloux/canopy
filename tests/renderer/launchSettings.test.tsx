import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LaunchSettingsView } from '../../src/renderer/shell/LaunchSettings'
import { toForm } from '../../src/renderer/shell/launchForm'

const noop = (): void => undefined
const html = (saved: boolean, form = toForm(null)): string =>
  renderToStaticMarkup(<LaunchSettingsView form={form} saved={saved} dirty={false} onChange={noop} onSave={noop} onReset={noop} />)

describe('LaunchSettings', () => {
  it('without a setting, says the file applies and offers no reset', () => {
    const out = html(false)
    expect(out).toContain('« Tester la PR » utilise .canopy/config.json')
    expect(out).not.toContain('Revenir au fichier')
  })

  it('with a setting, says it replaces the file and offers to go back to it', () => {
    const out = html(true, toForm({ setup: ['npm ci'], services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }] }))
    expect(out).toContain('remplace .canopy/config.json')
    expect(out).toContain('Revenir au fichier')
    expect(out).toContain('npm run dev')
    expect(out).toContain('npm ci')
  })
})
