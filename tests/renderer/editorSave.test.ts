import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketFields } from '../../src/shared/tickets'
import { createSaver, createVersionFilter, mergeDisk } from '../../src/renderer/tickets/editorSave'

type Changes = Partial<TicketFields>

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
    const s = createSaver(save, 500, (e) => errors.push(e))
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
