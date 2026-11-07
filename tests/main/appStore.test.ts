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

  it('approves a config hash per repo, durably, and nothing else', () => {
    const a = new AppStore(file)
    expect(a.isRepoTrusted('/r/one')).toBe(false)
    a.approveConfig('/r/one', 'h1')
    a.approveConfig('/r/one', 'h1')
    a.approveConfig('/r/one', 'h2')
    const b = new AppStore(file)
    expect(b.isRepoTrusted('/r/one')).toBe(true)
    expect(b.isConfigApproved('/r/one', 'h1')).toBe(true)
    expect(b.isConfigApproved('/r/one', 'h2')).toBe(true)
    expect(b.isConfigApproved('/r/one', 'h3')).toBe(false)
    expect(b.isConfigApproved('/r/two', 'h1')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).approvedConfigs).toEqual({ '/r/one': ['h1', 'h2'] })
  })

  it('takes an old trustedRepos entry, which has no hash, as untrusted', async () => {
    await writeFile(file, JSON.stringify({ recentRepos: ['/r/one'], trustedRepos: ['/r/one'] }))
    const s = new AppStore(file)
    expect(s.isRepoTrusted('/r/one')).toBe(false)
    expect(s.recentRepos).toEqual(['/r/one'])
  })

  it('sanitizes approvedConfigs on its own', async () => {
    await writeFile(file, JSON.stringify({ recentRepos: ['/r/one'], approvedConfigs: { '/r/ok': ['h', 1, null, 'h'], '/r/bad': 'h' } }))
    const s = new AppStore(file)
    expect(s.recentRepos).toEqual(['/r/one'])
    expect(s.isConfigApproved('/r/ok', 'h')).toBe(true)
    expect(s.isRepoTrusted('/r/bad')).toBe(false)
    await writeFile(file, JSON.stringify({ recentRepos: ['/r/one'], approvedConfigs: 'all' }))
    expect(new AppStore(file).isRepoTrusted('all')).toBe(false)
  })
})

it('keeps the last login PATH across restarts and ignores a bad value', async () => {
  const file = join(dir, 'state.json')
  const store = new AppStore(file)
  expect(store.loginPath).toBeUndefined()
  store.setLoginPath('/a:/b')
  expect(new AppStore(file).loginPath).toBe('/a:/b')
  await writeFile(file, JSON.stringify({ loginPath: 3 }))
  expect(new AppStore(file).loginPath).toBeUndefined()
})

describe('AppStore API key', () => {
  const cipher = (available = true) => ({
    isEncryptionAvailable: () => available,
    encryptString: (p: string) => Buffer.from(`enc:${p}`.split('').reverse().join('')),
    decryptString: (b: Buffer) => b.toString().split('').reverse().join('').slice(4)
  })

  it('stores the key encrypted, never in clear, and exposes it as ANTHROPIC_API_KEY', () => {
    const a = new AppStore(file, cipher())
    expect(a.apiKeyEnv()).toEqual({})
    a.saveApiKey('sk-ant-secret')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-secret')
    expect(a.hasApiKey()).toBe(true)
    expect(new AppStore(file, cipher()).apiKeyEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-secret' })
  })

  it('refuses to store a key when encryption is unavailable', () => {
    const a = new AppStore(file, cipher(false))
    expect(() => a.saveApiKey('sk-ant-secret')).toThrow(/trousseau/)
    expect(a.hasApiKey()).toBe(false)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('null removes the key', () => {
    const a = new AppStore(file, cipher())
    a.saveApiKey('sk-ant-secret')
    a.saveApiKey(null)
    expect(a.hasApiKey()).toBe(false)
    expect(a.apiKeyEnv()).toEqual({})
    expect(readFileSync(file, 'utf8')).not.toContain('apiKey')
  })

  it('gives no key when it cannot be decrypted', () => {
    new AppStore(file, cipher()).saveApiKey('sk-ant-secret')
    const broken = { ...cipher(), decryptString: () => { throw new Error('keychain locked') } }
    expect(new AppStore(file, broken).apiKeyEnv()).toEqual({})
  })
})

it('revoking a repo forgets its approvals, and survives a restart', () => {
  const store = new AppStore(file)
  store.approveConfig('/repo', 'h1')
  store.approveConfig('/other', 'h2')
  expect(store.trustedRepos).toEqual(['/repo', '/other'])

  store.revokeRepo('/repo')
  expect(store.isConfigApproved('/repo', 'h1')).toBe(false)
  expect(store.isRepoTrusted('/repo')).toBe(false)
  expect(new AppStore(file).trustedRepos).toEqual(['/other'])
})
