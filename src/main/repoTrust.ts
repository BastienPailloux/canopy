import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig } from '../shared/api'

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

/** What the config files at `root` would run or allow. Missing or invalid files count as empty. */
export async function readRepoConfig(root: string): Promise<RepoConfig> {
  const [shared, local, mcp] = await Promise.all([
    readJson(join(root, '.claude', 'settings.json')),
    readJson(join(root, '.claude', 'settings.local.json')),
    readJson(join(root, '.mcp.json'))
  ])
  return {
    hooks: [...new Set([...hookLines(shared), ...hookLines(local)])],
    mcpServers: isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : [],
    allowRules: [...new Set([...allowRules(shared), ...allowRules(local)])]
  }
}
