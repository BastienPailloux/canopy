import { expect, test, vi } from 'vitest'
import { createOpenFolders } from '../../src/main/openFolders'

test('a folder asked before the page is ready waits, and is not delivered', () => {
  const deliver = vi.fn()
  const q = createOpenFolders(deliver)
  q.push('/a')
  expect(deliver).not.toHaveBeenCalled()
  expect(q.take()).toBe('/a')
})

test('the last folder asked before the page is ready wins', () => {
  const q = createOpenFolders(vi.fn())
  q.push('/a')
  q.push('/b')
  expect(q.take()).toBe('/b')
  expect(q.take()).toBeNull()
})

test('once the page took its folder, the next ones are delivered at once', () => {
  const deliver = vi.fn()
  const q = createOpenFolders(deliver)
  expect(q.take()).toBeNull()
  q.push('/a')
  q.push('/b')
  expect(deliver.mock.calls).toEqual([['/a'], ['/b']])
  expect(q.take()).toBeNull()
})

test('a page that is gone makes the next folders wait again', () => {
  const deliver = vi.fn()
  const q = createOpenFolders(deliver)
  q.take()
  q.reset()
  q.push('/a')
  expect(deliver).not.toHaveBeenCalled()
  expect(q.take()).toBe('/a')
})

test('a relative path is ignored', () => {
  const q = createOpenFolders(vi.fn())
  q.push('relative/dir')
  expect(q.take()).toBeNull()
})
