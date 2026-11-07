/** Answers from memory for `ttlMs`. Concurrent reads share one call, a failure is not kept. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; at: number }>()

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string, read: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key)
    if (entry && this.now() - entry.at < this.ttlMs) return entry.value
    const value = read()
    const fresh = { value, at: this.now() }
    this.entries.set(key, fresh)
    value.catch(() => { if (this.entries.get(key) === fresh) this.entries.delete(key) })
    return value
  }

  clear(): void {
    this.entries.clear()
  }
}
