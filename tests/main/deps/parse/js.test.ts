import { describe, expect, it } from 'vitest'
import { parsePackageLock, parsePnpmLock, parseYarnLock } from '../../../../src/main/deps/parse/js'

const REG = 'https://registry.npmjs.org/'
const e = (version: string, extra: Record<string, unknown> = {}) => ({ version, resolved: `${REG}x/-/x-${version}.tgz`, ...extra })
const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages })
const names = (ds: { name: string }[]) => ds.map((d) => d.name).sort()

describe('parsePackageLock', () => {
  it('reads direct deps of the root and of workspace members', () => {
    const u = parsePackageLock('', lock({
      '': { dependencies: { a: '^1.0.0' }, devDependencies: { d: '^2.0.0' }, optionalDependencies: { o: '^3.0.0' }, workspaces: ['packages/*'] },
      'node_modules/a': e('1.2.0'), 'node_modules/d': e('2.1.0'), 'node_modules/o': e('3.0.0'), 'node_modules/w': e('9.0.0'),
      'packages/m': { dependencies: { w: '^9.0.0' } },
      'packages/m/node_modules/w': e('9.5.0')
    }))
    expect(u.error).toBeUndefined()
    expect(u.dir).toBe('')
    expect(u.ecosystem).toBe('npm')
    expect(u.deps).toContainEqual({ ecosystem: 'npm', name: 'a', version: '1.2.0', manifest: 'package.json', private: false })
    expect(names(u.deps)).toEqual(['a', 'd', 'o', 'w'])
    expect(u.deps.find((d) => d.name === 'w')).toMatchObject({ version: '9.5.0', manifest: 'packages/m/package.json' })
  })

  it('prefixes manifests with the lockfile directory', () => {
    const u = parsePackageLock('web', lock({ '': { dependencies: { a: '1' } }, 'node_modules/a': e('1.0.0') }))
    expect(u.dir).toBe('web')
    expect(u.deps[0].manifest).toBe('web/package.json')
  })

  it('links transitive deps to the direct dep that brings them', () => {
    const u = parsePackageLock('', lock({
      '': { dependencies: { a: '^1', c: '^1' } },
      'node_modules/a': e('1.0.0', { dependencies: { b: '^1' } }),
      'node_modules/b': e('1.0.0', { dependencies: { minimist: '^1' } }),
      'node_modules/c': e('1.0.0', { dependencies: { minimist: '^1' } }),
      'node_modules/minimist': e('1.2.0')
    }))
    expect(names(u.deps)).toEqual(['a', 'c'])
    const mins = u.transitive.filter((d) => d.name === 'minimist')
    expect(mins.map((d) => d.via)).toEqual([['a'], ['c']])
    expect(mins[0]).toMatchObject({ version: '1.2.0', manifest: 'package.json', private: false })
    expect(u.transitive.find((d) => d.name === 'b')?.via).toEqual(['a'])
  })

  it('resolves nested versions and survives cycles', () => {
    const u = parsePackageLock('', lock({
      '': { dependencies: { a: '^1' } },
      'node_modules/a': e('1.0.0', { dependencies: { b: '^2' } }),
      'node_modules/b': e('1.0.0', { dependencies: { a: '^1' } }),
      'node_modules/a/node_modules/b': e('2.0.0', { dependencies: { a: '^1' } })
    }))
    expect(u.transitive).toHaveLength(1)
    expect(u.transitive[0]).toMatchObject({ name: 'b', version: '2.0.0' })
  })

  it('marks non-registry, link and file/git sources as private and drops private transitive deps', () => {
    const u = parsePackageLock('', lock({
      '': { dependencies: { a: '1', l: 'file:../l', g: 'git+ssh://x', f: 'file:../f', p: '1', q: '1' } },
      'node_modules/a': { version: '1.0.0', resolved: 'https://npm.corp.example/a.tgz', dependencies: { z: '1' } },
      'node_modules/z': e('1.0.0'),
      'node_modules/l': { resolved: '../l', link: true },
      'node_modules/g': { version: 'git+ssh://x#abc' },
      'node_modules/f': { version: 'file:../f' },
      'node_modules/p': { version: '1.0.0', dependencies: { priv: '1' } },
      'node_modules/priv': { version: '1.0.0', resolved: 'https://corp.example/priv.tgz' },
      'node_modules/q': e('1.0.0')
    }))
    const priv = (n: string) => u.deps.find((d) => d.name === n)?.private
    expect(['a', 'l', 'g', 'f'].map(priv)).toEqual([true, true, true, true])
    expect(priv('p')).toBe(false)
    expect(priv('q')).toBe(false)
    expect(u.deps.find((d) => d.name === 'a')?.version).toBe('1.0.0')
    expect(u.transitive.map((d) => d.name)).toEqual([])
  })

  it('reads lockfile v1', () => {
    const u = parsePackageLock('', JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', resolved: `${REG}a/-/a-1.0.0.tgz`, dependencies: { b: { version: '2.0.0', resolved: `${REG}b/-/b-2.0.0.tgz` } } },
        l: { version: 'file:../l' }
      }
    }))
    expect(u.deps.map((d) => [d.name, d.version, d.private])).toEqual([['a', '1.0.0', false], ['l', 'file:../l', true]])
    expect(u.transitive).toEqual([{ ecosystem: 'npm', name: 'b', version: '2.0.0', manifest: 'package.json', private: false, via: ['a'] }])
  })

  it('returns an error unit for a corrupt lockfile', () => {
    expect(parsePackageLock('', '{nope')).toMatchObject({ deps: [], transitive: [], error: 'Fichier illisible : package-lock.json' })
    expect(parsePackageLock('web', '[]').error).toBe('Fichier illisible : web/package-lock.json')
  })
})

