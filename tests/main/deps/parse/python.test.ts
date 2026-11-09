import { describe, expect, it } from 'vitest'
import { parsePipfileLock, parsePoetryLock, parseRequirements, parseUvLock } from '../../../../src/main/deps/parse/python'

const names = (ds: { name: string }[]) => ds.map((d) => d.name).sort()
const pypi = (name: string, version: string | null, manifest: string, priv = false) => ({ ecosystem: 'PyPI', name, version, manifest, private: priv })

describe('parseUvLock', () => {
  const LOCK = `version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [
  { name = "Requests" },
  { name = "internal-lib" },
  { name = "forked" },
]

[package.dev-dependencies]
dev = [{ name = "pytest" }]

[[package]]
name = "requests"
version = "2.31.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "8.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "internal-lib"
version = "1.0.0"
source = { registry = "https://pkgs.example.com/simple" }

[[package]]
name = "forked"
version = "0.2.0"
source = { git = "https://github.com/acme/forked" }

[[package]]
name = "unrelated"
version = "9.9.9"
source = { registry = "https://pypi.org/simple" }
`
  it('reads the root package dependencies, including dev groups', () => {
    const u = parseUvLock('', LOCK)
    expect(u.error).toBeUndefined()
    expect(u.ecosystem).toBe('PyPI')
    expect(u.transitive).toEqual([])
    expect(u.deps).toContainEqual(pypi('requests', '2.31.0', 'pyproject.toml'))
    expect(names(u.deps)).toEqual(['forked', 'internal-lib', 'pytest', 'requests'])
  })

  it('marks non-PyPI registries and non-registry sources private', () => {
    const u = parseUvLock('svc', LOCK)
    expect(u.deps.find((d) => d.name === 'internal-lib')).toMatchObject({ private: true, manifest: 'svc/pyproject.toml' })
    expect(u.deps.find((d) => d.name === 'forked')?.private).toBe(true)
  })

  it('marks a root dependency without lock entry private (fail closed)', () => {
    const u = parseUvLock('', `[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "ghost" }]
`)
    expect(u.deps).toEqual([expect.objectContaining({ name: 'ghost', version: null, private: true })])
  })

  it('ORs the private flag when a name is declared twice', () => {
    const u = parseUvLock('', `[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "x" }]

[package.dev-dependencies]
dev = [{ name = "X" }]

[[package]]
name = "x"
version = "1.0.0"
source = { git = "https://example.com/x" }
`)
    expect(u.deps).toHaveLength(1)
    expect(u.deps[0].private).toBe(true)
  })

  it('accepts a virtual root', () => {
    const u = parseUvLock('', `[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "a" }]

[[package]]
name = "a"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
`)
    expect(names(u.deps)).toEqual(['a'])
  })

  it('returns an error unit for a corrupt lockfile', () => {
    expect(parseUvLock('x', '[[package\nname = ')).toEqual({ dir: 'x', ecosystem: 'PyPI', deps: [], transitive: [], error: 'Fichier illisible : x/uv.lock' })
  })
})

