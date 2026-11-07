export interface InputQueue<T> {
  push(v: T): void
  close(): void
  iterable: AsyncIterable<T>
}

/** Unbounded single-consumer queue feeding a long-lived async iteration. */
export function createInputQueue<T>(): InputQueue<T> {
  const items: T[] = []
  let waiter: ((r: IteratorResult<T>) => void) | undefined
  let closed = false

  const close = (): void => {
    closed = true
    waiter?.({ value: undefined, done: true })
    waiter = undefined
  }

  return {
    push(v) {
      if (closed) return
      if (waiter) {
        waiter({ value: v, done: false })
        waiter = undefined
      } else {
        items.push(v)
      }
    },
    close,
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (items.length > 0) return Promise.resolve({ value: items.shift() as T, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiter = resolve })
        },
        return: () => {
          close()
          return Promise.resolve({ value: undefined, done: true })
        }
      })
    }
  }
}
