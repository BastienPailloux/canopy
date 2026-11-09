import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CHECK_INTERVAL_MS, createDepsService, FIRST_PASS_DELAY_MS, type DepsServiceDeps } from '../../../src/main/deps/service'
import type { DepEntry, DepsReport } from '../../../src/shared/deps'

const entry = (key: string, level: DepEntry['level'] = 'critical'): DepEntry =>
  ({ key, ecosystem: 'npm', name: key, manifest: 'package-lock.json', installed: '1.0.0', target: '2.0.0', level, cause: 'advisory', reason: 'x', advisories: [], registryUrl: null })
const report = (repo: string, keys: string[] = []): DepsReport =>
  ({ repo, checkedAt: 1, entries: keys.map((k) => entry(k)), errors: [], baseRef: null, manifests: 1 })

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deps-service-')); file = join(dir, 'deps-reports.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(o: Partial<DepsServiceDeps> & { keys?: Record<string, string[]> } = {}) {
  const keys = o.keys ?? {}
  const events: unknown[][] = []
  let tick: () => void = () => {}
  const inFlight = { now: 0, max: 0 }
  const calls: string[] = []
  const check = vi.fn(async (repo: string) => {
    calls.push(repo)
    inFlight.now++; inFlight.max = Math.max(inFlight.max, inFlight.now)
    await Promise.resolve()
    inFlight.now--
    return report(repo, keys[repo] ?? [])
  })
  const clear = vi.fn()
  const d: DepsServiceDeps = {
    check, repos: async () => [{ entry: '/a', repos: ['/a'] }, { entry: '/dir', repos: ['/dir/x', '/dir/y'] }],
    file, now: () => 1,
    setInterval: ((f: () => void) => { tick = f; return 7 }) as unknown as typeof setInterval,
    clearInterval: clear as unknown as typeof clearInterval,
    setTimeout: ((f: () => void) => { f(); return 9 }) as unknown as typeof setTimeout,
    clearTimeout: clear as unknown as typeof clearTimeout,
    broadcast: (...a) => events.push(a), log: () => {}, ...o
  }
  delete (d as { keys?: unknown }).keys
  return { svc: createDepsService(d), check, calls, events, inFlight, tick: () => tick(), clear, d }
}
type T = ReturnType<typeof setup>
const REPOS = ['/a', '/b', '/dir/x', '/dir/y']
/** Waits until `n` checks were made and none is running (the report is stored right after a check ends). */
const until = (t: T, n: number) => vi.waitFor(() => { expect(t.calls.length).toBeGreaterThanOrEqual(n); expect(REPOS.some((r) => t.svc.checking(r))).toBe(false) })
/** Same for a pass with a custom `check`: waits for `repo` to hold a report and no check running. */
const stored = (t: T, repo: string) => vi.waitFor(() => { expect(t.svc.report(repo)).not.toBeNull(); expect(REPOS.some((r) => t.svc.checking(r))).toBe(false) })

