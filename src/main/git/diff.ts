import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChangedFile, WorktreeStats } from '../../shared/types'
import { git, GitError } from './exec'
import { aheadCount, mergeBase } from './refs'

type Kind = ChangedFile['kind']

interface NumstatEntry { added: number; deleted: number; binary: boolean }

/** Parse `git diff -z --name-status`: `S\0path\0` or `Rnn\0old\0new\0`. */
function parseNameStatus(out: string): Array<{ kind: Kind; path: string; oldPath?: string }> {
  const tok = out.split('\0')
  const res: Array<{ kind: Kind; path: string; oldPath?: string }> = []
  let i = 0
  while (i < tok.length && tok[i] !== '') {
    const status = tok[i++]
    const c = status[0]
    if (c === 'R' || c === 'C') {
      const oldPath = tok[i++]
      const path = tok[i++]
      res.push({ kind: 'R', path, oldPath })
    } else {
      const path = tok[i++]
      res.push({ kind: c === 'A' ? 'A' : c === 'D' ? 'D' : 'M', path })
    }
  }
  return res
}

/** Parse `git diff -z --numstat`: `a\td\tpath\0` or `a\td\t\0old\0new\0`. Keyed by (new) path. */
function parseNumstat(out: string): Map<string, NumstatEntry> {
  const tok = out.split('\0')
  const res = new Map<string, NumstatEntry>()
  let i = 0
  while (i < tok.length && tok[i] !== '') {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tok[i++])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      i++ // old path
      path = tok[i++]
    }
    const binary = m[1] === '-'
    res.set(path, { added: binary ? 0 : +m[1], deleted: binary ? 0 : +m[2], binary })
  }
  return res
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0
  let n = 0
  for (const b of buf) if (b === 10) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

const MISSING_FILE_CODES = new Set(['ENOENT', 'EISDIR', 'ELOOP', 'ENOTDIR'])
const READ_CONCURRENCY = 32
const MAX_BASE_BYTES = 64 * 1024 * 1024

type WorkingFile =
  | { type: 'missing' }
  | { type: 'file'; buf: Buffer }
  | { type: 'symlink'; target: string }
  | { type: 'other' }

/**
 * Inspect a working-tree path without ever following symlinks or opening special files
 * (the repository is untrusted). Only regular files are read; other errors propagate.
 */
async function inspectWorkingFile(cwd: string, path: string): Promise<WorkingFile> {
  const full = join(cwd, path)
  try {
    const st = await lstat(full)
    if (st.isSymbolicLink()) return { type: 'symlink', target: await readlink(full) }
    if (!st.isFile()) return { type: 'other' }
    return { type: 'file', buf: await readFile(full) }
  } catch (e) {
    if (MISSING_FILE_CODES.has((e as NodeJS.ErrnoException).code ?? '')) return { type: 'missing' }
    throw e
  }
}

const NO_LINES = { added: 0, deleted: 0, binary: false }

async function untrackedEntry(cwd: string, path: string): Promise<ChangedFile> {
  const f = await inspectWorkingFile(cwd, path)
  // A symlink counts as git would store it: its link text, one line.
  if (f.type === 'symlink') return { path, kind: 'A', ...NO_LINES, added: 1 }
  if (f.type !== 'file') return { path, kind: 'A', ...NO_LINES }
  if (f.buf.subarray(0, 8192).includes(0)) return { path, kind: 'A', ...NO_LINES, binary: true }
  return { path, kind: 'A', ...NO_LINES, added: countLines(f.buf) }
}

/** Run fn over items with bounded concurrency, preserving order. Rejects on the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Entry for a path the index lost (diff says D) but that exists on disk: compare the disk
 * content to the base blob with `git diff --no-index` on temp copies. Writes no git objects.
 */
