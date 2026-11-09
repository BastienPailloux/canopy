import { describe, expect, test } from 'vitest'
import { checkRepo, type CheckDeps } from '../../../src/main/deps/check'
import { HttpError, type Http } from '../../../src/main/deps/http'
import { advisoryKey } from '../../../src/main/deps/osv'
import type { Inventory } from '../../../src/main/deps/source'
import { depKey, type Advisory, type Dep, type DepEntry, type DepsReport, type PackageInfo } from '../../../src/shared/deps'

const NOW = Date.parse('2026-11-09T00:00:00Z')
const dep = (name: string, version: string | null, o: Partial<Dep> = {}): Dep =>
  ({ ecosystem: 'npm', name, version, manifest: 'package-lock.json', private: false, ...o })
const info = (o: Partial<PackageInfo> = {}): PackageInfo => ({ latest: '1.0.0', deprecated: null, yanked: false, inactive: false, lastRelease: '2026-06-01T00:00:00Z', ...o })
const adv = (o: Partial<Advisory> = {}): Advisory => ({ id: 'GHSA-aaaa-bbbb-cccc', package: 'x', severity: 'high', summary: 'Bad', fixed: null, url: 'u', ...o })
const inv = (units: Inventory['units'], o: Partial<Inventory> = {}): Inventory => ({ repo: '/r', baseRef: 'origin/develop', units, notes: [], ...o })
const unit = (deps: Dep[], transitive: Dep[] = [], o: object = {}) => ({ dir: '.', ecosystem: 'npm' as const, deps, transitive, ...o })
const http = {} as Http

function run(inventory: Inventory, o: Partial<CheckDeps> = {}, previous: DepsReport | null = null) {
  return checkRepo({ http, now: () => NOW, inventory: async () => inventory, packageInfo: async () => info(), advisories: async () => new Map(), ...o }, '/r', previous)
}
const prevReport = (entries: DepEntry[]): DepsReport => ({ repo: '/r', checkedAt: 1, entries, errors: [], baseRef: null, manifests: 1 })

