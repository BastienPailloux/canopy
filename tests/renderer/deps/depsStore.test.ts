import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DepsReport } from '../../../src/shared/deps'
import { connectDeps, recheckDeps, useDeps } from '../../../src/renderer/deps/depsStore'
import { useApp } from '../../../src/renderer/store'

const report = (repo: string, checkedAt = 1): DepsReport => ({ repo, checkedAt, entries: [], errors: [], baseRef: null, manifests: 1 })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('depsStore', () => {
  let changed: ((p: unknown) => void) | null
  let banners: Record<string, boolean>
  let reports: Record<string, DepsReport | null>
  let off: () => void

  beforeEach(() => {
    changed = null
    banners = { '/a': true, '/b': false }
    reports = { '/a': report('/a'), '/b': report('/b') }
    vi.stubGlobal('window', {
      canopy: {
        depsReport: vi.fn(async (repo: string) => reports[repo] ?? null),
        depsBanner: vi.fn(async (repo: string) => banners[repo] ?? false),
        depsRecheck: vi.fn(async (repo: string) => report(repo, 2)),
        on: (event: string, cb: (p: unknown) => void) => { if (event === 'deps:changed') changed = cb; return () => { changed = null } }
      }
    })
    useApp.setState({ repo: '/a' })
    off = connectDeps()
  })
  afterEach(() => { off(); vi.unstubAllGlobals() })

  it('banner follows the displayed repo', async () => {
    await flush()
    expect(useDeps.getState()).toMatchObject({ repo: '/a', banner: true, report: { repo: '/a' } })
    useApp.setState({ repo: '/b' })
    expect(useDeps.getState()).toMatchObject({ repo: '/b', banner: false, report: null })
    await flush()
    expect(useDeps.getState()).toMatchObject({ repo: '/b', banner: false, report: { repo: '/b' } })
  })

  it('ignores a late answer for the repo left', async () => {
    let release: (r: DepsReport) => void = () => {}
    vi.mocked(window.canopy.depsReport).mockImplementationOnce(() => new Promise((r) => { release = r }))
    useApp.setState({ repo: '/c' })
    useApp.setState({ repo: '/b' })
    await flush()
    release(report('/c'))
    await flush()
    expect(useDeps.getState().report?.repo).toBe('/b')
  })

  it('reloads on a change of the displayed repo only', async () => {
    await flush()
    vi.mocked(window.canopy.depsReport).mockClear()
    changed?.({ repo: '/b' })
    await flush()
    expect(window.canopy.depsReport).not.toHaveBeenCalled()
    banners['/a'] = false
    changed?.({ repo: '/a' })
    await flush()
    expect(window.canopy.depsReport).toHaveBeenCalledWith('/a')
    expect(useDeps.getState().banner).toBe(false)
  })

  it('is checking while a recheck runs', async () => {
    await flush()
    const p = recheckDeps()
    expect(useDeps.getState().checking).toBe(true)
    await p
    expect(useDeps.getState()).toMatchObject({ checking: false, report: { checkedAt: 2 } })
  })
})
