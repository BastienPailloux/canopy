import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PrDetail, PrSummary } from '../../src/shared/pr'
import { act, followWorktree, pollDelay, refresh, usePr } from '../../src/renderer/pr/prStore'
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

  it('does not read the PR detail while another view shows', async () => {
    useApp.setState({ view: 'code' })
    followWorktree('/w', 'feat/gtin-lookup')
    await flush()
    expect(usePr.getState().summary?.number).toBe(pr.number)
    expect(canopy.prView).not.toHaveBeenCalled()
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
})
