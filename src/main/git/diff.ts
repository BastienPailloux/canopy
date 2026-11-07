import { readFile } from 'node:fs/promises'
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

async function untrackedEntry(cwd: string, path: string): Promise<ChangedFile> {
  let buf: Buffer
  try {
    buf = await readFile(join(cwd, path))
  } catch {
    // vanished or unreadable (e.g. a broken symlink): still report it
    return { path, kind: 'A', added: 0, deleted: 0, binary: false }
  }
  if (buf.subarray(0, 8192).includes(0)) return { path, kind: 'A', added: 0, deleted: 0, binary: true }
  return { path, kind: 'A', added: countLines(buf), deleted: 0, binary: false }
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
  const files: ChangedFile[] = parseNameStatus(nameStatus).map((e) => {
    const s = stats.get(e.path) ?? { added: 0, deleted: 0, binary: false }
    return e.oldPath === undefined
      ? { path: e.path, kind: e.kind, ...s }
      : { path: e.path, oldPath: e.oldPath, kind: e.kind, ...s }
  })
  const tracked = new Set(files.map((f) => f.path))
  const untracked = others.split('\0').filter((p) => p !== '' && !tracked.has(p))
  files.push(...(await Promise.all(untracked.map((p) => untrackedEntry(cwd, p)))))
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** File content at the merge-base with `ref`, or null if the file does not exist there. */
export async function readAtBase(cwd: string, ref: string, path: string): Promise<string | null> {
  const mb = await mergeBase(cwd, ref)
  try {
    return await git(cwd, ['show', `${mb}:${path}`])
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
}

export async function worktreeStats(cwd: string, ref: string): Promise<WorktreeStats> {
  const [files, ahead] = await Promise.all([changedFiles(cwd, ref), aheadCount(cwd, ref)])
  return {
    ahead,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0)
  }
}
