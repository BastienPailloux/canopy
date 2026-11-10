import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'
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

  it('stored key that no longer decrypts is reported unreadable', () => {
    new AppStore(file, cipher()).saveApiKey('sk-ant-secret')
    const broken = { ...cipher(), decryptString: () => { throw new Error('keychain locked') } }
    const a = new AppStore(file, broken)
    expect(a.hasApiKey()).toBe(true)
    expect(a.apiKeyReadable()).toBe(false)
  })

  it('no stored key is readable: there is nothing to re-enter', () => {
    expect(new AppStore(file, cipher()).apiKeyReadable()).toBe(true)
    expect(new AppStore(file).apiKeyReadable()).toBe(true)
  })

  it('a stored key is unreadable when encryption is unavailable', () => {
    new AppStore(file, cipher()).saveApiKey('sk-ant-secret')
    expect(new AppStore(file, cipher(false)).apiKeyReadable()).toBe(false)
  })

  it('a stored key that decrypts is readable', () => {
    new AppStore(file, cipher()).saveApiKey('sk-ant-secret')
    expect(new AppStore(file, cipher()).apiKeyReadable()).toBe(true)
  })
})

describe('AppStore Linear auth', () => {
  const cipher = (available = true) => ({
    isEncryptionAvailable: () => available,
    encryptString: (p: string) => Buffer.from(`enc:${p}`.split('').reverse().join('')),
    decryptString: (b: Buffer) => b.toString().split('').reverse().join('').slice(4)
  })
  const state = { client: { client_id: 'cid-1' }, tokens: { access_token: 'lin-secret-token', refresh_token: 'lin-refresh' }, verifier: 'verif-1' }

  it('linear auth is never stored in clear', () => {
    const a = new AppStore(file, cipher())
    expect(a.linearAuth()).toBeNull()
    a.saveLinearAuth(state)
    const raw = readFileSync(file, 'utf8')
    for (const secret of ['lin-secret-token', 'lin-refresh', 'cid-1', 'verif-1']) expect(raw).not.toContain(secret)
    expect(typeof JSON.parse(raw).linearAuth).toBe('string')
    expect(new AppStore(file, cipher()).linearAuth()).toEqual(state)
  })

  it('keeps the expired mark of linear auth', () => {
    new AppStore(file, cipher()).saveLinearAuth({ ...state, expired: true })
    expect(new AppStore(file, cipher()).linearAuth()).toEqual({ ...state, expired: true })
  })

  it('unreadable linear auth reads as null', async () => {
    new AppStore(file, cipher()).saveLinearAuth(state)
    const broken = { ...cipher(), decryptString: () => { throw new Error('keychain locked') } }
    expect(new AppStore(file, broken).linearAuth()).toBeNull()
    expect(new AppStore(file, cipher(false)).linearAuth()).toBeNull()
    expect(new AppStore(file).linearAuth()).toBeNull()
    const notJson = { ...cipher(), decryptString: () => 'not json' }
    expect(new AppStore(file, notJson).linearAuth()).toBeNull()
    const notObject = { ...cipher(), decryptString: () => '[1]' }
    expect(new AppStore(file, notObject).linearAuth()).toBeNull()
    await writeFile(file, JSON.stringify({ linearAuth: 3 }))
    expect(new AppStore(file, cipher()).linearAuth()).toBeNull()
  })

  it('refuses to store linear auth when encryption is unavailable', () => {
    const a = new AppStore(file, cipher(false))
    expect(() => a.saveLinearAuth(state)).toThrow("Le trousseau macOS n'est pas disponible : la connexion Linear n'a pas été enregistrée.")
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('null clears linear auth and keeps the API key', () => {
    const a = new AppStore(file, cipher())
    a.saveApiKey('sk-ant-secret')
    a.saveLinearAuth(state)
    a.saveLinearAuth(null)
    expect(a.linearAuth()).toBeNull()
    expect(readFileSync(file, 'utf8')).not.toContain('linearAuth')
    expect(new AppStore(file, cipher()).apiKeyEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-secret' })
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

it('remembers repo bases, forgets one with null, ignores corrupt values', async () => {
  const a = new AppStore(file)
  a.setRepoBase('/r/one', 'origin/develop')
  a.setRepoBase('/r/two', 'main')
  a.setRepoBase('/r/two', null)
  expect(new AppStore(file).repoBases).toEqual({ '/r/one': 'origin/develop' })
  await writeFile(file, JSON.stringify({ recentRepos: ['/x'], repoBases: { '/a': 'main', '/b': 3, '/c': '' } }))
  expect(new AppStore(file).repoBases).toEqual({ '/a': 'main' })
  await writeFile(file, JSON.stringify({ repoBases: ['main'] }))
  expect(new AppStore(file).repoBases).toEqual({})
})

test('the last entry of a folder survives a restart, a bad value does not', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'canopy-store-')), 'state.json')
  const store = new AppStore(file)
  store.addRecentRepo('/ws')
  store.setLastEntry('/ws', '/ws/a')
  expect(new AppStore(file).lastEntries).toEqual({ '/ws': '/ws/a' })
  writeFileSync(file, JSON.stringify({ lastEntries: { '/ws': 3, '/ok': '/ok/a' } }))
  expect(new AppStore(file).lastEntries).toEqual({ '/ok': '/ok/a' })
})

test('last entries follow the recents: a folder that left them is dropped', () => {
  const store = new AppStore(join(mkdtempSync(join(tmpdir(), 'canopy-store-')), 'state.json'))
  store.addRecentRepo('/old')
  store.setLastEntry('/old', '/old/a')
  for (let i = 0; i < 10; i++) store.addRecentRepo(`/r${i}`)
  store.setLastEntry('/r9', '/r9/a')
  expect(store.lastEntries).toEqual({ '/r9': '/r9/a' })
})

test('remembers and prunes branch bases', async () => {
  const s = new AppStore(file)
  s.setBranchBase('/r', 'feat/a', 'feat/base')
  s.setBranchBase('/r', 'feat/b', 'develop')
  expect(s.branchBase('/r', 'feat/a')).toBe('feat/base')
  s.pruneBranchBases('/r', ['feat/b'])
  expect(s.branchBase('/r', 'feat/a')).toBeUndefined()
  expect(new AppStore(file).branchBase('/r', 'feat/b')).toBe('develop')
  s.setBranchBase('/r', 'feat/b', null)
  expect(s.branchBase('/r', 'feat/b')).toBeUndefined()
  await writeFile(file, JSON.stringify({ branchBases: { '/a': { x: 'y', z: 3 }, '/b': 'no' } }))
  expect(new AppStore(file).branchBase('/a', 'x')).toBe('y')
  expect(new AppStore(file).branchBase('/a', 'z')).toBeUndefined()
  await writeFile(file, JSON.stringify({ branchBases: ['x'] }))
  expect(new AppStore(file).branchBase('/a', 'x')).toBeUndefined()
})

test('a branch named __proto__ is a plain entry', () => {
  const s = new AppStore(file)
  s.setBranchBase('/r', '__proto__', 'main')
  expect(s.branchBase('/r', '__proto__')).toBe('main')
  expect(({} as Record<string, unknown>).main).toBeUndefined()
  expect(new AppStore(file).branchBase('/r', '__proto__')).toBe('main')
})

describe('linearLinks', () => {
  it('stores, replaces, clears, validates on load and prunes with the branches', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'canopy-links-')), 'state.json')
    const s = new AppStore(file)
    s.setLinearLink('/r', 'CAN-1', { branch: 'feat/a', worktree: '/w/a', base: 'main' })
    s.setLinearLink('/r', 'CAN-2', { branch: 'feat/b', worktree: '/w/b', base: 'main' })
    expect(new AppStore(file).linearLinks('/r')['CAN-1']).toEqual({ branch: 'feat/a', worktree: '/w/a', base: 'main' })
    s.pruneBranchBases('/r', ['feat/b'])
    expect(Object.keys(s.linearLinks('/r'))).toEqual(['CAN-2'])
    s.setLinearLink('/r', 'CAN-2', null)
    expect(s.linearLinks('/r')).toEqual({})
    await writeFile(file, JSON.stringify({ linearLinks: { '/r': { A: { branch: 1 }, B: { branch: 'b', worktree: 'w', base: 'x' } }, '/q': 4 } }))
    expect(new AppStore(file).linearLinks('/r')).toEqual({ B: { branch: 'b', worktree: 'w', base: 'x' } })
    expect(new AppStore(file).linearLinks('/q')).toEqual({})
  })
})

