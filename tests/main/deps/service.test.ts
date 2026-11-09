import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CHECK_INTERVAL_MS, createDepsService, type DepsServiceDeps } from '../../../src/main/deps/service'
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
    await new Promise((r) => setTimeout(r, 1))
    inFlight.now--
    return report(repo, keys[repo] ?? [])
  })
  const clear = vi.fn()
  const d: DepsServiceDeps = {
    check, repos: async () => [{ entry: '/a', repos: ['/a'] }, { entry: '/dir', repos: ['/dir/x', '/dir/y'] }],
    file, now: () => 1,
    setInterval: ((f: () => void) => { tick = f; return 7 }) as unknown as typeof setInterval,
    clearInterval: clear as unknown as typeof clearInterval,
    broadcast: (...a) => events.push(a), log: () => {}, ...o
  }
  delete (d as { keys?: unknown }).keys
  return { svc: createDepsService(d), check, calls, events, inFlight, tick: () => tick(), clear, d }
}
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('createDepsService', () => {
  test('checks repos one after another', async () => {
    const t = setup()
    t.svc.start()
    await settle()
    expect(t.calls).toEqual(['/a', '/dir/x', '/dir/y'])
    expect(t.inFlight.max).toBe(1)
  })

  test('rechecks everything every interval and recheck shares the in-flight promise', async () => {
    let interval = 0
    let fire: () => void = () => {}
    const t = setup({ setInterval: ((f: () => void, ms: number) => { fire = f; interval = ms; return 1 }) as unknown as typeof setInterval })
    t.svc.start()
    expect(interval).toBe(CHECK_INTERVAL_MS)
    await settle()
    t.calls.length = 0
    fire()
    await new Promise((r) => setTimeout(r, 0))
    const p1 = t.svc.recheck('/a')
    expect(t.svc.checking('/a')).toBe(true)
    expect(t.svc.recheck('/a')).toBe(p1)
    await settle()
    expect(t.calls).toEqual(['/a', '/dir/x', '/dir/y'])
    expect(t.svc.checking('/a')).toBe(false)
  })

  test('start twice is a no-op and stop clears the interval', async () => {
    const t = setup()
    t.svc.start(); t.svc.start()
    await settle()
    expect(t.calls).toHaveLength(3)
    t.svc.stop()
    expect(t.clear).toHaveBeenCalledWith(7)
  })

  test('broadcasts after each stored report', async () => {
    const t = setup()
    t.svc.start()
    await settle()
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
    await settle()
    expect(readFileSync(file, 'utf8')).toBe('{nope')
    const t2 = setup()
    t2.svc.start()
    await settle()
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
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
    await settle()
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
    await settle()
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
    await settle()
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
    await settle()
    t.svc.dismissBanner('/b')
    expect(t.svc.report('/b')).not.toBeNull()
    list = [{ entry: '/a', repos: ['/a'] }]
    t.calls.length = 0
    t.tick()
    await settle()
    expect(t.calls).toEqual(['/a'])
    expect(t.svc.report('/b')).toBeNull()
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(saved.reports)).toEqual(['/a'])
    expect(saved.dismissed['/b']).toBeUndefined()
    await expect(t.svc.recheck('/b')).rejects.toThrow('Dépôt inconnu')
  })

  test('a failing check keeps the previous report, logs, and continues', async () => {
    const log = vi.fn()
    let fail = false
    const t = setup({ log, check: async (r) => { if (fail && r === '/a') throw new Error('boom'); return report(r, ['k']) } })
    t.svc.start()
    await settle()
    fail = true
    const before = t.svc.report('/a')
    t.tick()
    await settle()
    expect(t.svc.report('/a')).toBe(before)
    expect(log).toHaveBeenCalled()
    await expect(t.svc.recheck('/a')).rejects.toThrow('boom')
    expect(t.svc.checking('/a')).toBe(false)
  })

  test('a write failure is logged, not thrown', async () => {
    const log = vi.fn()
    const t = setup({ file: join(dir, 'missing', 'x.json'), log })
    t.svc.start()
    await settle()
    expect(log).toHaveBeenCalled()
    expect(t.svc.report('/a')).not.toBeNull()
    expect(existsSync(join(dir, 'missing', 'x.json'))).toBe(false)
  })
})
