import { describe, expect, it } from 'vitest'
import { SearchSlots } from '../../../src/main/code/searchSlots'

const pending = (slots: SearchSlots, key: string): { signal: AbortSignal; done: () => void; result: Promise<string | null> } => {
  let done = (): void => undefined
  let signal!: AbortSignal
  const result = slots.run(key, (s) => {
    signal = s
    return new Promise<string>((resolve) => { done = () => resolve('ok') })
  })
  return { signal, done, result }
}

describe('SearchSlots', () => {
  it('a newer run on the same key aborts the older one', () => {
    const slots = new SearchSlots()
    const a = pending(slots, '1:panel')
    const b = pending(slots, '1:panel')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })

  it('runs on other keys do not disturb each other', () => {
    const slots = new SearchSlots()
    const a = pending(slots, '1:panel')
    const b = pending(slots, '1:bar')
    const c = pending(slots, '2:panel')
    expect([a, b, c].map((r) => r.signal.aborted)).toEqual([false, false, false])
  })

  it('resolves null when replaced, and frees the slot when done', async () => {
    const slots = new SearchSlots()
    const abortable = (s: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
      s.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))
      setTimeout(() => resolve('late'), 50)
    })
    const first = slots.run('k', abortable)
    const second = slots.run('k', async () => 'second')
    expect(await first).toBeNull()
    expect(await second).toBe('second')
    expect(slots.size).toBe(0)
  })
})