describe('branchHistory', () => {
  it('records branches most recent last without duplicates', () => {
    const s = new AppStore(file)
    s.recordBranch('/w', 'a')
    s.recordBranch('/w', 'b')
    s.recordBranch('/w', 'a')
    expect(s.branchHistory('/w')).toEqual(['b', 'a'])
    expect(s.branchHistory('/other')).toEqual([])
  })

  it('keeps the 50 most recent branches', () => {
    const s = new AppStore(file)
    for (let i = 0; i < 60; i++) s.recordBranch('/w', `b${i}`)
    const h = s.branchHistory('/w')
    expect(h).toHaveLength(50)
    expect(h[0]).toBe('b10')
    expect(h[49]).toBe('b59')
  })

  it('survives a reload and drops a malformed history', () => {
    const a = new AppStore(file)
    a.recordBranch('/w', 'a')
    expect(new AppStore(file).branchHistory('/w')).toEqual(['a'])
    writeFileSync(file, JSON.stringify({ branchHistory: { '/w': ['a', 3], '/x': 'no' } }))
    const b = new AppStore(file)
    expect(b.branchHistory('/w')).toEqual(['a'])
    expect(b.branchHistory('/x')).toEqual([])
  })

  it('drops a history whose worktree is not an absolute path', () => {
    writeFileSync(file, JSON.stringify({ branchHistory: { 'rel/wt': ['a'], '': ['b'], '/w': ['c'] } }))
    const s = new AppStore(file)
    expect(s.branchHistory('rel/wt')).toEqual([])
    expect(s.branchHistory('')).toEqual([])
    expect(s.branchHistory('/w')).toEqual(['c'])
  })

  it("forgets a worktree's history", () => {
    const s = new AppStore(file)
    s.recordBranch('/w', 'a')
    s.forgetBranchHistory('/w')
    expect(new AppStore(file).branchHistory('/w')).toEqual([])
  })
})

describe('autoMerges', () => {
  const entry = { number: 87, branch: 'feat/x', headOid: 'a'.repeat(40), cleanup: true }

  it('remembers a watched auto-merge across a reload, and forgets it with null', () => {
    const s = new AppStore(file)
    s.setAutoMerge('/w', entry)
    expect(new AppStore(file).autoMerges).toEqual({ '/w': entry })
    s.setAutoMerge('/w', null)
    expect(new AppStore(file).autoMerges).toEqual({})
  })

  it('drops a malformed entry', () => {
    writeFileSync(file, JSON.stringify({ autoMerges: { '/w': entry, '/a': { ...entry, number: 0 }, '/b': { ...entry, cleanup: 'yes' }, rel: entry, '/c': 3 } }))
    expect(new AppStore(file).autoMerges).toEqual({ '/w': entry })
  })
})