describe('parsePoetryLock', () => {
  const PYPROJECT = `[tool.poetry.dependencies]
python = "^3.11"
Django = "^4.2"
my_private = { version = "^1", source = "corp" }

[tool.poetry.group.dev.dependencies]
pytest = "^8"
`
  const LOCK = `[[package]]
name = "django"
version = "4.2.7"

[[package]]
name = "pytest"
version = "8.0.0"

[[package]]
name = "my-private"
version = "1.0.0"

[package.source]
type = "legacy"
url = "https://pkgs.example.com/simple"
reference = "corp"

[[package]]
name = "gitdep"
version = "0.1.0"

[package.source]
type = "git"
url = "https://github.com/acme/gitdep"
reference = "main"
`
  it('reads direct deps from pyproject.toml without python', () => {
    const u = parsePoetryLock('', PYPROJECT, LOCK)
    expect(u.error).toBeUndefined()
    expect(u.transitive).toEqual([])
    expect(u.deps).toContainEqual(pypi('django', '4.2.7', 'pyproject.toml'))
    expect(names(u.deps)).toEqual(['django', 'my-private', 'pytest'])
  })

  it('marks packages with a non-PyPI source private', () => {
    const u = parsePoetryLock('', PYPROJECT, LOCK)
    expect(u.deps.find((d) => d.name === 'my-private')?.private).toBe(true)
    expect(u.deps.find((d) => d.name === 'django')?.private).toBe(false)
  })

  it('keeps a legacy source pointing at PyPI public and a git source private', () => {
    const lock = `[[package]]
name = "a"
version = "1.0.0"

[package.source]
type = "legacy"
url = "https://pypi.org/simple"
reference = "pypi"

[[package]]
name = "gitdep"
version = "0.1.0"

[package.source]
type = "git"
url = "https://github.com/acme/gitdep"
`
    const u = parsePoetryLock('', '[tool.poetry.dependencies]\na = "1"\ngitdep = { git = "https://github.com/acme/gitdep" }\n', lock)
    expect(u.deps.map((d) => [d.name, d.private])).toEqual([['a', false], ['gitdep', true]])
  })

  it('marks a declared dep missing from the lock private (fail closed)', () => {
    const u = parsePoetryLock('', '[tool.poetry.dependencies]\nghost = "1"\n', '')
    expect(u.deps).toEqual([expect.objectContaining({ name: 'ghost', version: null, private: true })])
  })

  it('marks a dep with a source key private unless the source resolves to public PyPI', () => {
    const pyproject = `[tool.poetry.dependencies]
a = { version = "1", source = "corp" }
b = { version = "1", source = "mirror" }
c = { version = "1", source = "unknown" }
d = { version = "1", source = "pypi" }

[[tool.poetry.source]]
name = "corp"
url = "https://corp.example/simple"

[[tool.poetry.source]]
name = "mirror"
url = "https://pypi.org/simple/"
`
    const lock = ['a', 'b', 'c', 'd'].map((n) => `[[package]]\nname = "${n}"\nversion = "1.0.0"\n`).join('\n')
    const u = parsePoetryLock('', pyproject, lock)
    expect(u.deps.map((d) => [d.name, d.private])).toEqual([['a', true], ['b', false], ['c', true], ['d', false]])
  })

  it('ORs the private flag when a name is declared twice', () => {
    const u = parsePoetryLock('', '[tool.poetry.dependencies]\nx = "1"\n[tool.poetry.group.dev.dependencies]\nX = { git = "https://example.com/x" }\n', '[[package]]\nname = "x"\nversion = "1.0.0"\n')
    expect(u.deps).toEqual([expect.objectContaining({ name: 'x', private: true })])
  })

  it('reads PEP 621 project.dependencies', () => {
    const u = parsePoetryLock('', '[project]\ndependencies = ["Flask>=2.0", "requests[socks]==2.31.0 ; python_version > \'3.8\'"]\n', `[[package]]
name = "flask"
version = "3.0.0"

[[package]]
name = "requests"
version = "2.31.0"
`)
    expect(u.deps.map((d) => [d.name, d.version])).toEqual([['flask', '3.0.0'], ['requests', '2.31.0']])
  })

  it('returns an error unit for a corrupt lockfile or a missing pyproject', () => {
    const err = { dir: 'p', ecosystem: 'PyPI', deps: [], transitive: [] }
    expect(parsePoetryLock('p', PYPROJECT, '[[package\n')).toEqual({ ...err, error: 'Fichier illisible : p/poetry.lock' })
    expect(parsePoetryLock('p', null, LOCK)).toEqual({ ...err, error: 'Fichier illisible : p/pyproject.toml' })
    expect(parsePoetryLock('p', '[tool\n', LOCK)).toEqual({ ...err, error: 'Fichier illisible : p/pyproject.toml' })
  })
})

