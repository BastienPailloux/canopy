import { posix } from 'node:path'
import { parse } from 'smol-toml'
import type { Dep } from '../../../shared/deps'
import type { Unit } from './js'

const PYPI_INDEXES = new Set(['https://pypi.org/simple', 'https://pypi.python.org/simple'])

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const join = (...parts: string[]) => posix.join(...parts.filter(Boolean))
/** Same name declared twice: keep the first entry, but private if any declaration is. */
function put(map: Map<string, Dep>, d: Dep) {
  const prev = map.get(d.name)
  if (!prev) map.set(d.name, d)
  else if (d.private) prev.private = true
}
const fail = (dir: string, file: string): Unit => ({ dir, ecosystem: 'PyPI', deps: [], transitive: [], error: `Fichier illisible : ${join(dir, file)}` })
const dep = (name: string, version: string | null, manifest: string, priv: boolean): Dep =>
  ({ ecosystem: 'PyPI', name, version, manifest, private: priv })
const isPublicIndex = (url: unknown) => typeof url === 'string' && PYPI_INDEXES.has(url.trim().replace(/\/+$/, ''))

/** PEP 503 normalization. */
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Name of a PEP 508 requirement string (`Flask[async]>=2 ; marker`); null when it does not start with one. */
function requirementName(req: string): string | null {
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? null
}

/** Version of an exact `==`/`===` pin in a specifier list; null for ranges, wildcards and anything unpinned. */
function pinnedVersion(specifiers: string): string | null {
  return /^\s*===?\s*([^\s,*]+)\s*$/.exec(specifiers)?.[1] ?? null
}

function uvSourcePrivate(source: unknown): boolean {
  return !isObj(source) || !isPublicIndex(source.registry)
}

export function parseUvLock(dir: string, lockText: string): Unit {
  try {
    const lock = parse(lockText)
    const packages: Obj[] = Array.isArray(lock.package) ? lock.package.filter(isObj) : []
    const byName = new Map<string, Obj>()
    for (const p of packages) if (typeof p.name === 'string') byName.set(normalize(p.name), p)
    const manifest = join(dir, 'pyproject.toml')
    const deps = new Map<string, Dep>()
    const roots = packages.filter((p) => isObj(p.source) && (p.source.editable === '.' || p.source.virtual === '.'))
    for (const root of roots) {
      const refs: unknown[] = [...(root.dependencies ?? [])]
      for (const group of [root['dev-dependencies'], root['optional-dependencies']]) {
        if (isObj(group)) for (const list of Object.values(group)) if (Array.isArray(list)) refs.push(...list)
      }
      for (const ref of refs) {
        if (!isObj(ref) || typeof ref.name !== 'string') continue
        const name = normalize(ref.name)
        const p = byName.get(name)
        put(deps, dep(name, typeof p?.version === 'string' ? p.version : null, manifest, p ? uvSourcePrivate(p.source) : true))
      }
    }
    return { dir, ecosystem: 'PyPI', deps: [...deps.values()], transitive: [] }
  } catch {
    return fail(dir, 'uv.lock')
  }
}

