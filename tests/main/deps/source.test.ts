import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { git as gitSpy } from '../../../src/main/git/exec'
import { currentEnv } from '../../../src/main/env'
import { EXCLUDED_DIRS, forgetRepo, groupListing, readAtRef, readInventory } from '../../../src/main/deps/source'
import { createRepo, type TestRepo } from '../../helpers/repo'

// Pass-through: lets a test give the login-shell env that the app would see.
vi.mock('../../../src/main/env', async (original) => {
  const m = await original<typeof import('../../../src/main/env')>()
  return { ...m, currentEnv: vi.fn(m.currentEnv) }
})

// Pass-through spy: lets a test list the git commands readInventory ran.
vi.mock('../../../src/main/git/exec', async (original) => {
  const m = await original<typeof import('../../../src/main/git/exec')>()
  return { ...m, git: vi.fn(m.git) }
})

let repo: TestRepo | undefined
// The user's own ~/.npmrc must not change what these tests see.
const realHome = process.env.HOME
beforeAll(async () => { process.env.HOME = await mkdtemp(join(tmpdir(), 'deps-no-home-')) })
afterAll(async () => { await rm(process.env.HOME!, { recursive: true, force: true }); process.env.HOME = realHome })
afterEach(async () => { await repo?.cleanup(); repo = undefined })

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV }).toString()

const npmLock = (...names: string[]) => JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])) },
    ...Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: '1.0.0', resolved: `https://registry.npmjs.org/${n}/-/${n}-1.0.0.tgz` }]))
  }
})
const PKG = (...names: string[]) => JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])) })
const GEMS = `GEM
  remote: https://rubygems.org/
  specs:
    rake (13.0.0)

PLATFORMS
  ruby

DEPENDENCIES
  rake

BUNDLED WITH
   2.5.0
`
/** Several files in one commit: three git processes however many files, instead of three per file. */
async function commitAll(r: TestRepo, files: Record<string, string>): Promise<void> {
  for (const [f, c] of Object.entries(files)) {
    await mkdir(dirname(join(r.path, f)), { recursive: true })
    await writeFile(join(r.path, f), c)
  }
  sh(r.path, 'add', '--', ...Object.keys(files))
  sh(r.path, 'commit', '-q', '-m', 'update')
}
const names = (u: { deps: { name: string }[] }) => u.deps.map((d) => d.name).sort()

