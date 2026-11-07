import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CancellationTokenSource, ConfigurationRequest, createProtocolConnection, DefinitionRequest, DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, InitializedNotification, InitializeRequest, ReferencesRequest,
  StreamMessageReader, StreamMessageWriter, WorkspaceSymbolRequest,
  type CancellationToken, type ProtocolConnection, type Range
} from 'vscode-languageserver-protocol/node'
import { DEFAULT_SEARCH_LIMIT, type Location, type SymbolLocation } from '../../shared/types'
import { currentEnv } from '../env'
import { listTree, readFileSafe } from './files'
import { searchText } from './search'

const IDLE_MS = 10 * 60_000
/** A first answer waits for the project to load. Past this, text search answers instead. */
const REQUEST_TIMEOUT_MS = 60_000
const MAX_SYMBOLS = 50
const MAX_TEXT = 500

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact'
}
const languageOf = (path: string): string | undefined => LANGUAGES[extname(path).toLowerCase()]

/** In a packaged app a process cannot run from inside the archive: its files live next to it. */
export const unpackedPath = (p: string): string => p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
const bundled = (module: string): string => unpackedPath(createRequire(__filename).resolve(module))

const silent = { error: (): void => undefined, warn: (): void => undefined, info: (): void => undefined, log: (): void => undefined }

function abortError(): Error {
  const e = new Error('Recherche annulée')
  e.name = 'AbortError'
  return e
}

export interface LspPoolOptions {
  /** Default: the login shell's. */
  env?: () => Promise<NodeJS.ProcessEnv>
  /** Entry point of the language server. Default: the bundled one. */
  server?: string
  /** Default: the bundled one. */
  tsserver?: string
  requestTimeoutMs?: number
}

interface Server {
  cwd: string
  /** `cwd` and where it really is: the server may answer with either. */
  roots: string[]
  child?: ChildProcess
  connection?: ProtocolConnection
  ready: Promise<ProtocolConnection>
  /** Rejects when the server stops, for the calls waiting on it. */
  gone: Promise<never>
  fail: (e: Error) => void
  stopped: boolean
  /** Path of each document the server was given, with the version of the file it holds. */
  open: Map<string, { hash: string; version: number }>
  idle?: NodeJS.Timeout
}

async function readText(cwd: string, path: string): Promise<{ text: string; hash: string } | null> {
  try {
    const file = await readFileSafe(cwd, path)
    return file.kind === 'text' ? { text: file.content, hash: file.version } : null
  } catch {
    return null
  }
}

/** The word at a 1-based position, the position right after its end included. */
function wordAt(text: string, line: number, column: number): string | null {
  const content = text.split('\n')[line - 1] ?? ''
  for (const m of content.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (m.index <= column - 1 && column - 1 <= m.index + m[0].length) return m[0]
  }
  return null
}

async function textFallback(cwd: string, text: string, line: number, column: number): Promise<Location[]> {
  const word = wordAt(text, line, column)
  if (word === null) return []
  const hits = await searchText(cwd, `\\b${word}\\b`, { regex: true, caseSensitive: true })
  return hits.map((h) => ({ ...h, fallback: true }))
}

/** A file to open so that the server loads a project: nothing is indexed before that. */
async function seedOf(cwd: string): Promise<string | undefined> {
  const depth = (p: string): number => p.split('/').length + (p.startsWith('src/') ? 0 : 100)
  const files = await listTree(cwd).catch((): string[] => [])
  return files.filter((f) => languageOf(f) !== undefined).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0]
}

function toLocation(server: Server, uri: string, range: Range): Location | null {
  if (!uri.startsWith('file:')) return null
  const file = fileURLToPath(uri)
  const root = server.roots.find((r) => file.startsWith(r + sep))
  const at = { line: range.start.line + 1, column: range.start.character + 1 }
  return root ? { path: relative(root, file), ...at } : { path: file, ...at, external: true }
}

