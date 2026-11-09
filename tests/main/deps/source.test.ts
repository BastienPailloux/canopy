import { execFileSync } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { EXCLUDED_DIRS, readAtRef, readInventory } from '../../../src/main/deps/source'
import { createRepo, type TestRepo } from '../../helpers/repo'

let repo: TestRepo | undefined
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
const names = (u: { deps: { name: string }[] }) => u.deps.map((d) => d.name).sort()

describe('readInventory', () => {
  test('exports the excluded directories', () => {
    expect(EXCLUDED_DIRS).toEqual(['node_modules', 'vendor', '.venv', '.worktrees'])
  })

  test('reads lockfiles committed on the base, including in subfolders, and skips excluded dirs', async () => {
    repo = await createRepo()
    await repo.commit('package-lock.json', npmLock('left-pad'))
    await repo.commit('package.json', PKG('left-pad'))
    await repo.commit('api/Gemfile.lock', GEMS)
    await repo.commit('node_modules/x/package-lock.json', npmLock('evil'))
    await repo.commit('.worktrees/w/package-lock.json', npmLock('evil'))
    await repo.commit('vendor/Gemfile.lock', GEMS)
    const inv = await readInventory(repo.path)
    expect(inv.repo).toBe(repo.path)
    expect(inv.baseRef).toBe('main')
    expect(inv.notes).toEqual([])
    expect(inv.units.map((u) => `${u.dir}|${u.ecosystem}`).sort()).toEqual(['api|RubyGems', '|npm'])
    expect(names(inv.units.find((u) => u.ecosystem === 'npm')!)).toEqual(['left-pad'])
  })

  test('reads the base, not the checkout', async () => {
    repo = await createRepo()
    await repo.commit('package-lock.json', npmLock('committed'))
    await repo.commit('package.json', PKG('committed'))
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
    const pushOther = async () => {
      const other = join(repo!.path, '..', 'other')
      sh(repo!.path, 'clone', '-q', join(repo!.path, '..', 'remote.git'), other)
      await writeFile(join(other, 'Gemfile.lock'), GEMS)
      sh(other, 'add', '.')
      sh(other, 'commit', '-q', '-m', 'gems')
      sh(other, 'push', '-q', 'origin', 'main')
    }

    test.each([
      ['credential.helper', (m: string) => `!touch '${m}'`],
      ['remote.origin.uploadpack', (m: string) => `touch '${m}'; git-upload-pack`],
      ['core.sshCommand', (m: string) => `touch '${m}'; ssh`]
    ])('skips the fetch when local config sets %s', async (key, value) => {
      repo = await createRepo({ remote: true })
      await pushOther()
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', key, value(marker))
      const inv = await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
      expect(inv.notes).toEqual([UNSAFE])
      expect(inv.units).toEqual([])
    })

    test('never runs an ext:: remote', async () => {
      repo = await createRepo({ remote: true })
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'remote', 'set-url', 'origin', `ext::sh -c "touch '${marker}'"`)
      const inv = await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
      expect(inv.notes).toHaveLength(1)
    })

    test('protocol.ext.allow in local config does not let an ext:: remote run', async () => {
      repo = await createRepo({ remote: true })
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', 'protocol.ext.allow', 'always')
      sh(repo.path, 'remote', 'set-url', 'origin', `ext::sh -c "touch '${marker}'"`)
      await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
    })

    test('core.alternateRefsCommand never runs', async () => {
      repo = await createRepo({ remote: true })
      const marker = join(repo.path, '..', 'ran')
      sh(repo.path, 'config', 'core.alternateRefsCommand', `touch '${marker}'`)
      await writeFile(join(repo.path, '.git', 'objects', 'info', 'alternates'), join(repo.path, '..', 'remote.git', 'objects') + '\n')
      await readInventory(repo.path)
      expect(await exists(marker)).toBe(false)
    })

    test('an unknown local key skips the fetch', async () => {
      repo = await createRepo({ remote: true })
      await pushOther()
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
      repo = await createRepo({ remote: true })
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
      repo = await createRepo({ remote: true })
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

    test('a remote.origin.fetch refspec cannot move a local branch', async () => {
      repo = await createRepo({ remote: true })
      await pushOther()
      sh(repo.path, 'branch', 'keep')
      const before = sh(repo.path, 'rev-parse', 'keep')
      sh(repo.path, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/keep')
      await readInventory(repo.path)
      expect(sh(repo.path, 'rev-parse', 'keep')).toBe(before)
    })

    test('still fetches from a plain local remote', async () => {
      repo = await createRepo({ remote: true })
      await pushOther()
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
    expect(await readInventory(repo.path)).toMatchObject({ baseRef: null, units: [], notes: [] })
  })

  test('JS priority: package-lock > pnpm > yarn', async () => {
    repo = await createRepo()
    await repo.commit('package.json', PKG('yarndep'))
    await repo.commit('yarn.lock', '# yarn lockfile v1\n\n\nyarndep@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/yarndep/-/yarndep-1.0.0.tgz#x"\n')
    let inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(names(inv.units[0])).toEqual(['yarndep'])
    await repo.commit('package.json', PKG('pnpmdep'))
    await repo.commit('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      pnpmdep:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  pnpmdep@1.0.0:\n    resolution: {integrity: sha512-x}\n")
    inv = await readInventory(repo.path)
    expect(inv.units).toHaveLength(1)
    expect(names(inv.units[0])).toEqual(['pnpmdep'])
    await repo.commit('package.json', PKG('npmdep'))
    await repo.commit('package-lock.json', npmLock('npmdep'))
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
    await repo.commit('pyproject.toml', '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\npoetrydep = "^1.0"\n')
    await repo.commit('poetry.lock', '[[package]]\nname = "poetrydep"\nversion = "1.0.0"\n\n[package.source]\ntype = "legacy"\n')
    await only('poetrydep')
    await repo.commit('uv.lock', 'version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { virtual = "." }\ndependencies = [{ name = "uvdep" }]\n\n[[package]]\nname = "uvdep"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }\n')
    await only('uvdep')
  })

  test('an unparsable lockfile becomes an error unit and the rest is still read', async () => {
    repo = await createRepo()
    await repo.commit('web/package-lock.json', '{not json')
    await repo.commit('Gemfile.lock', GEMS)
    const inv = await readInventory(repo.path)
    expect(inv.units.find((u) => u.dir === 'web')?.error).toBe('Fichier illisible : web/package-lock.json')
    expect(inv.units.find((u) => u.ecosystem === 'RubyGems')?.error).toBeUndefined()
  })

  describe('requirements includes', () => {
    const priv = (u: { deps: { private: boolean }[] }) => u.deps.map((d) => d.private)
    const dev = (inv: { units: any[] }) => inv.units.find((u) => u.deps.some((d: any) => d.manifest === 'requirements-dev.txt'))

    test('a private index in an included file makes the including file private', async () => {
      repo = await createRepo()
      await repo.commit('requirements.txt', '--index-url https://corp/simple\nfoo==1.0\n')
      await repo.commit('requirements-dev.txt', '-r requirements.txt\npytest==8.0\n')
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('an include with only a private index taints the including file', async () => {
      repo = await createRepo()
      await repo.commit('requirements.txt', '--index-url https://corp/simple\n')
      await repo.commit('requirements-dev.txt', '-r requirements.txt\npytest==8.0\n')
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('a missing include makes the including file private', async () => {
      repo = await createRepo()
      await repo.commit('requirements-dev.txt', '-r requirements-base.txt\npytest==8.0\n')
      expect(priv(dev(await readInventory(repo.path)))).toEqual([true])
    })

    test('a clean include leaves the file public', async () => {
      repo = await createRepo()
      await repo.commit('requirements.txt', 'foo==1.0\n')
      await repo.commit('requirements-dev.txt', '-r requirements.txt\npytest==8.0\n')
      expect(priv(dev(await readInventory(repo.path)))).toEqual([false])
    })

    test('taint is followed transitively and cycles terminate', async () => {
      repo = await createRepo()
      await repo.commit('requirements-a.txt', '-r requirements-b.txt\nfoo==1.0\n')
      await repo.commit('requirements-b.txt', '-r requirements-a.txt\n-r requirements-c.txt\nbar==1.0\n')
      await repo.commit('requirements-c.txt', '--extra-index-url https://corp/simple\nbaz==1.0\n')
      await repo.commit('requirements-dev.txt', '-r requirements-a.txt\npytest==8.0\n')
      const inv = await readInventory(repo.path)
      expect(inv.units.every((u) => u.deps.every((d) => d.private))).toBe(true)
    })

    test('an include in a subdirectory is resolved repo-relative', async () => {
      repo = await createRepo()
      await repo.commit('py/requirements.txt', '--index-url https://corp/simple\nfoo==1.0\n')
      await repo.commit('py/requirements-dev.txt', '-r requirements.txt\npytest==8.0\n')
      const inv = await readInventory(repo.path)
      expect(inv.units.find((u) => u.deps.some((d) => d.manifest === 'py/requirements-dev.txt'))!.deps.every((d) => d.private)).toBe(true)
    })
  })
})
