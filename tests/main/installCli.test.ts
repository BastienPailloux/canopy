import { mkdir, mkdtemp, readlink, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { installCli } from '../../src/main/installCli'

let dir: string
let binDir: string
let source: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-cli-'))
  binDir = join(dir, 'home', '.local', 'bin')
  const resources = join(dir, 'Canopy.app', 'Contents', 'Resources')
  await mkdir(resources, { recursive: true })
  source = join(resources, 'canopy')
  await writeFile(source, '#!/bin/sh\n')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const run = (pathEnv = ''): ReturnType<typeof installCli> => installCli({ source, binDir, pathEnv })

test('creates the bin directory and the link', async () => {
  const r = await run()
  expect(r).toEqual({ status: 'installed', link: join(binDir, 'canopy'), onPath: false })
  expect(await readlink(r.link)).toBe(source)
})

test('replaces a link left by another Canopy.app', async () => {
  await mkdir(binDir, { recursive: true })
  const old = join(dir, 'Old', 'Canopy.app', 'Contents', 'Resources', 'canopy')
  await symlink(old, join(binDir, 'canopy'))
  expect((await run()).status).toBe('installed')
  expect(await readlink(join(binDir, 'canopy'))).toBe(source)
})

test('is idempotent', async () => {
  await run()
  expect((await run()).status).toBe('installed')
})

test('a regular file is a conflict and stays intact', async () => {
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'canopy'), 'mine')
  expect((await run()).status).toBe('conflict')
  expect((await lstat(join(binDir, 'canopy'))).isFile()).toBe(true)
})

test('an unrelated link is a conflict and stays intact', async () => {
  await mkdir(binDir, { recursive: true })
  await symlink('/usr/local/bin/canopy', join(binDir, 'canopy'))
  expect((await run()).status).toBe('conflict')
  expect(await readlink(join(binDir, 'canopy'))).toBe('/usr/local/bin/canopy')
})

test('a link to a canopy outside any Canopy.app is a conflict', async () => {
  await mkdir(binDir, { recursive: true })
  await symlink('/opt/Canopy.app.bak/canopy', join(binDir, 'canopy'))
  expect((await run()).status).toBe('conflict')
})

test('onPath tells whether the bin directory is in PATH', async () => {
  expect((await run(`/usr/bin:${binDir}:/bin`)).onPath).toBe(true)
  expect((await run(`/usr/bin:${binDir}/:/bin`)).onPath).toBe(true)
  expect((await run('/usr/bin:/bin')).onPath).toBe(false)
})
