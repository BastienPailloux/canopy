import type { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { fakeQuery, selectQuery } from '../../../src/main/sessions/fakeQuery'

const real = (() => { throw new Error('not called') }) as unknown as typeof query

describe('selectQuery', () => {
  it('uses the real query without the variable', () => {
    expect(selectQuery(real, { isPackaged: false, env: {} })).toBe(real)
    expect(selectQuery(real, { isPackaged: false, env: { CANOPY_FAKE_QUERY: '' } })).toBe(real)
  })

  it('selects the fake with the variable in development', () => {
    expect(selectQuery(real, { isPackaged: false, env: { CANOPY_FAKE_QUERY: '1' } })).toBe(fakeQuery)
  })

  it('never selects the fake in a packaged app', () => {
    expect(selectQuery(real, { isPackaged: true, env: { CANOPY_FAKE_QUERY: '1' } })).toBe(real)
  })
})
