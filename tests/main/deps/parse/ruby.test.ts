import { describe, expect, it } from 'vitest'
import { parseGemfileLock } from '../../../../src/main/deps/parse/ruby'

const LOCK = `GIT
  remote: https://github.com/acme/forked.git
  revision: abc123
  specs:
    forked (0.3.0)

PATH
  remote: vendor/local
  specs:
    local (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.1.0)
      rack (>= 2.2)
      thor
    nokogiri (1.16.0-arm64-darwin)
    nokogiri (1.16.0-x86_64-linux)
    rack (3.0.8)
    rails (7.1.0)
      actionpack (= 7.1.0)
      forked
      local
    thor (1.3.0)

PLATFORMS
  arm64-darwin

DEPENDENCIES
  forked!
  local!
  nokogiri
  rails (~> 7.1)
  rack (>= 3)

BUNDLED WITH
   2.5.0
`
const names = (ds: { name: string }[]) => ds.map((d) => d.name).sort()

describe('parseGemfileLock', () => {
  it('reads direct deps from DEPENDENCIES with versions from specs', () => {
    const u = parseGemfileLock('', LOCK)
    expect(u.error).toBeUndefined()
    expect(u.ecosystem).toBe('RubyGems')
    expect(u.dir).toBe('')
    expect(u.deps).toContainEqual({ ecosystem: 'RubyGems', name: 'rails', version: '7.1.0', manifest: 'Gemfile', private: false })
    expect(names(u.deps)).toEqual(['forked', 'local', 'nokogiri', 'rack', 'rails'])
  })

  it('strips the platform suffix and dedupes variants', () => {
    const u = parseGemfileLock('', LOCK)
    expect(u.deps.filter((d) => d.name === 'nokogiri')).toEqual([expect.objectContaining({ version: '1.16.0' })])
  })

  it('marks GIT and PATH gems private', () => {
    const u = parseGemfileLock('', LOCK)
    expect(u.deps.find((d) => d.name === 'forked')?.private).toBe(true)
    expect(u.deps.find((d) => d.name === 'local')?.private).toBe(true)
    expect(u.deps.find((d) => d.name === 'rack')?.private).toBe(false)
  })

  it('marks gems of a non-rubygems remote private, including mixed remotes', () => {
    const u = parseGemfileLock('', `GEM
  remote: https://gems.example.com/
  specs:
    secret (1.0.0)

GEM
  remote: https://rubygems.org/
  remote: https://gems.example.com/
  specs:
    mixed (2.0.0)

DEPENDENCIES
  secret
  mixed
`)
    expect(u.deps.map((d) => d.private)).toEqual([true, true])
  })

  it('lists public transitive deps once per bringing direct, via that direct', () => {
    const u = parseGemfileLock('', LOCK)
    expect(u.transitive).toContainEqual({ ecosystem: 'RubyGems', name: 'actionpack', version: '7.1.0', manifest: 'Gemfile', private: false, via: ['rails'] })
    expect(u.transitive).toContainEqual(expect.objectContaining({ name: 'thor', via: ['rails'] }))
    // rack is direct itself: not repeated as transitive
    expect(u.transitive.some((d) => d.name === 'rack')).toBe(false)
    // private gems are dropped
    expect(u.transitive.some((d) => d.name === 'forked' || d.name === 'local')).toBe(false)
  })

  it('does not follow dependencies of private gems', () => {
    const u = parseGemfileLock('', `GIT
  remote: https://github.com/acme/x.git
  specs:
    x (1.0.0)
      leaked

GEM
  remote: https://rubygems.org/
  specs:
    leaked (1.0.0)

DEPENDENCIES
  x!
`)
    expect(u.transitive).toEqual([])
  })

  it('prefixes the manifest with the directory', () => {
    const u = parseGemfileLock('api', LOCK)
    expect(u.dir).toBe('api')
    expect(u.deps[0].manifest).toBe('api/Gemfile')
  })

  it('keeps a direct dep without spec unpinned', () => {
    const u = parseGemfileLock('', 'DEPENDENCIES\n  ghost\n')
    expect(u.deps).toEqual([expect.objectContaining({ name: 'ghost', version: null, private: false })])
  })

  it('returns an error unit for a corrupt lockfile', () => {
    const u = parseGemfileLock('api', 'this is not a lockfile\n')
    expect(u).toEqual({ dir: 'api', ecosystem: 'RubyGems', deps: [], transitive: [], error: 'Fichier illisible : api/Gemfile.lock' })
  })
})
