import type { Worktree } from '../../shared/types'
import { existsSync } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { git } from './exec'

/** Whether `gitDir` is the git dir of a submodule, of the main worktree or of a linked one. */
export const isSubmoduleGitDir = (gitDir: string): boolean => /\/\.git\/(worktrees\/[^/]+\/)?modules\//.test(gitDir)

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
  // Git names a submodule's git dir as its main worktree: the files are where its config says.
  const main = result[0]
  if (main && isSubmoduleGitDir(main.path)) {
    const files = (await git(main.path, ['config', 'core.worktree'], { okCodes: [1] })).trim()
    if (files !== '') main.path = resolve(main.path, files)
  }
  return result
}

/** Root of the main worktree of the repo holding `dir`, the same from any of its worktrees. */
export async function mainWorktreeRoot(dir: string): Promise<string> {
  const main = (await listWorktrees(dir)).find((w) => w.isMain)
  if (!main) throw new Error(`Dépôt principal introuvable : ${dir}`)
  return main.path
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

const hasRef = (repo: string, ref: string): Promise<boolean> =>
  git(repo, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)

/** `git worktree add` arguments checking out a branch that exists: local, or a teammate's on a remote, as `origin/x`. */
async function existingBranchArgs(repo: string, branch: string, path: string): Promise<string[]> {
  if (await hasRef(repo, `refs/heads/${branch}`)) return ['--', path, branch]
  if (!(await hasRef(repo, `refs/remotes/${branch}`))) throw new Error(`Branche "${branch}" introuvable`)
  const local = branch.slice(branch.indexOf('/') + 1)
  return (await hasRef(repo, `refs/heads/${local}`)) ? ['--', path, local] : ['--track', '-b', local, '--', path, branch]
}

/** A new branch from `base`, tracking nothing: it is not a copy of `origin/main`. */
async function newBranchArgs(repo: string, branch: string, base: string | undefined, path: string): Promise<string[]> {
  if (base === undefined) throw new Error('Base du worktree manquante')
  if (await hasRef(repo, `refs/heads/${branch}`)) throw new Error(`La branche "${branch}" existe déjà`)
  return ['--no-track', '-b', branch, '--', path, base]
}

/** `branch` is new, from `base`, unless `existing`: then it is checked out as it is. */
export async function createWorktree(
  repo: string,
  o: { name: string; branch: string; base?: string; parentDir?: string; existing?: boolean }
): Promise<Worktree> {
  if (o.name === '' || o.name === '.' || o.name === '..' || /[/\\]/.test(o.name)) {
    throw new Error(`Nom de worktree invalide : "${o.name}"`)
  }
  const main = (await listWorktrees(repo)).find((w) => w.isMain)?.path ?? repo

  let parent: string
  if (o.parentDir === undefined) {
    // A cloned repo may commit `.worktrees` as a symlink: never follow it out of the repo.
    const dir = join(main, '.worktrees')
    const st = await lstat(dir).catch(() => undefined)
    if (st && !st.isDirectory()) {
      throw new Error('Le dossier .worktrees du dépôt n\'est pas un vrai dossier (lien symbolique ou fichier) : création refusée')
    }
    await mkdir(dir, { recursive: true })
    parent = await realpath(dir)
    const root = await realpath(main)
    if (parent !== join(root, '.worktrees') && !parent.startsWith(root + sep)) {
      throw new Error('Le dossier .worktrees sort du dépôt : création refusée')
    }
  } else {
    await mkdir(o.parentDir, { recursive: true })
    parent = await realpath(o.parentDir)
  }

  const path = join(parent, o.name)
  if (existsSync(path)) throw new Error(`Le dossier du worktree "${o.name}" existe déjà : ${path}`)
  const args = o.existing ? await existingBranchArgs(repo, o.branch, path) : await newBranchArgs(repo, o.branch, o.base, path)

  if (o.parentDir === undefined) await ensureExcluded(repo)
  await git(repo, ['worktree', 'add', ...args])
  let created: Worktree | undefined
  for (const w of await listWorktrees(repo)) {
    if ((await realpath(w.path).catch(() => w.path)) === path) created = w
  }
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
  const real = (p: string): Promise<string> => realpath(p).catch(() => resolve(p))
  const wanted = await real(path)
  let target: Worktree | undefined
  for (const w of await listWorktrees(repo)) if ((await real(w.path)) === wanted) target = w
  if (target?.isMain) throw new Error('Impossible de supprimer le worktree principal')
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path])
}
