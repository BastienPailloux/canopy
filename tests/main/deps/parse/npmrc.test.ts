import { describe, expect, it } from 'vitest'
import { applyRegistryConfig, parseNpmrc, parseYarnrc } from '../../../../src/main/deps/parse/npmrc'
import type { Unit } from '../../../../src/main/deps/parse/js'
import type { RegistryConfig } from '../../../../src/main/deps/parse/npmrc'
import type { Dep } from '../../../../src/shared/deps'

const dep = (name: string, o: Partial<Dep> = {}): Dep => ({ ecosystem: 'npm', name, version: '1.0.0', manifest: 'package.json', private: false, ...o })
const unit = (o: Partial<Unit> = {}): Unit => ({
  dir: '', ecosystem: 'npm',
  deps: [dep('@corp/ui'), dep('left-pad'), dep('@public/x')],
  transitive: [dep('@corp/util', { via: ['left-pad'] }), dep('ms', { via: ['@corp/ui'] }), dep('debug', { via: ['left-pad'] })],
  ...o
})
const privateNames = (u: Unit) => u.deps.filter((d) => d.private).map((d) => d.name)
const NONE: RegistryConfig = { overridden: false, scopes: [], publicScopes: [], defaultPublic: false }
const cfg = (o: Partial<RegistryConfig> = {}): RegistryConfig => ({ ...NONE, ...o })

describe('parseNpmrc', () => {
  it('reads scoped registries and the default registry', () => {
    expect(parseNpmrc('# c\n; c\n\n@Corp:registry=https://npm.corp.example/\n//npm.corp.example/:_authToken=${TOKEN}\n'))
      .toEqual(cfg({ scopes: ['@corp'] }))
    expect(parseNpmrc('registry=https://registry.npmjs.org/\n')).toEqual(cfg({ defaultPublic: true }))
    expect(parseNpmrc('registry = "https://registry.npmjs.org"\n')).toEqual(cfg({ defaultPublic: true }))
    expect(parseNpmrc('registry=https://npm.corp.example/\n').overridden).toBe(true)
    expect(parseNpmrc('registry=${NPM_REGISTRY}\n').overridden).toBe(true)
  })
  it('a scope pointing at the public registry is explicitly public', () => {
    expect(parseNpmrc('@pub:registry=https://registry.npmjs.org/\n')).toEqual(cfg({ publicScopes: ['@pub'] }))
  })
  it('keeps no token', () => {
    expect(JSON.stringify(parseNpmrc('//npm.corp.example/:_authToken=SECRET\n_auth=SECRET2\n'))).not.toContain('SECRET')
  })
  it('fails closed on an unreadable or unparsable file', () => {
    expect(parseNpmrc(null).overridden).toBe(true)
    expect(parseNpmrc('what is this\n').overridden).toBe(true)
  })
})

describe('parseYarnrc', () => {
  it('reads npmScopes and npmRegistryServer', () => {
    expect(parseYarnrc('npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n  pub:\n    npmAlwaysAuth: true\n'))
      .toEqual(cfg({ scopes: ['@corp'] }))
    expect(parseYarnrc('npmRegistryServer: "https://registry.yarnpkg.com"\n')).toEqual(cfg({ defaultPublic: true }))
    expect(parseYarnrc('npmRegistryServer: "https://registry.npmjs.org/"\n')).toEqual(cfg({ defaultPublic: true }))
    expect(parseYarnrc('npmScopes:\n  pub:\n    npmRegistryServer: "https://registry.npmjs.org"\n')).toEqual(cfg({ publicScopes: ['@pub'] }))
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
    const u = applyRegistryConfig(unit(), [cfg({ scopes: ['@corp'] })])
    expect(privateNames(u)).toEqual(['@corp/ui'])
    expect(u.transitive.map((d) => d.name)).toEqual(['debug'])
  })
  it('marks everything private when the default registry is overridden', () => {
    const u = applyRegistryConfig(unit(), [NONE, cfg({ overridden: true })])
    expect(privateNames(u)).toEqual(['@corp/ui', 'left-pad', '@public/x'])
    expect(u.transitive).toEqual([])
  })
  it('keeps a unit untouched without any config, and other ecosystems always', () => {
    expect(applyRegistryConfig(unit(), [])).toEqual(unit())
    const gems = unit({ ecosystem: 'RubyGems' })
    expect(applyRegistryConfig(gems, [cfg({ overridden: true })])).toEqual(gems)
  })
  it('strict units (pnpm, yarn berry): scoped names are private unless a config maps them to the public registry', () => {
    expect(privateNames(applyRegistryConfig(unit(), [], { strictScopes: true }))).toEqual(['@corp/ui', '@public/x'])
    expect(privateNames(applyRegistryConfig(unit(), [cfg({ publicScopes: ['@public'] })], { strictScopes: true }))).toEqual(['@corp/ui'])
    expect(privateNames(applyRegistryConfig(unit(), [cfg({ defaultPublic: true })], { strictScopes: true }))).toEqual([])
    // A private mapping anywhere wins over a public one.
    expect(privateNames(applyRegistryConfig(unit(), [cfg({ defaultPublic: true }), cfg({ scopes: ['@public'] })], { strictScopes: true }))).toEqual(['@public/x'])
    expect(applyRegistryConfig(unit(), [], { strictScopes: true }).transitive.map((d) => d.name)).toEqual(['debug'])
  })
  it('strict rule alone sets unmappedScope; other private causes do not', () => {
    const u = applyRegistryConfig(unit(), [cfg({ scopes: ['@public'] })], { strictScopes: true })
    const by = (n: string) => u.deps.find((d) => d.name === n)!
    expect(by('@corp/ui').unmappedScope).toBe('@corp')
    // custom registry mapping: private for another reason
    expect(by('@public/x').private).toBe(true)
    expect(by('@public/x').unmappedScope).toBeUndefined()
    expect(by('left-pad').unmappedScope).toBeUndefined()
    // default registry overridden: not the strict rule
    const o = applyRegistryConfig(unit(), [cfg({ overridden: true })], { strictScopes: true })
    expect(o.deps.every((d) => d.unmappedScope === undefined)).toBe(true)
    // already private (alias, private URL): untouched
    const a = applyRegistryConfig(unit({ deps: [dep('@corp/ui', { private: true })] }), [], { strictScopes: true })
    expect(a.deps[0].unmappedScope).toBeUndefined()
    // non-strict never sets it
    expect(applyRegistryConfig(unit(), [cfg({ scopes: ['@corp'] })]).deps.every((d) => d.unmappedScope === undefined)).toBe(true)
  })
})
