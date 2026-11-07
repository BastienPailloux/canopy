import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { AppStore } from '../appStore'

export interface CanopyService { name: string; command: string }
/** What `.canopy/config.json` declares: commands to run once, then long-running services. */
export interface CanopyConfig { setup: string[]; services: CanopyService[] }

export const CONFIG_FILE = join('.canopy', 'config.json')
const FIRST_PORT = 4100
/** A service name ends up in `PORT_<NAME>`. */
const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const invalid = (why: string): Error => new Error(`.canopy/config.json invalide : ${why}`)

/** Reads the shape of the file. Throws a readable error for anything else. */
export function parseConfig(raw: string): CanopyConfig {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw invalid(`JSON illisible (${(err as Error).message})`)
  }
  if (!isRecord(data)) throw invalid('un objet est attendu')
  const { setup = [], services = [] } = data
  if (!Array.isArray(setup) || !setup.every((c) => typeof c === 'string' && c.trim() !== '')) {
    throw invalid('"setup" doit être une liste de commandes')
  }
  if (!Array.isArray(services)) throw invalid('"services" doit être une liste')
  const seen = new Set<string>()
  const parsed = services.map((s): CanopyService => {
    if (!isRecord(s) || typeof s.name !== 'string' || typeof s.command !== 'string' || s.command.trim() === '') {
      throw invalid('chaque service a un "name" et une "command"')
    }
    if (!SERVICE_NAME.test(s.name)) throw invalid(`nom de service "${s.name}" : lettres, chiffres, - et _ seulement`)
    if (seen.has(s.name)) throw invalid(`le service "${s.name}" est déclaré deux fois`)
    seen.add(s.name)
    return { name: s.name, command: s.command }
  })
  return { setup: [...setup] as string[], services: parsed }
}

/** The config of the worktree at `cwd`. Absent file: nothing declared. */
export async function readConfig(cwd: string): Promise<CanopyConfig> {
  let raw: string
  try {
    raw = await readFile(join(cwd, CONFIG_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { setup: [], services: [] }
    throw invalid((err as Error).message)
  }
  return parseConfig(raw)
}

/** Free if nothing answers on 127.0.0.1: binds and closes. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

let allocating: Promise<unknown> = Promise.resolve()

async function allocate(store: AppStore, worktree: string, services: readonly string[]): Promise<Record<string, number>> {
  const mine = store.ports[worktree] ?? {}
  const taken = new Set(Object.entries(store.ports).flatMap(([wt, ports]) => (wt === worktree ? [] : Object.values(ports))))
  const result: Record<string, number> = {}
  let next = FIRST_PORT
  for (const name of services) {
    if (mine[name] !== undefined) {
      result[name] = mine[name]
      continue
    }
    const used = new Set([...taken, ...Object.values(mine), ...Object.values(result)])
    while (used.has(next) || !(await isFree(next))) next++
    result[name] = next++
  }
  const same = Object.keys(result).length === Object.keys(mine).length && Object.entries(result).every(([n, p]) => mine[n] === p)
  if (!same) store.setPorts(worktree, result)
  return result
}

/**
 * One port per service, from 4100, kept for the worktree between calls.
 * Skips ports reserved for another worktree or in use. Calls are serialized so that two never pick the same port.
 */
export function allocatePorts(store: AppStore, worktreePath: string, services: readonly string[]): Promise<Record<string, number>> {
  const run = allocating.then(() => allocate(store, worktreePath, services))
  allocating = run.catch(() => undefined)
  return run
}
