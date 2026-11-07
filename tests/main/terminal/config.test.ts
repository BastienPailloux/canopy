import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { allocatePorts, readConfig } from '../../../src/main/terminal/config'

let dir: string
let servers: Server[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-config-'))
  servers = []
})
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  await rm(dir, { recursive: true, force: true })
})

const writeConfig = async (content: unknown): Promise<void> => {
  await mkdir(join(dir, '.canopy'), { recursive: true })
  await writeFile(join(dir, '.canopy', 'config.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

test('reads setup and services', async () => {
  await writeConfig({ setup: ['npm install'], services: [{ name: 'web', command: 'npm run dev' }] })
  expect(await readConfig(dir)).toEqual({ setup: ['npm install'], services: [{ name: 'web', command: 'npm run dev' }] })
})

test('a missing file is an empty config', async () => {
  expect(await readConfig(dir)).toEqual({ setup: [], services: [] })
})

test.each([
  ['broken JSON', '{ nope'],
  ['a list at the top', '[]'],
  ['setup that is not a list', { setup: 'npm i' }],
  ['a setup command that is not text', { setup: [1] }],
  ['a service without a command', { services: [{ name: 'web' }] }],
  ['a service name that cannot be an env variable', { services: [{ name: 'my web', command: 'x' }] }],
  ['two services with the same name', { services: [{ name: 'web', command: 'a' }, { name: 'web', command: 'b' }] }]
])('rejects %s with a readable error', async (_label, content) => {
  await writeConfig(content)
  await expect(readConfig(dir)).rejects.toThrow(/\.canopy\/config\.json/)
})

const store = (): AppStore => new AppStore(join(dir, 'state.json'))

test('ports start at 4100 and are stable between two calls', async () => {
  const s = store()
  const first = await allocatePorts(s, '/wt/a', ['web'])
  expect(first.web).toBeGreaterThanOrEqual(4100)
  expect(await allocatePorts(s, '/wt/a', ['web'])).toEqual(first)
  expect(store().ports['/wt/a']).toEqual(first)
})

test('two services get two ports, two worktrees never overlap', async () => {
  const s = store()
  const a = await allocatePorts(s, '/wt/a', ['web', 'api'])
  const b = await allocatePorts(s, '/wt/b', ['web', 'api'])
  const all = [...Object.values(a), ...Object.values(b)]
  expect(new Set(all).size).toBe(4)
})

test('skips a port that something listens on', async () => {
  const busy = createServer()
  await new Promise<void>((resolve) => busy.once('error', () => resolve()).listen(4100, '127.0.0.1', resolve))
  servers.push(busy)
  const ports = await allocatePorts(store(), '/wt/a', ['web'])
  expect(ports.web).not.toBe(4100)
})

test('concurrent calls for two worktrees do not share a port', async () => {
  const s = store()
  const [a, b] = await Promise.all([allocatePorts(s, '/wt/a', ['web']), allocatePorts(s, '/wt/b', ['web'])])
  expect(a.web).not.toBe(b.web)
})
