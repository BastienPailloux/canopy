import { afterEach, expect, test, vi } from 'vitest'
import type { Worktree } from '../../../src/shared/types'

const lists = vi.hoisted(() => new Map<string, Promise<Worktree[]>>())
vi.mock('../../../src/main/git/worktrees', () => ({ listWorktrees: (repo: string) => lists.get(repo) }))
vi.mock('../../../src/main/code/files', () => ({ watchWorktree: () => () => undefined }))

import { stopAllWatchers, syncWatchers, watchedPaths } from '../../../src/main/code/watchers'

afterEach(() => { stopAllWatchers(); lists.clear() })

const worktree = (path: string): Worktree => ({ path, branch: 'main', head: 'h', isMain: true })

test('ends on the repo asked last, even when the first listing answers last', async () => {
  let answerFirst!: (list: Worktree[]) => void
  lists.set('/first', new Promise((resolve) => { answerFirst = resolve }))
  lists.set('/last', Promise.resolve([worktree('/last')]))

  const first = syncWatchers('/first', () => undefined, () => undefined)
  const last = syncWatchers('/last', () => undefined, () => undefined)
  await new Promise((r) => { setTimeout(r, 10) })
  answerFirst([worktree('/first')])
  await Promise.all([first, last])

  expect(watchedPaths()).toEqual(['/last'])
})