describe('readInventory', { timeout: 60_000 }, () => {
  test('exports the excluded directories', () => {
    expect(EXCLUDED_DIRS).toEqual(['node_modules', 'vendor', '.venv', '.worktrees'])
  })

  test('reads lockfiles committed on the base, including in subfolders, and skips excluded dirs', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': npmLock('left-pad'), 'package.json': PKG('left-pad'), 'api/Gemfile.lock': GEMS, 'node_modules/x/package-lock.json': npmLock('evil'), '.worktrees/w/package-lock.json': npmLock('evil'), 'vendor/Gemfile.lock': GEMS })
    const inv = await readInventory(repo.path)
    expect(inv.repo).toBe(repo.path)
    expect(inv.baseRef).toBe('main')
    expect(inv.notes).toEqual([])
    expect(inv.units.map((u) => `${u.dir}|${u.ecosystem}`).sort()).toEqual(['api|RubyGems', '|npm'])
    expect(names(inv.units.find((u) => u.ecosystem === 'npm')!)).toEqual(['left-pad'])
  })

  test('reads the base, not the checkout', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': npmLock('committed'), 'package.json': PKG('committed') })
    await writeFile(join(repo.path, 'package-lock.json'), npmLock('uncommitted'))
    const inv = await readInventory(repo.path)
    expect(names(inv.units[0])).toEqual(['committed'])
  })

  test('sees a commit pushed by another clone after fetching', async () => {
    repo = await createRepo({ remote: true })
    const other = join(repo.path, '..', 'other')
    sh(repo.path, 'clone', '-q', join(repo.path, '..', 'remote.git'), other)
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'Gemfile.lock'), GEMS)
    sh(other, 'add', '.')
    sh(other, 'commit', '-q', '-m', 'gems')
    sh(other, 'push', '-q', 'origin', 'main')
    const inv = await readInventory(repo.path)
    expect(inv.baseRef).toBe('origin/main')
    expect(inv.units.map((u) => u.ecosystem)).toEqual(['RubyGems'])
    expect(inv.notes).toEqual([])
  })

  test('does not fetch when fetch is false', async () => {
    repo = await createRepo({ remote: true })
    const other = join(repo.path, '..', 'other')
    sh(repo.path, 'clone', '-q', join(repo.path, '..', 'remote.git'), other)
    await writeFile(join(other, 'Gemfile.lock'), GEMS)
    sh(other, 'add', '.')
    sh(other, 'commit', '-q', '-m', 'gems')
    sh(other, 'push', '-q', 'origin', 'main')
    expect((await readInventory(repo.path, { fetch: false })).units).toEqual([])
  })

  describe('fetch hardening', () => {
    const UNSAFE = 'Branche de base non rafraîchie : configuration locale non sûre'
    const exists = (p: string) => stat(p).then(() => true, () => false)
    // One repo whose remote holds a commit it never fetched; each test works on a copy (a few git calls instead of ~13).
    let template: TestRepo
    beforeAll(async () => {
      template = await createRepo({ remote: true })
      const other = join(template.path, '..', 'other')
      sh(template.path, 'clone', '-q', join(template.path, '..', 'remote.git'), other)
      await writeFile(join(other, 'Gemfile.lock'), GEMS)
      sh(other, 'add', '.')
      sh(other, 'commit', '-q', '-m', 'gems')
      sh(other, 'push', '-q', 'origin', 'main')
      await rm(other, { recursive: true, force: true })
    })
    afterAll(async () => { await template.cleanup() })
    const copyOfTemplate = async (): Promise<TestRepo> => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'canopy-test-')))
      await cp(join(template.path, '..'), root, { recursive: true })
      const path = join(root, 'repo')
      sh(path, 'remote', 'set-url', 'origin', join(root, 'remote.git'))
      const commit: TestRepo['commit'] = async (file, content) => {
        await commitAll({ path } as TestRepo, { [file]: content })
        return sh(path, 'rev-parse', 'HEAD').trim()
      }
      return { path, commit, cleanup: () => rm(root, { recursive: true, force: true }) }
    }
    test.each([
      ['credential.helper', (m: string) => `!touch '${m}'`],
      ['remote.origin.uploadpack', (m: string) => `touch '${m}'; git-upload-pack`],
      ['core.sshCommand', (m: string) => `touch '${m}'; ssh`]
    ])('skips the fetch when local config sets %s', async (key, value) => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', key, value(marker))
      const inv = await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
      expect(inv.notes).toEqual([UNSAFE])
      expect(inv.units).toEqual([])
    })

    test('never runs an ext:: remote', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'remote', 'set-url', 'origin', `ext::sh -c "touch '${marker}'"`)
      const inv = await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
      expect(inv.notes).toHaveLength(1)
    })

    test('protocol.ext.allow in local config does not let an ext:: remote run', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', 'protocol.ext.allow', 'always')
      sh(repo.path, 'remote', 'set-url', 'origin', `ext::sh -c "touch '${marker}'"`)
      await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
    })

    test('core.alternateRefsCommand never runs', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', 'core.alternateRefsCommand', `touch '${marker}'`)
      await writeFile(join(repo.path, '.git', 'objects', 'info', 'alternates'), join(repo.path, '..', 'remote.git', 'objects') + '\n')
      await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
    })

    test('an unknown local key skips the fetch', async () => {
      repo = await copyOfTemplate()
      sh(repo.path, 'config', 'foo.bar', 'baz')
      const inv = await readInventory(repo.path)
      expect(inv.notes).toEqual([UNSAFE])
      expect(inv.units).toEqual([])
    })

    test('a submodule\'s own config is never used: the fetch does not recurse', async () => {
      repo = await createRepo({ remote: true })
      const subrepo = await createRepo({ dirName: 'subsrc' })
      try {
        const marker = join(repo.path, '..', 'ran')
        const fileOk = ['-c', 'protocol.file.allow=always']
        execFileSync('git', [...fileOk, 'submodule', 'add', '-q', subrepo.path, 'sub'], { cwd: repo.path, env: ENV })
        sh(repo.path, 'commit', '-q', '-m', 'add sub')
        sh(repo.path, 'push', '-q', 'origin', 'main')
        sh(repo.path, 'config', '-f', join(repo.path, '.git', 'modules', 'sub', 'config'), 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`)
        await subrepo.commit('x.txt', 'x')
        const other = join(repo.path, '..', 'other')
        execFileSync('git', [...fileOk, 'clone', '-q', '--recurse-submodules', join(repo.path, '..', 'remote.git'), other], { env: ENV })
        sh(join(other, 'sub'), 'fetch', '-q', 'origin')
        sh(join(other, 'sub'), 'checkout', '-q', 'origin/main')
        await writeFile(join(other, 'Gemfile.lock'), GEMS)
        sh(other, 'add', '.')
        sh(other, 'commit', '-q', '-m', 'bump sub')
        sh(other, 'push', '-q', 'origin', 'main')
        const inv = await readInventory(repo.path)
        expect(inv.notes).toEqual([])
        expect(inv.units).toHaveLength(1)
        expect(await exists(marker)).toBe(false)
      } finally {
        await subrepo.cleanup()
      }
    })

    test('reading a missing object never lazy-fetches from a promisor remote', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      await repo.commit('d/f', 'x')
      sh(repo.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const tree = sh(repo.path, 'rev-parse', 'HEAD:d').trim()
      await rm(join(repo.path, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))
      sh(repo.path, 'config', 'core.repositoryformatversion', '1')
      sh(repo.path, 'config', 'extensions.partialclone', 'evil')
      sh(repo.path, 'config', 'remote.evil.promisor', 'true')
      sh(repo.path, 'config', 'remote.evil.url', join(repo.path, '..', 'remote.git'))
      sh(repo.path, 'config', 'remote.evil.uploadpack', `touch '${marker}'; git-upload-pack`)
      const inv = await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
      expect(inv.units).toEqual([])
      expect(inv.notes.length).toBeGreaterThan(0)
    })

    test('resolving the base branch never lazy-fetches a missing commit', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      await repo.commit('d/f', 'x')
      sh(repo.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const commit = sh(repo.path, 'rev-parse', 'HEAD').trim()
      sh(repo.path, 'reset', '-q', '--hard', 'HEAD~1')
      await rm(join(repo.path, '.git', 'objects', commit.slice(0, 2), commit.slice(2)))
      sh(repo.path, 'config', 'core.repositoryformatversion', '1')
      sh(repo.path, 'config', 'extensions.partialclone', 'evil')
      sh(repo.path, 'config', 'remote.evil.promisor', 'true')
      sh(repo.path, 'config', 'remote.evil.url', join(repo.path, '..', 'remote.git'))
      sh(repo.path, 'config', 'remote.evil.uploadpack', `touch '${marker}'; git-upload-pack`)
      await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
    })

    test('a partial clone is skipped before any object read or fetch', async () => {
      repo = await copyOfTemplate()
      const marker = join(repo.path, '..', 'ran')
      await repo.commit('d/f', 'x')
      sh(repo.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const commit = sh(repo.path, 'rev-parse', 'HEAD').trim()
      sh(repo.path, 'reset', '-q', '--hard', 'HEAD~1')
      await rm(join(repo.path, '.git', 'objects', commit.slice(0, 2), commit.slice(2)))
      sh(repo.path, 'config', 'core.repositoryformatversion', '1')
      sh(repo.path, 'config', 'extensions.partialClone', 'evil')
      sh(repo.path, 'config', 'remote.evil.promisor', 'true')
      sh(repo.path, 'config', 'remote.evil.url', join(repo.path, '..', 'remote.git'))
      sh(repo.path, 'config', 'remote.evil.uploadpack', `touch '${marker}'; git-upload-pack`)
      vi.mocked(gitSpy).mockClear()
      const inv = await readInventory(repo.path)
      expect(inv).toEqual({ repo: repo.path, baseRef: null, units: [], notes: ['Dépôt partiel : dépendances non vérifiées'] })
      const commands = vi.mocked(gitSpy).mock.calls.map(([, args]) => args.find((a) => !a.startsWith('-') && !a.includes('=')))
      expect(new Set(commands)).toEqual(new Set(['worktree', 'config']))
      expect(await exists(marker)).toBe(false)
    })

    test('a promisor remote alone (git boolean) marks a partial clone', async () => {
      repo = await copyOfTemplate()
      sh(repo.path, 'config', 'remote.Evil.promisor', 'yes')
      const inv = await readInventory(repo.path, { fetch: false })
      expect(inv.notes).toEqual(['Dépôt partiel : dépendances non vérifiées'])
      expect(inv.baseRef).toBeNull()
    })

    // Old git reads these as a partial clone whatever their value (any non-zero int is true): presence is enough.
    test.each([
      ['remote.evil.promisor', 'false'],
      ['remote.evil.promisor', '2'],
      ['remote.evil.partialclonefilter', 'blob:none']
    ])('%s=%s marks a partial clone', async (key, value) => {
      repo = await copyOfTemplate()
      sh(repo.path, 'config', key, value)
      vi.mocked(gitSpy).mockClear()
      const inv = await readInventory(repo.path)
      expect(inv.notes).toEqual(['Dépôt partiel : dépendances non vérifiées'])
      expect(inv.baseRef).toBeNull()
      const commands = vi.mocked(gitSpy).mock.calls.map(([, args]) => args.find((a) => !a.startsWith('-') && !a.includes('=')))
      expect(new Set(commands)).toEqual(new Set(['worktree', 'config']))
    })

    test('a remote.origin.fetch refspec cannot move a local branch', async () => {
      repo = await copyOfTemplate()
      sh(repo.path, 'branch', 'keep')
      const before = sh(repo.path, 'rev-parse', 'keep')
      sh(repo.path, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/keep')
      await readInventory(repo.path)
      expect(sh(repo.path, 'rev-parse', 'keep')).toBe(before)
    })

    test('still fetches from a plain local remote', async () => {
      repo = await copyOfTemplate()
      const inv = await readInventory(repo.path)
      expect(inv.notes).toEqual([])
      expect(inv.units).toHaveLength(1)
    })
  })

  test('skips the fetch without a remote', async () => {
    repo = await createRepo()
    await repo.commit('Gemfile.lock', GEMS)
    const inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(inv.notes).toEqual([])
  })

  test('reports a failed fetch and reads the existing ref', async () => {
    repo = await createRepo({ remote: true })
    await repo.commit('Gemfile.lock', GEMS)
    sh(repo.path, 'push', '-q', 'origin', 'main')
    sh(repo.path, 'remote', 'set-url', 'origin', join(repo.path, '..', 'nowhere.git'))
    const inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(inv.notes).toHaveLength(1)
    expect(inv.notes[0]).toMatch(/^Branche de base non rafraîchie : .{1,160}$/)
  })

  test('returns no unit without a lockfile', async () => {
    repo = await createRepo()
    expect((await readInventory(repo.path)).units).toEqual([])
  })

  test('an unlistable ref gives no unit and a French note', async () => {
    repo = await createRepo()
    const inv = await readAtRef(repo.path, 'origin/gone')
    expect(inv.units).toEqual([])
    expect(inv.notes).toHaveLength(1)
    expect(inv.notes[0]).toMatch(/^Liste des fichiers illisible : .{1,160}$/)
  })

  test('rejects outside a git repo', async () => {
    await expect(readInventory('/tmp')).rejects.toThrow()
  })

  test('returns a null base when none resolves', async () => {
    repo = await createRepo({ branch: 'topic' })
    expect(await readInventory(repo.path)).toMatchObject({ baseRef: null, units: [], notes: ['Branche de base introuvable'] })
  })

  test('JS priority: package-lock > pnpm > yarn', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package.json': PKG('yarndep'), 'yarn.lock': '# yarn lockfile v1\n\n\nyarndep@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/yarndep/-/yarndep-1.0.0.tgz#x"\n' })
    let inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(names(inv.units[0])).toEqual(['yarndep'])
    await commitAll(repo, { 'package.json': PKG('pnpmdep'), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      pnpmdep:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  pnpmdep@1.0.0:\n    resolution: {integrity: sha512-x}\n" })
    inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(names(inv.units[0])).toEqual(['pnpmdep'])
    await commitAll(repo, { 'package.json': PKG('npmdep'), 'package-lock.json': npmLock('npmdep') })
    inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(names(inv.units[0])).toEqual(['npmdep'])
  })

  test('Python priority: uv > poetry > Pipfile.lock > requirements', async () => {
    repo = await createRepo()
    const only = async (name: string) => {
      const inv = await readInventory(repo!.path)
      expect(inv.units).toHaveLength(1)
      expect(JSON.stringify(inv.units[0])).toContain(name)
      expect(inv.units[0].error).toBeUndefined()
    }
    await repo.commit('requirements.txt', 'reqdep==2.0.0\n')
    await only('reqdep')
    await repo.commit('requirements-dev.txt', 'devdep==8.0.0\n')
    const both = await readInventory(repo.path)
    expect(both.units.map((u) => names(u)[0]).sort()).toEqual(['devdep', 'reqdep'])
    await repo.commit('Pipfile.lock', JSON.stringify({ default: { pipdep: { version: '==1.0.0', index: 'pypi' } }, develop: {} }))
    await only('pipdep')
    await commitAll(repo, { 'pyproject.toml': '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\npoetrydep = "^1.0"\n', 'poetry.lock': '[[package]]\nname = "poetrydep"\nversion = "1.0.0"\n\n[package.source]\ntype = "legacy"\n' })
    await only('poetrydep')
    await repo.commit('uv.lock', 'version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { virtual = "." }\ndependencies = [{ name = "uvdep" }]\n\n[[package]]\nname = "uvdep"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }\n')
    await only('uvdep')
  })

  test('an unparsable lockfile becomes an error unit and the rest is still read', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'web/package-lock.json': '{not json', 'Gemfile.lock': GEMS })
    const inv = await readInventory(repo.path)
    expect(inv.units.find((u) => u.dir === 'web')?.error).toBe('Fichier illisible : web/package-lock.json')
    expect(inv.units.find((u) => u.ecosystem === 'RubyGems')?.error).toBeUndefined()
  })

  describe('requirements includes', () => {
    const priv = (u: { deps: { private: boolean }[] }) => u.deps.map((d) => d.private)
    const dev = (inv: { units: any[] }) => inv.units.find((u) => u.deps.some((d: any) => d.manifest === 'requirements-dev.txt'))

    test('a private index in an included file makes the including file private', async () => {
      repo = await createRepo()
      await commitAll(repo, { 'requirements.txt': '--index-url https://corp/simple\nfoo==1.0\n', 'requirements-dev.txt': '-r requirements.txt\npytest==8.0\n' })
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('an include with only a private index taints the including file', async () => {
      repo = await createRepo()
      await commitAll(repo, { 'requirements.txt': '--index-url https://corp/simple\n', 'requirements-dev.txt': '-r requirements.txt\npytest==8.0\n' })
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('a missing include makes the including file private', async () => {
      repo = await createRepo()
      await repo.commit('requirements-dev.txt', '-r requirements-base.txt\npytest==8.0\n')
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('a clean include leaves the file public', async () => {
      repo = await createRepo()
      await commitAll(repo, { 'requirements.txt': 'foo==1.0\n', 'requirements-dev.txt': '-r requirements.txt\npytest==8.0\n' })
      expect(priv(dev(await readInventory(repo.path)))).toEqual([false])
    })

    test('taint is followed transitively and cycles terminate', async () => {
      repo = await createRepo()
      await commitAll(repo, { 'requirements-a.txt': '-r requirements-b.txt\nfoo==1.0\n', 'requirements-b.txt': '-r requirements-a.txt\n-r requirements-c.txt\nbar==1.0\n', 'requirements-c.txt': '--extra-index-url https://corp/simple\nbaz==1.0\n', 'requirements-dev.txt': '-r requirements-a.txt\npytest==8.0\n' })
      const inv = await readInventory(repo.path)
      expect(inv.units.every((u) => u.deps.every((d) => d.private))).toBe(true)
    })

    test('an include in a subdirectory is resolved repo-relative', async () => {
      repo = await createRepo()
      await commitAll(repo, { 'py/requirements.txt': '--index-url https://corp/simple\nfoo==1.0\n', 'py/requirements-dev.txt': '-r requirements.txt\npytest==8.0\n' })
      const inv = await readInventory(repo.path)
      expect(inv.units.find((u) => u.deps.some((d) => d.manifest === 'py/requirements-dev.txt'))!.deps.every((d) => d.private)).toBe(true)
    })
  })
})

describe('private registries', { timeout: 60_000 }, () => {
  const priv = (inv: { units: { deps: { name: string; private: boolean }[] }[] }) =>
    Object.fromEntries(inv.units.flatMap((u) => u.deps.map((d) => [d.name, d.private])))
  const PNPM = (...names: string[]) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${names.map((n) => `      '${n}':\n        specifier: ^1.0.0\n        version: 1.0.0\n`).join('')}`
  const BERRY = (...names: string[]) => `__metadata:\n  version: 8\n\n${names.map((n) => `"${n}@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "${n}@npm:1.0.0"\n`).join('\n')}`

  test('a scope with its own registry in the root .npmrc is private for a pnpm unit in a subfolder', async () => {
    repo = await createRepo()
    await commitAll(repo, { '.npmrc': '@corp:registry=https://npm.corp.example/\n', 'web/package.json': PKG('@corp/ui', 'left-pad'), 'web/pnpm-lock.yaml': PNPM('@corp/ui', 'left-pad') })
    expect(priv(await readInventory(repo.path))).toEqual({ '@corp/ui': true, 'left-pad': false })
  })

  test('a default registry overridden in the unit .npmrc makes every dep private', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'web/.npmrc': 'registry=https://npm.corp.example/\n', 'web/package.json': PKG('@corp/ui', 'left-pad'), 'web/pnpm-lock.yaml': PNPM('@corp/ui', 'left-pad') })
    expect(priv(await readInventory(repo.path))).toEqual({ '@corp/ui': true, 'left-pad': true })
  })

  test('yarn berry: npmScopes and npmRegistryServer in .yarnrc.yml', async () => {
    repo = await createRepo()
    await commitAll(repo, { '.yarnrc.yml': 'npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n', 'package.json': PKG('@corp/ui', 'left-pad'), 'yarn.lock': BERRY('@corp/ui', 'left-pad') })
    expect(priv(await readInventory(repo.path))).toEqual({ '@corp/ui': true, 'left-pad': false })
    await commitAll(repo, { '.yarnrc.yml': 'npmRegistryServer: "https://npm.corp.example"\n' })
    expect(priv(await readInventory(repo.path))).toEqual({ '@corp/ui': true, 'left-pad': true })
  })

  test('an unparsable rc file fails closed', async () => {
    repo = await createRepo()
    await commitAll(repo, { '.yarnrc.yml': 'npmScopes: [: x\n', 'package.json': PKG('left-pad'), 'yarn.lock': BERRY('left-pad') })
    expect(priv(await readInventory(repo.path))).toEqual({ 'left-pad': true })
  })

  test('npm units without any rc file stay public', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package.json': PKG('left-pad'), 'pnpm-lock.yaml': PNPM('left-pad') })
    expect(priv(await readInventory(repo.path))).toEqual({ 'left-pad': false })
  })
})