describe('createDepsService', () => {
  test('checks repos one after another', async () => {
    const t = setup()
    t.svc.start()
    await until(t, 3)
    expect(t.calls).toEqual(['/a', '/dir/x', '/dir/y'])
    expect(t.inFlight.max).toBe(1)
  })

  test('rechecks everything every interval and recheck shares the in-flight promise', async () => {
    let interval = 0
    let fire: () => void = () => {}
    let gate: (() => void) | null = null
    let hold = false
    const t = setup({
      setInterval: ((f: () => void, ms: number) => { fire = f; interval = ms; return 1 }) as unknown as typeof setInterval,
      check: async (r) => { if (hold && r === '/a') await new Promise<void>((res) => { gate = res }); return report(r) }
    })
    t.svc.start()
    expect(interval).toBe(CHECK_INTERVAL_MS)
    await stored(t, '/dir/y')
    hold = true
    fire()
    await vi.waitFor(() => { expect(t.svc.checking('/a')).toBe(true) })
    const p1 = t.svc.recheck('/a')
    expect(t.svc.recheck('/a')).toBe(p1)
    gate!()
    await p1
    expect(t.svc.checking('/a')).toBe(false)
  })

  test('delays the first pass but lists the repos and serves stored reports at once', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, reports: { '/dir/x': report('/dir/x', ['k']) }, dismissed: {} }))
    let first: (() => void) | null = null
    let delay = 0
    const t = setup({ setTimeout: ((f: () => void, ms: number) => { first = f; delay = ms; return 9 }) as unknown as typeof setTimeout })
    t.svc.start()
    expect(delay).toBe(FIRST_PASS_DELAY_MS)
    expect(FIRST_PASS_DELAY_MS).toBe(30_000)
    await vi.waitFor(() => { expect(t.svc.critical('/dir')).toBe(1) })
    expect(t.calls).toEqual([])
    first!()
    await until(t, 3)
    expect(t.calls).toEqual(['/a', '/dir/x', '/dir/y'])
  })

  test('the first pass delay can be injected', () => {
    let delay = -1
    const t = setup({ firstPassDelayMs: 0, setTimeout: ((_f: () => void, ms: number) => { delay = ms; return 9 }) as unknown as typeof setTimeout })
    t.svc.start()
    expect(delay).toBe(0)
  })

  test('start twice is a no-op and stop clears the interval', async () => {
    const t = setup()
    t.svc.start(); t.svc.start()
    await until(t, 3)
    expect(t.calls).toHaveLength(3)
    t.svc.stop()
    expect(t.clear).toHaveBeenCalledWith(7)
  })

  test('broadcasts after each stored report', async () => {
    const t = setup()
    t.svc.start()
    await until(t, 3)
    expect(t.events).toEqual([['deps:changed', { repo: '/a' }], ['deps:changed', { repo: '/dir/x' }], ['deps:changed', { repo: '/dir/y' }]])
  })

  test('reads stored reports at start, before any check, without broadcasting', () => {
    writeFileSync(file, JSON.stringify({ version: 1, reports: { '/a': report('/a', ['k']) }, dismissed: {} }))
    const t = setup()
    t.svc.start()
    expect(t.svc.report('/a')?.entries).toHaveLength(1)
    expect(t.svc.report('/b')).toBeNull()
    expect(t.events).toEqual([])
  })

  test('ignores a corrupt file and does not overwrite it before a new report', async () => {
    writeFileSync(file, '{nope')
    const t = setup({ repos: async () => [] })
    t.svc.start()
    await vi.waitFor(() => { expect(t.d.repos).toBeDefined() })
    await Promise.resolve(); await Promise.resolve()
    expect(readFileSync(file, 'utf8')).toBe('{nope')
    const t2 = setup()
    t2.svc.start()
    await until(t2, 3)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  test('drops stored reports of an unexpected shape one by one, without crashing', () => {
    const bad = { ...report('/b'), entries: 'x' }
    const badEntry = { ...report('/dir/x'), entries: [{ ...entry('k'), key: 1 }] }
    const badAdvisory = { ...report('/dir/y'), entries: [{ ...entry('k'), advisories: [null] }] }
    writeFileSync(file, JSON.stringify({ version: 1, reports: { '/a': report('/a', ['k']), '/b': bad, '/dir/x': badEntry, '/dir/y': badAdvisory, '/n': null }, dismissed: { '/a': 'k', '/b': ['k'] } }))
    const t = setup({ repos: async () => [] })
    t.svc.start()
    expect(t.svc.report('/a')?.entries).toHaveLength(1)
    for (const r of ['/b', '/dir/x', '/dir/y', '/n']) expect(t.svc.report(r)).toBeNull()
    expect(t.svc.bannerFor('/a')).toBe(true)
    expect(t.svc.critical('/dir')).toBe(0)
    expect(() => t.svc.critical('/b')).not.toThrow()
  })

  test('ignores a file with another version', () => {
    writeFileSync(file, JSON.stringify({ version: 2, reports: { '/a': report('/a') }, dismissed: {} }))
    const t = setup({ repos: async () => [] })
    t.svc.start()
    expect(t.svc.report('/a')).toBeNull()
  })

  test('critical sums the repos of an entry and excludes except', async () => {
    const t = setup({ keys: { '/a': ['a1'], '/dir/x': ['x1', 'x2'], '/dir/y': ['y1'] } })
    t.svc.start()
    await until(t, 3)
    expect(t.svc.critical('/a')).toBe(1)
    expect(t.svc.critical('/dir')).toBe(3)
    expect(t.svc.critical('/dir/x')).toBe(2)
    expect(t.svc.critical('/dir', '/dir/x')).toBe(1)
    expect(t.svc.critical('/dir', '/dir')).toBe(0)
    expect(t.svc.critical('/a', '/a')).toBe(0)
    expect(t.svc.critical('/dir/x', '/dir')).toBe(0)
  })

  test('banner: dismissed until a new critical key appears', async () => {
    let keys = ['k1', 'k2']
    const t = setup({ repos: async () => [{ entry: '/a', repos: ['/a'] }], check: async (r) => report(r, keys) })
    t.svc.start()
    await stored(t, '/a')
    expect(t.svc.bannerFor('/a')).toBe(true)
    t.svc.dismissBanner('/a')
    expect(t.svc.bannerFor('/a')).toBe(false)
    expect(t.events.at(-1)).toEqual(['deps:changed', { repo: '/a' }])
    keys = ['k1']
    await t.svc.recheck('/a')
    expect(t.svc.bannerFor('/a')).toBe(false)
    keys = ['k1', 'k3']
    await t.svc.recheck('/a')
    expect(t.svc.bannerFor('/a')).toBe(true)
  })

  test('dismissal survives a restart', async () => {
    const mk = () => setup({ repos: async () => [{ entry: '/a', repos: ['/a'] }], check: async (r) => report(r, ['k1']) })
    const t = mk()
    t.svc.start()
    await stored(t, '/a')
    t.svc.dismissBanner('/a')
    t.svc.stop()
    const t2 = mk()
    t2.svc.start()
    expect(t2.svc.bannerFor('/a')).toBe(false)
  })

  test('forgets repos no longer listed and stops checking them', async () => {
    let list = [{ entry: '/a', repos: ['/a', '/b'] }]
    const t = setup({ repos: async () => list })
    t.svc.start()
    await until(t, 2)
    t.svc.dismissBanner('/b')
    expect(t.svc.report('/b')).not.toBeNull()
    list = [{ entry: '/a', repos: ['/a'] }]
    t.calls.length = 0
    t.tick()
    await vi.waitFor(() => { expect(t.svc.report('/b')).toBeNull() })
    await until(t, 1)
    expect(t.calls).toEqual(['/a'])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(saved.reports)).toEqual(['/a'])
    expect(saved.dismissed['/b']).toBeUndefined()
    await expect(t.svc.recheck('/b')).rejects.toThrow('Dépôt inconnu')
  })

  test('forget is called for each repo dropped from the list', async () => {
    let list = [{ entry: '/a', repos: ['/a', '/b'] }]
    const forgotten: string[] = []
    const t = setup({ repos: async () => list, forget: (r) => forgotten.push(r) })
    t.svc.start()
    await until(t, 2)
    expect(forgotten).toEqual([])
    list = [{ entry: '/a', repos: ['/a'] }]
    t.tick()
    await vi.waitFor(() => { expect(forgotten).toEqual(['/b']) })
  })

  test('a failing check keeps the previous report, logs, and continues', async () => {
    const log = vi.fn()
    let fail = false
    const t = setup({ log, check: async (r) => { if (fail && r === '/a') throw new Error('boom'); return report(r, ['k']) } })
    t.svc.start()
    await stored(t, '/dir/y')
    fail = true
    const before = t.svc.report('/a')
    t.tick()
    await vi.waitFor(() => { expect(log).toHaveBeenCalled() })
    expect(t.svc.report('/a')).toBe(before)
    await expect(t.svc.recheck('/a')).rejects.toThrow('boom')
    expect(t.svc.checking('/a')).toBe(false)
  })

  test('a write failure is logged, not thrown', async () => {
    const log = vi.fn()
    const t = setup({ file: join(dir, 'missing', 'x.json'), log })
    t.svc.start()
    await until(t, 3)
    expect(log).toHaveBeenCalled()
    expect(t.svc.report('/a')).not.toBeNull()
    expect(existsSync(join(dir, 'missing', 'x.json'))).toBe(false)
  })

  test('recheck reads the list again for a repo added after it was cached', async () => {
    let list = [{ entry: '/a', repos: ['/a'] }]
    const t = setup({ repos: async () => list })
    t.svc.start()
    await until(t, 1)
    list = [{ entry: '/a', repos: ['/a'] }, { entry: '/b', repos: ['/b'] }]
    const r = await t.svc.recheck('/b')
    expect(r.repo).toBe('/b')
    expect(t.calls).toEqual(['/a', '/b'])
    await expect(t.svc.recheck('/nope')).rejects.toThrow('Dépôt inconnu')
  })

  test('an overdue pass checks only the repos without a report or with an old one', async () => {
    const at = (repo: string, checkedAt: number | null) => ({ ...report(repo), checkedAt })
    writeFileSync(file, JSON.stringify({ version: 1, reports: { '/a': at('/a', 1000), '/dir/x': at('/dir/x', 1000 - CHECK_INTERVAL_MS), '/dir/y': at('/dir/y', null) }, dismissed: {} }))
    const t = setup({ now: () => 1000, setTimeout: (() => 9) as unknown as typeof setTimeout })
    t.svc.start()
    await t.svc.checkOverdue()
    expect(t.calls).toEqual(['/dir/x', '/dir/y'])
  })

  test('passes never overlap', async () => {
    let gate: (() => void) | null = null
    const t = setup({ check: async (r) => { t.calls.push(r); if (r === '/a') await new Promise<void>((res) => { gate = res }); return report(r) } })
    t.svc.start()
    await vi.waitFor(() => { expect(gate).not.toBeNull() })
    t.tick()
    const overdue = t.svc.checkOverdue()
    await overdue
    gate!()
    await until(t, 3)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.calls).toEqual(['/a', '/dir/x', '/dir/y'])
  })

  test('a failed listing keeps the reports and dismissals of that entry', async () => {
    let list: { entry: string; repos: string[] | null }[] = [{ entry: '/a', repos: ['/a'] }, { entry: '/dir', repos: ['/dir/x'] }]
    const t = setup({ repos: async () => list, keys: { '/a': ['k'], '/dir/x': ['k'] } })
    t.svc.start()
    await until(t, 2)
    t.svc.dismissBanner('/dir/x')
    list = [{ entry: '/a', repos: ['/a'] }, { entry: '/dir', repos: null }]
    await t.svc.recheck('/a')
    await expect(t.svc.recheck('/nope')).rejects.toThrow('Dépôt inconnu')
    expect(t.svc.report('/dir/x')).not.toBeNull()
    expect(t.svc.critical('/dir')).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).dismissed['/dir/x']).toEqual(['k'])
  })

  test('a listing that fails before any success keeps the stored reports under the entry', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, reports: { '/dir/x': report('/dir/x', ['k']), '/gone': report('/gone', ['k']) }, dismissed: {} }))
    const t = setup({ repos: async () => [{ entry: '/dir', repos: null }], setTimeout: (() => 9) as unknown as typeof setTimeout })
    t.svc.start()
    await expect(t.svc.recheck('/nope')).rejects.toThrow('Dépôt inconnu')
    expect(t.svc.report('/dir/x')).not.toBeNull()
    expect(t.svc.report('/gone')).toBeNull()
  })
})