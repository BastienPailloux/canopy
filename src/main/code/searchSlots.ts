/** The search each caller has running: a newer one on the same key cancels the older. */
export class SearchSlots {
  private readonly running = new Map<string, AbortController>()

  get size(): number { return this.running.size }

  /** Resolves null if replaced by a newer run on `key`. */
  async run<T>(key: string, start: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    this.running.get(key)?.abort()
    const ctl = new AbortController()
    this.running.set(key, ctl)
    try {
      return await start(ctl.signal)
    } catch (err) {
      if (ctl.signal.aborted && err instanceof Error && err.name === 'AbortError') return null
      throw err
    } finally {
      if (this.running.get(key) === ctl) this.running.delete(key)
    }
  }
}
