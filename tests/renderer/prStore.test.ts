import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PrDetail, PrSummary } from '../../src/shared/pr'
import { act, connectPr, followWorktree, pollDelay, refresh, sendToClaude, usePr } from '../../src/renderer/pr/prStore'
import { useSessions } from '../../src/renderer/sessions/sessionStore'
import { tabCounts } from '../../src/renderer/pr/mergeModel'
import { useApp } from '../../src/renderer/store'

const fixture = (): PrDetail => (JSON.parse(readFileSync('tests/fixtures/gh/pr.json', 'utf8')) as { detail: PrDetail }).detail
const summary = (d: PrDetail): PrSummary => ({ number: d.number, state: d.state, title: d.title, url: d.url })
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('prStore', () => {
  let canopy: Record<string, ReturnType<typeof vi.fn>>
  const pr = fixture()

  beforeEach(() => {
    canopy = {
      prFind: vi.fn(async () => summary(pr)),
      prView: vi.fn(async () => pr),
      prOptions: vi.fn(async () => ({ labels: [], assignable: [], suggested: [] })),
      prAct: vi.fn(async () => ({ ok: true }))
    }
    vi.stubGlobal('window', { canopy })
    useApp.setState({ view: 'pr' })
    usePr.setState({ cwd: null, branch: null, summary: null, detail: null, options: null, error: null, busy: null, subTab: 'conv' })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('drops a view answered for a branch no longer current', async () => {
    const view = deferred<PrDetail>()
    canopy.prView.mockImplementationOnce(() => view.promise)
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    expect(canopy.prView).toHaveBeenCalledWith('/w', pr.number)
    canopy.prFind.mockImplementation(async () => null)
    followWorktree('/w', 'main')
    await flush()
    view.resolve(pr)
    await flush()
    expect(usePr.getState().branch).toBe('main')
    expect(usePr.getState().summary).toBeNull()
    expect(usePr.getState().detail).toBeNull()
  })

  it('a failed refresh keeps the last PR and shows the error', async () => {
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    expect(usePr.getState().detail?.number).toBe(pr.number)
    canopy.prView.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'pr:view': Error: GitHub (gh) : hors ligne")
    })
    await refresh()
    expect(usePr.getState().detail?.number).toBe(pr.number)
    expect(usePr.getState().summary?.number).toBe(pr.number)
    expect(usePr.getState().error).toBe('GitHub (gh) : hors ligne')
  })

  it('reads the detail while another view shows: the header badge has its count', async () => {
    useApp.setState({ view: 'code' })
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    const d = usePr.getState().detail
    expect(d?.number).toBe(pr.number)
    expect(tabCounts(d!).openThreads).toBe(1)
  })

  it('a failed find keeps the last PR and shows the error, the next good one clears it', async () => {
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    canopy.prFind.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'pr:find': Error: GitHub (gh) : hors ligne")
    })
    await refresh()
    expect(usePr.getState().summary?.number).toBe(pr.number)
    expect(usePr.getState().detail?.number).toBe(pr.number)
    expect(usePr.getState().error).toBe('GitHub (gh) : hors ligne')
    await refresh()
    expect(usePr.getState().error).toBeNull()
  })

  it('a find answering no PR clears the error too', async () => {
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    usePr.setState({ error: 'GitHub (gh) : hors ligne' })
    canopy.prFind.mockImplementationOnce(async () => null)
    await refresh()
    expect(usePr.getState().error).toBeNull()
    expect(usePr.getState().summary).toBeNull()
  })

  it('polls the PR every 60 s while another view shows', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('window', { canopy, addEventListener: vi.fn(), removeEventListener: vi.fn() })
      vi.stubGlobal('document', { hidden: false, hasFocus: () => true })
      const done = { ...pr, autoMerge: false, checks: pr.checks.map((c) => ({ ...c, outcome: 'success' as const })) }
      canopy.prView.mockImplementation(async () => done)
      useApp.setState({ view: 'code', worktree: '/w', worktrees: [{ path: '/w', branch: 'feat/gtin-lookup', head: 'a', isMain: false }] })
      // StrictMode connects twice: the second connect follows the same worktree and must still poll.
      const first = connectPr()
      await vi.advanceTimersByTimeAsync(0)
      first()
      const stop = connectPr()
      await vi.advanceTimersByTimeAsync(0)
      canopy.prView.mockClear()
      await vi.advanceTimersByTimeAsync(60_000)
      stop()
      expect(canopy.prView).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a focus with no worktree selected reads nothing', async () => {
    let focus: (() => void) | undefined
    vi.stubGlobal('window', { canopy, addEventListener: (e: string, f: () => void) => { if (e === 'focus') focus = f }, removeEventListener: vi.fn() })
    useApp.setState({ worktree: null, worktrees: [] })
    const stop = connectPr()
    focus?.()
    await flush()
    stop()
    expect(focus).toBeDefined()
    expect(canopy.prFind).not.toHaveBeenCalled()
  })

  it('act refreshes after success', async () => {
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    canopy.prView.mockClear()
    const drafted: PrDetail = { ...pr, state: 'draft' }
    canopy.prView.mockImplementation(async () => drafted)
    const done = act({ type: 'draft', draft: true })
    expect(usePr.getState().busy).toBe('draft')
    expect(await done).toEqual({ ok: true })
    expect(canopy.prAct).toHaveBeenCalledWith('/w', pr.number, { type: 'draft', draft: true })
    expect(canopy.prView).toHaveBeenCalled()
    expect(usePr.getState().detail?.state).toBe('draft')
    expect(usePr.getState().busy).toBeNull()
  })

  it('a failed act keeps the PR and shows GitHub\'s message', async () => {
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    canopy.prAct.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'pr:act': Error: GitHub (gh) : Pull request is in clean status")
    })
    expect(await act({ type: 'close' })).toBeNull()
    expect(usePr.getState().error).toBe('GitHub (gh) : Pull request is in clean status')
    expect(usePr.getState().detail?.state).toBe('open')
    expect(usePr.getState().busy).toBeNull()
  })

  it('pollDelay is 15 s while a check is pending', () => {
    const none = { ...pr, autoMerge: false, checks: pr.checks.map((c) => ({ ...c, outcome: 'success' as const })) }
    expect(pollDelay(null)).toBe(60_000)
    expect(pollDelay(none)).toBe(60_000)
    expect(pollDelay({ ...none, checks: [...none.checks, { ...none.checks[0], outcome: 'pending' }] })).toBe(15_000)
    expect(pollDelay({ ...none, autoMerge: true })).toBe(15_000)
  })

  it('sendToClaude starts a new session on the worktree, remembers the thread and shows Sessions', () => {
    canopy.repoTrust = vi.fn(() => new Promise(() => undefined))
    usePr.setState({ cwd: '/w', claudeThreads: {} })
    useSessions.setState({ tabs: {}, active: {} })
    sendToClaude('corrige', 'PRRT_1')
    const tabId = useSessions.getState().active['/w']
    expect(useSessions.getState().tabs[tabId].draft.text).toBe('corrige')
    expect(usePr.getState().claudeThreads).toEqual({ PRRT_1: tabId })
    expect(useApp.getState().view).toBe('sessions')
    sendToClaude('autre')
    expect(Object.keys(useSessions.getState().tabs)).toHaveLength(2)
    expect(usePr.getState().claudeThreads).toEqual({ PRRT_1: tabId })
  })
})
