import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { TerminalInfo } from '../../shared/api'
import type { AppStore } from '../appStore'
import { requireTrustedRoot } from '../repoTrust'
import { assertId } from '../sessions/validate'
import { allocatePorts, isFree, readConfig, type CanopyConfig } from './config'
import type { TerminalManager } from './TerminalManager'

const STOP_WAIT_MS = 3000
const MAX_WRITE = 1024 * 1024

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

function assertSize(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) throw new Error('Taille invalide')
}

/**
 * The config of `cwd`, only if that exact config is approved: its commands run with the user's rights.
 * Approval is checked again after the read, since the file may change in between.
 */
async function trustedConfig(store: AppStore, cwd: string): Promise<CanopyConfig> {
  await requireTrustedRoot(store, cwd)
  const config = await readConfig(cwd)
  await requireTrustedRoot(store, cwd)
  return config
}

const envName = (service: string): string => `PORT_${service.toUpperCase().replace(/-/g, '_')}`

/** Ends the terminal and waits for its process, so that a restart does not find the port still taken. */
async function stop(terminals: TerminalManager, id: string): Promise<void> {
  if (!terminals.get(id)?.running) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, STOP_WAIT_MS)
    function done(): void {
      clearTimeout(timer)
      terminals.off('exit', onExit)
      resolve()
    }
    function onExit(e: { id: string }): void { if (e.id === id) done() }
    terminals.on('exit', onExit)
    terminals.kill(id)
  })
}

/** One start or restart at a time per worktree: two at once would each start the same service. */
const queues = new Map<string, Promise<unknown>>()

export function runServices(
  store: AppStore, terminals: TerminalManager, cwd: string, name?: string,
  getConfig: (store: AppStore, cwd: string) => Promise<CanopyConfig> = trustedConfig
): Promise<TerminalInfo[]> {
  const run = (queues.get(cwd) ?? Promise.resolve()).then(() => startServices(store, terminals, cwd, name, getConfig))
  const tail = run.catch(() => undefined)
  queues.set(cwd, tail)
  void tail.then(() => { if (queues.get(cwd) === tail) queues.delete(cwd) })
  return run
}

async function startServices(
  store: AppStore, terminals: TerminalManager, cwd: string, name: string | undefined,
  getConfig: (store: AppStore, cwd: string) => Promise<CanopyConfig>
): Promise<TerminalInfo[]> {
  const { services } = await getConfig(store, cwd)
  const targets = name === undefined ? services : services.filter((s) => s.name === name)
  if (name !== undefined && targets.length === 0) throw new Error(`Service inconnu : ${name}`)
  const ports = await allocatePorts(store, cwd, services.map((s) => s.name))
  const shared = Object.fromEntries(services.map((s) => [envName(s.name), String(ports[s.name])]))
  const started: TerminalInfo[] = []
  for (const service of targets) {
    for (const old of terminals.list(cwd).filter((t) => t.kind === 'service' && t.label === service.name)) {
      await stop(terminals, old.id)
      terminals.remove(old.id)
    }
    const port = ports[service.name]
    const taken = !(await isFree(port))
    const id = terminals.create(cwd, {
      command: service.command,
      env: { ...shared, PORT: String(port) },
      label: service.name,
      kind: 'service',
      port
    })
    if (taken) terminals.notice(id, `Le port ${port} est déjà utilisé par un autre processus : « ${service.name} » risque de ne pas démarrer. Libère-le, puis redémarre le service.`)
    started.push(terminals.get(id) as TerminalInfo)
  }
  return started
}

export function registerTerminalIpc(store: AppStore, terminals: TerminalManager, broadcast: (event: string, payload?: unknown) => void): void {
  terminals.on('data', (e) => broadcast('terminal:data', e))
  terminals.on('exit', (e) => broadcast('terminal:exit', e))

  ipcMain.handle('terminal:create', (_e, cwd: unknown) => {
    assertPath(cwd)
    return terminals.get(terminals.create(cwd)) as TerminalInfo
  })

  ipcMain.handle('terminal:list', (_e, cwd: unknown) => {
    assertPath(cwd)
    return terminals.list(cwd)
  })

  ipcMain.handle('terminal:write', (_e, id: unknown, data: unknown) => {
    assertId(id)
    if (typeof data !== 'string' || data.length > MAX_WRITE) throw new Error('Données invalides')
    terminals.write(id, data)
  })

  ipcMain.handle('terminal:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    assertId(id)
    assertSize(cols)
    assertSize(rows)
    terminals.resize(id, cols, rows)
  })

  ipcMain.handle('terminal:kill', (_e, id: unknown) => {
    assertId(id)
    terminals.kill(id)
  })

  ipcMain.handle('terminal:remove', (_e, id: unknown) => {
    assertId(id)
    terminals.remove(id)
  })

  ipcMain.handle('terminal:snapshot', (_e, id: unknown) => {
    assertId(id)
    return terminals.snapshot(id)
  })

  ipcMain.handle('terminal:runSetup', async (_e, cwd: unknown) => {
    assertPath(cwd)
    const { setup } = await trustedConfig(store, cwd)
    if (setup.length === 0) return null
    for (const old of terminals.list(cwd).filter((t) => t.kind === 'setup')) {
      await stop(terminals, old.id)
      terminals.remove(old.id)
    }
    const id = terminals.create(cwd, { command: setup.map((c) => `(${c})`).join(' && '), label: 'setup', kind: 'setup' })
    return terminals.get(id) as TerminalInfo
  })

  ipcMain.handle('terminal:runServices', (_e, cwd: unknown, name: unknown) => {
    assertPath(cwd)
    if (name !== undefined) assertId(name)
    return runServices(store, terminals, cwd, name)
  })
}
