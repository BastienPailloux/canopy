import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { HttpError, fetchHttp } from '../../../src/main/deps/http'
import { depsFirstPassDelay, replayHttp, selectDepsHttp } from '../../../src/main/deps/replay'
import { FIRST_PASS_DELAY_MS } from '../../../src/main/deps/service'
import { advisoriesFor } from '../../../src/main/deps/osv'
import { createRegistry } from '../../../src/main/deps/registries'

const FIX = join(__dirname, '../../fixtures/deps')
const d = (name: string, version: string, ecosystem = 'npm' as const) => ({ ecosystem, name, version, manifest: 'package-lock.json', private: false })
let tmp: string | undefined
afterEach(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = undefined })

describe('replayHttp', () => {
  test('rereads registry fixtures', async () => {
    const j: any = (await replayHttp(FIX).getJson('https://registry.npmjs.org/zustand')).body
    expect(j['dist-tags'].latest).toBe('5.0.8')
  })

  test('missing file is a 404', async () => {
    await expect(replayHttp(FIX).getJson('https://registry.npmjs.org/nope')).rejects.toMatchObject({ status: 404 })
    await expect(replayHttp(FIX).getJson('https://registry.npmjs.org/nope')).rejects.toBeInstanceOf(HttpError)
  })

  test('rejects traversal', async () => {
    const h = replayHttp(FIX)
    await expect(h.getJson('https://registry.npmjs.org/%2e%2e%2fpackage')).rejects.toThrow()
    await expect(h.getJson('https://registry.npmjs.org/a/%2e%2e/b')).rejects.toThrow()
    await expect(h.getJson('https://registry.npmjs.org/a%00b')).rejects.toThrow()
  })

  test('scoped npm names read @scope%2fname.json literally', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'deps-'))
    await mkdir(join(tmp, 'registry.npmjs.org'))
    await writeFile(join(tmp, 'registry.npmjs.org', '@s%2fn.json'), '{"ok":1}')
    expect((await replayHttp(tmp).getJson('https://registry.npmjs.org/@s%2fn')).body).toEqual({ ok: 1 })
  })

  test('answers querybatch from the per-package map and details from vulns/<id>', async () => {
    const h = replayHttp(FIX)
    const m = await advisoriesFor(h, [d('tar', '6.1.11'), d('zustand', '5.0.1')])
    const tar = m.get('npm:tar@6.1.11')!
    expect(tar).toHaveLength(1)
    expect(tar[0]).toMatchObject({ severity: 'critical', fixed: '6.2.1' })
    expect(m.get('npm:zustand@5.0.1')).toEqual([])
  })

  test('fixtures give the four scenarios', async () => {
    const r = createRegistry({}), h = replayHttp(FIX)
    expect((await r.packageInfo(h, d('request', '2.88.2'))).deprecated).toMatch(/has been deprecated/)
    expect((await r.packageInfo(h, d('electron', '33.2.0'))).latest).toBe('39.1.0')
  })
})

describe('selectDepsHttp', () => {
  test('replays only when unpackaged with CANOPY_FAKE_DEPS', async () => {
    const env = { CANOPY_FAKE_DEPS: FIX }
    await expect(selectDepsHttp({ isPackaged: false, env }).getJson('https://registry.npmjs.org/zustand')).resolves.toBeTruthy()
    // packaged: the real client, which refuses non-allowlisted hosts before any fetch
    await expect(selectDepsHttp({ isPackaged: true, env }).getJson('https://example.com/x')).rejects.toThrow()
  })
})

describe('depsFirstPassDelay', () => {
  test('no delay only when replaying', () => {
    expect(depsFirstPassDelay({ isPackaged: false, env: { CANOPY_FAKE_DEPS: FIX } })).toBe(0)
    expect(depsFirstPassDelay({ isPackaged: true, env: { CANOPY_FAKE_DEPS: FIX } })).toBe(FIRST_PASS_DELAY_MS)
    expect(depsFirstPassDelay({ isPackaged: false, env: {} })).toBe(FIRST_PASS_DELAY_MS)
  })
})

describe('fetchHttp guards', () => {
  test('refuses other hosts and non-https before fetching', async () => {
    const h = fetchHttp()
    await expect(h.getJson('http://registry.npmjs.org/a')).rejects.toThrow()
    await expect(h.getJson('https://evil.example/a')).rejects.toThrow()
    await expect(h.postJson('https://registry.npmjs.org.evil.example/a', {})).rejects.toThrow()
  })
})