async function recreatedEntry(cwd: string, mb: string, path: string): Promise<ChangedFile> {
  const f = await inspectWorkingFile(cwd, path)
  if (f.type === 'missing') return { path, kind: 'D', ...NO_LINES }
  const baseSize = parseInt((await git(cwd, ['cat-file', '-s', `${mb}:${path}`])).trim(), 10)
  if (baseSize > MAX_BASE_BYTES) return { path, kind: 'M', ...NO_LINES, binary: true }
  const dir = await mkdtemp(join(tmpdir(), 'canopy-diff-'))
  try {
    const baseFile = join(dir, 'base')
    const newFile = join(dir, 'new')
    await writeFile(baseFile, await git(cwd, ['show', `${mb}:${path}`], { maxBuffer: MAX_BASE_BYTES + 1024 * 1024 }))
    await writeFile(newFile, f.type === 'file' ? f.buf : f.type === 'symlink' ? f.target : '')
    const out = await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--numstat', '-z', baseFile, newFile], {
      okCodes: [0, 1]
    })
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(out)
    if (!m) return { path, kind: 'M', ...NO_LINES } // identical content
    const binary = m[1] === '-'
    return { path, kind: 'M', added: binary ? 0 : +m[1], deleted: binary ? 0 : +m[2], binary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Files changed since the merge-base with `ref`: committed, staged, unstaged and untracked work. */
export async function changedFiles(cwd: string, ref: string): Promise<ChangedFile[]> {
  const mb = await mergeBase(cwd, ref)
  const [nameStatus, numstat, others] = await Promise.all([
    git(cwd, ['diff', '-M', '-z', '--name-status', mb]),
    git(cwd, ['diff', '-M', '-z', '--numstat', mb]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const stats = parseNumstat(numstat)
  const untrackedPaths = new Set(others.split('\0').filter((p) => p !== ''))
  const files: ChangedFile[] = await mapLimit(parseNameStatus(nameStatus), READ_CONCURRENCY, async (e) => {
    // Deleted from the index/base but present on disk: report the real modification.
    if (e.kind === 'D' && untrackedPaths.has(e.path)) {
      untrackedPaths.delete(e.path)
      return recreatedEntry(cwd, mb, e.path)
    }
    const s = stats.get(e.path) ?? { added: 0, deleted: 0, binary: false }
    return e.oldPath === undefined
      ? { path: e.path, kind: e.kind, ...s }
      : { path: e.path, oldPath: e.oldPath, kind: e.kind, ...s }
  })
  files.push(...(await mapLimit([...untrackedPaths], READ_CONCURRENCY, (p) => untrackedEntry(cwd, p))))
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export type BaseContent =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'notBlob' }

/**
 * File content at the merge-base with `ref`. null: the path does not exist there.
 * notBlob: a directory or submodule. tooLarge: over 64 MiB, not read. Git failures propagate.
 */
export async function readAtBase(cwd: string, ref: string, path: string): Promise<BaseContent | null> {
  const mb = await mergeBase(cwd, ref)
  const listed = await git(cwd, ['ls-tree', '-z', mb, '--', path])
  if (listed === '') return null
  const m = /^\d+ (\w+) ([0-9a-f]+)\t/.exec(listed)
  if (!m) throw new GitError(`Unexpected ls-tree output for ${path}`, listed)
  if (m[1] !== 'blob') return { kind: 'notBlob' }
  const size = parseInt((await git(cwd, ['cat-file', '-s', m[2]])).trim(), 10)
  if (size > MAX_BASE_BYTES) return { kind: 'tooLarge', size }
  const content = await git(cwd, ['show', m[2]], { maxBuffer: MAX_BASE_BYTES + 1024 * 1024 })
  return { kind: 'text', content }
}

export async function worktreeStats(cwd: string, ref: string): Promise<WorktreeStats> {
  const [files, ahead] = await Promise.all([changedFiles(cwd, ref), aheadCount(cwd, ref)])
  return {
    ahead,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0)
  }
}
