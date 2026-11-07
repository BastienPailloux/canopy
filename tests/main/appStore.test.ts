import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../src/main/appStore'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-store-'))
  file = join(dir, 'state.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AppStore', () => {
  it('starts with defaults when the file is missing', () => {
    const s = new AppStore(file)
    expect(s.recentRepos).toEqual([])
    expect(s.ports).toEqual({})
    expect(s.prefs).toEqual({})
  })

  it('reads back what it wrote', () => {
    const a = new AppStore(file)
    a.addRecentRepo('/r/one')
    a.setPorts('/r/one/.worktrees/x', { web: 4001 })
    a.setPrefs({ theme: 'dark' })
    const b = new AppStore(file)
    expect(b.recentRepos).toEqual(['/r/one'])
    expect(b.ports).toEqual({ '/r/one/.worktrees/x': { web: 4001 } })
    expect(b.prefs).toEqual({ theme: 'dark' })
  })

  it('dedupes recent repos (most recent first) and caps at 10', () => {
    const s = new AppStore(file)
    for (let i = 0; i < 12; i++) s.addRecentRepo(`/r/${i}`)
    s.addRecentRepo('/r/5')
    expect(s.recentRepos).toHaveLength(10)
    expect(s.recentRepos[0]).toBe('/r/5')
    expect(s.recentRepos.filter((r) => r === '/r/5')).toHaveLength(1)
    expect(new AppStore(file).recentRepos).toEqual(s.recentRepos)
  })

  it.each(['{not json', '[]', '{"recentRepos":"x","ports":3,"prefs":null}', ''])(
    'falls back to defaults on corrupt content %j',
    async (content) => {
      await writeFile(file, content)
      const s = new AppStore(file)
      expect(s.recentRepos).toEqual([])
      expect(s.ports).toEqual({})
      expect(s.prefs).toEqual({})
      s.addRecentRepo('/r/a')
      expect(new AppStore(file).recentRepos).toEqual(['/r/a'])
    }
  )

  it('writes atomically and leaves no temp file', async () => {
    const s = new AppStore(join(dir, 'sub', 'state.json'))
    s.addRecentRepo('/r/a')
    expect(await readdir(join(dir, 'sub'))).toEqual(['state.json'])
  })

  it('trusts a repo durably, and nothing else', () => {
    const a = new AppStore(file)
    expect(a.isRepoTrusted('/r/one')).toBe(false)
    a.trustRepo('/r/one')
    a.trustRepo('/r/one')
    const b = new AppStore(file)
    expect(b.isRepoTrusted('/r/one')).toBe(true)
    expect(b.isRepoTrusted('/r/two')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).trustedRepos).toEqual(['/r/one'])
  })

  it('sanitizes trustedRepos on its own', async () => {
    await writeFile(file, JSON.stringify({ recentRepos: ['/r/one'], trustedRepos: ['/r/ok', 1, null, '/r/ok'] }))
    const s = new AppStore(file)
    expect(s.isRepoTrusted('/r/ok')).toBe(true)
    await writeFile(file, JSON.stringify({ recentRepos: ['/r/one'], trustedRepos: 'all' }))
    const t = new AppStore(file)
    expect(t.isRepoTrusted('all')).toBe(false)
    expect(t.recentRepos).toEqual(['/r/one'])
  })
})
