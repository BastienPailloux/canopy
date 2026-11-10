import { homedir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import { currentEnv } from '../env'
import { git as run } from '../git/exec'
import { resolveBaseRef } from '../git/refs'
import { mainWorktreeRoot } from '../git/worktrees'
import { readRegularFile } from '../safeRead'
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

/**
 * Parsed units per repo root, then lockfile path: parsing a big lockfile blocks the main process, unchanged ones
 * are never parsed again. One map per repo, so a pass over many repos never evicts a repo before its next check.
 * A read keeps only the paths it used: a repo holds at most its own lockfiles. `forgetRepo` drops a repo's map.
 */
type Parsed = { files: [string, string | null][]; value: unknown; read: number }
const parsed = new Map<string, { read: number; entries: Map<string, Parsed> }>()

/** Drops the parsed lockfiles of a repo no longer watched (`root` as given to readAtRef). */
export function forgetRepo(root: string): void {
  parsed.delete(root)
}

function repoCache(root: string) {
  let c = parsed.get(root)
  if (!c) { c = { read: 0, entries: new Map() }; parsed.set(root, c) }
  return c
}

async function cached<T>(root: string, tree: Tree, path: string, produce: (t: Tracker) => Promise<T>): Promise<T> {
  const cache = repoCache(root)
  const hit = cache.entries.get(path)
  if (hit && hit.files.every(([p, oid]) => (tree.get(p) ?? null) === oid)) {
    hit.read = cache.read
    return hit.value as T
  }
  const t = tracker(root, tree)
  const value = await produce(t)
  cache.entries.delete(path)
  if (!t.failed()) cache.entries.set(path, { files: [...t.files], value, read: cache.read })
  return value
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

const RC_FILES = [['.npmrc', parseNpmrc], ['.yarnrc.yml', parseYarnrc]] as const

/** The registry settings of every directory from the unit's up to the repo root (unreadable or invalid files fail closed). */
async function registryConfigs(t: Tracker, tree: Tree, dir: string): Promise<RegistryConfig[]> {
  const dirs: string[] = []
  for (let d = dir; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) { dirs.push(d); if (!d) break }
  const configs: RegistryConfig[] = []
  for (const [file, parse] of RC_FILES) {
    for (const path of dirs.map((d) => posix.join(d, file))) {
      // Recorded even when absent: adding one must invalidate the cached unit.
      const text = await t.read(path)
      if (tree.has(path)) configs.push(parse(text))
    }
  }
  return configs
}

const RC_MAX_BYTES = 1024 * 1024

/**
 * A missing file is skipped; one that cannot be read fails closed. Symlinks are followed (dotfiles managers link
 * ~/.npmrc), but a target that is not a regular file (a device, a FIFO that would block) or is over 1 MB fails closed.
 */
async function userFile(path: string, parse: (text: string | null) => RegistryConfig): Promise<RegistryConfig | null> {
  try {
    const read = await readRegularFile(path, { maxBytes: RC_MAX_BYTES })
    return parse(read.kind === 'file' ? read.bytes.toString('utf8') : null)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : parse(null)
  }
}

/** Configs read outside the base ref may only make packages private: a public mapping there is ignored. */
const addOnly = (c: RegistryConfig): RegistryConfig => ({ ...c, publicScopes: [], defaultPublic: false })

const envValue = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([k, v]) => k.toLowerCase() === name && v !== undefined)?.[1]

/** `npm_config_registry` and `npm_config_@scope:registry`, any case, as npm reads them. */
function envConfig(env: NodeJS.ProcessEnv): RegistryConfig | null {
  const lines: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (key === 'npm_config_registry') lines.push(`registry=${v}`)
    const scope = /^npm_config_(@[^:]+):registry$/.exec(key)
    if (scope) lines.push(`${scope[1]}:registry=${v}`)
  }
  if (lines.length === 0) return null
  // A line break in a value would add a line of its own: fail closed rather than read it.
  return addOnly(parseNpmrc(lines.some((l) => /[\r\n]/.test(l)) ? null : lines.join('\n')))
}

/**
 * The user's own `~/.npmrc` and `~/.yarnrc.yml`, read from disk: npm, pnpm and yarn use them too. Then, only adding
 * privacy: pnpm's global rc, `$PREFIX/etc/npmrc` and the npm_config registry variables.
 * Only registry keys are kept; a file that exists but cannot be read fails closed.
 */
async function userConfigs(home: string, env: NodeJS.ProcessEnv): Promise<RegistryConfig[]> {
  const configs: RegistryConfig[] = []
  for (const [file, parse] of RC_FILES) {
    const c = await userFile(join(home, file), parse)
    if (c) configs.push(c)
  }
  const extra = [join(home, 'Library/Preferences/pnpm/rc')]
  const prefix = envValue(env, 'npm_config_prefix') ?? env.PREFIX
  if (prefix && isAbsolute(prefix)) extra.push(join(prefix, 'etc/npmrc'))
  for (const path of extra) {
    const c = await userFile(path, parseNpmrc)
    if (c) configs.push(addOnly(c))
  }
  const fromEnv = envConfig(env)
  if (fromEnv) configs.push(fromEnv)
  return configs
}

