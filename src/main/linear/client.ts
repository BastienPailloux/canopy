import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LinearComment, LinearConnection, LinearIssue, LinearIssueDetail, LinearStatus, LinearUser } from '../../shared/linear'
import type { AppStore } from '../appStore'
import { LinearAuthProvider, waitForCallback } from './auth'
import {
  ISSUE_FIELDS, LinearError, LinearFormatError, parseComments, parseIssue, parseIssueList, parseLabels, parseStatuses, parseUsers,
  parseWhoami, toolJson, type CallToolResult,
} from './parse'

export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp'

/** First port tried for the OAuth callback. */
export const CALLBACK_PORT = 33418

export const REQUIRED_TOOLS = [
  'whoami', 'list_issues', 'get_issue', 'save_issue', 'list_comments', 'save_comment', 'list_issue_statuses', 'list_issue_labels', 'list_users',
]

/** Parameters Canopy relies on, reported as `tool.param` in `missingTools` when a tool lost them. */
export const REQUIRED_PARAMS: [tool: string, param: string][] = [
  ['save_issue', 'patch'], ['save_issue', 'id'], ['list_issues', 'assignee'], ['list_issues', 'cursor'],
]

/** The parameters `inputSchema` declares; null when it declares none readable. */
function paramsOf(schema: unknown): Set<string> | null {
  if (!isRecord(schema) || !isRecord(schema.properties)) return null
  return new Set(Object.keys(schema.properties))
}

/** What `LinearClient` needs of an MCP client. */
export interface McpCaller {
  listTools(): Promise<{ name: string; inputSchema: unknown }[]>
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export type { LinearConnection } from '../../shared/linear'

/** Linear refused the stored tokens, refresh included: Bastien must connect again. */
export class LinearExpiredError extends Error {
  constructor() {
    super('La connexion à Linear a expiré : reconnecte Linear.')
    this.name = 'LinearExpiredError'
  }
}

/** No Linear connection (never connected, or disconnected). */
export class LinearNotConnectedError extends Error {
  constructor() {
    super("Linear n'est pas connecté.")
    this.name = 'LinearNotConnectedError'
  }
}

/** Tokens are stored but Linear could not be reached when resuming: nothing was sent. */
export class LinearOfflineError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'LinearOfflineError'
  }
}

const offlineReason = (e: unknown): string => `Linear injoignable : ${e instanceof Error ? e.message : String(e)}`

/** The SDK's own error, or the transport's 401 after a refresh that did not help. */
const isUnauthorized = (e: unknown): boolean =>
  e instanceof UnauthorizedError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 401)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const PAGE = 50

/** Connection to the official Linear MCP server, and the calls Canopy makes. */
export class LinearClient {
  private caller: McpCaller | null = null
  private conn: LinearConnection = { state: 'disconnected', missingTools: [] }
  /** Bumped by every connect, resume and disconnect: a slower, older one never overwrites a newer result. */
  private generation = 0

  constructor(
    private readonly open: (interactive: boolean) => Promise<McpCaller>,
    private readonly store: Pick<AppStore, 'saveLinearAuth'>,
  ) {}

  connection(): LinearConnection {
    return { ...this.conn, missingTools: [...this.conn.missingTools] }
  }

  /** Interactive: may open the browser for the OAuth consent. */
  connect(): Promise<LinearConnection> {
    return this.start(true, ++this.generation)
  }

  /**
   * Stored tokens only: never opens the browser. No tokens = disconnected, refused tokens = expired, Linear unreachable
   * (or any other failure) = offline with the reason: the tokens stay, a later resume tries them again. Never throws.
   */
  async resume(): Promise<LinearConnection> {
    const gen = ++this.generation
    try {
      return await this.start(false, gen)
    } catch (e) {
      if (gen !== this.generation) return this.connection()
      if (e instanceof LinearNotConnectedError) {
        await this.drop()
        this.conn = { state: 'disconnected', missingTools: [] }
        return this.connection()
      }
      if (isUnauthorized(e) || e instanceof LinearExpiredError) {
        await this.drop()
        this.conn = { state: 'expired', missingTools: [] }
        return this.connection()
      }
      await this.drop()
      this.conn = { state: 'offline', error: offlineReason(e), missingTools: [] }
      return this.connection()
    }
  }

