import { posix } from 'node:path'
import { git as run } from '../git/exec'
import { resolveBaseRef } from '../git/refs'
import { mainWorktreeRoot } from '../git/worktrees'
import { parsePackageLock, parsePnpmLock, parseYarnLock, type Unit } from './parse/js'
import { applyRegistryConfig, parseNpmrc, parseYarnrc, type RegistryConfig } from './parse/npmrc'
import { parsePipfileLock, parsePoetryLock, parseRequirements, parseUvLock } from './parse/python'
import { parseGemfileLock } from './parse/ruby'

export interface Inventory { repo: string; baseRef: string | null; units: Unit[]; notes: string[] }

export const EXCLUDED_DIRS = ['node_modules', 'vendor', '.venv', '.worktrees']

const MAX_FILE_BYTES = 20 * 1024 * 1024
const REQUIREMENTS = /^requirements[A-Za-z0-9._-]*\.txt$/
const JS_LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
const PYTHON_LOCKS = ['uv.lock', 'poetry.lock', 'Pipfile.lock']
const unreadable = (path: string, ecosystem: Unit['ecosystem']): Unit =>
  ({ dir: posix.dirname(path) === '.' ? '' : posix.dirname(path), ecosystem, deps: [], transitive: [], error: `Fichier illisible : ${path}` })

/**
 * Every git call here: a missing object in a partial clone would otherwise be fetched from the promisor
 * remote, with the repo's own config (and its commands) in charge. A read that needs it fails instead.
 */
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' }
const git: typeof run = (cwd, args, opts = {}) => run(cwd, args, { ...opts, env: { ...NO_LAZY_FETCH, ...opts.env } })

/** Never prompts (credentials, host keys): an unattended fetch must fail rather than hang. */
const FETCH_ENV = {
  GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
  // Wins over every protocol.*.allow in config, and children inherit it.
  GIT_ALLOW_PROTOCOL: 'https:ssh:git:file'
}
/** Only the plain transports: `ext::` and the like would run a command named by the remote URL. */
const FETCH_PROTOCOLS = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.file.allow=always']
/**
 * An allowlist, not a denylist: git has too many settings that run a command or reroute a fetch
 * (credential helpers, proxies, uploadpack, alternateRefsCommand, protocol.*.allow, includes...) to name them all.
 * Any repo-local key outside this list skips the fetch. Keys are lowercase here, as `git config --list` prints
 * the section and variable names (the subsection keeps its case, hence `.+`).
 */
const SAFE_LOCAL_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|sparsecheckout|sparsecheckoutcone)$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage|partialclone)$/,
  /^remote\..+\.(url|pushurl|fetch|tagopt|prune|mirror|promisor|partialclonefilter)$/,
  /^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base|github-pr-owner-number)$/,
  /^(user|pull|color|lfs|maintenance)\./,
  /^push\.(default|autosetupremote|followtags)$/,
  /^init\.defaultbranch$/,
  // Fetch runs no filter, and the untrusted git() blanks them anyway.
  /^filter\.lfs\.(clean|smudge|process|required)$/,
  /^submodule\..+\.(url|active)$/,
  /^gc\.auto$/,
  /^rerere\.enabled$/,
  /^merge\.(ff|conflictstyle)$/,
  // Included files report as local, so their keys are checked too.
  /^(include|includeif\..+)\.path$/,
  // Written by `git init` here and by many setups; fetch never signs.
  /^commit\.gpgsign$/
]
const OWN_SCOPES = new Set(['local', 'worktree'])

/** The repo's own (local and worktree scope) config keys. Reads no object. */
async function localConfig(root: string): Promise<{ key: string }[]> {
  const out = await git(root, ['config', '--list', '--show-scope', '--name-only', '-z'], { okCodes: [1] })
  const fields = out.split('\0')
  const entries: { key: string }[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (OWN_SCOPES.has(fields[i])) entries.push({ key: fields[i + 1] })
  }
  return entries
}

/**
 * Any read of a missing object would fetch it from the promisor remote, running the repo's own config.
 * GIT_NO_LAZY_FETCH forbids that only from git 2.45: older git (Apple's) ignores it, so such a repo is never read.
 * Presence, not value: git reads any non-zero int as true, and a partialclonefilter alone makes a promisor remote.
 */