describe('parsePipfileLock', () => {
  const LOCK = JSON.stringify({
    _meta: { sources: [{ name: 'pypi', url: 'https://pypi.org/simple', verify_ssl: true }, { name: 'corp', url: 'https://pkgs.example.com/simple' }] },
    default: {
      Requests: { version: '==2.31.0', index: 'pypi' },
      internal: { version: '==1.0.0', index: 'corp' },
      forked: { git: 'https://github.com/acme/forked', ref: 'abc' },
      loose: { version: '>=1.0' }
    },
    develop: { pytest: { version: '==8.0.0' }, local: { path: '.', editable: true } }
  })
  it('reads default and develop with == stripped', () => {
    const u = parsePipfileLock('', LOCK)
    expect(u.error).toBeUndefined()
    expect(u.transitive).toEqual([])
    expect(u.deps).toContainEqual(pypi('requests', '2.31.0', 'Pipfile'))
    expect(u.deps).toContainEqual(pypi('pytest', '8.0.0', 'Pipfile'))
    expect(u.deps.find((d) => d.name === 'loose')?.version).toBeNull()
  })
  it('marks non-PyPI indexes, git and path entries private', () => {
    const u = parsePipfileLock('app', LOCK)
    expect(u.deps.filter((d) => d.private).map((d) => d.name).sort()).toEqual(['forked', 'internal', 'local'])
    expect(u.deps[0].manifest).toBe('app/Pipfile')
  })
  it('decides by URL when a source is named pypi, implicit pypi is public otherwise', () => {
    const lock = (sources: unknown[]) => JSON.stringify({ _meta: { sources }, default: { a: { version: '==1.0', index: 'pypi' } } })
    expect(parsePipfileLock('', lock([{ name: 'pypi', url: 'https://corp.example/simple' }])).deps[0].private).toBe(true)
    expect(parsePipfileLock('', lock([{ name: 'pypi', url: 'https://pypi.org/simple' }])).deps[0].private).toBe(false)
    expect(parsePipfileLock('', lock([{ name: 'corp', url: 'https://corp.example/simple' }])).deps[0].private).toBe(false)
  })
  it('marks entries without index private when no source is public', () => {
    const u = parsePipfileLock('', JSON.stringify({ _meta: { sources: [{ name: 'corp', url: 'https://corp.example/simple' }] }, default: { a: { version: '==1.0' } } }))
    expect(u.deps[0].private).toBe(true)
  })
  it('ORs the private flag across default and develop', () => {
    const u = parsePipfileLock('', JSON.stringify({ default: { a: { version: '==1.0' } }, develop: { A: { path: '.' } } }))
    expect(u.deps).toHaveLength(1)
    expect(u.deps[0].private).toBe(true)
  })
  it('returns an error unit for a corrupt lockfile', () => {
    expect(parsePipfileLock('', '{nope')).toEqual({ dir: '', ecosystem: 'PyPI', deps: [], transitive: [], error: 'Fichier illisible : Pipfile.lock' })
  })
})

