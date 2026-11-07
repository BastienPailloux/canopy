import { afterEach, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRepo, type TestRepo } from '../helpers/repo'

const run = promisify(execFile)
let repo: TestRepo | undefined

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

test('createRepo with remote sets origin/HEAD to origin/main', async () => {
  repo = await createRepo({ remote: true })
  const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: repo.path })
  expect(stdout.trim()).toBe('origin/main')
})

test('commit returns a 40 character sha', async () => {
  repo = await createRepo({ remote: true })
  const sha = await repo.commit('a.txt', 'x')
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
})
