import { beforeEach, describe, expect, it, vi } from 'vitest'
import { preferredMode, rememberMode } from '../../src/renderer/sessions/modePreference'

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) }
  })
})

describe('preferredMode', () => {
  it('is auto when nothing was chosen yet', () => {
    expect(preferredMode()).toBe('auto')
  })

  it('is the last mode chosen', () => {
    rememberMode('plan')
    expect(preferredMode()).toBe('plan')
    rememberMode('default')
    expect(preferredMode()).toBe('default')
  })

  it('falls back to auto on a value the selector cannot show', () => {
    storage.set('canopy.sessionMode', 'bypassPermissions')
    expect(preferredMode()).toBe('auto')
  })

  it('falls back to auto when the storage cannot be read', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(() => rememberMode('plan')).not.toThrow()
    expect(preferredMode()).toBe('auto')
  })
})