function isPartialClone(config: { key: string }[]): boolean {
  return config.some(({ key }) => {
    const k = key.toLowerCase()
    return k === 'extensions.partialclone' || (k.startsWith('remote.') && (k.endsWith('.promisor') || k.endsWith('.partialclonefilter')))
  })
}

function hasUnknownLocalConfig(config: { key: string }[]): boolean {
  return config.some(({ key }) => !SAFE_LOCAL_KEYS.some((re) => re.test(key.toLowerCase())))
}

async function refresh(root: string, branch: string, timeoutMs: number, config: { key: string }[]): Promise<string | null> {
  try {
    if (hasUnknownLocalConfig(config)) return 'Branche de base non rafraîchie : configuration locale non sûre'
    await git(root, [...FETCH_PROTOCOLS, 'fetch', '--quiet', '--no-tags', '--refmap=', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--upload-pack=git-upload-pack', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: FETCH_ENV, timeoutMs })
    return null
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? ''
    const reason = (stderr.trim() || (e as Error).message).split('\n')[0].trim().slice(0, 160)
    return `Branche de base non rafraîchie : ${reason}`
  }
}

/** Blob id per repo-relative path at the ref (every blob, excluded dirs included: requirements may point there). */
type Tree = Map<string, string>

/**
 * Reads blobs of the tree and records every path the result depends on, with its blob id (null when absent):
 * the result stays valid while those ids do. `failed`: a read failed although the blob exists (maybe transient).
 */
function tracker(root: string, tree: Tree) {
  const files = new Map<string, string | null>()
  let failed = false
  return {
    files,
    failed: () => failed,
    async read(path: string): Promise<string | null> {
      const oid = tree.get(path) ?? null
      files.set(path, oid)
      if (oid === null) return null
      try {
        return await git(root, ['cat-file', 'blob', oid], { maxBuffer: MAX_FILE_BYTES })
      } catch {
        failed = true
        return null
      }
    }
  }
}
type Tracker = ReturnType<typeof tracker>

/** Parsed units by root and lockfile path, LRU: parsing a big lockfile blocks the main process, unchanged ones are never parsed again. */
const CACHE_MAX = 200
const parsed = new Map<string, { files: [string, string | null][]; units: Unit[] }>()

async function cachedUnits(root: string, tree: Tree, path: string, produce: (t: Tracker) => Promise<Unit[]>): Promise<Unit[]> {
  const key = `${root}\0${path}`
  const hit = parsed.get(key)
  if (hit && hit.files.every(([p, oid]) => (tree.get(p) ?? null) === oid)) {
    parsed.delete(key)
    parsed.set(key, hit)
    return hit.units
  }
  const t = tracker(root, tree)
  const units = await produce(t)
  parsed.delete(key)
  if (!t.failed()) {
    parsed.set(key, { files: [...t.files], units })
    if (parsed.size > CACHE_MAX) parsed.delete(parsed.keys().next().value!)
  }
  return units
}

/** Repo-relative requirements files that `unit` pulls in, followed transitively, are all readable and public. */
async function includesTainted(t: Tracker, unit: Unit): Promise<boolean> {
  const seen = new Set<string>()
  const queue = [...unit.includes ?? []]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    const text = await t.read(path)
    if (text === null) return true
    const included = parseRequirements(posix.dirname(path) === '.' ? '' : posix.dirname(path), posix.basename(path), text)
    if (included.error || included.tainted) return true
    queue.push(...included.includes ?? [])
  }
  return false
}

/** The registry settings of the unit's directory and of the repo root (unreadable or invalid files fail closed). */
async function registryConfigs(t: Tracker, tree: Tree, dir: string): Promise<RegistryConfig[]> {
  const configs: RegistryConfig[] = []
  for (const [file, parse] of [['.npmrc', parseNpmrc], ['.yarnrc.yml', parseYarnrc]] as const) {
    for (const path of new Set([posix.join(dir, file), file])) {
      // Recorded even when absent: adding one must invalidate the cached unit.
      const text = await t.read(path)
      if (tree.has(path)) configs.push(parse(text))
    }
  }
  return configs
}

async function readDir(root: string, tree: Tree, dir: string, files: string[]): Promise<Unit[]> {
  const path = (f: string) => posix.join(dir, f)
  const units: Unit[] = []
  const read = async (file: string, ecosystem: Unit['ecosystem'], parse: (text: string, t: Tracker) => Unit | Promise<Unit>) => {
    units.push(...await cachedUnits(root, tree, path(file), async (t) => {
      const text = await t.read(path(file))
      try {
        return [text === null ? unreadable(path(file), ecosystem) : await parse(text, t)]
      } catch {
        return [unreadable(path(file), ecosystem)]
      }
    }))
  }

  const js = JS_LOCKS.find((f) => files.includes(f))
  if (js) {
    await read(js, 'npm', async (lock, t) => {
      const pkg = await t.read(path('package.json'))
      const configs = await registryConfigs(t, tree, dir)
      return applyRegistryConfig(
        js === 'package-lock.json' ? parsePackageLock(dir, lock, pkg ?? undefined)
          : js === 'pnpm-lock.yaml' ? parsePnpmLock(dir, pkg ?? '{}', lock)
            : parseYarnLock(dir, pkg ?? '{}', lock), configs)
    })
  }
  if (files.includes('Gemfile.lock')) await read('Gemfile.lock', 'RubyGems', (lock) => parseGemfileLock(dir, lock))

  const py = PYTHON_LOCKS.find((f) => files.includes(f))
  if (py === 'uv.lock') await read(py, 'PyPI', (lock) => parseUvLock(dir, lock))
  else if (py === 'poetry.lock') {
    await read(py, 'PyPI', async (lock, t) => parsePoetryLock(dir, await t.read(path('pyproject.toml')), lock))
  } else if (py === 'Pipfile.lock') await read(py, 'PyPI', (lock) => parsePipfileLock(dir, lock))
  else {
    for (const file of files.filter((f) => REQUIREMENTS.test(f)).sort()) {
      await read(file, 'PyPI', async (text, t) => {
        const unit = parseRequirements(dir, file, text)
        if (unit.error || unit.tainted || !(await includesTainted(t, unit))) return unit
        return { ...unit, deps: unit.deps.map((d) => ({ ...d, private: true })) }
      })
    }
  }
  return units
}

/** Fetches the base branch non-interactively, then reads every recognized lockfile at it. */
export async function readInventory(repo: string, o: { fetch?: boolean; fetchTimeoutMs?: number } = {}): Promise<Inventory> {
  const root = await mainWorktreeRoot(repo)
  const config = await localConfig(root)
  if (isPartialClone(config)) return { repo: root, baseRef: null, units: [], notes: ['Dépôt partiel : dépendances non vérifiées'] }
  const notes: string[] = []
  let base = await resolveBaseRef(root, { env: NO_LAZY_FETCH }).catch(() => null)
  if (base && o.fetch !== false && base.ref.startsWith('origin/')) {
    const note = await refresh(root, base.name, o.fetchTimeoutMs ?? 30_000, config)
    if (note) notes.push(note)
    // Fresh read: the shared cache could still hold the ref as it was before the fetch.
    base = await resolveBaseRef(root, { env: NO_LAZY_FETCH }).catch(() => base)
  }
  if (!base) return { repo: root, baseRef: null, units: [], notes: [...notes, 'Branche de base introuvable'] }

  const read = await readAtRef(root, base.ref)
  return { ...read, repo: root, notes: [...notes, ...read.notes] }
}

/** Lists and reads the lockfiles at `ref`. A listing failure (ref gone since it was resolved) is a note, not a throw. */
export async function readAtRef(root: string, ref: string): Promise<Inventory> {
  let listing: string
  try {
    listing = await git(root, ['ls-tree', '-r', '-z', ref])
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? ''
    const reason = (stderr.trim() || (e as Error).message).split('\n')[0].trim().slice(0, 160)
    return { repo: root, baseRef: ref, units: [], notes: [`Liste des fichiers illisible : ${reason}`] }
  }
  const tree: Tree = new Map()
  const byDir = new Map<string, string[]>()
  // `<mode> <type> <oid>\t<path>`: only blobs are files (gitlinks are submodules).
  for (const record of listing.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/s.exec(record)
    if (!m) continue
    const [, oid, path] = m
    tree.set(path, oid)
    const segments = path.split('/')
    if (segments.some((s) => EXCLUDED_DIRS.includes(s))) continue
    const dir = segments.slice(0, -1).join('/')
    byDir.set(dir, [...byDir.get(dir) ?? [], segments[segments.length - 1]])
  }
  const units: Unit[] = []
  for (const dir of [...byDir.keys()].sort()) units.push(...await readDir(root, tree, dir, byDir.get(dir)!))
  return { repo: root, baseRef: ref, units, notes: [] }
}
