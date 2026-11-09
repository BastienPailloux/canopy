import { describe, expect, it } from 'vitest'
import { fromForm, toForm, toSave } from '../../src/renderer/shell/launchForm'

describe('launch settings form', () => {
  it('no setting yet: an empty form with one service row to fill', () => {
    expect(toForm(null)).toEqual({ setup: '', services: [{ name: '', command: '', portEnv: '' }] })
  })

  it('shows one setup command per line, and the default port variable as empty', () => {
    expect(toForm({ setup: ['npm ci', 'npm run build'], services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }, { name: 'vite', command: 'vite', portEnv: 'VITE_PORT' }] })).toEqual({
      setup: 'npm ci\nnpm run build',
      services: [{ name: 'web', command: 'npm run dev', portEnv: '' }, { name: 'vite', command: 'vite', portEnv: 'VITE_PORT' }]
    })
  })

  it('reads back a config, trimming and skipping blank lines and empty rows', () => {
    expect(fromForm({
      setup: '  npm ci \n\n npm run build\n',
      services: [{ name: ' web ', command: ' npm run dev ', portEnv: ' ' }, { name: '', command: '  ', portEnv: '' }, { name: 'vite', command: 'vite', portEnv: 'VITE_PORT' }]
    })).toEqual({
      setup: ['npm ci', 'npm run build'],
      services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }, { name: 'vite', command: 'vite', portEnv: 'VITE_PORT' }]
    })
  })
})

describe('launch settings to save', () => {
  it('a form left empty means going back to the file', () => {
    expect(toSave({ setup: ' \n', services: [{ name: '', command: '', portEnv: '' }] })).toBeNull()
  })

  it('a filled form is saved as its config', () => {
    expect(toSave({ setup: 'npm ci', services: [] })).toEqual({ setup: ['npm ci'], services: [] })
  })
})
