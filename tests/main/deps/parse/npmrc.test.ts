import { describe, expect, it } from 'vitest'
import { applyRegistryConfig, parseNpmrc, parseYarnrc } from '../../../../src/main/deps/parse/npmrc'
import type { Unit } from '../../../../src/main/deps/parse/js'
import type { Dep } from '../../../../src/shared/deps'

const dep = (name: string, o: Partial<Dep> = {}): Dep => ({ ecosystem: 'npm', name, version: '1.0.0', manifest: 'package.json', private: false, ...o })
const unit = (o: Partial<Unit> = {}): Unit => ({
  dir: '', ecosystem: 'npm',
  deps: [dep('@corp/ui'), dep('left-pad'), dep('@public/x')],
  transitive: [dep('@corp/util', { via: ['left-pad'] }), dep('ms', { via: ['@corp/ui'] }), dep('debug', { via: ['left-pad'] })],
  ...o
})
const privateNames = (u: Unit) => u.deps.filter((d) => d.private).map((d) => d.name)
const NONE = { overridden: false, scopes: [] }

describe('parseNpmrc', () => {
  it('reads scoped registries and the default registry', () => {
    expect(parseNpmrc('# c\n; c\n\n@Corp:registry=https://npm.corp.example/\n//npm.corp.example/:_authToken=${TOKEN}\n'))
      .toEqual({ overridden: false, scopes: ['@corp'] })
    expect(parseNpmrc('registry=https://registry.npmjs.org/\n')).toEqual(NONE)
    expect(parseNpmrc('registry = "https://registry.npmjs.org"\n')).toEqual(NONE)
    expect(parseNpmrc('registry=https://npm.corp.example/\n').overridden).toBe(true)
    expect(parseNpmrc('registry=${NPM_REGISTRY}\n').overridden).toBe(true)
  })
  it('a scope pointing at the public registry stays public', () => {
    expect(parseNpmrc('@pub:registry=https://registry.npmjs.org/\n')).toEqual(NONE)
  })
  it('fails closed on an unreadable or unparsable file', () => {
    expect(parseNpmrc(null).overridden).toBe(true)
    expect(parseNpmrc('what is this\n').overridden).toBe(true)
  })
})

describe('parseYarnrc', () => {
  it('reads npmScopes and npmRegistryServer', () => {
    expect(parseYarnrc('npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n  pub:\n    npmAlwaysAuth: true\n'))
      .toEqual({ overridden: false, scopes: ['@corp'] })
    expect(parseYarnrc('npmRegistryServer: "https://registry.yarnpkg.com"\n')).toEqual(NONE)
    expect(parseYarnrc('npmRegistryServer: "https://registry.npmjs.org/"\n')).toEqual(NONE)
    expect(parseYarnrc('npmRegistryServer: "https://npm.corp.example"\n').overridden).toBe(true)
    expect(parseYarnrc('')).toEqual(NONE)
  })
  it('fails closed on an unreadable or unparsable file', () => {
    expect(parseYarnrc(null).overridden).toBe(true)
    expect(parseYarnrc('npmScopes: [: x').overridden).toBe(true)
    expect(parseYarnrc('- a\n- b\n').overridden).toBe(true)
    expect(parseYarnrc('npmRegistryServer: 3\n').overridden).toBe(true)
    expect(parseYarnrc('npmScopes:\n  corp: 1\n').scopes).toEqual(['@corp'])
  })
})

describe('applyRegistryConfig', () => {
  it('marks the scopes with a custom registry private and drops their transitive deps', () => {
    const u = applyRegistryConfig(unit(), [{ overridden: false, scopes: ['@corp'] }])
    expect(privateNames(u)).toEqual(['@corp/ui'])
    expect(u.transitive.map((d) => d.name)).toEqual(['debug'])
  })
  it('marks everything private when the default registry is overridden', () => {
    const u = applyRegistryConfig(unit(), [NONE, { overridden: true, scopes: [] }])
    expect(privateNames(u)).toEqual(['@corp/ui', 'left-pad', '@public/x'])
    expect(u.transitive).toEqual([])
  })
  it('keeps a unit untouched without any config, and other ecosystems always', () => {
    expect(applyRegistryConfig(unit(), [])).toEqual(unit())
    const gems = unit({ ecosystem: 'RubyGems' })
    expect(applyRegistryConfig(gems, [{ overridden: true, scopes: [] }])).toEqual(gems)
  })
})
