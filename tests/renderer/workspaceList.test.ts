import { describe, expect, it } from 'vitest'
import { defaultEntry, entryLabel, entryPaths, groupEntries, isSingleRepo, listDiffers, listedPaths, mergeScan, outsideList, repoWorktrees, workspaceRepos } from '../../src/renderer/shell/workspaceList'
import type { Workspace, WorkspaceEntry } from '../../src/shared/types'

function entry(repoName: string, group: WorkspaceEntry['group'], branch: string | null = 'main', feature?: string): WorkspaceEntry {
  const repo = `/ws/${repoName}`
  const path = group === 'main' || group === 'space' ? repo : `/ws/.worktrees/${feature ?? 'x'}/${repoName}-${branch}`
  return { repo, repoName, group, ...(feature ? { feature } : {}), worktree: { path, branch, head: '0123456789', isMain: group === 'main' || group === 'space' } }
}

const ws = (...entries: WorkspaceEntry[]): Workspace => ({ root: '/ws', entries, truncated: false, failed: [] })

const space = entry('ws', 'space')
const a = entry('a', 'main')
const b = entry('b', 'main')
const aZed = entry('a', 'feature', 'zed', 'zed')
const bZed = entry('b', 'feature', 'zed', 'zed')
const aAlpha = entry('a', 'feature', 'alpha', 'alpha')
const bHot = entry('b', 'other', 'hot')

describe('groupEntries', () => {
  it('orders main repos, one section per feature by name, then the others', () => {
    const sections = groupEntries(ws(a, aZed, aAlpha, b, bZed, bHot))
    expect(sections.map((s) => s.title)).toEqual(['Principal', 'alpha', 'zed', 'Autres'])
    expect(sections[0].entries).toEqual([a, b])
    expect(sections[2].entries).toEqual([aZed, bZed])
  })

  it('puts the parent repo after the real repos of Principal', () => {
    expect(groupEntries(ws(space, a, b))[0].entries).toEqual([a, b, space])
  })

  it('leaves out empty sections', () => {
    expect(groupEntries(ws(a, b)).map((s) => s.title)).toEqual(['Principal'])
  })

  it('has one section without a title for a single repo, in the order of its list', () => {
    const list = [a, aZed, entry('a', 'other', 'hot')]
    expect(groupEntries(ws(...list))).toEqual([{ id: 'all', title: null, entries: list }])
  })

  it('tells sections apart when a feature is named like a fixed one', () => {
    const sections = groupEntries(ws(a, b, entry('a', 'feature', 'x', 'Autres'), bHot))
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length)
  })
})

describe('entryLabel', () => {
  it('names a main repo by its repo', () => {
    expect(entryLabel(a, false)).toBe('a')
  })

  it('names a feature or other worktree by repo and branch', () => {
    expect(entryLabel(aZed, false)).toBe('a · zed')
    expect(entryLabel(bHot, false)).toBe('b · hot')
  })

  it('calls the parent repo Espace', () => {
    expect(entryLabel(space, false)).toBe('Espace')
  })

  it('keeps a detached worktree readable', () => {
    expect(entryLabel(entry('a', 'other', null), false)).toBe('a · (détaché) 0123456')
  })

  it('shows only the branch in a single repo, as a plain list does', () => {
    expect(entryLabel(a, true)).toBe('main')
    expect(entryLabel(aZed, true)).toBe('zed')
  })
})

describe('defaultEntry', () => {
  it('takes the first main entry, never the parent repo first', () => {
    expect(defaultEntry(ws(space, a, b))).toBe(a)
  })

  it('takes the first entry when there is no main one', () => {
    expect(defaultEntry(ws(space, bHot))).toBe(space)
  })

  it('has nothing to take in an empty workspace', () => {
    expect(defaultEntry(ws())).toBeUndefined()
  })
})

describe('mergeScan', () => {
  it('takes a clean scan as it is: what it misses is gone', () => {
    expect(mergeScan(ws(a, b), ws(a), null).entries).toEqual([a])
  })

  it('keeps the entries of a failed repo, in repo order', () => {
    expect(mergeScan(ws(a, aZed, b), { ...ws(b), failed: ['/ws/a'] }, null).entries).toEqual([a, aZed, b])
  })

  it('keeps what lies under a folder that could not be read, repo or worktree', () => {
    const under = { ...bHot, worktree: { ...bHot.worktree, path: '/ws/sub/hot' } }
    expect(mergeScan(ws(a, under), { ...ws(a), failed: ['/ws/sub'] }, null).entries).toEqual([a, under])
  })

  it('does not take a sibling sharing a prefix for something under the folder', () => {
    expect(mergeScan(ws(a, entry('ab', 'main')), { ...ws(a), failed: ['/ws/a'] }, null).entries).toEqual([a])
  })

  it('does not double an entry the scan still has', () => {
    expect(mergeScan(ws(a, aZed), { ...ws(a, aZed), failed: ['/ws/a'] }, null).entries).toEqual([a, aZed])
  })

  it('keeps the active repo when the scan stopped at its limit, and only that one', () => {
    expect(mergeScan(ws(a, b), { ...ws(), truncated: true }, '/ws/b').entries).toEqual([b])
  })
})

describe('helpers', () => {
  it('isSingleRepo counts repos, not worktrees', () => {
    expect(isSingleRepo(ws(a, aZed))).toBe(true)
    expect(isSingleRepo(ws(a, b))).toBe(false)
  })

  it('workspaceRepos lists each repo once', () => {
    expect(workspaceRepos(ws(a, aZed, b))).toEqual(['/ws/a', '/ws/b'])
  })

  it('repoWorktrees keeps the worktrees of one repo', () => {
    expect(repoWorktrees(ws(a, aZed, b), '/ws/a')).toEqual([a.worktree, aZed.worktree])
  })

  it('entryPaths starts with the live list and adds every other entry, once each', () => {
    const extra = { path: '/new', branch: 'n', head: 'h', isMain: false }
    expect(entryPaths(ws(a, b), [a.worktree, extra])).toEqual(['/ws/a', '/new', '/ws/b'])
    expect(entryPaths(null, [extra])).toEqual(['/new'])
  })

  it('listedPaths keeps an orphan of another repo that came back: its tabs stay', () => {
    expect(listedPaths(ws(a, b, bHot), '/ws/a', [a.worktree])).toContain(bHot.worktree.path)
  })

  it('listedPaths trusts the live list over a scan of the same repo, stale by then', () => {
    expect(listedPaths(ws(a, aZed, b), '/ws/a', [a.worktree])).toEqual([a.worktree.path, b.worktree.path])
  })

  it('outsideList leaves out what reading the live list covers', () => {
    expect(outsideList(['/ws/a', '/ws/b', '/new'], [a.worktree])).toEqual(['/ws/b', '/new'])
  })

  it('listDiffers sees a worktree that came, left or changed branch, not a new commit', () => {
    const w = ws(a, aZed, b)
    expect(listDiffers(w, '/ws/a', [a.worktree, aZed.worktree])).toBe(false)
    expect(listDiffers(w, '/ws/a', [aZed.worktree, { ...a.worktree, head: 'fedcba9' }])).toBe(false)
    expect(listDiffers(w, '/ws/a', [a.worktree])).toBe(true)
    expect(listDiffers(w, '/ws/a', [a.worktree, { ...aZed.worktree, branch: 'other' }])).toBe(true)
  })
})