describe('checkRepo', () => {
  test('attaches a transitive advisory to the direct dep of via[0]', async () => {
    const direct = dep('express', '4.0.0'), other = dep('lodash', '1.0.0')
    const trans = dep('qs', '1.0.0', { via: ['express', 'qs'] })
    const r = await run(inv([unit([direct, other], [trans])]), { advisories: async () => new Map([[advisoryKey(trans), [adv({ package: 'qs' })]]]) })
    const e = r.entries.find((x) => x.name === 'express')!
    expect(e.level).toBe('critical')
    expect(e.reason).toBe('Faille haute dans qs (via express)')
    expect(r.entries.find((x) => x.name === 'lodash')?.level).not.toBe('critical')
  })

  test('attaches advisories of the exact version each direct dep brings', async () => {
    const a = dep('a', '1.0.0'), b = dep('b', '1.0.0')
    const old = dep('minimist', '0.0.8', { via: ['a'] }), fresh = dep('minimist', '1.2.8', { via: ['b'] })
    const r = await run(inv([unit([a, b], [old, fresh])]), {
      advisories: async () => new Map([[advisoryKey(old), [adv({ package: 'minimist', severity: 'critical' })]], [advisoryKey(fresh), []]])
    })
    expect(r.entries.find((x) => x.name === 'a')?.level).toBe('critical')
    expect(r.entries.find((x) => x.name === 'b')?.level).not.toBe('critical')
  })

  test("a nested older copy's advisory is a transitive flaw, not the direct's own", async () => {
    const x = dep('x', '2.0.0'), nested = dep('x', '1.0.0', { via: ['x'] })
    const r = await run(inv([unit([x], [nested])]), {
      packageInfo: async () => info({ latest: '2.1.0' }),
      advisories: async () => new Map([[advisoryKey(nested), [adv({ package: 'x', version: '1.0.0', fixed: '1.0.5' })]]])
    })
    const e = r.entries.find((d) => d.name === 'x')!
    expect(e.target).toBe('2.1.0')
    expect(e.reason).toBe('Faille haute dans x 1.0.0 (via x)')
  })

  test('only queries packageInfo for direct deps', async () => {
    const asked: string[] = []
    await run(inv([unit([dep('a', '1.0.0')], [dep('t', '1.0.0', { via: ['a'] })])]), { packageInfo: async (_h, d) => { asked.push(d.name); return info() } })
    expect(asked).toEqual(['a'])
  })

  test('sorts by level then name', async () => {
    const deps = [dep('priv', '1.0.0', { private: true }), dep('pin', null), dep('zlater', '0.9.0'), dep('asoon', '0.9.0'), dep('crit', '1.0.0')]
    const r = await run(inv([unit(deps)]), {
      packageInfo: async (_h, d) => d.name === 'asoon' ? info({ latest: '3.0.0', lastRelease: '2026-01-01T00:00:00Z' }) : d.name === 'crit' ? info({ deprecated: 'x' }) : info()
    })
    expect(r.entries.map((e) => e.name)).toEqual(['crit', 'asoon', 'zlater', 'pin', 'priv'])
  })

  test('keeps the previous entry when a lookup fails', async () => {
    const prev: DepEntry = { key: depKey(dep('lodash', '1.0.0')), ecosystem: 'npm', name: 'lodash', manifest: 'package-lock.json', installed: '1.0.0', target: '2.0.0', level: 'soon', cause: 'patches', reason: 'old', advisories: [], registryUrl: null }
    const r = await run(inv([unit([dep('lodash', '1.0.0')])]), { packageInfo: async () => { throw new HttpError(429, 'https://registry.npmjs.org/lodash') } }, prevReport([prev]))
    expect(r.entries).toEqual([prev])
    expect(r.errors).toContain('npm : lodash non vérifié (HTTP 429)')
  })

  test('formats a registry error without previous entry', async () => {
    const r = await run(inv([unit([dep('lodash', '1.0.0')])]), { packageInfo: async () => { throw new Error('boom') } })
    expect(r.errors).toEqual(['npm : lodash non vérifié (boom)'])
    expect(r.entries).toEqual([])
  })

  test('OSV failure keeps previous advisories and critical level', async () => {
    const d = dep('lodash', '1.0.0')
    const prev: DepEntry = { key: depKey(d), ecosystem: 'npm', name: 'lodash', manifest: 'package-lock.json', installed: '1.0.0', target: null, level: 'critical', cause: 'advisory', reason: 'Faille haute : Bad', advisories: [adv({ package: 'lodash' })], registryUrl: null }
    const r = await run(inv([unit([d])]), { advisories: async () => { throw new Error('offline') } }, prevReport([prev]))
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].level).toBe('critical')
    expect(r.entries[0].advisories).toEqual(prev.advisories)
    expect(r.errors).toEqual(['Failles non vérifiées : offline'])
  })

  test('a critical previous entry is kept when OSV fails and the registry shows nothing', async () => {
    const d = dep('lodash', '1.0.0')
    const prev: DepEntry = { key: depKey(d), ecosystem: 'npm', name: 'lodash', manifest: 'package-lock.json', installed: '1.0.0', target: null, level: 'critical', cause: 'deprecated', reason: 'Déprécié : x', advisories: [], registryUrl: null }
    const r = await run(inv([unit([d])]), { advisories: async () => { throw new Error('offline') } }, prevReport([prev]))
    expect(r.entries).toEqual([prev])
  })

  test('copies unit errors and notes, counts manifests, baseRef and checkedAt', async () => {
    const r = await run(inv([unit([], [], { error: 'Fichier illisible : yarn.lock' }), unit([dep('a', '1.0.0')])], { notes: ['une note'] }))
    expect(r.errors).toEqual(['Fichier illisible : yarn.lock', 'une note'])
    expect(r.manifests).toBe(2)
    expect(r.baseRef).toBe('origin/develop')
    expect(r.checkedAt).toBe(NOW)
    expect(r.repo).toBe('/r')
  })

  const prevEntry = (d: Dep, o: Partial<DepEntry>): DepEntry => ({ key: depKey(d), ecosystem: 'npm', name: d.name, manifest: d.manifest, installed: d.version, target: null, level: 'soon', cause: 'majors', reason: 'old', advisories: [], registryUrl: null, ...o })

  test('a registry failure does not drop fresh advisories', async () => {
    const d = dep('lodash', '1.0.0')
    const r = await run(inv([unit([d])]), {
      packageInfo: async () => { throw new HttpError(429, 'u') },
      advisories: async () => new Map([[advisoryKey(d), [adv({ package: 'lodash' })]]])
    }, prevReport([prevEntry(d, {})]))
    expect(r.entries[0].level).toBe('critical')
    expect(r.entries[0].advisories).toHaveLength(1)
  })

  test('a registry failure keeps a previous critical entry without fresh advisory', async () => {
    const d = dep('lodash', '1.0.0')
    const prev = prevEntry(d, { level: 'critical', cause: 'deprecated', reason: 'Déprécié : x' })
    const r = await run(inv([unit([d])]), { packageInfo: async () => { throw new Error('x') } }, prevReport([prev]))
    expect(r.entries).toEqual([prev])
  })

  test('an unknown severity from a failed detail lookup keeps the previous known one', async () => {
    const d = dep('lodash', '1.0.0')
    const prev = prevEntry(d, { level: 'critical', cause: 'advisory', advisories: [adv({ package: 'lodash', severity: 'high' })] })
    const r = await run(inv([unit([d])]), { advisories: async () => new Map([[advisoryKey(d), [adv({ package: 'lodash', severity: 'unknown' })]]]) }, prevReport([prev]))
    expect(r.entries[0].level).toBe('critical')
    expect(r.entries[0].advisories[0].severity).toBe('high')
  })

  test('a failure reuses the previous entry only for the same installed version', async () => {
    const d = dep('lodash', '2.0.0')
    const prev = prevEntry(dep('lodash', '1.0.0'), { level: 'critical', cause: 'advisory', reason: 'Faille haute : Bad', advisories: [adv({ package: 'lodash' })] })
    const osvDown = await run(inv([unit([d])]), { advisories: async () => { throw new Error('offline') } }, prevReport([prev]))
    expect(osvDown.entries.find((e) => e.name === 'lodash')?.level ?? null).not.toBe('critical')
    expect(osvDown.entries.flatMap((e) => e.advisories)).toEqual([])
    const registryDown = await run(inv([unit([d])]), { packageInfo: async () => { throw new Error('x') } }, prevReport([{ ...prev, cause: 'deprecated', advisories: [] }]))
    expect(registryDown.entries).toEqual([])
  })

  test('errors are sorted and deduplicated', async () => {
    const r = await run(inv([unit([], [], { error: 'b' }), unit([], [], { error: 'b' })], { notes: ['a'] }))
    expect(r.errors).toEqual(['a', 'b'])
  })

  test('propagates an inventory failure', async () => {
    await expect(checkRepo({ http, now: () => NOW, inventory: async () => { throw new Error('no repo') } }, '/r', null)).rejects.toThrow('no repo')
  })

  test('groups registry errors per ecosystem and reason', async () => {
    const deps = [dep('a', '1.0.0'), dep('b', '1.0.0'), dep('c', '1.0.0'), dep('r', '1.0.0', { ecosystem: 'RubyGems' }), dep('d', '1.0.0')]
    const r = await run(inv([unit(deps)]), { packageInfo: async (_h, d) => { throw d.name === 'd' ? new HttpError(429, 'u') : new Error('fetch failed') } })
    expect(r.errors).toEqual(['RubyGems : r non vérifié (fetch failed)', 'npm : 3 paquets non vérifiés (fetch failed)', 'npm : d non vérifié (HTTP 429)'].sort())
  })

  test('keeps the previous checkedAt when every lookup failed', async () => {
    const offline = { advisories: async () => { throw new Error('offline') }, packageInfo: async () => { throw new Error('offline') } }
    const prev = prevReport([])
    expect((await run(inv([unit([dep('a', '1.0.0')])]), offline, prev)).checkedAt).toBe(1)
    expect((await run(inv([unit([dep('a', '1.0.0', { private: true })])]), offline, prev)).checkedAt).toBe(1)
    expect((await run(inv([unit([dep('a', '1.0.0')])]), offline, null)).checkedAt).toBeNull()
    // One answer is enough to call it a check.
    expect((await run(inv([unit([dep('a', '1.0.0')])]), { advisories: offline.advisories }, prev)).checkedAt).toBe(NOW)
    expect((await run(inv([unit([dep('a', '1.0.0')])]), { packageInfo: offline.packageInfo }, prev)).checkedAt).toBe(NOW)
  })
})