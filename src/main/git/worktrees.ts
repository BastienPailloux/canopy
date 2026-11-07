import type { Worktree } from '../../shared/types'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { git } from './exec'

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain', '-z'])
  const result: Worktree[] = []
  let cur: { path?: string; head: string; branch: string | null; prunable: boolean } | undefined
  let index = 0

  const flush = (): void => {
    if (cur?.path !== undefined) {
      if (!cur.prunable) {
        result.push({ path: cur.path, branch: cur.branch, head: cur.head, isMain: index === 0 })
      }
      index++
    }
    cur = undefined
  }

  for (const field of out.split('\0')) {
    if (field === '') { flush(); continue }
    cur ??= { head: '', branch: null, prunable: false }
    if (field.startsWith('worktree ')) cur.path = field.slice('worktree '.length)
    else if (field.startsWith('HEAD ')) cur.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch ')) cur.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (field === 'prunable' || field.startsWith('prunable ')) cur.prunable = true
  }
  flush()
  return result
}

const EXCLUDE_ENTRY = '.worktrees/'

/** Add `.worktrees/` to the common git dir's info/exclude (never touches tracked files). */
async function ensureExcluded(repo: string): Promise<void> {
  const common = (await git(repo, ['rev-parse', '--git-common-dir'])).trim()
  const infoDir = join(isAbsolute(common) ? common : resolve(repo, common), 'info')
  const file = join(infoDir, 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split('\n').some((l) => l.trim() === EXCLUDE_ENTRY)) return
  await mkdir(infoDir, { recursive: true })
  await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE_ENTRY}\n`)
}

export async function createWorktree(
  repo: string,
  o: { name: string; branch: string; base: string; parentDir?: string }
): Promise<Worktree> {
  const main = (await listWorktrees(repo)).find((w) => w.isMain)?.path ?? repo
  const path = resolve(o.parentDir ?? join(main, '.worktrees'), o.name)
  if (existsSync(path)) throw new Error(`Le dossier du worktree "${o.name}" existe déjà : ${path}`)
  const branchTaken = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`]).then(() => true, () => false)
  if (branchTaken) throw new Error(`La branche "${o.branch}" existe déjà`)

  if (o.parentDir === undefined) await ensureExcluded(repo)
  await git(repo, ['worktree', 'add', '-b', o.branch, '--', path, o.base])
  const created = (await listWorktrees(repo)).find((w) => w.path === path)
  if (!created) throw new Error(`Worktree introuvable après création : ${path}`)
  return created
}

/** Uncommitted files and commits that would be lost: unpushed vs upstream, else vs `ref`. */
export async function removalRisks(path: string, ref: string): Promise<{ dirty: number; unpushed: number }> {
  const status = await git(path, ['status', '--porcelain', '-z'])
  const dirty = status.split('\0').filter((e) => e !== '').length
  const hasUpstream = await git(path, ['rev-parse', '--verify', '--quiet', '@{upstream}']).then(() => true, () => false)
  const range = hasUpstream ? '@{upstream}..HEAD' : `${ref}..HEAD`
  const unpushed = Number((await git(path, ['rev-list', '--count', range])).trim())
  return { dirty, unpushed }
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  const target = (await listWorktrees(repo)).find((w) => w.path === resolve(path))
  if (target?.isMain) throw new Error('Impossible de supprimer le worktree principal')
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path])
}
