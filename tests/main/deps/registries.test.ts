import { describe, expect, test } from 'vitest'
import { createRegistry, packageInfo } from '../../../src/main/deps/registries'
import type { Http } from '../../../src/main/deps/http'
import type { Dep } from '../../../src/shared/deps'

const dep = (ecosystem: Dep['ecosystem'], name: string, version: string | null): Dep => ({ ecosystem, name, version, manifest: 'm', private: false })
function fake(answers: Record<string, unknown>, delay = 0) {
  const gets: { url: string; headers?: Record<string, string> }[] = []
  let cur = 0, max = 0
  const http: Http = {
    async getJson(url, headers) {
      gets.push({ url, headers }); cur++; max = Math.max(max, cur)
      if (delay) await new Promise((r) => setTimeout(r, delay))
      cur--
      if (!(url in answers)) throw new Error('404')
      return answers[url]
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
})
