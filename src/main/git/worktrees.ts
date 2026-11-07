import type { Worktree } from '../../shared/types'
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
