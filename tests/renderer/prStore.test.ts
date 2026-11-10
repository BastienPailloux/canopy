import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PrDetail, PrSummary } from '../../src/shared/pr'
import { act, connectPr, fixCheck, followWorktree, openPrDiff, pollDelay, prBaseRef, refresh, rerunFailed, sendToClaude, usePr } from '../../src/renderer/pr/prStore'
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
    expect(sendToClaude('corrige', 'PRRT_1')).toBe(true)
    const tabId = useSessions.getState().active['/w']
    expect(useSessions.getState().tabs[tabId].draft.text).toBe('corrige')
    expect(usePr.getState().claudeThreads).toEqual({ PRRT_1: tabId })
    expect(useApp.getState().view).toBe('sessions')
    sendToClaude('autre')
    expect(Object.keys(useSessions.getState().tabs)).toHaveLength(2)
    expect(usePr.getState().claudeThreads).toEqual({ PRRT_1: tabId })
    usePr.setState({ cwd: null })
    expect(sendToClaude('perdu')).toBe(false)
  })

  it('fixCheck sends an Actions check with its failed log, another app\'s with its detail and link', async () => {
    canopy.repoTrust = vi.fn(() => new Promise(() => undefined))
    canopy.prFailedLog = vi.fn(async () => 'Expected 404, received 422')
    usePr.setState({ cwd: '/w' })
    useSessions.setState({ tabs: {}, active: {} })
    const draft = (): string => useSessions.getState().tabs[useSessions.getState().active['/w']].draft.text
    expect(await fixCheck(pr, { name: 'e2e', detail: 'Failing after 2m', outcome: 'failure', durationMs: 1, url: null, run: { runId: 5, jobId: 7 } })).toBe(true)
    expect(canopy.prFailedLog).toHaveBeenCalledWith('/w', 5, 7)
    expect(draft()).toContain('Expected 404, received 422')
    canopy.prFailedLog.mockClear()
    await fixCheck(pr, { name: 'Greptile', detail: '2 issues found', outcome: 'failure', durationMs: null, url: 'https://app.greptile.com/r/1', run: null })
    expect(canopy.prFailedLog).not.toHaveBeenCalled()
    expect(draft()).toContain('2 issues found')
    expect(draft()).toContain('https://app.greptile.com/r/1')
    // a log already read is not asked again
    await fixCheck(pr, { name: 'e2e', detail: '', outcome: 'failure', durationMs: 1, url: null, run: { runId: 5, jobId: 7 } }, 'déjà lu')
    expect(canopy.prFailedLog).not.toHaveBeenCalled()
    expect(draft()).toContain('déjà lu')
  })
  it('fixCheck drops the log answered once another worktree or PR is followed', async () => {
    canopy.repoTrust = vi.fn(() => new Promise(() => undefined))
    const log = deferred<string>()
    canopy.prFailedLog = vi.fn(() => log.promise)
    usePr.setState({ cwd: '/w', branch: 'feat/gtin-lookup', summary: summary(pr) })
    useSessions.setState({ tabs: {}, active: {} })
    useApp.setState({ view: 'pr' })
    const sent = fixCheck(pr, { name: 'e2e', detail: '', outcome: 'failure', durationMs: 1, url: null, run: { runId: 5, jobId: 7 } })
    usePr.setState({ cwd: '/v', branch: 'feat/other', summary: null })
    log.resolve('Expected 404')
    expect(await sent).toBe(false)
    expect(useSessions.getState().tabs).toEqual({})
    expect(useApp.getState().view).toBe('pr')
  })

  it('rerunFailed stops once another worktree is followed: no run id goes to its repo', async () => {
    const first = deferred<{ ok: true }>()
    canopy.prAct.mockImplementationOnce(() => first.promise)
    usePr.setState({ cwd: '/w', branch: 'feat/gtin-lookup', summary: summary(pr) })
    const done = rerunFailed([1, 2])
    await flush()
    usePr.setState({ cwd: '/v', branch: 'feat/other', summary: { ...summary(pr), number: 12 } })
    first.resolve({ ok: true })
    await done
    expect(canopy.prAct.mock.calls).toEqual([['/w', pr.number, { type: 'rerun', runId: 1, jobId: null }]])
  })

  it('rerunFailed reruns every run while the PR stays followed', async () => {
    usePr.setState({ cwd: '/w', branch: 'feat/gtin-lookup', summary: summary(pr) })
    await rerunFailed([1, 2])
    expect(canopy.prAct.mock.calls.map((c) => c[2])).toEqual([{ type: 'rerun', runId: 1, jobId: null }, { type: 'rerun', runId: 2, jobId: null }])
  })

  it('prBaseRef prefers the remote-tracking base, then the local one', () => {
    expect(prBaseRef('main', ['feat/x', 'main', 'origin/main'])).toBe('origin/main')
    expect(prBaseRef('main', ['main', 'upstream/main'])).toBe('main')
    expect(prBaseRef('develop', ['main', 'upstream/develop'])).toBe('upstream/develop')
    expect(prBaseRef('develop', ['main'])).toBeNull()
  })

  it('openPrDiff compares against the PR base, then opens Code', async () => {
    canopy.codeBranches = vi.fn(async () => ['develop', 'main', 'origin/main'])
    usePr.setState({ cwd: '/w', branch: 'feat/gtin-lookup', summary: summary(pr) })
    useApp.setState({ view: 'pr', bases: { '/w': 'develop' } })
    await openPrDiff(pr)
    expect(useApp.getState().bases['/w']).toBe('origin/main')
    expect(useApp.getState().view).toBe('code')
    expect(useApp.getState().codeRequest).toMatchObject({ cwd: '/w', path: pr.files[0].path, mode: 'diff' })
  })

  it('openPrDiff does nothing once another worktree is followed', async () => {
    const branches = deferred<string[]>()
    canopy.codeBranches = vi.fn(() => branches.promise)
    usePr.setState({ cwd: '/w', branch: 'feat/gtin-lookup', summary: summary(pr) })
    useApp.setState({ view: 'pr', bases: {} })
    const opened = openPrDiff(pr)
    usePr.setState({ cwd: '/v', branch: 'main', summary: null })
    branches.resolve(['main'])
    await opened
    expect(useApp.getState().bases).toEqual({})
    expect(useApp.getState().view).toBe('pr')
  })
})
