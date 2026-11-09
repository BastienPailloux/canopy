import { parse } from 'yaml'
import type { Unit } from './js'

/**
 * Where a JS unit's packages come from, as far as privacy goes: lockfiles of pnpm, yarn berry and
 * some npm entries do not record the registry, so a private package would look public.
 * `overridden`: the default registry is replaced, every package is private. `scopes`: '@scope' (lowercase) with
 * another registry. `publicScopes` / `defaultPublic`: explicitly mapped to the public registry.
 * Only registry keys are read: tokens and auth lines are never kept.
 */
export interface RegistryConfig { overridden: boolean; scopes: string[]; publicScopes: string[]; defaultPublic: boolean }

const CLOSED: RegistryConfig = { overridden: true, scopes: [], publicScopes: [], defaultPublic: false }
const norm = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '')
const NPM_DEFAULT = ['https://registry.npmjs.org']
const YARN_DEFAULTS = ['https://registry.yarnpkg.com', 'https://registry.npmjs.org']

/** `.npmrc` (ini). Null (unreadable) or a line that is not `key=value` fails closed. */
export function parseNpmrc(text: string | null): RegistryConfig {
  if (text === null) return CLOSED
  const scopes = new Set<string>(), publicScopes = new Set<string>()
  let overridden = false, defaultPublic = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const i = line.indexOf('=')
    if (i <= 0) return CLOSED
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    const custom = !NPM_DEFAULT.includes(norm(value))
    if (key === 'registry') { overridden ||= custom; defaultPublic ||= !custom }
    const scope = /^(@[^:]+):registry$/.exec(key)
    if (scope) (custom ? scopes : publicScopes).add(scope[1].toLowerCase())
  }
  return { overridden, scopes: [...scopes], publicScopes: [...publicScopes], defaultPublic }
}

/** `.yarnrc.yml`. Null (unreadable), invalid YAML or an unexpected shape fails closed. */
export function parseYarnrc(text: string | null): RegistryConfig {
  if (text === null) return CLOSED
  let doc: unknown
  try { doc = parse(text) } catch { return CLOSED }
  if (doc === null || doc === undefined) return { overridden: false, scopes: [], publicScopes: [], defaultPublic: false }
  if (typeof doc !== 'object' || Array.isArray(doc)) return CLOSED
  const d = doc as Record<string, unknown>
  const custom = (v: unknown) => typeof v !== 'string' || !YARN_DEFAULTS.includes(norm(v))
  const overridden = 'npmRegistryServer' in d && custom(d.npmRegistryServer)
  const defaultPublic = 'npmRegistryServer' in d && !custom(d.npmRegistryServer)
  const scopes = new Set<string>(), publicScopes = new Set<string>()
  if ('npmScopes' in d) {
    if (typeof d.npmScopes !== 'object' || d.npmScopes === null || Array.isArray(d.npmScopes)) return CLOSED
    for (const [name, s] of Object.entries(d.npmScopes as Record<string, unknown>)) {
      const isObj = typeof s === 'object' && s !== null && !Array.isArray(s)
      // A scope entry we cannot read may name a registry: private.
      const scope = `@${name.replace(/^@/, '').toLowerCase()}`
      if (!isObj) scopes.add(scope)
      else if ('npmRegistryServer' in s) (custom((s as Record<string, unknown>).npmRegistryServer) ? scopes : publicScopes).add(scope)
    }
  }
  return { overridden, scopes: [...scopes], publicScopes: [...publicScopes], defaultPublic }
}

const scopeOf = (name: string) => (name.startsWith('@') ? name.slice(0, name.indexOf('/')).toLowerCase() : null)

/**
 * Marks the unit's packages that come from a private registry; their transitive deps go, like the parsers drop them.
 * `strictScopes` (pnpm, yarn berry: the lockfile does not say where a package came from): a scoped name is private
 * unless a config maps its scope, or the default registry, to the public registry.
 */
export function applyRegistryConfig(unit: Unit, configs: RegistryConfig[], o: { strictScopes?: boolean } = {}): Unit {
  if (unit.ecosystem !== 'npm' || (configs.length === 0 && !o.strictScopes)) return unit
  const overridden = configs.some((c) => c.overridden)
  const scopes = new Set(configs.flatMap((c) => c.scopes))
  const publicScopes = new Set(configs.flatMap((c) => c.publicScopes))
  const defaultPublic = configs.some((c) => c.defaultPublic)
  const explicitlyPrivate = (name: string) => {
    const s = scopeOf(name)
    return overridden || (s !== null && scopes.has(s))
  }
  const unmapped = (name: string) => {
    const s = scopeOf(name)
    return !!o.strictScopes && s !== null && !publicScopes.has(s) && !defaultPublic ? s : null
  }
  const isPrivate = (name: string) => explicitlyPrivate(name) || unmapped(name) !== null
  const deps = unit.deps.map((d) => {
    if (d.private || !isPrivate(d.name)) return d
    // Only the strict rule explains itself: a configured private registry is a deliberate choice.
    const scope = explicitlyPrivate(d.name) ? null : unmapped(d.name)
    return scope ? { ...d, private: true, unmappedScope: scope } : { ...d, private: true }
  })
  const privateDirect = new Set(deps.filter((d) => d.private).map((d) => `${d.manifest}\0${d.name}`))
  const transitive = unit.transitive.filter((t) => !isPrivate(t.name) && !privateDirect.has(`${t.manifest}\0${t.via?.[0]}`))
  return { ...unit, deps, transitive }
}