export function parsePoetryLock(dir: string, pyproject: string | null, lockText: string): Unit {
  if (pyproject === null) return fail(dir, 'pyproject.toml')
  let project: Obj
  try {
    project = parse(pyproject)
  } catch {
    return fail(dir, 'pyproject.toml')
  }
  try {
    const lock = parse(lockText)
    const byName = new Map<string, Obj>()
    for (const p of (Array.isArray(lock.package) ? lock.package : []) as unknown[]) if (isObj(p) && typeof p.name === 'string') byName.set(normalize(p.name), p)

    // Named sources of pyproject; 'pypi' is implicit unless declared.
    const poetrySources = new Map<string, boolean>([['pypi', true]])
    const srcList = isObj(project.tool) && isObj(project.tool.poetry) ? project.tool.poetry.source : undefined
    if (Array.isArray(srcList)) {
      for (const s of srcList) if (isObj(s) && typeof s.name === 'string') poetrySources.set(s.name.toLowerCase(), isPublicIndex(s.url))
      if (!srcList.some((s) => isObj(s) && typeof s.name === 'string' && s.name.toLowerCase() === 'pypi')) poetrySources.set('pypi', true)
    }
    // name -> declared as git/path/url, or from a non-public named source, in pyproject
    const declared = new Map<string, boolean>()
    const add = (name: string, direct: boolean) => declared.set(name, direct || declared.get(name) === true)
    const poetry = isObj(project.tool) && isObj(project.tool.poetry) ? project.tool.poetry : {}
    const tables: unknown[] = [poetry.dependencies, poetry['dev-dependencies']]
    if (isObj(poetry.group)) for (const g of Object.values(poetry.group)) if (isObj(g)) tables.push(g.dependencies)
    for (const t of tables) {
      if (!isObj(t)) continue
      for (const [name, spec] of Object.entries(t)) {
        if (name.toLowerCase() === 'python') continue
        const specs = Array.isArray(spec) ? spec : [spec]
        add(normalize(name), specs.some((s) => isObj(s) && (s.git || s.path || s.url || (s.source !== undefined && poetrySources.get(String(s.source).toLowerCase()) !== true))))
      }
    }
    const list = isObj(project.project) ? project.project.dependencies : undefined
    if (Array.isArray(list)) {
      for (const req of list) {
        const name = typeof req === 'string' ? requirementName(req) : null
        if (name) add(normalize(name), false)
      }
    }

    const manifest = join(dir, 'pyproject.toml')
    const deps: Dep[] = []
    for (const [name, localSpec] of declared) {
      const p = byName.get(name)
      const src = p?.source
      const priv = localSpec || !p || (isObj(src) && !(src.type === 'legacy' && isPublicIndex(src.url)))
      deps.push(dep(name, typeof p?.version === 'string' ? p.version : null, manifest, priv))
    }
    return { dir, ecosystem: 'PyPI', deps, transitive: [] }
  } catch {
    return fail(dir, 'poetry.lock')
  }
}

export function parsePipfileLock(dir: string, lockText: string): Unit {
  try {
    const lock = JSON.parse(lockText)
    if (!isObj(lock)) return fail(dir, 'Pipfile.lock')
    const sources: Obj[] = Array.isArray(lock._meta?.sources) ? lock._meta.sources.filter(isObj) : []
    const publicSources = new Set(sources.filter((s) => isPublicIndex(s.url)).map((s) => s.name))
    // Pipfile adds an implicit 'pypi' source only when none is declared under that name.
    if (!sources.some((s) => s.name === 'pypi')) publicSources.add('pypi')
    const manifest = join(dir, 'Pipfile')
    const deps = new Map<string, Dep>()
    for (const group of ['default', 'develop']) {
      if (!isObj(lock[group])) continue
      for (const [raw, e] of Object.entries<any>(lock[group])) {
        const name = normalize(raw)
        if (!isObj(e)) continue
        const local = !!(e.git || e.path || e.file || e.editable || e.hg || e.svn || e.bzr)
        const otherIndex = typeof e.index === 'string' ? !publicSources.has(e.index) : sources.length > 0 && !sources.some((s) => isPublicIndex(s.url))
        const version = typeof e.version === 'string' ? pinnedVersion(e.version) : null
        put(deps, dep(name, version, manifest, local || otherIndex))
      }
    }
    return { dir, ecosystem: 'PyPI', deps: [...deps.values()], transitive: [] }
  } catch {
    return fail(dir, 'Pipfile.lock')
  }
}

/** Options that cannot change where packages come from. */
const FLAG_OPTIONS = new Set(['--require-hashes', '--pre', '--prefer-binary'])
const VALUE_OPTIONS = new Set(['--hash', '--only-binary', '--no-binary'])
const INCLUDE_FILE = /^requirements[A-Za-z0-9._-]*\.txt$/