  async disconnect(): Promise<void> {
    this.generation++
    await this.drop()
    this.conn = { state: 'disconnected', missingTools: [] }
    this.store.saveLinearAuth(null)
  }

  private async start(interactive: boolean, gen: number): Promise<LinearConnection> {
    const caller = await this.open(interactive)
    if (gen !== this.generation) {
      await caller.close().catch(() => {})
      return this.connection()
    }
    await this.drop()
    this.caller = caller
    const tools = await this.guard(caller, () => caller.listTools())
    const names = new Set(tools.map((t) => t.name))
    const missingTools = REQUIRED_TOOLS.filter((t) => !names.has(t))
    const schemas = new Map(tools.map((t) => [t.name, paramsOf(t.inputSchema)]))
    for (const [tool, param] of REQUIRED_PARAMS) {
      if (names.has(tool) && !schemas.get(tool)?.has(param)) missingTools.push(`${tool}.${param}`)
    }
    const me = names.has('whoami') ? parseWhoami(await this.call('whoami', {})) : undefined
    // A newer connect, resume or disconnect took over (and closed this caller) meanwhile.
    if (gen !== this.generation) return this.connection()
    this.conn = { state: 'connected', ...(me ? { workspace: me.workspace, email: me.email, userId: me.userId } : {}), missingTools }
    return this.connection()
  }

  private async drop(): Promise<void> {
    const c = this.caller
    this.caller = null
    await c?.close().catch(() => {})
  }

  /** Runs `f` on `caller`; an auth failure expires the connection (if `caller` is still the current one). */
  private async guard<T>(caller: McpCaller, f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } catch (e) {
      if (!isUnauthorized(e)) throw e
      if (this.caller === caller) {
        await this.drop()
        this.conn = { state: 'expired', missingTools: [] }
      }
      throw new LinearExpiredError()
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const caller = this.caller
    if (!caller) {
      if (this.conn.state === 'expired') throw new LinearExpiredError()
      if (this.conn.state === 'offline') throw new LinearOfflineError(this.conn.error ?? offlineReason('?'))
      throw new LinearNotConnectedError()
    }
    const r = await this.guard(caller, () => caller.callTool(tool, args))
    try {
      return toolJson(tool, r)
    } catch (e) {
      // Only `get_issue` errors say reliably that the issue does not exist.
      if (e instanceof LinearError && e.notFound && tool !== 'get_issue') throw new LinearError(e.message, false)
      throw e
    }
  }

  /** Every page of a paginated list (`hasNextPage` + `cursor`). */
  private async all<T>(tool: string, args: Record<string, unknown>, parse: (v: unknown) => T[]): Promise<T[]> {
    const out: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const v = await this.call(tool, cursor === undefined ? args : { ...args, cursor })
      out.push(...parse(v))
      if (!isRecord(v) || v.hasNextPage !== true) return out
      if (typeof v.cursor !== 'string' || seen.has(v.cursor)) throw new LinearFormatError(tool, 'cursor')
      seen.add(v.cursor)
      cursor = v.cursor
    }
  }

  /** Issues assigned to Bastien, every page. */
  listMine(): Promise<LinearIssue[]> {
    return this.all('list_issues', { assignee: 'me', limit: PAGE }, (v) => parseIssueList(v).issues)
  }

  issueBrief(id: string): Promise<LinearIssue> {
    return this.call('get_issue', { id, fields: ISSUE_FIELDS }).then(parseIssue)
  }

  /** The issue with all its sub-issues and comments. */
  async issue(id: string): Promise<LinearIssueDetail> {
    const issue = await this.issueBrief(id)
    const [children, comments] = await Promise.all([
      this.all('list_issues', { parentId: issue.id, limit: PAGE }, (v) =>
        parseIssueList(v).issues.map(({ id: childId, title, status }) => ({ id: childId, title, status }))),
      this.all('list_comments', { issueId: issue.id }, parseComments),
    ])
    return { ...issue, children, comments }
  }

  async teamOptions(teamId: string): Promise<{ statuses: LinearStatus[]; labels: string[]; users: LinearUser[] }> {
    const [statuses, labels, users] = await Promise.all([
      this.call('list_issue_statuses', { team: teamId }).then(parseStatuses),
      this.all('list_issue_labels', { team: teamId }, parseLabels),
      this.all('list_users', { team: teamId }, parseUsers),
    ])
    return { statuses, labels, users }
  }

  /** `save_issue` on `id`; the answer is the saved issue (its fields as Linear normalised them). */
  save(id: string, args: Record<string, unknown>): Promise<LinearIssue> {
    return this.call('save_issue', { ...args, id }).then(parseIssue)
  }

  async comment(id: string, body: string): Promise<LinearComment> {
    const v = await this.call('save_comment', { issueId: id, body })
    const c = isRecord(v) && isRecord(v.comment) ? v.comment : v
    const [parsed] = parseComments({ comments: [c] })
    return parsed
  }
}

