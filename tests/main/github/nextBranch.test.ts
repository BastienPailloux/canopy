import { describe, expect, it } from 'vitest'
import { nextBranch } from '../../../src/main/github/cleanup'

type PrState = 'open' | 'merged' | 'closed' | null
const base = (o: Partial<Parameters<typeof nextBranch>[0]> = {}): Parameters<typeof nextBranch>[0] => ({
  history: ['a', 'b', 'c'],
  current: 'c',
  locals: new Set(['a', 'b', 'c']),
  base: 'main',
  heldElsewhere: new Set(),
  prState: () => 'open',
  ...o
})

describe('nextBranch', () => {
  it('picks the most recent open branch', () => {
    expect(nextBranch(base())).toBe('b')
  })

  it('counts a branch without PR as in progress', () => {
    expect(nextBranch(base({ prState: () => null }))).toBe('b')
  })

  it('skips merged, closed, deleted, base and held branches', () => {
    const states: Record<string, PrState> = { a: 'merged', b: 'closed', d: 'open', main: 'open', e: 'open' }
    expect(nextBranch(base({
      history: ['e', 'main', 'gone', 'd', 'a', 'b', 'c'],
      locals: new Set(['a', 'b', 'c', 'd', 'e', 'main']),
      heldElsewhere: new Set(['d', 'e']),
      prState: (b) => states[b] ?? null
    }))).toBeNull()
  })

  it('never returns the current branch', () => {
    expect(nextBranch(base({ history: ['c'] }))).toBeNull()
  })
})
