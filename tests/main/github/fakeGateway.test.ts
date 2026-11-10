import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeGateway, selectPrGateway } from '../../../src/main/github/fakeGateway'

const file = join(__dirname, '../../fixtures/gh/pr.json')
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'fakegh-')))

describe('fakeGateway', () => {
  it('finds the PR only for its head branch', async () => {
    const g = fakeGateway({ file })
    expect((await g.find('/r', 'feat/gtin-lookup'))?.number).toBe(87)
    expect(await g.find('/r', 'other')).toBeNull()
    expect((await g.branchStates('/r'))?.get('feat/gtin-lookup')).toBe('open')
  })

  it('the remote tip of the head branch is the PR head', async () => {
    const g = fakeGateway({ file })
    const pr = await g.view('/r', 87)
    expect(await g.remoteTip('/r', pr.head)).toBe(pr.headOid)
    await expect(g.remoteTip('/r', 'other')).rejects.toThrow()
  })

  it('applies a comment and logs it', async () => {
    const logFile = join(tmp(), 'log')
    const g = fakeGateway({ file, logFile })
    await g.act('/r', 87, { type: 'comment', body: 'hello' })
    await g.act('/r', 87, { type: 'labels', add: ['new'], remove: ['api'] })
    const d = await g.view('/r', 87)
    expect(d.timeline.some((t) => t.kind === 'comment' && t.comment.body === 'hello')).toBe(true)
    expect(d.labels).toContain('new')
    expect(d.labels).not.toContain('api')
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ number: 87, action: { type: 'comment', body: 'hello' } })
  })

  it('merge marks the PR merged, revert gives a url', async () => {
    const g = fakeGateway({ file })
    await g.act('/r', 87, { type: 'merge', method: 'squash', subject: 's', body: '', headOid: 'a'.repeat(40) })
    expect((await g.view('/r', 87)).state).toBe('merged')
    expect((await g.find('/r', 'feat/gtin-lookup'))?.state).toBe('merged')
    expect(await g.act('/r', 87, { type: 'revert' })).toEqual({ ok: true, url: 'https://github.com/acme/passports/pull/999' })
  })

  it('a fixture with mergeQueue leaves a merged PR open, as a merge queue does', async () => {
    const queued = join(tmp(), 'pr.json')
    writeFileSync(queued, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), mergeQueue: true }))
    const g = fakeGateway({ file: queued })
    await g.act('/r', 87, { type: 'merge', method: 'squash', subject: 's', body: '', headOid: 'a'.repeat(40) })
    expect((await g.view('/r', 87)).state).toBe('open')
  })

  it('gives each comment its own id', async () => {
    const g = fakeGateway({ file })
    await g.act('/r', 87, { type: 'comment', body: 'a' })
    await g.act('/r', 87, { type: 'comment', body: 'b' })
    const ids = (await g.view('/r', 87)).timeline.flatMap((t) => (t.kind === 'comment' ? [t.comment.id] : []))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('fails while the fail file exists', async () => {
    const failFile = join(tmp(), 'fail')
    const g = fakeGateway({ file, failFile })
    writeFileSync(failFile, '')
    await expect(g.view('/r', 87)).rejects.toThrow()
    await expect(g.find('/r', 'feat/gtin-lookup')).rejects.toThrow()
    rmSync(failFile)
    await expect(g.view('/r', 87)).resolves.toBeTruthy()
  })

  it('returns a failed log excerpt', async () => {
    expect(await fakeGateway({ file }).failedLog('/r', 1, 2)).toContain('Expected status 404, received 422')
  })
})

describe('selectPrGateway', () => {
  it('ignores CANOPY_FAKE_GH when packaged', async () => {
    const env = { CANOPY_FAKE_GH: file }
    const fake = selectPrGateway({ isPackaged: false, env })
    expect((await fake.find('/r', 'feat/gtin-lookup'))?.number).toBe(87)
    const real = selectPrGateway({ isPackaged: true, env })
    // not called: the real gateway would shell out to gh
    expect(real).not.toBe(fake)
    expect(real.find).not.toBe(fake.find)
  })
})