/** An include we can follow: a relative requirements file that stays below the directory. */
const includeOk = (t: string) => !t.includes(':') && !t.startsWith('/') && !t.split('/').includes('..') && INCLUDE_FILE.test(posix.basename(t))

/**
 * Checks every option token (`--opt=value`, `--opt value`, `-iURL`). Fail closed: the result is
 * `clean` only when each option is allowlisted and each index is public PyPI.
 */
function scanOptions(tokens: string[]): { clean: boolean; includes: string[] } {
  const includes: string[] = []
  let clean = true
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1
    const opt = eq > 0 ? tok.slice(0, eq) : tok.startsWith('--') ? tok : tok.slice(0, 2)
    const attached = eq > 0 ? tok.slice(eq + 1) : tok.startsWith('--') ? '' : tok.slice(2)
    const value = () => attached || (eq > 0 ? '' : tokens[++i] ?? '')
    if (FLAG_OPTIONS.has(opt) && eq < 0) continue
    if (VALUE_OPTIONS.has(opt)) { value(); continue }
    if (opt === '-r' || opt === '-c' || opt === '--requirement' || opt === '--constraint') {
      const v = value()
      if (v && includeOk(v)) includes.push(v)
      else clean = false
    } else if (opt === '-i' || opt === '--index-url' || opt === '--extra-index-url') {
      if (!isPublicIndex(value())) clean = false
    } else {
      clean = false
    }
  }
  return { clean, includes }
}

/** Drops hashes and inline comments; backslash-continued lines are joined first. */
function logicalLines(text: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const raw of text.split(/\r?\n/)) {
    if (raw.endsWith('\\')) { acc += raw.slice(0, -1) + ' '; continue }
    out.push(acc + raw)
    acc = ''
  }
  if (acc) out.push(acc)
  return out.map((l) => l.replace(/(^|\s)#.*$/, '').replace(/\s--hash[= ]\S+/g, '').trim()).filter(Boolean)
}

export function parseRequirements(dir: string, file: string, text: string): Unit {
  try {
    const manifest = join(dir, file)
    // Several indexes make resolution ambiguous, so any non-PyPI index taints the whole file.
    let allPrivate = false
    const found = new Map<string, Dep>()
    const includes: string[] = []
    const scan = (opts: string) => {
      const r = scanOptions(opts.trim().split(/\s+/))
      if (!r.clean) allPrivate = true
      includes.push(...r.includes.map((t) => join(dir, posix.dirname(file), t)))
    }
    for (const line of logicalLines(text)) {
      let editable = false
      let body = line
      if (/^(?:-e|--editable)\s/.test(body)) { editable = true; body = body.replace(/^\S+\s+/, '') }
      else if (body.startsWith('-')) { scan(body); continue }
      // Options may trail a requirement; a specifier or marker never contains whitespace followed by '-'.
      const tail = /\s-{1,2}[A-Za-z]/.exec(body)
      if (tail) { scan(body.slice(tail.index)); body = body.slice(0, tail.index) }
      body = body.replace(/\s*;.*$/, '').trim()

      let name: string | null = null
      let version: string | null = null
      let priv = false
      const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(body)
      const direct = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*@\s*\S+/.exec(body)
      if (direct) { name = direct[1]; priv = true }
      else if (/^(?:[a-z][a-z0-9+.-]*:|\.|\/|~)/i.test(body) && !/^[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[|[=<>!~]|$)/.test(body)) {
        if (egg) { name = egg[1]; priv = true }
      } else if (editable) {
        if (egg) { name = egg[1]; priv = true }
      } else {
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(body)
        if (m) { name = m[1]; version = pinnedVersion(m[2]) }
      }
      if (!name) continue
      const key = normalize(name)
      put(found, dep(key, version, manifest, priv))
    }
    const deps = [...found.values()].map((d) => (allPrivate ? { ...d, private: true } : d))
    return { dir, ecosystem: 'PyPI', deps, transitive: [], ...(includes.length ? { includes } : {}) }
  } catch {
    return fail(dir, file)
  }
}
