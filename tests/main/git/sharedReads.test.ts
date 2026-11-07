import { expect, test, vi } from 'vitest'
import { Coalescer, TtlCache } from '../../../src/main/git/sharedReads'

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('TtlCache reads once within the delay, again after it', async () => {
  let now = 0
  const cache = new TtlCache<number>(1000, () => now)
  const read = vi.fn(async () => 1)
  await cache.get('a', read)
  now = 999
  await cache.get('a', read)
  expect(read).toHaveBeenCalledOnce()
  now = 1000
  await cache.get('a', read)
  expect(read).toHaveBeenCalledTimes(2)
})

test('TtlCache shares a read in progress, per key', async () => {
  const cache = new TtlCache<number>(1000)
  const d = deferred<number>()
  const read = vi.fn(() => d.promise)
  const both = Promise.all([cache.get('a', read), cache.get('a', read)])
  d.resolve(7)
  expect(await both).toEqual([7, 7])
  expect(read).toHaveBeenCalledOnce()
  await cache.get('b', async () => 8)
  expect(await cache.get('b', read)).toBe(8)
})

test('TtlCache keeps no failure, and clear forgets everything', async () => {
  const cache = new TtlCache<number>(1000)
  await expect(cache.get('a', async () => { throw new Error('no') })).rejects.toThrow('no')
  expect(await cache.get('a', async () => 1)).toBe(1)
  cache.clear()
  expect(await cache.get('a', async () => 2)).toBe(2)
})

test('a read in progress during clear does not fill the cache with stale data', async () => {
  const cache = new TtlCache<number>(1000)
  const d = deferred<number>()
  const stale = cache.get('a', () => d.promise)
  cache.clear()
  d.resolve(1)
  await stale
  expect(await cache.get('a', async () => 2)).toBe(2)
})

test('Coalescer: one in flight, and any number of callers meanwhile share one rerun', async () => {
  const coalescer = new Coalescer<number>()
  const first = deferred<number>()
  const second = deferred<number>()
  const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

  const a = coalescer.run('k', run)
  const b = coalescer.run('k', run)
  const c = coalescer.run('k', run)
  expect(run).toHaveBeenCalledOnce()
  first.resolve(1)
  expect(await a).toBe(1)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  second.resolve(2)
  expect(await Promise.all([b, c])).toEqual([2, 2])
})

test('Coalescer: keys are independent, a failure frees the slot', async () => {
  const coalescer = new Coalescer<number>()
  await expect(coalescer.run('k', async () => { throw new Error('no') })).rejects.toThrow('no')
  const d = deferred<number>()
  const other = vi.fn(async () => 2)
  const a = coalescer.run('k', () => d.promise)
  expect(await coalescer.run('other', other)).toBe(2)
  d.resolve(1)
  expect(await a).toBe(1)
})

test('Coalescer: the rerun still happens after a failed run', async () => {
  const coalescer = new Coalescer<number>()
  const d = deferred<number>()
  const a = coalescer.run('k', () => d.promise)
  const b = coalescer.run('k', async () => 2)
  d.reject(new Error('no'))
  await expect(a).rejects.toThrow('no')
  expect(await b).toBe(2)
})
