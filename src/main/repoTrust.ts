import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig, RepoTrust } from '../shared/api'
import { RepoNotTrustedError } from '../shared/errors'
import type { AppStore } from './appStore'
import { mainWorktreeRoot } from './git/worktrees'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The parsed object, or an empty one if the file is missing or invalid. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
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

/** What the config files at `root` would run or allow. Missing or invalid files count as empty. */
export async function readRepoConfig(root: string): Promise<RepoConfig> {
  const [shared, local, mcp] = await Promise.all([
    readJson(join(root, '.claude', 'settings.json')),
    readJson(join(root, '.claude', 'settings.local.json')),
    readJson(join(root, '.mcp.json'))
  ])
  const fromSettings = (read: (settings: Record<string, unknown>) => string[]): string[] => unique(read(shared), read(local))
  return {
    hooks: fromSettings(hookLines),
    mcpServers: isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : [],
    allowRules: fromSettings(allowRules),
    apiKeyHelper: fromSettings((s) => stringOf(s.apiKeyHelper)),
    statusLine: fromSettings((s) => (isRecord(s.statusLine) ? stringOf(s.statusLine.command) : [])),
    env: fromSettings((s) => (isRecord(s.env) ? Object.keys(s.env) : []))
  }
}

export async function repoTrust(store: AppStore, repo: string): Promise<RepoTrust> {
  const root = await mainWorktreeRoot(repo)
  return { trusted: store.isRepoTrusted(root), ...(await readRepoConfig(root)) }
}

/** The main worktree root of `cwd`. Throws `RepoNotTrustedError` if that repo is not trusted. */
export async function requireTrustedRoot(store: AppStore, cwd: string): Promise<string> {
  const root = await mainWorktreeRoot(cwd)
  if (!store.isRepoTrusted(root)) throw new RepoNotTrustedError()
  return root
}