/** In reading order, the external ones last, each with its line of text. */
async function presented(cwd: string, locations: Location[]): Promise<Location[]> {
  const order = (l: Location): string => `${l.external ? 1 : 0}${l.path}`
  const sorted = locations
    .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : a.line - b.line || a.column - b.column))
    .slice(0, DEFAULT_SEARCH_LIMIT)
  const lines = new Map<string, string[]>()
  for (const l of sorted) {
    if (l.external) continue
    if (!lines.has(l.path)) lines.set(l.path, (await readText(cwd, l.path))?.text.split('\n') ?? [])
    const text = lines.get(l.path)?.[l.line - 1]
    if (text !== undefined) l.text = text.replace(/\r$/, '').slice(0, MAX_TEXT)
  }
  return sorted
}

/**
 * One TypeScript language server per worktree: started by the first call, stopped after 10 minutes without one.
 * Line and column are 1-based here, as in the editor; 0-based on the wire.
 *
 * A repository is untrusted: the server runs Canopy's own tsserver, loads no plugin of the repository and
 * acquires no typings. Its tsconfig and node_modules are only read as data.
 */
export class LspPool {
  private readonly servers = new Map<string, Server>()

  constructor(private readonly options: LspPoolOptions = {}) {}

  /** Where the symbol at this position is defined. Text hits of the word for another language, or if the server fails. */
  definition(cwd: string, path: string, line: number, col: number): Promise<Location[]> {
    return this.navigate(cwd, path, line, col, async (connection, textDocument, position, token) => {
      const found = await connection.sendRequest(DefinitionRequest.type, { textDocument, position }, token)
      const list = found === null ? [] : Array.isArray(found) ? found : [found]
      return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l))
    })
  }

  /** The uses of the symbol at this position, without its declaration. Text hits as for `definition`. */
  references(cwd: string, path: string, line: number, col: number): Promise<Location[]> {
    return this.navigate(cwd, path, line, col, async (connection, textDocument, position, token) =>
      (await connection.sendRequest(ReferencesRequest.type, { textDocument, position, context: { includeDeclaration: false } }, token)) ?? [])
  }

  /**
   * Symbols of the projects the server loaded, in the worktree and outside node_modules.
   * Rejects if the server fails: the text search is already next to it. Starts nothing without a TS or JS file.
   */
  async symbols(cwd: string, q: string, signal?: AbortSignal): Promise<SymbolLocation[]> {
    const seed = this.servers.get(cwd)?.open.size ? undefined : await seedOf(cwd)
    if (seed === undefined && !this.servers.has(cwd)) return []
    const server = this.server(cwd)
    this.touch(server)
    try {
      const connection = await this.ask(server, () => server.ready, signal)
      if (seed !== undefined) await this.sync(server, connection, seed)
      const found = await this.ask(server, (token) => connection.sendRequest(WorkspaceSymbolRequest.type, { query: q }, token), signal)
      const symbols: SymbolLocation[] = []
      for (const s of found ?? []) {
        const l = 'range' in s.location ? toLocation(server, s.location.uri, s.location.range) : null
        if (l && !l.external && !l.path.split(sep).includes('node_modules')) symbols.push({ ...l, name: s.name })
      }
      return symbols.slice(0, MAX_SYMBOLS)
    } finally {
      this.touch(server)
    }
  }

  /** Stops the server of `cwd`, if any. */
  release(cwd: string): void {
    const server = this.servers.get(cwd)
    if (server) this.stop(server)
  }

  disposeAll(): void {
    for (const server of [...this.servers.values()]) this.stop(server)
  }

  private async navigate(
    cwd: string, path: string, line: number, col: number,
    request: (
      c: ProtocolConnection, doc: { uri: string }, position: { line: number; character: number }, token: CancellationToken
    ) => Promise<{ uri: string; range: Range }[]>
  ): Promise<Location[]> {
    const file = await readText(cwd, path)
    if (file === null) return []
    if (languageOf(path) === undefined) return textFallback(cwd, file.text, line, col)

    const server = this.server(cwd)
    this.touch(server)
    try {
      const connection = await this.ask(server, () => server.ready)
      const uri = await this.sync(server, connection, path)
      const position = { line: line - 1, character: col - 1 }
      const found = await this.ask(server, (token) => request(connection, { uri }, position, token))
      return await presented(cwd, found.flatMap((l) => toLocation(server, l.uri, l.range) ?? []))
    } catch {
      return textFallback(cwd, file.text, line, col)
    } finally {
      this.touch(server)
    }
  }

  private server(cwd: string): Server {
    const running = this.servers.get(cwd)
    if (running) return running
    let fail: (e: Error) => void = () => undefined
    const gone = new Promise<never>((_resolve, reject) => { fail = reject })
    gone.catch(() => undefined)
    const server: Server = { cwd, roots: [cwd], ready: Promise.resolve().then(() => this.start(server)), gone, fail, stopped: false, open: new Map() }
    this.servers.set(cwd, server)
    server.ready.catch(() => this.stop(server))
    return server
  }

  private async start(server: Server): Promise<ProtocolConnection> {
    const tsserver = this.options.tsserver ?? bundled('tsserver-runtime/lib/tsserver.js')
    // Without this one, the language server would look for a tsserver in the repository and run it.
    if (!existsSync(tsserver)) throw new Error(`tsserver introuvable : ${tsserver}`)
    const entry = this.options.server ?? bundled('typescript-language-server/lib/cli.mjs')
    const [env, real] = await Promise.all([(this.options.env ?? (() => Promise.resolve(currentEnv())))(), realpath(server.cwd)])
    if (server.stopped) throw new Error('Serveur de langage arrêté')
    server.roots = [...new Set([server.cwd, real])]

    const { NODE_OPTIONS: _ignored, ...childEnv } = env
    // Its own process group: tsserver, forked by the language server, must stop with it.
    const child = spawn(process.execPath, [entry, '--stdio'], {
      cwd: server.cwd,
      detached: true,
      env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    server.child = child
    child.on('error', () => this.stop(server))
    child.on('exit', () => this.stop(server))
    child.stdin?.on('error', () => undefined)
    if (!child.stdout || !child.stdin) throw new Error('Serveur de langage sans flux')

    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin), silent)
    server.connection = connection
    connection.onRequest(ConfigurationRequest.type, (p) => p.items.map(() => null))
    connection.listen()
    const rootUri = pathToFileURL(server.cwd).href
    await this.ask(server, (token) => connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
      capabilities: {},
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        hostInfo: 'canopy',
        tsserver: { path: tsserver, logVerbosity: 'off', useSyntaxServer: 'never' }
      }
    }, token))
    await connection.sendNotification(InitializedNotification.type, {})
    return connection
  }

  /** Stops the wait, and tells the server so, at the first of: an answer, the timeout, `signal`, the end of the server. */
  private async ask<T>(server: Server, send: (token: CancellationToken) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const cancel = new CancellationTokenSource()
    let timer: NodeJS.Timeout | undefined
    let onAbort = (): void => undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Serveur de langage sans réponse')), this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      onAbort = () => reject(abortError())
      if (signal?.aborted) onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([send(cancel.token), interrupted, server.gone])
    } catch (e) {
      cancel.cancel()
      throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      cancel.dispose()
    }
  }

  /**
   * Gives the server the disk's content of `path` and of the documents it holds, and returns the URI of `path`.
   * An open document is no longer read from disk by tsserver: Claude may have changed it since.
   */
  private async sync(server: Server, connection: ProtocolConnection, path: string): Promise<string> {
    const uriOf = (p: string): string => pathToFileURL(join(server.cwd, p)).href
    for (const p of new Set([...server.open.keys(), path])) {
      const uri = uriOf(p)
      const file = await readText(server.cwd, p)
      const doc = server.open.get(p)
      if (file === null) {
        server.open.delete(p)
        if (doc) await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } })
      } else if (!doc) {
        server.open.set(p, { hash: file.hash, version: 1 })
        await connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri, languageId: languageOf(p) ?? 'plaintext', version: 1, text: file.text }
        })
      } else if (doc.hash !== file.hash) {
        doc.hash = file.hash
        doc.version++
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: doc.version }, contentChanges: [{ text: file.text }]
        })
      }
    }
    return uriOf(path)
  }

  private touch(server: Server): void {
    clearTimeout(server.idle)
    if (server.stopped) return
    server.idle = setTimeout(() => this.stop(server), IDLE_MS)
    server.idle.unref?.()
  }

  private stop(server: Server): void {
    if (server.stopped) return
    server.stopped = true
    clearTimeout(server.idle)
    if (this.servers.get(server.cwd) === server) this.servers.delete(server.cwd)
    server.fail(new Error('Serveur de langage arrêté'))
    server.connection?.dispose()
    const pid = server.child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