/**
 * The rc files of the main checkout's working tree, from the unit's directory up to the root: an untracked
 * `.npmrc` there is what npm and pnpm use, so it may name a private registry the base ref does not.
 * Only adds privacy. A symlink (it could point anywhere), a non-regular, unreadable or oversized file fails closed.
 */
async function checkoutConfigs(root: string, dir: string): Promise<RegistryConfig[]> {
  const configs: RegistryConfig[] = []
  for (let d = dir; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
    for (const [file, parse] of RC_FILES) {
      const path = join(root, d, file)
      let text: string | null = null
      try {
        // A symlink rejects with ELOOP, so it fails closed.
        const read = await readRegularFile(path, { maxBytes: RC_MAX_BYTES, noFollow: true })
        if (read.kind === 'file') text = read.bytes.toString('utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      configs.push(addOnly(parse(text)))
    }
    if (!d) break
  }
  return configs
}

async function readDir(root: string, tree: Tree, dir: string, files: string[], user: RegistryConfig[]): Promise<Unit[]> {
  const path = (f: string) => posix.join(dir, f)
  const units: Unit[] = []
  const parseOrUnreadable = async (file: string, ecosystem: Unit['ecosystem'], t: Tracker, parse: (text: string, t: Tracker) => Unit | Promise<Unit>): Promise<Unit> => {
    const text = await t.read(path(file))
    try {
      return text === null ? unreadable(path(file), ecosystem) : await parse(text, t)
    } catch {
      return unreadable(path(file), ecosystem)
    }
  }
  const read = async (file: string, ecosystem: Unit['ecosystem'], parse: (text: string, t: Tracker) => Unit | Promise<Unit>) => {
    units.push(await cached(root, tree, path(file), (t) => parseOrUnreadable(file, ecosystem, t, parse)))
  }

  const js = JS_LOCKS.find((f) => files.includes(f))
  if (js) {
    // The registry configs apply after the cache: the user's own and the checkout's files are not part of its key.
    const { unit, configs, strict } = await cached(root, tree, path(js), async (t) => {
      let berry = false
      const unit = await parseOrUnreadable(js, 'npm', t, async (lock) => {
        const pkg = await t.read(path('package.json'))
        berry = /^__metadata:/m.test(lock)
        return js === 'package-lock.json' ? parsePackageLock(dir, lock, pkg ?? undefined)
          : js === 'pnpm-lock.yaml' ? parsePnpmLock(dir, pkg ?? '{}', lock)
            : parseYarnLock(dir, pkg ?? '{}', lock)
      })
      // pnpm and yarn berry do not record where a package came from.
      return { unit, configs: await registryConfigs(t, tree, dir), strict: js === 'pnpm-lock.yaml' || berry }
    })
    units.push(applyRegistryConfig(unit, [...configs, ...user, ...await checkoutConfigs(root, dir)], { strictScopes: strict }))
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
export async function readInventory(repo: string, o: { fetch?: boolean; fetchTimeoutMs?: number; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Inventory> {
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

  const read = await readAtRef(root, base.ref, { home: o.home, env: o.env })
  return { ...read, repo: root, notes: [...notes, ...read.notes] }
}

/** Blob ids by path, and file names by directory outside EXCLUDED_DIRS, from `git ls-tree -r -z` output. */
export function groupListing(listing: string): { tree: Tree; byDir: Map<string, string[]> } {
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
    const names = byDir.get(dir)
    if (names) names.push(segments[segments.length - 1])
    else byDir.set(dir, [segments[segments.length - 1]])
  }
  return { tree, byDir }
}

/** Lists and reads the lockfiles at `ref`. A listing failure (ref gone since it was resolved) is a note, not a throw. */
/**
 * `root`: the main worktree root, whose working tree rc files are read too. `home`: where the user's own rc files are
 * (the user's home directory by default). `env`: where the npm_config variables are read (the login-shell env by default: a Dock-launched app lacks the shell's exports in process.env).
 */
export async function readAtRef(root: string, ref: string, o: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Inventory> {
  let listing: string
  try {
    listing = await git(root, ['ls-tree', '-r', '-z', ref])
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? ''
    const reason = (stderr.trim() || (e as Error).message).split('\n')[0].trim().slice(0, 160)
    return { repo: root, baseRef: ref, units: [], notes: [`Liste des fichiers illisible : ${reason}`] }
  }
  const { tree, byDir } = groupListing(listing)
  const units: Unit[] = []
  const user = await userConfigs(o.home ?? homedir(), o.env ?? currentEnv())
  const cache = repoCache(root)
  const read = ++cache.read
  for (const dir of [...byDir.keys()].sort()) units.push(...await readDir(root, tree, dir, byDir.get(dir)!, user))
  for (const [path, e] of cache.entries) if (e.read !== read) cache.entries.delete(path)
  return { repo: root, baseRef: ref, units, notes: [] }
}
