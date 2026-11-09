import { posix } from 'node:path'
import { parse } from 'yaml'
import type { Dep, Ecosystem } from '../../../shared/deps'

/**
 * Dependencies read from one directory's lockfile. `dir` is repo-relative ('' for the root).
 * `deps` are the direct dependencies, `transitive` the public packages they bring (one per direct,
 * `via` = names of the direct deps); `error` is set when the lockfile could not be read.
 */
export interface Unit { dir: string; ecosystem: Ecosystem; deps: Dep[]; transitive: Dep[]; error?: string
  /** Requirements units only: repo-relative `-r`/`-c` targets, whose privacy taints this file. */
  includes?: string[]
  /** Requirements units only: a file-level option (private index, unknown option) makes the whole file private, with or without deps. */
  tainted?: boolean }

const REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.yarnpkg.com/']
const PRIVATE_PREFIXES = ['file:', 'git+', 'git:', 'github:', 'http:', 'https:', 'link:', 'workspace:', 'portal:', 'patch:']
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const join = (...parts: string[]) => posix.join(...parts.filter(Boolean))
const hasPrivatePrefix = (v: string) => PRIVATE_PREFIXES.some((p) => v.startsWith(p))
/** `npm:<name>@<range>` installs another package under this name: that name may be private. `npm:^1` is not an alias. */
const isAlias = (spec: unknown) => typeof spec === 'string' && /^npm:[^\d^~<>=*xX\s]/.test(spec)
/** The package name a node_modules key installs: 'a/node_modules/@s/b' -> '@s/b'. */
const keyName = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
const fail = (dir: string, file: string): Unit => ({ dir, ecosystem: 'npm', deps: [], transitive: [], error: `Fichier illisible : ${join(dir, file)}` })
const dep = (name: string, version: string | null, manifest: string, priv: boolean, via?: string[]): Dep =>
  ({ ecosystem: 'npm', name, version, manifest, private: priv, ...(via ? { via } : {}) })

/** Without `resolved`, a scoped name may come from a private registry: fail closed. Unscoped names stay public. */
function npmEntryPrivate(e: Obj, name: string): boolean {
  if (e.link === true) return true
  // An alias records the real package in `name` (v2/v3) or `npm:<name>@<version>` (v1).
  if ((typeof e.name === 'string' && e.name !== name) || isAlias(e.version)) return true
  if (typeof e.resolved === 'string' ? !e.resolved.startsWith(REGISTRIES[0]) : name.startsWith('@')) return true
  return typeof e.version === 'string' && hasPrivatePrefix(e.version)
}

/** Parent location in node's resolution walk: 'node_modules/a/node_modules/b' -> 'node_modules/a' -> ''. */
function parentOf(loc: string): string {
  const i = loc.lastIndexOf('node_modules/')
  return i > 0 ? loc.slice(0, i - 1) : ''
}

/** The lockfile entry a package at `from` resolves `name` to, like node does. */
function resolveNpm(packages: Obj, from: string, name: string): string | null {
  for (let loc = from; ; loc = parentOf(loc)) {
    const key = `${loc ? `${loc}/` : ''}node_modules/${name}`
    if (isObj(packages[key])) return key
    if (!loc) return null
  }
}

/** `pkgJson` is only needed for lockfile v1, which does not record the direct deps. */
export function parsePackageLock(dir: string, lockText: string, pkgJson?: string): Unit {
  try {
    const lock = JSON.parse(lockText)
    if (!isObj(lock)) return fail(dir, 'package-lock.json')
    if (isObj(lock.packages)) return npmFromPackages(dir, lock.packages)
    if (pkgJson === undefined) return { ...fail(dir, 'package-lock.json'), error: `Format de fichier inattendu : ${join(dir, 'package-lock.json')}` }
    const pkg = JSON.parse(pkgJson)
    if (!isObj(pkg)) return fail(dir, 'package.json')
    return npmFromV1(dir, lock, pkg)
  } catch {
    return fail(dir, 'package-lock.json')
  }
}