/** Redirect port of the stored client registration, to refresh with the same client. */
function registeredPort(client: unknown): number | undefined {
  if (!isRecord(client) || !Array.isArray(client.redirect_uris)) return undefined
  const uri = client.redirect_uris[0]
  if (typeof uri !== 'string') return undefined
  try {
    const port = Number(new URL(uri).port)
    return port > 0 ? port : undefined
  } catch { return undefined }
}

const toCaller = (client: Client): McpCaller => ({
  async listTools() {
    const tools: { name: string; inputSchema: unknown }[] = []
    let cursor: string | undefined
    do {
      const r = await client.listTools(cursor === undefined ? undefined : { cursor })
      tools.push(...r.tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })))
      cursor = r.nextCursor
    } while (cursor)
    return tools
  },
  async callTool(name, args) {
    return (await client.callTool({ name, arguments: args })) as CallToolResult
  },
  close: () => client.close(),
})

/**
 * The real `open` of `LinearClient`: an MCP client on `LINEAR_MCP_URL`, authenticated with the stored OAuth state.
 * Interactive: on `UnauthorizedError`, waits for the browser callback, finishes the auth and reconnects with a fresh
 * transport. The browser can only open during that interactive connect, never later from a refresh in the background:
 * a refused refresh then marks the stored state `expired` (see `LinearAuthProvider`), which `resume()` reports.
 */
export function linearOpener(deps: {
  store: Pick<AppStore, 'linearAuth' | 'saveLinearAuth'>
  openExternal: (url: string) => void
  version: string
}): (interactive: boolean) => Promise<McpCaller> {
  return async (interactive) => {
    const stored = deps.store.linearAuth()
    if (!interactive && !isRecord(stored?.tokens)) throw new LinearNotConnectedError()
    if (!interactive && stored?.expired === true) throw new LinearExpiredError()
    let provider: LinearAuthProvider | undefined
    const callback = interactive ? await waitForCallback({ port: CALLBACK_PORT, state: () => provider?.expectedState }) : null
    const port = callback?.port ?? registeredPort(stored?.client) ?? CALLBACK_PORT
    const auth = new LinearAuthProvider(deps.store, `http://localhost:${port}/callback`, deps.openExternal, interactive)
    provider = auth
    const fresh = () => ({
      transport: new StreamableHTTPClientTransport(new URL(LINEAR_MCP_URL), { authProvider: auth }),
      client: new Client({ name: 'canopy', version: deps.version }),
    })
    try {
      let c = fresh()
      try {
        await c.client.connect(c.transport)
      } catch (e) {
        if (!(e instanceof UnauthorizedError) || !callback) throw e
        const code = await callback.code
        await c.transport.finishAuth(code)
        await c.client.close().catch(() => {})
        c = fresh()
        await c.client.connect(c.transport)
      }
      return toCaller(c.client)
    } finally {
      auth.interactive = false // a later refresh in the background never opens the browser
      callback?.close()
    }
  }
}
