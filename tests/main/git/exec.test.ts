import { execFileSync } from 'node:child_process'
import { chmod, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { git } from '../../../src/main/git/exec'
import { createRepo, type TestRepo } from '../../helpers/repo'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

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