function npmFromPackages(dir: string, packages: Obj): Unit {
  const deps: Dep[] = []
  const transitive = new Map<string, Dep>()
  // The root and the workspace members (in-tree targets of links) declare direct deps.
  const owners = [''].concat(Object.entries<Obj>(packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && v.link === true && typeof v.resolved === 'string')
    .map(([, v]) => posix.normalize(v.resolved as string))
    .filter((r) => r !== '' && r !== '.' && !r.startsWith('..') && !r.startsWith('/') && isObj(packages[r])))
  for (const owner of owners) {
    const manifest = join(dir, owner, 'package.json')
    const declared = new Set<string>()
    for (const field of DEP_FIELDS) for (const n of Object.keys(packages[owner]?.[field] ?? {})) declared.add(n)
    // Only the direct dep's own entry is reported as direct: another (nested) version of it is a transitive.
    const directKeys = new Set([...declared].map((n) => resolveNpm(packages, owner, n)).filter((k) => k !== null))
    for (const name of declared) {
      const key = resolveNpm(packages, owner, name)
      const entry = key ? packages[key] : null
      const spec = DEP_FIELDS.map((f) => packages[owner]?.[f]?.[name]).find((v) => v !== undefined)
      const priv = isAlias(spec) || (entry ? npmEntryPrivate(entry, name) : name.startsWith('@'))
      deps.push(dep(name, typeof entry?.version === 'string' ? entry.version : null, manifest, priv))
      if (!key || priv) continue
      const seen = new Set([key])
      const queue = [key]
      while (queue.length) {
        const cur = queue.shift()!
        const e = packages[cur]
        for (const field of ['dependencies', 'optionalDependencies']) {
          for (const child of Object.keys(e[field] ?? {})) {
            const ck = resolveNpm(packages, cur, child)
            if (!ck || seen.has(ck)) continue
            seen.add(ck)
            const ce = packages[ck]
            if (npmEntryPrivate(ce, keyName(ck))) continue
            queue.push(ck)
            if (directKeys.has(ck)) continue
            const version = typeof ce.version === 'string' ? ce.version : null
            transitive.set(`${manifest}\0${name}\0${child}\0${version}`, dep(child, version, manifest, false, [name]))
          }
        }
      }
    }
  }
  return { dir, ecosystem: 'npm', deps, transitive: [...transitive.values()] }
}

/** v1 lockfiles do not list direct deps (package.json does) and hoist transitive ones: follow `requires` node-style. */
function npmFromV1(dir: string, lock: Obj, pkg: Obj): Unit {
  if (!isObj(lock.dependencies)) throw new Error('no dependencies')
  const manifest = join(dir, 'package.json')
  const deps: Dep[] = []
  const transitive = new Map<string, Dep>()
  const root: Obj = lock.dependencies
  const declared = new Set<string>()
  for (const field of DEP_FIELDS) for (const n of Object.keys(pkg[field] ?? {})) declared.add(n)
  for (const name of declared) {
    const e = root[name]
    const alias = DEP_FIELDS.some((f) => isAlias(pkg[f]?.[name]))
    if (!isObj(e)) { deps.push(dep(name, null, manifest, alias || name.startsWith('@'))); continue }
    const priv = alias || npmEntryPrivate(e, name)
    deps.push(dep(name, typeof e.version === 'string' ? e.version : null, manifest, priv))
    if (priv) continue
    // `scopes[0]` holds the entry's own nested deps, then the maps that contain it, up to the top level.
    const seen = new Set<Obj>([e])
    const queue: { e: Obj; scopes: Obj[] }[] = [{ e, scopes: [isObj(e.dependencies) ? e.dependencies : {}, root] }]
    while (queue.length) {
      const cur = queue.shift()!
      for (const child of Object.keys(cur.e.requires ?? {})) {
        const i = cur.scopes.findIndex((m) => isObj(m[child]))
        if (i < 0) continue
        const ce: Obj = cur.scopes[i][child]
        if (seen.has(ce) || npmEntryPrivate(ce, child)) continue
        seen.add(ce)
        queue.push({ e: ce, scopes: [isObj(ce.dependencies) ? ce.dependencies : {}, ...cur.scopes.slice(i)] })
        // Only the direct dep's own entry is reported as direct: another (nested) version of it is a transitive.
        if (declared.has(child) && root[child] === ce) continue
        const version = typeof ce.version === 'string' ? ce.version : null
        transitive.set(`${name}\0${child}\0${version}`, dep(child, version, manifest, false, [name]))
      }
    }
  }
  return { dir, ecosystem: 'npm', deps, transitive: [...transitive.values()] }
}

