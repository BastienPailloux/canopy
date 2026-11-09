import { posix } from 'node:path'
import { parse } from 'smol-toml'
import type { Dep } from '../../../shared/deps'
import type { Unit } from './js'

const PYPI_INDEXES = new Set(['https://pypi.org/simple', 'https://pypi.python.org/simple'])

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const join = (...parts: string[]) => posix.join(...parts.filter(Boolean))
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
        if (deps.has(name)) continue
        const p = byName.get(name)
        deps.set(name, dep(name, typeof p?.version === 'string' ? p.version : null, manifest, p ? uvSourcePrivate(p.source) : false))
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

    // name -> declared as git/path/url in pyproject
    const declared = new Map<string, boolean>()
    const add = (name: string, direct: boolean) => { if (!declared.has(name)) declared.set(name, direct) }
    const poetry = isObj(project.tool) && isObj(project.tool.poetry) ? project.tool.poetry : {}
    const tables: unknown[] = [poetry.dependencies, poetry['dev-dependencies']]
    if (isObj(poetry.group)) for (const g of Object.values(poetry.group)) if (isObj(g)) tables.push(g.dependencies)
    for (const t of tables) {
      if (!isObj(t)) continue
      for (const [name, spec] of Object.entries(t)) {
        if (name.toLowerCase() === 'python') continue
        const specs = Array.isArray(spec) ? spec : [spec]
        add(normalize(name), specs.some((s) => isObj(s) && (s.git || s.path || s.url)))
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
      const priv = localSpec || (isObj(src) && !(src.type === 'legacy' && isPublicIndex(src.url)))
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
    publicSources.add('pypi')
    const manifest = join(dir, 'Pipfile')
    const deps = new Map<string, Dep>()
    for (const group of ['default', 'develop']) {
      if (!isObj(lock[group])) continue
      for (const [raw, e] of Object.entries<any>(lock[group])) {
        const name = normalize(raw)
        if (deps.has(name) || !isObj(e)) continue
        const local = !!(e.git || e.path || e.file || e.editable || e.hg || e.svn || e.bzr)
        const otherIndex = typeof e.index === 'string' && !publicSources.has(e.index)
        const version = typeof e.version === 'string' ? pinnedVersion(e.version) : null
        deps.set(name, dep(name, version, manifest, local || otherIndex))
      }
    }
    return { dir, ecosystem: 'PyPI', deps: [...deps.values()], transitive: [] }
  } catch {
    return fail(dir, 'Pipfile.lock')
  }
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
    for (const line of logicalLines(text)) {
      const index = /^(?:--index-url|--extra-index-url|-i)(?:[=\s]\s*)(\S+)/.exec(line)
      if (index) { if (!isPublicIndex(index[1])) allPrivate = true; continue }
      let editable = false
      let body = line
      if (/^(?:-e|--editable)\s/.test(body)) { editable = true; body = body.replace(/^\S+\s+/, '') }
      else if (body.startsWith('-')) continue
      body = body.replace(/\s;.*$/, '').trim()

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
      if (!found.has(key)) found.set(key, dep(key, version, manifest, priv))
    }
    const deps = [...found.values()].map((d) => (allPrivate ? { ...d, private: true } : d))
    return { dir, ecosystem: 'PyPI', deps, transitive: [] }
  } catch {
    return fail(dir, file)
  }
}
