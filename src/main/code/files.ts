import { git } from '../git/exec'

/** Files of the working tree relative to `cwd`: tracked and untracked, without ignored ones. */
export async function listTree(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  // Git reports a nested repository as a directory, and an unmerged path once per stage.
  return [...new Set(out.split('\0'))].filter((p) => p !== '' && !p.endsWith('/'))
}