describe('parsed lockfile cache', { timeout: 60_000 }, () => {
  const reads = () => vi.mocked(gitSpy).mock.calls.filter(([, args]) => args.includes('show') || args.includes('cat-file')).length
  const priv = (inv: { units: { deps: { name: string; private: boolean }[] }[] }) =>
    Object.fromEntries(inv.units.flatMap((u) => u.deps.map((d) => [d.name, d.private])))

  test('an unchanged tree reads no file again', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': npmLock('left-pad'), 'package.json': PKG('left-pad'), 'Gemfile.lock': GEMS, 'requirements.txt': '-r requirements-base.txt\nfoo==1.0\n', 'requirements-base.txt': 'bar==1.0\n' })
    const first = await readAtRef(repo.path, 'main')
    vi.mocked(gitSpy).mockClear()
    const second = await readAtRef(repo.path, 'main')
    expect(reads()).toBe(0)
    expect(second.units).toEqual(first.units)
  })

  test('a changed sibling package.json, rc file or included requirements file is read again', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' }, b: { version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz' } } }), 'package.json': PKG('a'), 'requirements.txt': '-r requirements-base.txt\nfoo==1.0\n', 'requirements-base.txt': 'bar==1.0\n' })
    expect(priv(await readAtRef(repo.path, 'main'))).toEqual({ a: false, bar: false, foo: false })
    await commitAll(repo, { 'package.json': PKG('a', 'b') })
    expect(priv(await readAtRef(repo.path, 'main'))).toEqual({ a: false, b: false, bar: false, foo: false })
    await commitAll(repo, { '.npmrc': 'registry=https://npm.corp.example/\n' })
    expect(priv(await readAtRef(repo.path, 'main'))).toEqual({ a: true, b: true, bar: false, foo: false })
    await commitAll(repo, { 'requirements-base.txt': '--index-url https://corp/simple\nbar==1.0\n' })
    expect(priv(await readAtRef(repo.path, 'main'))).toEqual({ a: true, b: true, bar: true, foo: true })
  })
})