describe('parseRequirements', () => {
  const TEXT = `# comment
Foo_Bar==1.2   # inline comment
requests[socks]==2.31.0 ; python_version < "3.9"
numpy>=1.0
django>=3,<5
pinned===2.0
wild==1.*
-r requirements-other.txt
-c requirements-c.txt
./local/path
git+https://github.com/acme/x.git
https://example.com/pkg.whl
-e git+https://github.com/acme/editable.git#egg=Editable_Pkg
corp @ https://example.com/corp-1.0.tar.gz
long==3.0 \\
    --hash=sha256:abc
`
  it('reads pinned, unpinned and normalized entries', () => {
    const u = parseRequirements('', 'requirements.txt', TEXT)
    expect(u.error).toBeUndefined()
    expect(u.ecosystem).toBe('PyPI')
    expect(u.transitive).toEqual([])
    expect(u.deps).toContainEqual(pypi('foo-bar', '1.2', 'requirements.txt'))
    expect(u.deps).toContainEqual(pypi('requests', '2.31.0', 'requirements.txt'))
    expect(u.deps).toContainEqual(pypi('numpy', null, 'requirements.txt'))
    expect(u.deps.find((d) => d.name === 'django')?.version).toBeNull()
    expect(u.deps.find((d) => d.name === 'pinned')?.version).toBe('2.0')
    expect(u.deps.find((d) => d.name === 'wild')?.version).toBeNull()
    expect(u.deps.find((d) => d.name === 'long')?.version).toBe('3.0')
  })
  it('ignores -r, -c, paths and unnamed URLs but lists named -e and URL requirements as private', () => {
    const u = parseRequirements('', 'requirements.txt', TEXT)
    expect(names(u.deps)).toEqual(['corp', 'django', 'editable-pkg', 'foo-bar', 'long', 'numpy', 'pinned', 'requests', 'wild'])
    expect(u.deps.filter((d) => d.private).map((d) => d.name).sort()).toEqual(['corp', 'editable-pkg'])
  })
  it('uses the file itself as manifest', () => {
    const u = parseRequirements('api', 'requirements-dev.txt', 'a==1\n')
    expect(u.dir).toBe('api')
    expect(u.deps[0].manifest).toBe('api/requirements-dev.txt')
  })
  it('makes the whole file private for a non-PyPI index', () => {
    for (const line of ['--index-url https://pkgs.example.com/simple', '--index-url=https://pkgs.example.com/simple', '-i https://pkgs.example.com/simple', '--extra-index-url https://pkgs.example.com/simple']) {
      const u = parseRequirements('', 'requirements.txt', `${line}\na==1\nb>=2\n`)
      expect(u.deps.map((d) => d.private)).toEqual([true, true])
    }
  })
  it('keeps the file public for PyPI index URLs', () => {
    for (const url of ['https://pypi.org/simple', 'https://pypi.org/simple/', 'https://pypi.python.org/simple']) {
      const u = parseRequirements('', 'requirements.txt', `--index-url ${url}\na==1\n`)
      expect(u.deps.map((d) => d.private)).toEqual([false])
    }
  })
  it('strips markers without surrounding spaces', () => {
    const u = parseRequirements('', 'requirements.txt', 'a==1.0;python_version<"3.9"\n')
    expect(u.deps).toEqual([pypi('a', '1.0', 'requirements.txt')])
  })
  it('taints the whole file for non-allowlisted or unknown options', () => {
    for (const line of ['-ihttps://corp/simple', '--find-links ./wheels', '-f ./wheels', '--no-index', '--trusted-host corp', '--unknown-flag', '--index-url', '--extra-index-url=https://corp/simple']) {
      const u = parseRequirements('', 'requirements.txt', `${line}\na==1\n`)
      expect(u.deps.map((d) => d.private), line).toEqual([true])
    }
  })
  it('keeps allowlisted options and public indexes public', () => {
    for (const line of ['-i https://pypi.org/simple', '-ihttps://pypi.org/simple', '--extra-index-url https://pypi.org/simple', '-r requirements-other.txt', '--requirement requirements-other.txt', '-c requirements-c.txt', '--constraint=requirements-c.txt', '--require-hashes', '--pre', '--prefer-binary', '--only-binary :all:', '--no-binary :none:', '--hash=sha256:abc']) {
      const u = parseRequirements('', 'requirements.txt', `${line}\na==1 --hash=sha256:abc\n`)
      expect(u.deps.map((d) => d.private), line).toEqual([false])
    }
  })
  it('taints for options that merely start like an allowlisted one', () => {
    for (const line of ['--pre-foo', '--hash-foo', '--requirement-x']) {
      expect(parseRequirements('', 'requirements.txt', `${line}\na==1\n`).deps.map((d) => d.private), line).toEqual([true])
    }
  })
  it('taints for -r/-c targets that are not requirements files below the directory', () => {
    for (const t of ['../requirements.txt', 'a/../../requirements.txt', '/etc/requirements.txt', 'https://x/requirements.txt', 'deps.txt', 'req.in']) {
      expect(parseRequirements('', 'requirements.txt', `-r ${t}\na==1\n`).deps.map((d) => d.private), t).toEqual([true])
    }
  })
  it('reports -r/-c targets as repo-relative includes', () => {
    const u = parseRequirements('api', 'requirements-dev.txt', '-r requirements.txt\n-crequirements/requirements-base.txt\n--requirement=sub/requirements-x.txt\na==1\n')
    expect(u.includes).toEqual(['api/requirements.txt', 'api/requirements/requirements-base.txt', 'api/sub/requirements-x.txt'])
    expect(u.deps.map((d) => d.private)).toEqual([false])
  })
  it('ORs the private flag for a repeated name', () => {
    const u = parseRequirements('', 'requirements.txt', 'a==1\n-e git+https://x/a.git#egg=A\n')
    expect(u.deps).toEqual([expect.objectContaining({ name: 'a', private: true })])
  })
  it('checks every option on a line and trailing options', () => {
    for (const text of ['--pre --index-url https://corp/simple\na==1', '-r requirements.txt -i https://corp/simple\na==1', 'a==1 --index-url=https://corp/simple', 'a==1 ; python_version<"3" -ihttps://corp/simple', 'a==1 --find-links ./w']) {
      expect(parseRequirements('', 'requirements.txt', text).deps.map((d) => d.private), text).toEqual([true])
    }
    const ok = parseRequirements('', 'requirements.txt', '--pre -i https://pypi.org/simple -r requirements-b.txt\na==1 --hash=sha256:abc --hash sha256:def\n')
    expect(ok.deps.map((d) => d.private)).toEqual([false])
    expect(ok.includes).toEqual(['requirements-b.txt'])
  })
  it('dedupes by name', () => {
    expect(parseRequirements('', 'requirements.txt', 'A==1\na==1\n').deps).toHaveLength(1)
  })
})
