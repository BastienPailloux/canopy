import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRegistry, packageInfo } from '../../../src/main/deps/registries'
import type { Http } from '../../../src/main/deps/http'
import type { Dep } from '../../../src/shared/deps'

const dep = (ecosystem: Dep['ecosystem'], name: string, version: string | null): Dep => ({ ecosystem, name, version, manifest: 'm', private: false })
function fake(answers: Record<string, unknown>, delay = 0, etags: Record<string, string> = {}) {
  const gets: { url: string; headers?: Record<string, string> }[] = []
  let cur = 0, max = 0
  const http: Http = {
    async getJson(url, headers) {
      gets.push({ url, headers }); cur++; max = Math.max(max, cur)
      if (delay) await new Promise((r) => setTimeout(r, delay))
      cur--
      if (!(url in answers)) throw new Error('404')
      const etag = etags[url] ?? null
      if (etag !== null && headers?.['If-None-Match'] === etag) return { status: 304, etag, body: null }
      return { status: 200, etag, body: answers[url] }
    },
    async postJson() { throw new Error('no') }
  }
  return { http, gets, max: () => max }
}

describe('packageInfo', () => {
  test('npm: dist-tags, deprecation, modified, Accept header', async () => {
    const f = fake({ 'https://registry.npmjs.org/request': { 'dist-tags': { latest: '2.88.2' }, modified: '2020-02-11T00:00:00.000Z', versions: { '2.88.2': { deprecated: 'gone' } } } })
    expect(await packageInfo(f.http, dep('npm', 'request', '2.88.2'))).toEqual({ latest: '2.88.2', deprecated: 'gone', yanked: false, inactive: false, lastRelease: '2020-02-11T00:00:00.000Z' })
    expect(f.gets[0].headers).toEqual({ Accept: 'application/vnd.npm.install-v1+json' })
  })

  test('npm: scoped names are encoded @scope%2fname', async () => {
    const f = fake({ 'https://registry.npmjs.org/@types%2fnode': { 'dist-tags': { latest: '1.0.0' }, versions: {} } })
    expect((await packageInfo(f.http, dep('npm', '@types/node', '1.0.0'))).latest).toBe('1.0.0')
  })

  test('RubyGems: latest non-prerelease, yanked when missing, newest created_at', async () => {
    const f = fake({ 'https://rubygems.org/api/v1/versions/rake.json': [
      { number: '14.0.0.rc1', prerelease: true, created_at: '2025-03-01T00:00:00Z' },
      { number: '13.1.0', prerelease: false, created_at: '2024-01-01T00:00:00Z' },
      { number: '13.0.0', prerelease: false, created_at: '2023-01-01T00:00:00Z' }
    ] })
    expect(await packageInfo(f.http, dep('RubyGems', 'rake', '13.0.0'))).toEqual({ latest: '13.1.0', deprecated: null, yanked: false, inactive: false, lastRelease: '2025-03-01T00:00:00Z' })
    expect((await createRegistry({}).packageInfo(f.http, dep('RubyGems', 'rake', '12.0.0'))).yanked).toBe(true)
  })

  test('PyPI: normalized name, yanked files, inactive classifier, latest upload', async () => {
    const f = fake({ 'https://pypi.org/pypi/foo-bar/json': {
      info: { version: '2.0', classifiers: ['Development Status :: 7 - Inactive'] },
      releases: { '1.0': [{ yanked: true, upload_time_iso_8601: '2020-01-01T00:00:00Z' }], '2.0': [{ yanked: false, upload_time_iso_8601: '2021-05-01T00:00:00Z' }] }
    } })
    expect(await packageInfo(f.http, dep('PyPI', 'Foo_Bar', '1.0'))).toEqual({ latest: '2.0', deprecated: null, yanked: true, inactive: true, lastRelease: '2021-05-01T00:00:00Z' })
  })

  test('a document of the wrong shape throws instead of reading as up to date', async () => {
    const urls = { npm: 'https://registry.npmjs.org/x', RubyGems: 'https://rubygems.org/api/v1/versions/x.json', PyPI: 'https://pypi.org/pypi/x/json' } as const
    for (const [eco, url] of Object.entries(urls) as [Dep['ecosystem'], string][]) {
      for (const body of [{}, null, 'x', []]) {
        await expect(createRegistry({}).packageInfo(fake({ [url]: body }).http, dep(eco, 'x', '1.0.0')), `${eco} ${JSON.stringify(body)}`).rejects.toThrow('Réponse inattendue')
      }
    }
    await expect(createRegistry({}).packageInfo(fake({ [urls.npm]: { 'dist-tags': { latest: 1 }, versions: {} } }).http, dep('npm', 'x', '1.0.0'))).rejects.toThrow()
    await expect(createRegistry({}).packageInfo(fake({ [urls.npm]: { 'dist-tags': { latest: '1.0.0' } } }).http, dep('npm', 'x', '1.0.0'))).rejects.toThrow()
    await expect(createRegistry({}).packageInfo(fake({ [urls.RubyGems]: [{ number: 1 }] }).http, dep('RubyGems', 'x', '1.0.0'))).rejects.toThrow()
    await expect(createRegistry({}).packageInfo(fake({ [urls.PyPI]: { info: { version: '1.0' } } }).http, dep('PyPI', 'x', '1.0.0'))).rejects.toThrow()
  })

  test('invalid names throw without any request', async () => {
    const f = fake({})
    await expect(packageInfo(f.http, dep('npm', '../etc', '1.0.0'))).rejects.toThrow('Nom de paquet invalide')
    await expect(packageInfo(f.http, { ...dep('npm', 'ok', '1.0.0'), private: true })).rejects.toThrow()
    expect(f.gets).toHaveLength(0)
  })

  test('caches responses for 6 hours', async () => {
    let now = 0
    const f = fake({ 'https://registry.npmjs.org/a': { 'dist-tags': { latest: '1.0.0' }, versions: {} } })
    const r = createRegistry({ now: () => now })
    await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    now = 6 * 3600_000 - 1
    await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets).toHaveLength(1)
    now = 6 * 3600_000
    await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets).toHaveLength(2)
  })

  test('does not cache failures', async () => {
    const f = fake({})
    const r = createRegistry({})
    await expect(r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).rejects.toThrow()
    await expect(r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).rejects.toThrow()
    expect(f.gets).toHaveLength(2)
  })

  test('at most 6 registry requests at a time', async () => {
    const answers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`https://registry.npmjs.org/p${i}`, { 'dist-tags': { latest: '1.0.0' }, versions: {} }]))
    const f = fake(answers, 5)
    const r = createRegistry({})
    await Promise.all(Array.from({ length: 20 }, (_, i) => r.packageInfo(f.http, dep('npm', `p${i}`, '1.0.0'))))
    expect(f.max()).toBe(6)
  })

  test('the same package at another version is looked up again: documents are not kept', async () => {
    const f = fake({ 'https://registry.npmjs.org/a': { 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': { deprecated: 'old' } } } })
    const r = createRegistry({})
    expect((await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).deprecated).toBe('old')
    expect((await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).deprecated).toBe('old')
    expect((await r.packageInfo(f.http, dep('npm', 'a', '2.0.0'))).deprecated).toBeNull()
    expect(f.gets).toHaveLength(2)
  })

  test('revalidates with the ETag after 6 hours and reuses the info on 304', async () => {
    let now = 0
    const url = 'https://registry.npmjs.org/a'
    const answers: Record<string, unknown> = { [url]: { 'dist-tags': { latest: '1.0.0' }, versions: {} } }
    const f = fake(answers, 0, { [url]: '"v1"' })
    const r = createRegistry({ now: () => now })
    await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets[0].headers?.['If-None-Match']).toBeUndefined()
    now = 6 * 3600_000
    answers[url] = { 'dist-tags': { latest: '9.9.9' }, versions: {} }
    expect((await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).latest).toBe('1.0.0')
    expect(f.gets[1].headers).toEqual({ Accept: 'application/vnd.npm.install-v1+json', 'If-None-Match': '"v1"' })
    // Revalidated: fresh again for 6 hours.
    now = 12 * 3600_000 - 1
    await r.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets).toHaveLength(2)
  })
})

