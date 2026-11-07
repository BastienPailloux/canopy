import { execFileSync } from 'node:child_process'
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { changedFiles, worktreeStats } from '../../../src/main/git/diff'
import { git } from '../../../src/main/git/exec'
import { createRepo, type TestRepo } from '../../helpers/repo'

let repo: TestRepo | undefined
afterEach(async () => { vi.unstubAllEnvs(); await repo?.cleanup(); repo = undefined })

test('a repo\'s core.fsmonitor command does not run on a read', async () => {
  repo = await createRepo()
  const marker = join(repo.path, '..', 'fsmonitor-ran')
  const hook = join(repo.path, '..', 'fsmonitor.sh')
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
  await chmod(hook, 0o755)
  execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repo.path })

  await git(repo.path, ['status', '--porcelain'])
  await expect(stat(marker)).rejects.toThrow()
})

test('input goes to the command\'s stdin', async () => {
  repo = await createRepo()
  await writeFile(join(repo.path, '.gitignore'), 'dist\n')
  const out = await git(repo.path, ['check-ignore', '--stdin'], { input: 'dist\nsrc\n', okCodes: [1] })
  expect(out).toBe('dist\n')
})

test('a command that exits without reading a large input does not raise an uncaught EPIPE', async () => {
  const uncaught: unknown[] = []
  const onUncaught = (e: unknown): void => { uncaught.push(e) }
  const previous = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', onUncaught)
  try {
    const repo = await createRepo()
    await repo.commit('a.txt', 'a\n')
    await git(repo.path, ['rev-parse', 'HEAD'], { input: 'x\n'.repeat(2_000_000) })
    await new Promise((r) => setTimeout(r, 50))
    await repo.cleanup()
    expect(uncaught).toEqual([])
  } finally {
    process.off('uncaughtException', onUncaught)
    for (const l of previous) process.on('uncaughtException', l)
  }
})