describe('parsed lockfile cache across repos', { timeout: 120_000 }, () => {
  const reads = () => vi.mocked(gitSpy).mock.calls.filter(([, args]) => args.includes('cat-file')).length
  let other: TestRepo | undefined
  afterEach(async () => { await other?.cleanup(); other = undefined })
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}/Gemfile.lock`, GEMS]))

  test('a pass over several big repos does not evict the first one, and forgetRepo drops a repo', async () => {
    repo = await createRepo()
    other = await createRepo()
    await commitAll(repo, many(120))
    await commitAll(other, many(120))
    await readAtRef(repo.path, 'main')
    await readAtRef(other.path, 'main')
    vi.mocked(gitSpy).mockClear()
    await readAtRef(repo.path, 'main')
    expect(reads()).toBe(0)
    forgetRepo(repo.path)
    await readAtRef(repo.path, 'main')
    expect(reads()).toBe(120)
  })
})

describe('registry config sources', { timeout: 60_000 }, () => {
  const priv = (inv: { units: { deps: { name: string; private: boolean }[] }[] }) =>
    Object.fromEntries(inv.units.flatMap((u) => u.deps.map((d) => [d.name, d.private])))
  const PNPM = (...names: string[]) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${names.map((n) => `      '${n}':\n        specifier: ^1.0.0\n        version: 1.0.0\n`).join('')}`
  let home: string
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'deps-home-')) })
  afterAll(async () => { await rm(home, { recursive: true, force: true }) })
  afterEach(async () => { await rm(join(home, '.npmrc'), { recursive: true, force: true }) })

  test('pnpm: scoped names are private unless a config maps them to the public registry', async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package.json': PKG('@pub/x', 'left-pad'), 'pnpm-lock.yaml': PNPM('@pub/x', 'left-pad') })
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@pub/x': true, 'left-pad': false })
    await commitAll(repo, { '.npmrc': '@pub:registry=https://registry.npmjs.org/\n' })
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@pub/x': false, 'left-pad': false })
  })

  test('reads the rc files of every directory between the unit and the root', async () => {
    repo = await createRepo()
    await commitAll(repo, {
      '.npmrc': 'registry=https://registry.npmjs.org/\n', 'apps/.npmrc': '@corp:registry=https://npm.corp.example/\n',
      'apps/web/package.json': PKG('@corp/ui', '@pub/x', 'left-pad'), 'apps/web/pnpm-lock.yaml': PNPM('@corp/ui', '@pub/x', 'left-pad')
    })
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@corp/ui': true, '@pub/x': false, 'left-pad': false })
  })

  test("reads the user's own ~/.npmrc, and fails closed when it is unreadable", async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': npmLock('@corp/ui', 'left-pad'), 'package.json': PKG('@corp/ui', 'left-pad') })
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@corp/ui': false, 'left-pad': false })
    await writeFile(join(home, '.npmrc'), '@corp:registry=https://npm.corp.example/\n//npm.corp.example/:_authToken=SECRET\n')
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@corp/ui': true, 'left-pad': false })
    await rm(join(home, '.npmrc'))
    await mkdir(join(home, '.npmrc'))
    expect(priv(await readInventory(repo.path, { home }))).toEqual({ '@corp/ui': true, 'left-pad': true })
  })

  test("follows a symlinked ~/.npmrc, but fails closed on a non-regular or oversized target", async () => {
    repo = await createRepo()
    await commitAll(repo, { 'package-lock.json': npmLock('@corp/ui', 'left-pad'), 'package.json': PKG('@corp/ui', 'left-pad') })
    const target = join(home, 'dotfiles-npmrc')
    await writeFile(target, '@corp:registry=https://npm.corp.example/\n')
    await symlink(target, join(home, '.npmrc'))
    expect(priv(await readInventory(repo.path, { home, env: {} }))).toEqual({ '@corp/ui': true, 'left-pad': false })
    await rm(join(home, '.npmrc'))
    await symlink('/dev/null', join(home, '.npmrc'))
    expect(priv(await readInventory(repo.path, { home, env: {} }))).toEqual({ '@corp/ui': true, 'left-pad': true })
    await rm(join(home, '.npmrc'))
    await writeFile(target, `# ${'x'.repeat(1024 * 1024)}\n`)
    await symlink(target, join(home, '.npmrc'))
    expect(priv(await readInventory(repo.path, { home, env: {} }))).toEqual({ '@corp/ui': true, 'left-pad': true })
    await rm(target)
  })

  describe('untracked and environment configs only add privacy', () => {
    const CORP = 'registry=https://npm.corp.example/\n'
    const setup = async () => {
      repo = await createRepo()
      await commitAll(repo, { 'web/package.json': PKG('@pub/x', 'left-pad'), 'web/pnpm-lock.yaml': PNPM('@pub/x', 'left-pad') })
    }
    const read = (env: NodeJS.ProcessEnv = {}) => readInventory(repo!.path, { home, env })

    test('an untracked .npmrc in the checkout overrides the default registry', async () => {
      await setup()
      await writeFile(join(repo!.path, '.npmrc'), CORP)
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': true })
    })

    test('an untracked .yarnrc.yml in the unit directory overrides the default registry', async () => {
      await setup()
      await writeFile(join(repo!.path, 'web/.yarnrc.yml'), 'npmRegistryServer: "https://npm.corp.example"\n')
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': true })
    })

    test('an untracked public mapping does not make a scope public', async () => {
      await setup()
      await writeFile(join(repo!.path, '.npmrc'), '@pub:registry=https://registry.npmjs.org/\nregistry=https://registry.npmjs.org/\n')
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': false })
    })

    test('a symlinked or oversized .npmrc fails closed', async () => {
      await setup()
      const target = join(home, 'harmless')
      await writeFile(target, '@pub:registry=https://registry.npmjs.org/\n')
      await symlink(target, join(repo!.path, 'web/.npmrc'))
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': true })
      await rm(join(repo!.path, 'web/.npmrc'))
      await writeFile(join(repo!.path, '.npmrc'), `# ${'x'.repeat(1024 * 1024)}\n`)
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': true })
    })

    test('npm_config registry variables, any case', async () => {
      await setup()
      expect(priv(await read({ NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' }))).toEqual({ '@pub/x': true, 'left-pad': true })
      expect(priv(await read({ npm_config_registry: 'https://registry.npmjs.org/' }))).toEqual({ '@pub/x': true, 'left-pad': false })
      await commitAll(repo!, { 'package-lock.json': npmLock('@corp/ui', 'other'), 'package.json': PKG('@corp/ui', 'other') })
      const all = await read({ 'NPM_CONFIG_@CORP:REGISTRY': 'https://npm.corp.example/' })
      expect(priv(all)).toMatchObject({ '@corp/ui': true, other: false })
    })

    test('reads npm_config variables from the login-shell env by default, not process.env', async () => {
      await setup()
      const shell = { ...process.env, NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' }
      vi.mocked(currentEnv).mockReturnValue(shell)
      try {
        expect(priv(await readInventory(repo!.path, { home }))).toEqual({ '@pub/x': true, 'left-pad': true })
      } finally {
        vi.mocked(currentEnv).mockReset()
      }
    })

    test("pnpm's global rc and the npm prefix's etc/npmrc", async () => {
      await setup()
      await mkdir(join(home, 'Library/Preferences/pnpm'), { recursive: true })
      await writeFile(join(home, 'Library/Preferences/pnpm/rc'), CORP)
      expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': true })
      await rm(join(home, 'Library'), { recursive: true })
      const prefix = await mkdtemp(join(tmpdir(), 'deps-prefix-'))
      await mkdir(join(prefix, 'etc'))
      await writeFile(join(prefix, 'etc/npmrc'), CORP)
      try {
        expect(priv(await read({ npm_config_prefix: prefix }))).toEqual({ '@pub/x': true, 'left-pad': true })
        expect(priv(await read({ PREFIX: prefix }))).toEqual({ '@pub/x': true, 'left-pad': true })
        expect(priv(await read())).toEqual({ '@pub/x': true, 'left-pad': false })
      } finally {
        await rm(prefix, { recursive: true, force: true })
      }
    })
  })
})

describe('groupListing', () => {
  const OID = 'a'.repeat(40)
  test('groups blobs by directory, skips excluded dirs from the groups but keeps them in the tree', () => {
    const listing = [`100644 blob ${OID}\tpackage.json`, `100644 blob ${OID}\tweb/yarn.lock`, `160000 commit ${OID}\tsub`, `100644 blob ${OID}\tnode_modules/x/package.json`].join('\0')
    const { tree, byDir } = groupListing(listing)
    expect([...byDir]).toEqual([['', ['package.json']], ['web', ['yarn.lock']]])
    expect([...tree.keys()]).toEqual(['package.json', 'web/yarn.lock', 'node_modules/x/package.json'])
  })

  test('runs in linear time on a huge directory', () => {
    const listing = Array.from({ length: 50_000 }, (_, i) => `100644 blob ${OID}\tbig/f${i}.txt`).join('\0')
    const start = performance.now()
    const { byDir } = groupListing(listing)
    expect(performance.now() - start).toBeLessThan(500)
    expect(byDir.get('big')).toHaveLength(50_000)
  })
})
