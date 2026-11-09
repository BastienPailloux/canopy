import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { allocatePorts, isFree, readConfig, validateConfig } from '../../../src/main/terminal/config'

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
  expect(await readConfig(dir)).toEqual({ setup: ['npm install'], services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }] })
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
  ['a portEnv that is not a variable name', { services: [{ name: 'web', command: 'x', portEnv: 'A B' }] }],
  ['a portEnv that would redirect the shell config', { services: [{ name: 'web', command: 'x', portEnv: 'ZDOTDIR' }] }],
  ['a portEnv that would replace the PATH', { services: [{ name: 'web', command: 'x', portEnv: 'PATH' }] }],
  ['a portEnv ending in PORT without the separator', { services: [{ name: 'web', command: 'x', portEnv: 'NOTAPORT' }] }],
  ['a portEnv in lower case', { services: [{ name: 'web', command: 'x', portEnv: 'vite_port' }] }],
  ['a portEnv with PORT only as a prefix', { services: [{ name: 'web', command: 'x', portEnv: 'PORT_PATH' }] }],
  ['a portEnv that is not a string', { services: [{ name: 'web', command: 'x', portEnv: 3000 }] }],
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

const listening = (port: number, host: string): Promise<void> => new Promise((resolve, reject) => {
  const server = createServer()
  servers.push(server)
  server.once('error', reject)
  server.listen(port, host, resolve)
})

test.each(['127.0.0.1', '0.0.0.0', '::', '::1'])('a port listened on at %s is not free', async (host) => {
  const port = 41873
  expect(await isFree(port)).toBe(true)
  await listening(port, host)
  expect(await isFree(port)).toBe(false)
  await new Promise((r) => { servers.pop()?.close(r) })
})

test('a service names the variable that receives its port', async () => {
  await writeConfig({ services: [{ name: 'web', command: 'x', portEnv: 'VITE_PORT' }] })
  expect((await readConfig(dir)).services).toEqual([{ name: 'web', command: 'x', portEnv: 'VITE_PORT' }])
})

test('without portEnv a service gets PORT, which the declared form does not need to spell', async () => {
  await writeConfig({ services: [{ name: 'web', command: 'x' }, { name: 'api', command: 'y', portEnv: 'API_PORT' }] })
  expect((await readConfig(dir)).services.map((s) => s.portEnv)).toEqual(['PORT', 'API_PORT'])
})

test('a refused portEnv says what is expected', async () => {
  await writeConfig({ services: [{ name: 'web', command: 'x', portEnv: 'ZDOTDIR' }] })
  await expect(readConfig(dir)).rejects.toThrow(/portEnv.*web.*PORT/)
})

test('PORT itself may be spelled out, like any _PORT variable', async () => {
  await writeConfig({ services: [{ name: 'web', command: 'x', portEnv: 'PORT' }, { name: 'api', command: 'y', portEnv: 'API_PORT' }] })
  expect((await readConfig(dir)).services.map((s) => s.portEnv)).toEqual(['PORT', 'API_PORT'])
})

test('validates a config given as data, naming its source in errors', () => {
  expect(validateConfig({ services: [{ name: 'web', command: 'npm run dev' }] }, 'Réglage')).toEqual({
    setup: [], services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }]
  })
  expect(() => validateConfig({ services: [{ name: 'web', command: 'x', portEnv: 'PATH' }] }, 'Réglage')).toThrow(/^Réglage invalide/)
})
