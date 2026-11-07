import type { BaseRef, Worktree } from '../../shared/types'
import { resolveBaseRef, resolveCompareRef } from './refs'
import { listWorktrees } from './worktrees'

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

interface Slot<T> {
  rerun?: Promise<T>
  begin?: () => void
}

/**
 * One run per key at a time. Callers arriving during a run share a single rerun after it,
 * so that they see what happened after they asked, whatever the number of file events.
 */
export class Coalescer<T> {
  private readonly slots = new Map<string, Slot<T>>()

  run(key: string, work: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(key)
    if (!slot) return this.start(key, work)
    slot.rerun ??= new Promise<T>((resolve) => {
      slot.begin = () => resolve(this.start(key, work))
    })
    return slot.rerun
  }

  private start(key: string, work: () => Promise<T>): Promise<T> {
    const slot: Slot<T> = {}
    this.slots.set(key, slot)
    const running = work()
    const settled = (): void => {
      this.slots.delete(key)
      slot.begin?.()
    }
    running.then(settled, settled)
    return running
  }
}

const READ_TTL_MS = 5_000

const worktrees = new TtlCache<Worktree[]>(READ_TTL_MS)
const baseRefs = new TtlCache<BaseRef>(READ_TTL_MS)

/** For what polls: the sidebar and the repo picker. Anything deciding on trust reads git itself. */
export const cachedWorktrees = (repo: string): Promise<Worktree[]> => worktrees.get(repo, () => listWorktrees(repo))

/** The base remembered for the repo of `cwd`, if any. Injected, so that this module stays free of the app store. */
type BaseOverride = (cwd: string) => Promise<string | null | undefined>
let baseOverride: BaseOverride | undefined

export function setBaseOverride(lookup: BaseOverride | undefined): void {
  baseOverride = lookup
}

/** The remembered base while its ref exists, else the repo's default one. */
async function readBaseRef(cwd: string): Promise<BaseRef> {
  const remembered = await baseOverride?.(cwd).catch(() => null)
  if (remembered) {
    try {
      return await resolveCompareRef(cwd, remembered)
    } catch {
      // the branch is gone: fall back
    }
  }
  return resolveBaseRef(cwd)
}

export const cachedBaseRef = (cwd: string): Promise<BaseRef> => baseRefs.get(cwd, () => readBaseRef(cwd))

/** After a change: the next read must see it. */
export function clearSharedReads(): void {
  worktrees.clear()
  baseRefs.clear()
}
