import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DESCRIPTION, MAX_TITLE, type TicketFields, type TicketPatch } from '../../src/shared/tickets'
import { closeSaver, createSaver, createVersionFilter, draftToCreate, flushSavers, mergeDisk, notifySavers, onSaversChange, quickTicketFields, trackSaver, unsavedTickets } from '../../src/renderer/tickets/editorSave'

type Changes = TicketPatch

describe('createSaver', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('coalesces changes into one save', async () => {
    const save = vi.fn(async (_c: Changes) => {})
    const s = createSaver(save, 500)
    s.change({ title: 'Export' })
    await vi.advanceTimersByTimeAsync(300)
    s.change({ labels: ['DPP'] })
    await vi.advanceTimersByTimeAsync(499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ title: 'Export', labels: ['DPP'] })
  })

  it('flush saves pending changes immediately', async () => {
    const save = vi.fn(async (_c: Changes) => {})
    const s = createSaver(save, 500)
    s.change({ description: 'Texte' })
    await s.flush()
    expect(save).toHaveBeenCalledWith({ description: 'Texte' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('later change of a key wins', async () => {
    const save = vi.fn(async (_c: Changes) => {})
    const s = createSaver(save, 500)
    s.change({ status: 'todo', priority: 'high' })
    s.change({ status: 'done' })
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledWith({ status: 'done', priority: 'high' })
  })

  it('flush with nothing pending saves nothing', async () => {
    const save = vi.fn(async (_c: Changes) => {})
    await createSaver(save, 500).flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('reports keys pending or being saved, until their save ends', async () => {
    let done: () => void = () => {}
    const save = vi.fn((_c: Changes) => new Promise<void>((r) => { done = r }))
    const s = createSaver(save, 500)
    s.change({ title: 'A' })
    expect([...s.pending()]).toEqual(['title'])
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect([...s.pending()]).toEqual(['title'])
    done()
    await vi.advanceTimersByTimeAsync(0)
    expect([...s.pending()]).toEqual([])
  })

  it('runs one save at a time, in order', async () => {
    const calls: Changes[] = []
    let release: () => void = () => {}
    const save = vi.fn((c: Changes) => { calls.push(c); return new Promise<void>((r) => { release = r }) })
    const s = createSaver(save, 500)
    s.change({ title: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    s.change({ title: 'B' })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual([{ title: 'A' }])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([{ title: 'A' }, { title: 'B' }])
    release()
    await s.flush()
  })

  it('keeps a failed change pending for the next save, unless changed since', async () => {
    const errors: unknown[] = []
    const save = vi.fn(async (c: Changes) => { if (save.mock.calls.length === 1) throw new Error(`refusé ${Object.keys(c)}`) })
    const s = createSaver(save, 500, { onError: (e) => errors.push(e) })
    s.change({ title: 'A', description: 'd' })
    await vi.advanceTimersByTimeAsync(500)
    expect(errors).toHaveLength(1)
    expect([...s.pending()].sort()).toEqual(['description', 'title'])
    s.change({ title: 'B' })
    await s.flush()
    expect(save).toHaveBeenLastCalledWith({ title: 'B', description: 'd' })
    expect([...s.pending()]).toEqual([])
  })
})

describe('mergeDisk', () => {
  const base: TicketFields & { id: string; updated: string } = {
    id: 'A-1', updated: '1', title: 'Local', description: 'mine', status: 'todo', priority: 'high', labels: ['x'], subtasks: []
  }
  it('takes disk values except for kept keys; branch and dates always from disk', () => {
    const disk = { ...base, updated: '2', title: 'Disk', description: 'theirs', status: 'done' as const, branch: 'feat/x', worktree: '/w' }
    const out = mergeDisk(base, disk, new Set(['description'] as const))
    expect(out).toEqual({ ...disk, description: 'mine' })
  })
})

describe('createVersionFilter', () => {
  const v = (title: string, updated: string) => ({ id: 'A-1', title, description: '', status: 'todo' as const, priority: 'none' as const, labels: [], subtasks: [], created: '', updated, archived: false })
  it('lets each version through once, whatever its clock says', () => {
    const fresh = createVersionFilter()
    expect(fresh(v('a', '2026-11-08T10:00:00Z'))).toBe(true)
    expect(fresh(v('b', '2026-11-08T01:00:00Z'))).toBe(true)
    // A read started before the last save answers late: already seen.
    expect(fresh(v('a', '2026-11-08T10:00:00Z'))).toBe(false)
    expect(fresh(v('b', '2026-11-08T01:00:00Z'))).toBe(false)
    // Edited by hand without touching `updated`: new content.
    expect(fresh(v('c', '2026-11-08T01:00:00Z'))).toBe(true)
  })
})

describe('saver retries and flush result', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('retries a failed save on its own after retryMs', async () => {
    let fail = true
    const save = vi.fn(async (_c: Changes) => { if (fail) throw new Error('disque plein') })
    const s = createSaver(save, 500, { retryMs: 2000, onError: () => {} })
    s.change({ title: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    fail = false
    await vi.advanceTimersByTimeAsync(1999)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(s.pending().size).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('dispose stops the timers', async () => {
    const save = vi.fn(async (_c: Changes) => { throw new Error('x') })
    const s = createSaver(save, 500, { retryMs: 1000, onError: () => {} })
    s.change({ title: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    s.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush resolves true once everything is written, false when something stays pending', async () => {
    let fail = true
    const s = createSaver(async () => { if (fail) throw new Error('x') }, 500, { onError: () => {} })
    expect(await s.flush()).toBe(true)
    s.change({ title: 'A' })
    expect(await s.flush()).toBe(false)
    fail = false
    expect(await s.flush()).toBe(true)
  })

  it('tells onPending when the pending keys may have changed', async () => {
    const onPending = vi.fn()
    const s = createSaver(async () => {}, 500, { onPending })
    s.change({ title: 'A' })
    expect(onPending).toHaveBeenCalled()
    onPending.mockClear()
    await s.flush()
    expect(onPending).toHaveBeenCalled()
  })
})

describe('open savers registry', () => {
  it('counts the tracked savers with pending changes, notifies, and flushes them all', async () => {
    const seen: number[] = []
    const off = onSaversChange(() => seen.push(unsavedTickets()))
    const save = vi.fn(async (_c: Changes) => {})
    const a = createSaver(save, 60_000, { onPending: notifySavers })
    const b = createSaver(save, 60_000, { onPending: notifySavers })
    const untrackA = trackSaver(a)
    const untrackB = trackSaver(b)
    expect(unsavedTickets()).toBe(0)
    a.change({ title: 'A' })
    b.change({ description: 'B' })
    expect(unsavedTickets()).toBe(2)
    expect(seen.at(-1)).toBe(2)
    await flushSavers()
    expect(save).toHaveBeenCalledTimes(2)
    expect(unsavedTickets()).toBe(0)
    expect(seen.at(-1)).toBe(0)
    a.change({ title: 'C' })
    untrackA()
    expect(unsavedTickets()).toBe(0)
    untrackB()
    off()
    a.dispose()
  })
})

describe('draftToCreate', () => {
  const draft = { title: '', description: 'd', status: 'todo' as const, priority: 'high' as const, labels: ['x'], subtasks: [] }
  it('creates from what the editor shows, nothing while its title is empty or erased', () => {
    expect(draftToCreate(draft)).toBeNull()
    expect(draftToCreate({ ...draft, title: '   ' })).toBeNull()
    expect(draftToCreate({ ...draft, title: 'T' })).toEqual({ ...draft, title: 'T' })
  })
})

describe('closeSaver', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('untracks at once when the last flush works', async () => {
    const s = createSaver(async () => {}, 500, { onPending: notifySavers })
    trackSaver(s)
    s.change({ title: 'A' })
    await closeSaver(s, () => true)
    expect(unsavedTickets()).toBe(0)
    s.change({ title: 'B' })
    expect(unsavedTickets()).toBe(0)
    s.dispose()
  })

  it('a failed flush on close stays counted and retried with backoff; a later success untracks it', async () => {
    let fail = true
    const save = vi.fn(async (_c: Changes) => { if (fail) throw new Error('x') })
    const s = createSaver(save, 500, { onPending: notifySavers, onError: () => {}, retryMs: 3000 })
    trackSaver(s)
    s.change({ title: 'A' })
    void closeSaver(s, () => true, { firstMs: 1000, maxMs: 4000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(unsavedTickets()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(save).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(4000)
    expect(save).toHaveBeenCalledTimes(5)
    expect(unsavedTickets()).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(4000)
    expect(save).toHaveBeenCalledTimes(6)
    expect(unsavedTickets()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(6)
  })

  it('stops when the editor came back (StrictMode remount): the saver stays its own', async () => {
    const save = vi.fn(async (_c: Changes) => { throw new Error('x') })
    const s = createSaver(save, 500, { onPending: notifySavers, onError: () => {}, retryMs: 3000 })
    const untrack = trackSaver(s)
    s.change({ title: 'A' })
    await closeSaver(s, () => false)
    expect(unsavedTickets()).toBe(1)
    // Its own retry timer still runs.
    await vi.advanceTimersByTimeAsync(3000)
    expect(save).toHaveBeenCalledTimes(2)
    untrack()
    s.dispose()
  })
})

describe('quickTicketFields', () => {
  it('creates nothing without a title', () => {
    expect(quickTicketFields('  ', 'x')).toBeNull()
  })

  it('creates nothing past the limits the main process enforces', () => {
    expect(quickTicketFields('a'.repeat(MAX_TITLE + 1), '')).toBeNull()
    expect(quickTicketFields('Bug', 'd'.repeat(MAX_DESCRIPTION + 1))).toBeNull()
    expect(quickTicketFields('a'.repeat(MAX_TITLE), 'd'.repeat(MAX_DESCRIPTION))).not.toBeNull()
  })

  it('takes the trimmed title and the editor defaults', () => {
    expect(quickTicketFields(' Bug ', 'd')).toEqual({ title: 'Bug', description: 'd', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
  })
})