describe('parsePnpmLock', () => {
  const pkg = JSON.stringify({ dependencies: { a: '^1' } })
  it('reads importers', () => {
    const u = parsePnpmLock('', pkg, [
      'lockfileVersion: \'9.0\'',
      'importers:',
      '  .:',
      '    dependencies:',
      '      a: { specifier: ^1, version: 1.2.3(react@18.0.0) }',
      '      l: { specifier: link:../l, version: link:../l }',
      '      f: { specifier: file:../f, version: file:../f }',
      '    devDependencies:',
      '      d: { specifier: ^2, version: 2.0.0 }',
      '  packages/m:',
      '    dependencies:',
      '      w: { specifier: ^1, version: 1.0.0 }',
      'packages: {}'
    ].join('\n'))
    expect(u.error).toBeUndefined()
    expect(u.deps.map((d) => [d.name, d.version, d.private, d.manifest])).toEqual([
      ['a', '1.2.3', false, 'package.json'], ['l', 'link:../l', true, 'package.json'], ['f', 'file:../f', true, 'package.json'],
      ['d', '2.0.0', false, 'package.json'], ['w', '1.0.0', false, 'packages/m/package.json']
    ])
    expect(u.transitive).toEqual([])
  })
  it('returns an error unit for a corrupt lockfile', () => {
    expect(parsePnpmLock('web', pkg, 'a: [').error).toBe('Fichier illisible : web/pnpm-lock.yaml')
  })
})

describe('parseYarnLock', () => {
  const pkg = JSON.stringify({ dependencies: { a: '^1.0.0', '@s/b': '~2.0.0', l: 'file:../l', missing: '^1' }, devDependencies: { d: '^3' } })
  it('reads yarn v1', () => {
    const u = parseYarnLock('', pkg, [
      '# yarn lockfile v1', '',
      'a@^1.0.0, a@^1.0.1:', '  version "1.0.5"', `  resolved "https://registry.yarnpkg.com/a/-/a-1.0.5.tgz#abc"`, '  dependencies:', '    x "^1"', '',
      '"@s/b@~2.0.0":', '  version "2.0.3"', `  resolved "${REG}@s/b/-/b-2.0.3.tgz"`, '',
      'd@^3:', '  version "3.1.0"', '  resolved "https://corp.example/d.tgz"', '',
      '"l@file:../l":', '  version "0.0.1"', ''
    ].join('\n'))
    expect(u.deps.map((d) => [d.name, d.version, d.private])).toEqual([
      ['a', '1.0.5', false], ['@s/b', '2.0.3', false], ['l', '0.0.1', true], ['missing', null, false], ['d', '3.1.0', true]
    ])
    expect(u.transitive).toEqual([])
  })
  it('reads yarn berry', () => {
    const u = parseYarnLock('', JSON.stringify({ dependencies: { a: '^1.0.0', w: 'workspace:*', p: 'patch:p@npm:1.0.0#./p.patch', n: '^2' } }), [
      '__metadata:', '  version: 6', '',
      '"a@npm:^1.0.0, a@npm:^1.0.1":', '  version: 1.0.5', '  resolution: "a@npm:1.0.5"', '',
      '"w@workspace:*":', '  version: 0.0.0-use.local', '  resolution: "w@workspace:packages/w"', '',
      '"p@patch:p@npm:1.0.0#./p.patch":', '  version: 1.0.0', '  resolution: "p@patch:p@npm%3A1.0.0#./p.patch::version=1.0.0"', '',
      '"n@npm:^2":', '  version: 2.0.0', '  resolution: "n@npm:2.0.0"'
    ].join('\n'))
    expect(u.deps.map((d) => [d.name, d.version, d.private])).toEqual([
      ['a', '1.0.5', false], ['w', '0.0.0-use.local', true], ['p', '1.0.0', true], ['n', '2.0.0', false]
    ])
  })
  it('returns an error unit for corrupt input', () => {
    expect(parseYarnLock('web', '{', '').error).toBe('Fichier illisible : web/package.json')
    expect(parseYarnLock('web', pkg, '__metadata: [').error).toBe('Fichier illisible : web/yarn.lock')
  })
})
