import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const script = resolve(__dirname, '../../../build/cli/canopy')
let dir: string
let log: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'canopy-sh-')))
  log = join(dir, 'open.log')
  await mkdir(join(dir, 'bin'))
  // A fake `open` that records its arguments, one per line.
  await writeFile(join(dir, 'bin', 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`)
  await chmod(join(dir, 'bin', 'open'), 0o755)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

interface Result { code: number; stdout: string; stderr: string }
const run = (args: string[], cwd = dir): Promise<Result> =>
  new Promise((done) => {
    execFile('/bin/sh', [script, ...args], { cwd, env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` } }, (err, stdout, stderr) => {
      done({ code: err ? (err.code as number) : 0, stdout, stderr })
    })
  })
const opened = async (): Promise<string[] | null> => readFile(log, 'utf8').then((s) => s.trimEnd().split('\n'), () => null)

test('the script is executable', async () => {
  await expect(access(script, 1)).resolves.toBeUndefined()
})

test('`.` opens the current folder', async () => {
  const proj = join(dir, 'proj')
  await mkdir(proj)
  expect((await run(['.'], proj)).code).toBe(0)
  expect(await opened()).toEqual(['-a', 'Canopy', proj])
})

test('no argument opens the current folder', async () => {
  const proj = join(dir, 'proj')
  await mkdir(proj)
  await run([], proj)
  expect(await opened()).toEqual(['-a', 'Canopy', proj])
})

test('a relative path becomes an absolute one', async () => {
  await mkdir(join(dir, 'a', 'b'), { recursive: true })
  await run(['b/../b'], join(dir, 'a'))
  expect(await opened()).toEqual(['-a', 'Canopy', join(dir, 'a', 'b')])
})

test('spaces and accents survive', async () => {
  const odd = join(dir, 'Mes projets', 'été  café')
  await mkdir(odd, { recursive: true })
  await run([odd])
  expect(await opened()).toEqual(['-a', 'Canopy', odd])
})

test('a symlink is resolved to its physical path', async () => {
  await mkdir(join(dir, 'real'))
  await symlink(join(dir, 'real'), join(dir, 'link'))
  await run([join(dir, 'link')])
  expect(await opened()).toEqual(['-a', 'Canopy', join(dir, 'real')])
})

test('a missing folder fails in French and opens nothing', async () => {
  const r = await run([join(dir, 'nope')])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/n'existe pas/)
  expect(await opened()).toBeNull()
})

test('a file is not a folder', async () => {
  await writeFile(join(dir, 'f.txt'), '')
  const r = await run([join(dir, 'f.txt')])
  expect(r.code).toBe(1)
  expect(await opened()).toBeNull()
})

test('--help and -h print the usage', async () => {
  for (const flag of ['--help', '-h']) {
    const r = await run([flag])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Usage : canopy/)
  }
  expect(await opened()).toBeNull()
})
