import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '../../src/renderer/store'

beforeEach(() => { useApp.setState({ view: 'sessions', worktree: null, codeRequest: null }) })

describe('openInCode', () => {
  it('carries the column of a definition', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'code', 42, 7)
    expect(useApp.getState().codeRequest).toMatchObject({ line: 42, column: 7 })
  })

  it('carries the line to reveal', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'code', 42)
    expect(useApp.getState().codeRequest).toMatchObject({ path: 'src/a.ts', mode: 'code', line: 42 })
    useApp.getState().openInCode('/wt', 'src/a.ts', 'diff')
    expect(useApp.getState().codeRequest?.line).toBeUndefined()
  })

  it('opens the Code view on a file, and the request is gone once consumed', () => {
    useApp.getState().openInCode('/wt', 'src/a.ts', 'diff')
    const { codeRequest, view, worktree } = useApp.getState()
    expect(view).toBe('code')
    expect(worktree).toBe('/wt')
    expect(codeRequest).toMatchObject({ cwd: '/wt', path: 'src/a.ts', mode: 'diff' })

    useApp.getState().clearCodeRequest(codeRequest!.seq)
    expect(useApp.getState().codeRequest).toBeNull()
  })

  it('does not clear a newer request when an old one is acknowledged', () => {
    useApp.getState().openInCode('/wt', 'a', 'code')
    const first = useApp.getState().codeRequest!.seq
    useApp.getState().openInCode('/wt', 'b', 'code')
    useApp.getState().clearCodeRequest(first)
    expect(useApp.getState().codeRequest?.path).toBe('b')
  })
})

describe('setWorktrees with orphans', () => {
  const main = { path: '/main', branch: 'main', head: 'h', isMain: true }
  const gone = { path: '/gone', branch: 'feat', head: 'h', isMain: false, sessions: 1, terminals: 0 }

  it('keeps an orphan selected while it is reachable, and falls back once it is not', () => {
    useApp.setState({ worktree: '/gone', worktrees: [main], orphans: [] })
    useApp.getState().setOrphans([gone])
    useApp.getState().setWorktrees([main])
    expect(useApp.getState().worktree).toBe('/gone')

    useApp.getState().setOrphans([])
    useApp.getState().setWorktrees([main])
    expect(useApp.getState().worktree).toBe('/main')
  })

  it('a new repo starts without orphans', () => {
    useApp.setState({ orphans: [gone] })
    useApp.getState().setRepo('/other')
    expect(useApp.getState().orphans).toEqual([])
  })
})
