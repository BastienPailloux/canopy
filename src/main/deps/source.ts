import { posix } from 'node:path'
import { git } from '../git/exec'
import { resolveBaseRef } from '../git/refs'
import { mainWorktreeRoot } from '../git/worktrees'
import { parsePackageLock, parsePnpmLock, parseYarnLock, type Unit } from './parse/js'
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

/** Never prompts (credentials, host keys): an unattended fetch must fail rather than hang. */
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }

async function refresh(root: string, branch: string, timeoutMs: number): Promise<string | null> {
  try {
    await git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: FETCH_ENV, timeoutMs })
    return null
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? ''
    const reason = (stderr.trim() || (e as Error).message).split('\n')[0].trim().slice(0, 160)
    return `Branche de base non rafraîchie : ${reason}`
  }
}

async function show(root: string, ref: string, path: string): Promise<string | null> {
  try {
    return await git(root, ['show', `${ref}:${path}`], { maxBuffer: MAX_FILE_BYTES })
  } catch {
    return null
  }
}

/** Repo-relative requirements files that `unit` pulls in, followed transitively, are all readable and public. */
async function includesTainted(root: string, ref: string, unit: Unit): Promise<boolean> {
  const seen = new Set<string>()
  const queue = [...unit.includes ?? []]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    const text = await show(root, ref, path)
    if (text === null) return true
    const parsed = parseRequirements(posix.dirname(path) === '.' ? '' : posix.dirname(path), posix.basename(path), text)
    if (parsed.error || (parsed.deps.length > 0 && parsed.deps.every((d) => d.private))) return true
    queue.push(...parsed.includes ?? [])
  }
  return false
}

async function readDir(root: string, ref: string, dir: string, files: string[]): Promise<Unit[]> {
  const path = (f: string) => posix.join(dir, f)
  const units: Unit[] = []
  const read = async (file: string, ecosystem: Unit['ecosystem'], parse: (text: string) => Unit | Promise<Unit>) => {
    const text = await show(root, ref, path(file))
    units.push(text === null ? unreadable(path(file), ecosystem) : await parse(text))
  }

  const js = JS_LOCKS.find((f) => files.includes(f))
  if (js) {
    const pkg = files.includes('package.json') ? await show(root, ref, path('package.json')) : null
    await read(js, 'npm', (lock) =>
      js === 'package-lock.json' ? parsePackageLock(dir, lock, pkg ?? undefined)
        : js === 'pnpm-lock.yaml' ? parsePnpmLock(dir, pkg ?? '{}', lock)
          : parseYarnLock(dir, pkg ?? '{}', lock))
  }
  if (files.includes('Gemfile.lock')) await read('Gemfile.lock', 'RubyGems', (lock) => parseGemfileLock(dir, lock))

  const py = PYTHON_LOCKS.find((f) => files.includes(f))
  if (py === 'uv.lock') await read(py, 'PyPI', (lock) => parseUvLock(dir, lock))
  else if (py === 'poetry.lock') {
    const pyproject = files.includes('pyproject.toml') ? await show(root, ref, path('pyproject.toml')) : null
    await read(py, 'PyPI', (lock) => parsePoetryLock(dir, pyproject, lock))
  } else if (py === 'Pipfile.lock') await read(py, 'PyPI', (lock) => parsePipfileLock(dir, lock))
  else {
    for (const file of files.filter((f) => REQUIREMENTS.test(f)).sort()) {
      await read(file, 'PyPI', async (text) => {
        const unit = parseRequirements(dir, file, text)
        if (unit.error || !(await includesTainted(root, ref, unit))) return unit
        return { ...unit, deps: unit.deps.map((d) => ({ ...d, private: true })) }
      })
    }
  }
  return units
}

/** Fetches the base branch non-interactively, then reads every recognized lockfile at it. */
export async function readInventory(repo: string, o: { fetch?: boolean; fetchTimeoutMs?: number } = {}): Promise<Inventory> {
  const root = await mainWorktreeRoot(repo)
  const notes: string[] = []
  let base = await resolveBaseRef(root).catch(() => null)
  if (base && o.fetch !== false && base.ref.startsWith('origin/')) {
    const note = await refresh(root, base.name, o.fetchTimeoutMs ?? 30_000)
    if (note) notes.push(note)
    // Fresh read: the shared cache could still hold the ref as it was before the fetch.
    base = await resolveBaseRef(root).catch(() => base)
  }
  if (!base) return { repo: root, baseRef: null, units: [], notes: [] }

  const listing = await git(root, ['ls-tree', '-r', '-z', '--name-only', base.ref])
  const byDir = new Map<string, string[]>()
  for (const path of listing.split('\0')) {
    if (!path) continue
    const segments = path.split('/')
    if (segments.some((s) => EXCLUDED_DIRS.includes(s))) continue
    const dir = segments.slice(0, -1).join('/')
    byDir.set(dir, [...byDir.get(dir) ?? [], segments[segments.length - 1]])
  }
  const units: Unit[] = []
  for (const dir of [...byDir.keys()].sort()) units.push(...await readDir(root, base.ref, dir, byDir.get(dir)!))
  return { repo: root, baseRef: base.ref, units, notes }
}
