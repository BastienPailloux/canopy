import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig, RepoTrust } from '../shared/api'
import { RepoNotTrustedError } from '../shared/errors'
import type { AppStore } from './appStore'
import { listWorktrees, mainWorktreeRoot } from './git/worktrees'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const SETTINGS = join('.claude', 'settings.json')
const LOCAL_SETTINGS = join('.claude', 'settings.local.json')
const MCP = '.mcp.json'
/** What a clone can bring. `settings.local.json` is left out: Canopy writes it, and it is not cloned. */
const HASHED_FILES = [SETTINGS, MCP]

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT'

/** The parsed object, empty if the file is missing. `unknown` when the file exists but says nothing readable. */
async function readJson(file: string): Promise<{ data: Record<string, unknown>; unknown: boolean }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isRecord(parsed) ? { data: parsed, unknown: false } : { data: {}, unknown: true }
  } catch (err) {
    return { data: {}, unknown: !isMissing(err) }
  }
}

/** One line per hook: its event, then what it runs. */
function hookLines(settings: Record<string, unknown>): string[] {
  if (!isRecord(settings.hooks)) return []
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    asArray(groups).flatMap((group) => asArray(isRecord(group) ? group.hooks : undefined).flatMap((hook) => {
      const target = isRecord(hook) ? hook.command ?? hook.url ?? hook.prompt : undefined
      return typeof target === 'string' ? [`${event}: ${target}`] : []
    }))
  )
}

function allowRules(settings: Record<string, unknown>): string[] {
  const rules = isRecord(settings.permissions) ? asArray(settings.permissions.allow) : []
  return rules.filter((r): r is string => typeof r === 'string')
}

const stringOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : [])
const unique = (...lists: string[][]): string[] => [...new Set(lists.flat())]

/** A server and what it runs or reaches. */
function mcpLine(name: string, server: unknown): string {
  if (!isRecord(server)) return name
  const args = asArray(server.args).filter((a): a is string => typeof a === 'string')
  const target = [...stringOf(server.command), ...args, ...stringOf(server.url)].join(' ')
  return target === '' ? name : `${name}: ${target}`
}

/** What the config files at `dir` would run or allow. Missing files count as empty, unreadable ones are flagged. */
export async function readRepoConfig(dir: string): Promise<RepoConfig> {
  const files = [SETTINGS, LOCAL_SETTINGS, MCP]
  const reads = await Promise.all(files.map((f) => readJson(join(dir, f))))
  const [shared, local, mcp] = reads
  const fromSettings = (read: (settings: Record<string, unknown>) => string[]): string[] => unique(read(shared.data), read(local.data))
  const servers = mcp.data.mcpServers
  return {
    hooks: fromSettings(hookLines),
    mcpServers: isRecord(servers) ? Object.entries(servers).map(([name, server]) => mcpLine(name, server)) : [],
    allowRules: fromSettings(allowRules),
    apiKeyHelper: fromSettings((s) => stringOf(s.apiKeyHelper)),
    statusLine: fromSettings((s) => (isRecord(s.statusLine) ? stringOf(s.statusLine.command) : [])),
    env: fromSettings((s) => (isRecord(s.env) ? Object.keys(s.env) : [])),
    settingsKeys: fromSettings((s) => Object.keys(s)),
    unknownFiles: files.filter((_, i) => reads[i].unknown)
  }
}

/** Identifies the config a session in `dir` would load. Missing and unreadable files hash differently from any content. */
export async function configHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of HASHED_FILES) {
    const content = await readFile(join(dir, file)).catch((err: unknown) => (isMissing(err) ? null : undefined))
    const state = content === null ? 'missing' : content === undefined ? 'unreadable' : `bytes:${content.length}`
    hash.update(`${file}\0${state}\0`)
    if (content) hash.update(content)
  }
  return hash.digest('hex')
}

/**
 * `cwd`'s own `.git` picks the root it reports, so a directory could claim any repo.
 * Only the repo's list, read from its root, says what belongs to it.
 */
async function isWorktreeOf(root: string, cwd: string): Promise<boolean> {
  const real = await realpath(cwd)
  const paths = await Promise.all((await listWorktrees(root)).map((w) => realpath(w.path).catch(() => w.path)))
  return paths.includes(real)
}

export async function repoTrust(store: AppStore, cwd: string): Promise<RepoTrust> {
  const root = await mainWorktreeRoot(cwd)
  const hash = await configHash(cwd)
  const trusted = store.isConfigApproved(root, hash) && await isWorktreeOf(root, cwd)
  return { trusted, configHash: hash, ...(await readRepoConfig(cwd)) }
}

/** Approves the config that was shown, whatever `cwd` holds by now: `start` checks that again. */
export async function approveConfig(store: AppStore, cwd: string, hash: string): Promise<void> {
  store.approveConfig(await mainWorktreeRoot(cwd), hash)
}

/** The main worktree root of `cwd`. Throws `RepoNotTrustedError` unless the config at `cwd` was approved for that repo. */
export async function requireTrustedRoot(store: AppStore, cwd: string): Promise<string> {
  const root = await mainWorktreeRoot(cwd)
  if (!store.isConfigApproved(root, await configHash(cwd)) || !(await isWorktreeOf(root, cwd))) throw new RepoNotTrustedError()
  return root
}
