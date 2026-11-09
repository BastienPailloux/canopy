import { parse } from 'yaml'
import type { Unit } from './js'

/**
 * Where a JS unit's packages come from, as far as privacy goes: lockfiles of pnpm, yarn berry and
 * some npm entries do not record the registry, so a private package would look public.
 * `overridden`: the default registry is replaced, every package is private. `scopes`: '@scope', lowercase.
 */
export interface RegistryConfig { overridden: boolean; scopes: string[] }

const CLOSED: RegistryConfig = { overridden: true, scopes: [] }
const norm = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '')
const NPM_DEFAULT = ['https://registry.npmjs.org']
const YARN_DEFAULTS = ['https://registry.yarnpkg.com', 'https://registry.npmjs.org']

/** `.npmrc` (ini). Null (unreadable) or a line that is not `key=value` fails closed. */
export function parseNpmrc(text: string | null): RegistryConfig {
  if (text === null) return CLOSED
  const scopes = new Set<string>()
  let overridden = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const i = line.indexOf('=')
    if (i <= 0) return CLOSED
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    const custom = !NPM_DEFAULT.includes(norm(value))
    if (key === 'registry') overridden ||= custom
    const scope = /^(@[^:]+):registry$/.exec(key)
    if (scope && custom) scopes.add(scope[1].toLowerCase())
  }
  return { overridden, scopes: [...scopes] }
}

/** `.yarnrc.yml`. Null (unreadable), invalid YAML or an unexpected shape fails closed. */
export function parseYarnrc(text: string | null): RegistryConfig {
  if (text === null) return CLOSED
  let doc: unknown
  try { doc = parse(text) } catch { return CLOSED }
  if (doc === null || doc === undefined) return { overridden: false, scopes: [] }
  if (typeof doc !== 'object' || Array.isArray(doc)) return CLOSED
  const d = doc as Record<string, unknown>
  const custom = (v: unknown) => typeof v !== 'string' || !YARN_DEFAULTS.includes(norm(v))
  const overridden = 'npmRegistryServer' in d && custom(d.npmRegistryServer)
  const scopes = new Set<string>()
  if ('npmScopes' in d) {
    if (typeof d.npmScopes !== 'object' || d.npmScopes === null || Array.isArray(d.npmScopes)) return CLOSED
    for (const [name, s] of Object.entries(d.npmScopes as Record<string, unknown>)) {
      const isObj = typeof s === 'object' && s !== null && !Array.isArray(s)
      // A scope entry we cannot read may name a registry: private.
      if (!isObj || ('npmRegistryServer' in s && custom((s as Record<string, unknown>).npmRegistryServer))) scopes.add(`@${name.replace(/^@/, '').toLowerCase()}`)
    }
  }
  return { overridden, scopes: [...scopes] }
}

const scopeOf = (name: string) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')).toLowerCase() : null)

/** Marks the unit's packages that come from a private registry; their transitive deps go, like the parsers drop them. */
export function applyRegistryConfig(unit: Unit, configs: RegistryConfig[]): Unit {
  if (unit.ecosystem !== 'npm' || configs.length === 0) return unit
  const overridden = configs.some((c) => c.overridden)
  const scopes = new Set(configs.flatMap((c) => c.scopes))
  const isPrivate = (name: string) => { const s = scopeOf(name); return overridden || (s !== null && scopes.has(s)) }
  const deps = unit.deps.map((d) => (d.private || !isPrivate(d.name) ? d : { ...d, private: true }))
  const privateDirect = new Set(deps.filter((d) => d.private).map((d) => `${d.manifest}\0${d.name}`))
  const transitive = unit.transitive.filter((t) => !isPrivate(t.name) && !privateDirect.has(`${t.manifest}\0${t.via?.[0]}`))
  return { ...unit, deps, transitive }
}