describe('registry cache file', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deps-registry-')); file = join(dir, 'deps-registry-cache.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const doc = { 'dist-tags': { latest: '1.0.0' }, readme: 'HUGE-README', versions: { '1.0.0': {} } }

  test('a restart within 6 hours reuses the stored info, which holds no document', async () => {
    let now = 1000
    const f = fake({ 'https://registry.npmjs.org/a': doc }, 0, { 'https://registry.npmjs.org/a': '"e"' })
    await createRegistry({ now: () => now, file, schedule: (fn) => fn() }).packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    const saved = readFileSync(file, 'utf8')
    expect(JSON.parse(saved).version).toBe(1)
    expect(saved).not.toContain('HUGE-README')
    now += 6 * 3600_000 - 1
    const again = createRegistry({ now: () => now, file, schedule: (fn) => fn() })
    expect((await again.packageInfo(f.http, dep('npm', 'a', '1.0.0'))).latest).toBe('1.0.0')
    expect(f.gets).toHaveLength(1)
    now += 1
    await again.packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets[1].headers?.['If-None-Match']).toBe('"e"')
  })

  test('ignores a corrupt file or another version', async () => {
    const f = fake({ 'https://registry.npmjs.org/a': doc })
    writeFileSync(file, '{nope')
    await createRegistry({ file, schedule: () => undefined }).packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    writeFileSync(file, JSON.stringify({ version: 2, entries: { 'npm\u0000a\u00001.0.0': { at: Date.now(), etag: null, info: { latest: 'x', deprecated: null, yanked: false, inactive: false, lastRelease: null } } } }))
    await createRegistry({ file, schedule: () => undefined }).packageInfo(f.http, dep('npm', 'a', '1.0.0'))
    expect(f.gets).toHaveLength(2)
  })
})
