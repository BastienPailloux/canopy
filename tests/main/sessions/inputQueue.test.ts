import { expect, test } from 'vitest'
import { createInputQueue } from '../../../src/main/sessions/inputQueue'

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

test('delivers values pushed before and after the consumer starts, in order', async () => {
  const q = createInputQueue<number>()
  q.push(1)
  const all = drain(q.iterable)
  await Promise.resolve()
  q.push(2)
  q.push(3)
  q.close()
  expect(await all).toEqual([1, 2, 3])
})

test('close ends a waiting consumer', async () => {
  const q = createInputQueue<number>()
  const all = drain(q.iterable)
  q.close()
  expect(await all).toEqual([])
})

test('push after close is ignored', async () => {
  const q = createInputQueue<number>()
  q.close()
  q.push(1)
  expect(await drain(q.iterable)).toEqual([])
})

test('a consumer that stops early closes the queue', async () => {
  const q = createInputQueue<number>()
  q.push(1)
  for await (const v of q.iterable) { expect(v).toBe(1); break }
  q.push(2)
  expect(await drain(q.iterable)).toEqual([])
})
