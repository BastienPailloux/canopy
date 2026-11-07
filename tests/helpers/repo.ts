import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface TestRepo {
  path: string
  commit(file: string, content: string, msg?: string): Promise<string>
  cleanup(): Promise<void>
}

export interface CreateRepoOptions {
  branch?: string
  remote?: boolean
  dirName?: string
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...GIT_ENV } })
  return stdout.trim()
}

export async function createRepo(opts: CreateRepoOptions = {}): Promise<TestRepo> {
  const branch = opts.branch ?? 'main'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canopy-test-')))
  const path = join(root, opts.dirName ?? 'repo')
  await mkdir(path, { recursive: true })

  await git(path, ['init', '-b', branch])
  await git(path, ['config', 'commit.gpgsign', 'false'])

  const repo: TestRepo = {
    path,
    async commit(file, content, msg = `update ${file}`) {
      const full = join(path, file)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content)
      await git(path, ['add', '--', file])
      await git(path, ['commit', '-m', msg])
      return git(path, ['rev-parse', 'HEAD'])
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    }
  }

  await repo.commit('README.md', '# test\n', 'initial commit')

  if (opts.remote) {
    const bare = join(root, 'remote.git')
    await git(root, ['init', '--bare', '-b', branch, bare])
    await git(path, ['remote', 'add', 'origin', bare])
    await git(path, ['push', '-u', 'origin', branch])
    await git(path, ['remote', 'set-head', 'origin', branch])
  }

  return repo
}