export function parsePnpmLock(dir: string, _pkgJson: string, lockText: string): Unit {
  try {
    const lock = parse(lockText)
    if (!isObj(lock)) return fail(dir, 'pnpm-lock.yaml')
    // Older lockfiles keep the root importer at the top level.
    const importers: Obj = isObj(lock.importers) ? lock.importers : { '.': lock }
    const deps: Dep[] = []
    for (const [path, imp] of Object.entries<Obj>(importers)) {
      if (!isObj(imp)) continue
      const manifest = join(dir, path, 'package.json')
      for (const field of DEP_FIELDS) {
        for (const [name, v] of Object.entries<any>(imp[field] ?? {})) {
          const raw = isObj(v) ? v.version : v
          const alias = isObj(v) && isAlias(v.specifier)
          if (typeof raw !== 'string') { deps.push(dep(name, null, manifest, alias || name.startsWith('@'))); continue }
          // A plain version starts with a digit; anything else ('@s/y@1.0.0', '/@s/y/1.0.0', link:, file:...) is another source or an alias.
          deps.push(dep(name, raw.replace(/\(.*$/, ''), manifest, alias || !/^\d/.test(raw)))
        }
      }
    }
    return { dir, ecosystem: 'npm', deps, transitive: [] }
  } catch {
    return fail(dir, 'pnpm-lock.yaml')
  }
}

interface YarnEntry { version: string; private: boolean }

/** 'x@npm:1.0.0' -> 'x', '@s/y@npm:1.0.0' -> '@s/y'. */
const descriptorName = (d: string) => d.slice(0, d.indexOf('@', 1))

/** Hand-written yarn v1 reader: unindented `descriptor, descriptor:` headers followed by indented fields. */
function parseYarnV1(text: string): Map<string, YarnEntry> {
  const out = new Map<string, YarnEntry>()
  let keys: string[] = []
  let version: string | null = null
  let resolved: string | null = null
  const flush = () => {
    if (version !== null) {
      const priv = resolved !== null && !REGISTRIES.some((r) => resolved!.startsWith(r))
      for (const k of keys) out.set(k, { version, private: priv })
    }
    keys = []; version = null; resolved = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      flush()
      if (line.endsWith(':')) keys = line.slice(0, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
      continue
    }
    const m = /^ {2}(version|resolved) "(.*)"$/.exec(line)
    if (m?.[1] === 'version') version = m[2]
    else if (m) resolved = m[2]
  }
  flush()
  if (!out.size && !/^# yarn lockfile v1/m.test(text)) throw new Error('no yarn v1 blocks')
  return out
}

function parseYarnBerry(text: string): Map<string, YarnEntry> {
  const doc = parse(text)
  if (!isObj(doc)) throw new Error('not a mapping')
  const out = new Map<string, YarnEntry>()
  for (const [header, e] of Object.entries<any>(doc)) {
    if (header === '__metadata' || !isObj(e) || typeof e.version !== 'string') continue
    const priv = typeof e.resolution !== 'string' || !/^(@?[^@]+)@npm:/.test(e.resolution)
    for (const k of header.split(',')) {
      const key = k.trim()
      // Resolved under another name: an alias.
      out.set(key, { version: e.version, private: priv || descriptorName(key) !== descriptorName(e.resolution) })
    }
  }
  return out
}

export function parseYarnLock(dir: string, pkgJson: string, lockText: string): Unit {
  let pkg: Obj
  try {
    pkg = JSON.parse(pkgJson)
    if (!isObj(pkg)) throw new Error('not an object')
  } catch {
    return fail(dir, 'package.json')
  }
  try {
    const berry = /^__metadata:/m.test(lockText)
    const entries = berry ? parseYarnBerry(lockText) : parseYarnV1(lockText)
    const manifest = join(dir, 'package.json')
    const deps: Dep[] = []
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries<any>(pkg[field] ?? {})) {
        if (typeof spec !== 'string') continue
        const found = (berry ? entries.get(`${name}@npm:${spec}`) : undefined) ?? entries.get(`${name}@${spec}`)
        // Missing from the lockfile, a scoped name may come from a private registry: fail closed, like package-lock and pnpm.
        deps.push(dep(name, found?.version ?? null, manifest, hasPrivatePrefix(spec) || isAlias(spec) || (found ? found.private : name.startsWith('@'))))
      }
    }
    return { dir, ecosystem: 'npm', deps, transitive: [] }
  } catch {
    return fail(dir, 'yarn.lock')
  }
}
