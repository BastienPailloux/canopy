import chokidar, { type FSWatcher } from 'chokidar'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileContent } from '../../shared/api'
import { FILE_CHANGED } from '../../shared/errors'
import { git } from '../git/exec'

/** Files of the working tree relative to `cwd`: tracked and untracked, without ignored ones. */
export async function listTree(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  // Git reports a nested repository as a directory, and an unmerged path once per stage.
  return [...new Set(out.split('\0'))].filter((p) => p !== '' && !p.endsWith('/'))
}

export const MAX_TEXT_BYTES = 5 * 1024 * 1024


const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)
const versionOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex')
/** macOS opens `.GIT` as `.git`: a comparison of the name as typed would let it through. */
const isGitDir = (part: string): boolean => part.toLowerCase() === '.git'

/**
 * Where `rel` really is on disk, if that is under the worktree after resolving every symlink.
 * The repository is untrusted: a link in it may point anywhere, and a string prefix check would not see it.
 */
async function resolveInside(cwd: string, rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) throw new Error('Chemin invalide')
  const parts = rel.split(/[\\/]/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.includes('..') || parts.some(isGitDir)) throw new Error('Chemin invalide')
  const root = await realpath(cwd)
  const full = join(root, ...parts)
  // The nearest existing ancestor stands for a file that does not exist yet.
  let existing = full
  const missing: string[] = []
  for (;;) {
    try {
      await lstat(existing)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      missing.unshift(basename(existing))
      existing = dirname(existing)
      if (!isInside(root, existing)) throw new Error('Chemin hors du worktree')
    }
  }
  let real: string
  try {
    real = await realpath(existing)
  } catch {
    throw new Error('Lien symbolique invalide')
  }
  if (!isInside(root, real)) throw new Error('Chemin hors du worktree')
  const resolved = join(real, ...missing)
  // A link may lead into git's own directory, where a hook would run code.
  if (relative(root, resolved).split(sep).some(isGitDir)) throw new Error('Chemin invalide')
  return resolved
}

/** Text of a file of the worktree. Binary files and files over 5 MB are reported, not read. */
export async function readFileSafe(cwd: string, path: string): Promise<FileContent> {
  const real = await resolveInside(cwd, path)
  const st = await stat(real)
  if (!st.isFile()) throw new Error('Ce chemin n\'est pas un fichier')
  if (st.size > MAX_TEXT_BYTES) return { kind: 'tooLarge', size: st.size }
  const bytes = await readFile(real)
  if (bytes.subarray(0, 8192).includes(0)) return { kind: 'binary' }
  return { kind: 'text', content: bytes.toString('utf8'), version: versionOf(bytes), ...(isUtf8(bytes) ? {} : { notUtf8: true }) }
}

/**
 * Writes a text file and returns its new version. With `expectedVersion`, rejects with FILE_CHANGED
 * unless the file still holds what was read: someone else (Claude) changed or deleted it meanwhile.
 */
export async function writeFileSafe(
  cwd: string, path: string, content: string, opts: { expectedVersion?: string } = {}
): Promise<string> {
  const real = await resolveInside(cwd, path)
  let current: Buffer | null = null
  try {
    current = await readFile(real)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // What was shown is a lossy decoding: writing it back would replace every byte it could not read.
  if (current && !current.subarray(0, 8192).includes(0) && !isUtf8(current)) throw new Error('Fichier non UTF-8 : modification refusée')
  if (opts.expectedVersion !== undefined && (current ? versionOf(current) : null) !== opts.expectedVersion) throw new Error(FILE_CHANGED)
  await mkdir(dirname(real), { recursive: true })
  const bytes = Buffer.from(content, 'utf8')
  await writeFile(real, bytes)
  return versionOf(bytes)
}

const DEBOUNCE_MS = 300

/** Git state worth reacting to: a commit, a checkout, a worktree added or removed; not the index or object churn. */
function gitPathKept(parts: string[]): boolean {
  if (parts[1] === 'worktrees') return parts.length <= 3
  return parts.length === 1 || parts[1] === 'HEAD' || parts[1] === 'refs'
}

/** What git ignores right now, relative to `cwd`, whole folders as one entry. Empty if git cannot tell. */
async function ignoredPaths(cwd: string): Promise<Set<string>> {
  try {
    const out = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
    return new Set(out.split('\0').filter((p) => p !== '').map((p) => p.replace(/\/$/, '')))
  } catch {
    return new Set()
  }
}

/** In a linked worktree `.git` is a file: its HEAD and the shared refs live elsewhere. */
async function linkedGitPaths(cwd: string): Promise<string[]> {
  try {
    const [gitDir, common] = (await git(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split('\n')
    return isInside(cwd, gitDir) ? [] : [join(gitDir, 'HEAD'), join(resolve(cwd, common), 'refs')]
  } catch {
    // Not a git worktree any more: the files themselves are still watched.
    return []
  }
}

/** Whether a burst says more than "ignored files changed". Git state and anything git cannot judge count. */
async function burstMatters(cwd: string, paths: string[]): Promise<boolean> {
  const inTree = paths.map((p) => relative(cwd, p))
  if (inTree.some((r) => r === '' || r.startsWith('..') || isGitDir(r.split(sep)[0]))) return true
  try {
    const out = await git(cwd, ['check-ignore', '-z', '--stdin'], { input: inTree.join('\0'), okCodes: [1] })
    const ignored = new Set(out.split('\0'))
    return inTree.some((r) => !ignored.has(r))
  } catch {
    return true
  }
}

/**
 * Calls `cb` once per burst of changes (300 ms) in the worktree, a commit included. Ignores node_modules, `.worktrees`,
 * what git ignores, and the inside of `.git` except HEAD, refs and the list of worktrees.
 * `onError`: live refresh may have stopped. `onReady`: everything is watched, linked git paths included.
 * Returns the stop function.
 */
export function watchWorktree(cwd: string, cb: () => void, onReady?: () => void, onError?: (e: Error) => void): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let ignored = new Set<string>()
  const burst = new Set<string>()

  const flush = async (): Promise<void> => {
    const paths = [...burst]
    burst.clear()
    if (await burstMatters(cwd, paths)) {
      if (!stopped) cb()
    } else {
      // A folder that appeared since the start: nothing under it needs watching.
      ignored = await ignoredPaths(cwd)
    }
  }
  const fire = (_event: string, path: string): void => {
    burst.add(path)
    clearTimeout(timer)
    timer = setTimeout(() => { if (!stopped) void flush() }, DEBOUNCE_MS)
  }

  void (async () => {
    const [known, linked] = await Promise.all([ignoredPaths(cwd), linkedGitPaths(cwd)])
    if (stopped) return
    ignored = known
    watcher = chokidar.watch([cwd, ...linked], {
      ignoreInitial: true,
      ignored: (p) => {
        const rel = relative(cwd, p)
        const parts = rel.split(sep)
        if (parts.includes('node_modules') || parts[0] === '.worktrees' || ignored.has(rel)) return true
        return parts[0] === '.git' && !gitPathKept(parts)
      }
    })
    watcher.on('all', fire).on('error', (e) => { if (!stopped) onError?.(e instanceof Error ? e : new Error(String(e))) })
    watcher.on('ready', () => { if (!stopped) onReady?.() })
  })()

  return () => {
    stopped = true
    clearTimeout(timer)
    void watcher?.close()
  }
}
