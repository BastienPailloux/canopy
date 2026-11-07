import { expect, test, vi } from 'vitest'
import { OrphanTracker, removeAndStop, type LiveProcesses } from '../../src/main/worktreeLife'
import type { Worktree } from '../../src/shared/types'

const wt = (path: string): Worktree => ({ path, branch: path.slice(1), head: 'abc', isMain: false })

function live(counts: Record<string, { sessions: number; terminals: number }> = {}): LiveProcesses {
  return {
    sessions: (cwd) => counts[cwd]?.sessions ?? 0,
    terminals: (cwd) => counts[cwd]?.terminals ?? 0,
    stopSessions: vi.fn<(cwd: string) => void>(),
    killTerminals: vi.fn<(cwd: string) => void>()
  }
}

test('a confirmed removal stops the sessions and terminals of the worktree', async () => {
  const processes = live()
  const remove = vi.fn(async () => undefined)
  await removeAndStop('/repo', '/wt', true, processes, remove)
  expect(remove).toHaveBeenCalledWith('/repo', '/wt', true)
  expect(processes.stopSessions).toHaveBeenCalledWith('/wt')
  expect(processes.killTerminals).toHaveBeenCalledWith('/wt')
})

test('a removal git refuses stops nothing', async () => {
  const processes = live()
  await expect(removeAndStop('/repo', '/wt', false, processes, async () => { throw new Error('dirty') })).rejects.toThrow('dirty')
  expect(processes.stopSessions).not.toHaveBeenCalled()
  expect(processes.killTerminals).not.toHaveBeenCalled()
})

test('a worktree gone from the list with live processes is an orphan, with its counts', () => {
  const tracker = new OrphanTracker()
  tracker.observe('/repo', [wt('/a'), wt('/b')])
  tracker.observe('/repo', [wt('/a')])
  expect(tracker.orphans('/repo', live({ '/b': { sessions: 1, terminals: 2 } }))).toEqual([{ ...wt('/b'), sessions: 1, terminals: 2 }])
})

test('a worktree gone with nothing running is forgotten, for good', () => {
  const tracker = new OrphanTracker()
  tracker.observe('/repo', [wt('/a'), wt('/b')])
  tracker.observe('/repo', [wt('/a')])
  expect(tracker.orphans('/repo', live())).toEqual([])
  expect(tracker.orphans('/repo', live({ '/b': { sessions: 1, terminals: 0 } }))).toEqual([])
})

test('a worktree still listed, or of another repo, is no orphan', () => {
  const tracker = new OrphanTracker()
  tracker.observe('/repo', [wt('/a')])
  tracker.observe('/other', [wt('/b')])
  tracker.observe('/other', [])
  expect(tracker.orphans('/repo', live({ '/a': { sessions: 1, terminals: 0 }, '/b': { sessions: 1, terminals: 0 } }))).toEqual([])
})

test('a worktree that comes back is no orphan any more', () => {
  const tracker = new OrphanTracker()
  tracker.observe('/repo', [wt('/a')])
  tracker.observe('/repo', [])
  tracker.observe('/repo', [wt('/a')])
  expect(tracker.orphans('/repo', live({ '/a': { sessions: 1, terminals: 0 } }))).toEqual([])
})