describe('filters a repo sets for itself', () => {
  const marker = (name: string): string => join(repo!.path, '..', name)
  const ran = (name: string): Promise<boolean> => stat(marker(name)).then(() => true, () => false)
  const config = (key: string, value: string): void => { execFileSync('git', ['config', key, value], { cwd: repo!.path }) }

  /** A repo where every file goes through filter `name`, with one change to diff. */
  async function filtered(name: string): Promise<void> {
    repo = await createRepo()
    await repo.commit('.gitattributes', `* filter=${name}\n`)
    await repo.commit('a.txt', 'a\n')
    await writeFile(join(repo.path, 'a.txt'), 'a\nb\n')
  }

  test('a clean filter does not run from the stats, which still count the change', async () => {
    await filtered('evil')
    config('filter.evil.clean', `touch '${marker('clean-ran')}'; cat`)
    expect((await worktreeStats(repo!.path, 'HEAD')).added).toBe(1)
    expect(await ran('clean-ran')).toBe(false)
  })

  test('a filter with an empty name does not run either', async () => {
    await filtered('')
    config('filter..clean', `touch '${marker('empty-name-ran')}'; cat`)
    await git(repo!.path, ['diff', '--numstat', 'HEAD'])
    await expect(stat(marker('empty-name-ran'))).rejects.toThrow()
  })

  test('a filter whose name has a line separator does not run', async () => {
    await filtered('a\u2028b')
    config('filter.a\u2028b.clean', `touch '${marker('separator-ran')}'; cat`)
    await git(repo!.path, ['diff', '--numstat', 'HEAD'])
    expect(await ran('separator-ran')).toBe(false)
  })

  test('a filter whose name is not UTF-8 stops the read rather than run', async () => {
    await filtered('plain')
    const name = Buffer.from([0x62, 0xff, 0x63])
    await appendFile(join(repo!.path, '.git', 'config'), Buffer.concat([
      Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = touch '${marker('bytes-ran')}'; cat\n`)
    ]))
    await writeFile(join(repo!.path, '.gitattributes'), Buffer.concat([Buffer.from('* filter='), name, Buffer.from('\n')]))
    await expect(git(repo!.path, ['diff', '--numstat', 'HEAD'])).rejects.toThrow(/filter/i)
    expect(await ran('bytes-ran')).toBe(false)
  })

  test('a process filter does not run either', async () => {
    await filtered('evil')
    config('filter.evil.process', `touch '${marker('process-ran')}'`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('process-ran')).toBe(false)
  })

  test('a required filter does not turn the read into a failure', async () => {
    await filtered('evil')
    config('filter.evil.clean', `touch '${marker('clean-ran')}'; cat`)
    config('filter.evil.required', 'true')
    expect((await worktreeStats(repo!.path, 'HEAD')).added).toBe(1)
    expect(await ran('clean-ran')).toBe(false)
  })

  test('a filter defined in a file the repo config includes is found too', async () => {
    await filtered('evil')
    const included = marker('included.cfg')
    await writeFile(included, `[filter "evil"]\n  clean = touch '${marker('clean-ran')}'; cat\n`)
    config('include.path', included)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('clean-ran')).toBe(false)
  })

  test('a filter whose name holds an equals sign is found too', async () => {
    await filtered('a=b')
    config('filter.a=b.clean', `touch '${marker('clean-ran')}'; cat`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('clean-ran')).toBe(false)
  })

  test('a filter of the user\'s own config still runs: it is not the repo\'s', async () => {
    await filtered('mine')
    const global = marker('global.cfg')
    await writeFile(global, `[filter "mine"]\n  clean = touch '${marker('clean-ran')}'; cat\n`)
    vi.stubEnv('GIT_CONFIG_GLOBAL', global)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('clean-ran')).toBe(true)
  })

  test('a diff driver or external diff of the repo does not run from the changes', async () => {
    await filtered('none')
    await repo!.commit('.gitattributes', '* diff=evil\n')
    await writeFile(join(repo!.path, 'a.txt'), 'a\nc\n')
    config('diff.external', `touch '${marker('external-ran')}'`)
    config('diff.evil.command', `touch '${marker('command-ran')}'`)
    config('diff.evil.textconv', `touch '${marker('textconv-ran')}'; cat`)
    await changedFiles(repo!.path, 'HEAD')
    await worktreeStats(repo!.path, 'HEAD')
    expect([await ran('external-ran'), await ran('command-ran'), await ran('textconv-ran')]).toEqual([false, false, false])
  })

  test('a filter added to a file already included is blanked by the very next command', async () => {
    await filtered('inc')
    const included = marker('already.cfg')
    await writeFile(included, '[core]\n  quotepath = true\n')
    config('include.path', included)
    await worktreeStats(repo!.path, 'HEAD')
    await appendFile(included, `[filter "inc"]\n  clean = touch '${marker('inc-ran')}'; cat\n`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('inc-ran')).toBe(false)
  })

  test('a filter in a file a new include.path brings is blanked by the very next command', async () => {
    await filtered('newinc')
    const included = marker('new.cfg')
    await writeFile(included, `[filter "newinc"]\n  clean = touch '${marker('newinc-ran')}'; cat\n`)
    await worktreeStats(repo!.path, 'HEAD')
    config('include.path', included)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('newinc-ran')).toBe(false)
  })

  test('a filter in an included file that appears after a read is blanked by the very next command', async () => {
    await filtered('late')
    const included = marker('later.cfg')
    config('include.path', included)
    await worktreeStats(repo!.path, 'HEAD')
    await writeFile(included, `[filter "late"]\n  clean = touch '${marker('later-ran')}'; cat\n`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('later-ran')).toBe(false)
  })

  test('a filter in a file included by an included file, by a relative path, is blanked by the very next command', async () => {
    await filtered('nested')
    await mkdir(marker('cfg'))
    await writeFile(marker('cfg/outer.cfg'), '[include]\n  path = inner.cfg\n')
    config('include.path', marker('cfg/outer.cfg'))
    await worktreeStats(repo!.path, 'HEAD')
    await writeFile(marker('cfg/inner.cfg'), `[filter "nested"]\n  clean = touch '${marker('nested-ran')}'; cat\n`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('nested-ran')).toBe(false)
  })

  test('a filter added to the repo config is blanked when the command runs from a subfolder', async () => {
    await filtered('sub')
    await mkdir(join(repo!.path, 'deep', 'er'), { recursive: true })
    await writeFile(join(repo!.path, 'deep', 'er', 'b.txt'), 'b\n')
    await git(join(repo!.path, 'deep', 'er'), ['add', '-N', '.'])
    config('filter.sub.clean', `touch '${marker('sub-ran')}'; cat`)
    await git(join(repo!.path, 'deep', 'er'), ['diff', '--numstat', 'HEAD'])
    expect(await ran('sub-ran')).toBe(false)
  })

  test('a filter added after a read is blanked by the very next command', async () => {
    await filtered('late')
    await worktreeStats(repo!.path, 'HEAD')
    config('filter.late.clean', `touch '${marker('late-ran')}'; cat`)
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('late-ran')).toBe(false)
  })

  test('a filter a branch brings through includeIf is blanked by the very next command', async () => {
    await filtered('branchy')
    const included = marker('onbranch.cfg')
    await writeFile(included, `[filter "branchy"]\n  clean = touch '${marker('onbranch-ran')}'; cat\n`)
    config('includeIf.onbranch:other.path', included)
    await worktreeStats(repo!.path, 'HEAD')
    execFileSync('git', ['switch', '-q', '-c', 'other'], { cwd: repo!.path })
    await worktreeStats(repo!.path, 'HEAD')
    expect(await ran('onbranch-ran')).toBe(false)
  })

  test('a filter added in a linked worktree\'s own config is blanked by the very next command', async () => {
    await filtered('wt')
    const wt = marker('linked')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', wt], { cwd: repo!.path })
    await writeFile(join(wt, 'a.txt'), 'a\nb\n')
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo!.path })
    await worktreeStats(wt, 'HEAD')
    execFileSync('git', ['config', '--worktree', 'filter.wt.clean', `touch '${marker('wt-ran')}'; cat`], { cwd: wt })
    await worktreeStats(wt, 'HEAD')
    expect(await ran('wt-ran')).toBe(false)
  })
})
