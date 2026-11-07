import chokidar from 'chokidar'
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

/**
 * Where `rel` really is on disk, if that is under the worktree after resolving every symlink.
 * The repository is untrusted: a link in it may point anywhere, and a string prefix check would not see it.
 */
async function resolveInside(cwd: string, rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) throw new Error('Chemin invalide')
  const parts = rel.split(/[\\/]/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.includes('..') || parts.includes('.git')) throw new Error('Chemin invalide')
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
  return join(real, ...missing)
}

/** Text of a file of the worktree. Binary files and files over 5 MB are reported, not read. */
export async function readFileSafe(cwd: string, path: string): Promise<FileContent> {
  const real = await resolveInside(cwd, path)
  const st = await stat(real)
  if (!st.isFile()) throw new Error('Ce chemin n\'est pas un fichier')
  if (st.size > MAX_TEXT_BYTES) return { kind: 'tooLarge', size: st.size }
  const bytes = await readFile(real)
  if (bytes.subarray(0, 8192).includes(0)) return { kind: 'binary' }
  return { kind: 'text', content: bytes.toString('utf8'), version: versionOf(bytes) }
}

/**
 * Writes a text file and returns its new version. With `expectedVersion`, rejects with FILE_CHANGED
 * unless the file still holds what was read: someone else (Claude) changed or deleted it meanwhile.
 */
export async function writeFileSafe(
  cwd: string, path: string, content: string, opts: { expectedVersion?: string } = {}
): Promise<string> {
  const real = await resolveInside(cwd, path)
  if (opts.expectedVersion !== undefined) {
    let current: string | null = null
    try {
      current = versionOf(await readFile(real))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (current !== opts.expectedVersion) throw new Error(FILE_CHANGED)
  }
  await mkdir(dirname(real), { recursive: true })
  const bytes = Buffer.from(content, 'utf8')
  await writeFile(real, bytes)
  return versionOf(bytes)
}

const DEBOUNCE_MS = 300

/** Git state worth reacting to: a commit or a checkout, not the index or object churn. */
function gitPathKept(parts: string[]): boolean {
  return parts.length === 1 || parts[1] === 'HEAD' || parts[1] === 'refs'
}

/**
 * Calls `cb` once per burst of changes (300 ms) in the worktree, a commit included.
 * Ignores node_modules and the inside of `.git` except HEAD and refs. Returns the stop function.
 */
export function watchWorktree(cwd: string, cb: () => void, onReady?: () => void): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const fire = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => { if (!stopped) cb() }, DEBOUNCE_MS)
  }
  const watcher = chokidar.watch(cwd, {
    ignoreInitial: true,
    ignored: (p) => {
      const parts = relative(cwd, p).split(sep)
      if (parts.includes('node_modules')) return true
      return parts[0] === '.git' && !gitPathKept(parts)
    }
  })
  watcher.on('all', fire).on('error', () => undefined)
  watcher.on('ready', () => { if (!stopped) onReady?.() })
  // In a linked worktree `.git` is a file: its HEAD and the shared refs live elsewhere.
  void (async () => {
    try {
      const [gitDir, common] = (await git(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split('\n')
      const commonDir = resolve(cwd, common)
      if (!stopped && !isInside(cwd, gitDir)) watcher.add([join(gitDir, 'HEAD'), join(commonDir, 'refs')])
    } catch {
      // Not a git worktree any more: the files themselves are still watched.
    }
  })()
  return () => {
    stopped = true
    clearTimeout(timer)
    void watcher.close()
  }
}
