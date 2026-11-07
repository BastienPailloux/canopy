import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '../../src/renderer/store'

beforeEach(() => { useApp.setState({ view: 'sessions', worktree: null, codeRequest: null }) })

describe('openInCode', () => {
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
