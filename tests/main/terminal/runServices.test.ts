import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { runServices } from '../../../src/main/terminal/terminalIpc'
import { TerminalManager, type PtyProcess } from '../../../src/main/terminal/TerminalManager'

class Pty implements PtyProcess {
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => undefined
  onData(): void { /* unused */ }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb }
  write(): void { /* unused */ }
  resize(): void { /* unused */ }
  kill(): void { setTimeout(() => this.exitCb({ exitCode: 0, signal: 1 }), 20) }
}

let dir: string
let store: AppStore
let manager: TerminalManager
let server: Server | undefined
const config = async () => ({ setup: [], services: [{ name: 'web', command: 'x', portEnv: 'PORT' }] })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-run-'))
  store = new AppStore(join(dir, 'state.json'))
  manager = new TerminalManager({ spawn: () => new Pty(), env: () => ({}) })
})
afterEach(async () => {
  manager.disposeAll()
  await new Promise((r) => (server ? server.close(r) : r(undefined)))
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

test('two simultaneous restarts of a service leave one terminal for it', async () => {
  await runServices(store, manager, dir, undefined, config)
  await Promise.all([runServices(store, manager, dir, 'web', config), runServices(store, manager, dir, 'web', config)])
  const web = manager.list(dir).filter((t) => t.label === 'web')
  expect(web).toHaveLength(1)
  expect(web[0].running).toBe(true)
})

test('a reserved port that a foreign process holds is reported in the terminal', async () => {
  server = createServer()
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  store.setPorts(dir, { web: port })
  const [info] = await runServices(store, manager, dir, undefined, config)
  expect(manager.buffer(info.id)).toContain(`Le port ${port} est déjà utilisé`)
})

test('a free reserved port gives no hint', async () => {
  const [info] = await runServices(store, manager, dir, undefined, config)
  expect(manager.buffer(info.id)).toBe('')
})

test('each service gets its port in its own portEnv, PORT by default', async () => {
  const envs: Record<string, string>[] = []
  const spying = new TerminalManager({ spawn: (_f, _a, o) => { envs.push(o.env); return new Pty() }, env: () => ({}) })
  const services = async () => ({
    setup: [],
    services: [{ name: 'api', command: 'a', portEnv: 'API_PORT' }, { name: 'web', command: 'w', portEnv: 'PORT' }]
  })
  const [api, web] = await runServices(store, spying, dir, undefined, services)
  expect(envs[0].API_PORT).toBe(String(api.port))
  expect(envs[0]).not.toHaveProperty('PORT')
  expect(envs[1].PORT).toBe(String(web.port))
  expect(envs[1]).not.toHaveProperty('API_PORT')
  // Each still finds the others.
  expect(envs[1].PORT_API).toBe(String(api.port))
  spying.disposeAll()
})
