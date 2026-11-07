import { afterEach, expect, test, vi } from 'vitest'
import { allDrafts, draftCount, dropDraft, dropDrafts, onDraftsChange, setDraft } from '../../src/renderer/code/drafts'

afterEach(() => { dropDrafts('/a'); dropDrafts('/b') })

test('counts unsaved buffers and tells who listens', () => {
  const listener = vi.fn()
  const off = onDraftsChange(listener)
  setDraft('/a', 'x.ts', { text: 't', version: 'v' })
  setDraft('/b', 'y.ts', { text: 't', version: 'v' })
  expect(draftCount()).toBe(2)
  dropDraft('/a', 'x.ts')
  expect(draftCount()).toBe(1)
  expect(listener).toHaveBeenCalledTimes(3)
  off()
  setDraft('/a', 'x.ts', { text: 't', version: 'v' })
  expect(listener).toHaveBeenCalledTimes(3)
})

test('dropDrafts forgets one worktree only', () => {
  setDraft('/a', 'x.ts', { text: 't', version: 'v' })
  setDraft('/a', 'y.ts', { text: 't', version: 'v' })
  setDraft('/b', 'x.ts', { text: 't', version: 'v' })
  dropDrafts('/a')
  expect(draftCount()).toBe(1)
})

test('allDrafts lists every unsaved buffer with its version', () => {
  setDraft('/a', 'x.ts', { text: 't1', version: 'v1' })
  setDraft('/b', 'y.ts', { text: 't2', version: 'v2' })
  expect(allDrafts()).toEqual(expect.arrayContaining([
    { cwd: '/a', path: 'x.ts', text: 't1', version: 'v1' },
    { cwd: '/b', path: 'y.ts', text: 't2', version: 'v2' }
  ]))
  expect(allDrafts()).toHaveLength(2)
})
