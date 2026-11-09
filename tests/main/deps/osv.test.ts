import { describe, expect, test } from 'vitest'
import { advisoriesFor } from '../../../src/main/deps/osv'
import type { Http } from '../../../src/main/deps/http'
import { depKey, type Dep } from '../../../src/shared/deps'

const dep = (name: string, version: string | null, o: Partial<Dep> = {}): Dep =>
  ({ ecosystem: 'npm', name, version, manifest: 'package-lock.json', private: false, ...o })

interface Fake { http: Http; posts: { url: string; body: any }[]; gets: string[] }
function fake(batch: (queries: any[]) => any[], details: Record<string, unknown> = {}): Fake {
  const posts: Fake['posts'] = [], gets: string[] = []
  const http: Http = {
    async getJson(url) {
      gets.push(url)
      const id = decodeURIComponent(url.split('/v1/vulns/')[1])
      if (!(id in details)) throw new Error('boom')
      return { status: 200, etag: null, body: details[id] }
    },
    async postJson(url, body) { posts.push({ url, body }); return { results: batch((body as any).queries) } }
  }
  return { http, posts, gets }
}

const detail = (o: Record<string, unknown>) => ({ id: 'GHSA-aaaa-bbbb-cccc', ...o })

describe('advisoriesFor', () => {
  test('never sends private, unpinned or invalid-named deps', async () => {
    const f = fake((q) => q.map(() => ({})))
    const m = await advisoriesFor(f.http, [dep('ok', '1.0.0'), dep('priv', '1.0.0', { private: true }), dep('nover', null), dep('bad name; rm', '1.0.0'), dep('../x', '1.0.0')])
    expect(f.posts).toHaveLength(1)
    expect(f.posts[0].body).toEqual({ queries: [{ package: { name: 'ok', ecosystem: 'npm' }, version: '1.0.0' }] })
    expect([...m.keys()]).toEqual([depKey(dep('ok', '1.0.0'))])
  })

  test('splits OSV queries in batches of 1000', async () => {
    const f = fake((q) => q.map(() => ({})))
    await advisoriesFor(f.http, Array.from({ length: 1500 }, (_, i) => dep(`p${i}`, '1.0.0')))
    expect(f.posts.map((p) => [p.url, p.body.queries.length])).toEqual([
      ['https://api.osv.dev/v1/querybatch', 1000], ['https://api.osv.dev/v1/querybatch', 500]
    ])
  })

  test('does not post anything without eligible deps', async () => {
    const f = fake(() => [])
    expect((await advisoriesFor(f.http, [dep('a', null)])).size).toBe(0)
    expect(f.posts).toHaveLength(0)
  })

  test('details each id once, even when shared, and skips malformed ids', async () => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'GHSA-1', modified: 'x' }, { id: '../etc/passwd', modified: 'x' }] })), {
      'GHSA-1': detail({ id: 'GHSA-1', summary: 'Bad', database_specific: { severity: 'MODERATE' } })
    })
    const m = await advisoriesFor(f.http, [dep('a', '1.0.0'), dep('b', '2.0.0')])
    expect(f.gets).toEqual(['https://api.osv.dev/v1/vulns/GHSA-1'])
    expect(m.get(depKey(dep('a', '1.0.0')))).toEqual([{ id: 'GHSA-1', package: 'a', severity: 'moderate', summary: 'Bad', fixed: null, url: 'https://osv.dev/vulnerability/GHSA-1' }])
    expect(m.get(depKey(dep('b', '2.0.0')))![0].package).toBe('b')
  })

  test.each([['CRITICAL', 'critical'], ['HIGH', 'high'], ['MODERATE', 'moderate'], ['MEDIUM', 'moderate'], ['LOW', 'low']])('maps %s', async (label, sev) => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'X-1' }] })), { 'X-1': detail({ database_specific: { severity: label } }) })
    expect((await advisoriesFor(f.http, [dep('a', '1.0.0')])).get(depKey(dep('a', '1.0.0')))![0].severity).toBe(sev)
  })

  test('falls back to the CVSS_V3 vector, then unknown', async () => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'X-1' }, { id: 'X-2' }] })), {
      'X-1': detail({ severity: [{ type: 'CVSS_V2', score: 'AV:N' }, { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }),
      'X-2': detail({ details: 'First line\nsecond' })
    })
    const a = (await advisoriesFor(f.http, [dep('a', '1.0.0')])).get(depKey(dep('a', '1.0.0')))!
    expect(a.map((x) => x.severity)).toEqual(['critical', 'unknown'])
    expect(a[1].summary).toBe('First line')
  })

  test('fixed is the smallest fix above the installed version for the matching package', async () => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'X-1' }] })), {
      'X-1': detail({
        affected: [
          { package: { name: 'other', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '6.0.1' }] }] },
          { package: { name: 'tar', ecosystem: 'npm' }, ranges: [
            { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.4.18' }] },
            { type: 'SEMVER', events: [{ introduced: '6.0.0' }, { fixed: '6.2.1' }] },
            { type: 'SEMVER', events: [{ introduced: '5.0.0' }, { fixed: '5.0.10' }] }
          ] }
        ]
      })
    })
    const a = (await advisoriesFor(f.http, [dep('tar', '5.0.2')])).get(depKey(dep('tar', '5.0.2')))!
    expect(a[0].fixed).toBe('5.0.10')
  })

  test('PyPI affected names compare normalized', async () => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'X-1' }] })), {
      'X-1': detail({ affected: [{ package: { name: 'Foo_Bar', ecosystem: 'PyPI' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0' }] }] }] })
    })
    const d = dep('foo.bar', '1.0', { ecosystem: 'PyPI' })
    expect((await advisoriesFor(f.http, [d])).get(depKey(d))![0].fixed).toBe('2.0')
  })

  test('a failed detail still shows the advisory as unknown', async () => {
    const f = fake((q) => q.map(() => ({ vulns: [{ id: 'X-9' }] })))
    expect((await advisoriesFor(f.http, [dep('a', '1.0.0')])).get(depKey(dep('a', '1.0.0')))).toEqual([
      { id: 'X-9', package: 'a', severity: 'unknown', summary: '', fixed: null, url: 'https://osv.dev/vulnerability/X-9' }
    ])
  })

  test('detail fetches run at most 6 at a time', async () => {
    let cur = 0, max = 0
    const http: Http = {
      async getJson() { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 5)); cur--; return { status: 200, etag: null, body: {} } },
      async postJson(_u, body) { return { results: (body as any).queries.map(() => ({ vulns: Array.from({ length: 20 }, (_, i) => ({ id: `V-${i}` })) })) } }
    }
    await advisoriesFor(http, [dep('a', '1.0.0')])
    expect(max).toBe(6)
  })
})
