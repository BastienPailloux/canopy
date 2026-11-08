import { randomBytes } from 'node:crypto'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AppStore, LinearAuthState } from '../appStore'

type AuthStore = Pick<AppStore, 'linearAuth' | 'saveLinearAuth'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * OAuth state of the Linear MCP connection, kept encrypted in the app store. Opens the browser through `openExternal`,
 * and only while `interactive`. Outside an interactive connect, credentials the SDK wants to drop are kept and the state
 * is marked `expired` instead, so a restart still reads « expirée » and not « déconnectée ».
 */
export class LinearAuthProvider implements OAuthClientProvider {
  private flow: string | undefined

  constructor(
    private readonly store: AuthStore,
    private readonly redirect: string,
    private readonly openExternal: (url: string) => void,
    public interactive = true,
  ) {}

  get redirectUrl(): string { return this.redirect }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Canopy',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write',
    }
  }

  /** The `state` of the authorization in progress (memory only), for the callback to check. */
  get expectedState(): string | undefined { return this.flow }

  state(): string {
    this.flow = randomBytes(16).toString('base64url')
    return this.flow
  }

  private stored(): LinearAuthState { return this.store.linearAuth() ?? {} }

  private update(patch: Partial<Record<keyof LinearAuthState, unknown>>): void {
    const next: Record<string, unknown> = { ...this.stored(), ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    this.store.saveLinearAuth(Object.keys(next).length > 0 ? (next as LinearAuthState) : null)
  }

  private markExpired(): void {
    if (this.stored().expired !== true) this.update({ expired: true })
  }

  /** A client registered for another redirect URL (another port) is dropped, with the tokens issued to it: the SDK registers again. */
  clientInformation(): OAuthClientInformationMixed | undefined {
    const c = this.stored().client
    if (!isRecord(c) || typeof c.client_id !== 'string') return undefined
    if (Array.isArray(c.redirect_uris) && !c.redirect_uris.includes(this.redirect)) {
      this.update({ client: undefined, tokens: undefined })
      return undefined
    }
    return c as unknown as OAuthClientInformationMixed
  }

  saveClientInformation(info: OAuthClientInformationMixed): void { this.update({ client: info }) }

  /** Expired tokens are not offered: the SDK then asks for a new authorization instead of retrying a refused refresh. */
  tokens(): OAuthTokens | undefined {
    const s = this.stored()
    if (s.expired === true) return undefined
    return isRecord(s.tokens) && typeof s.tokens.access_token === 'string' ? (s.tokens as unknown as OAuthTokens) : undefined
  }

  saveTokens(tokens: OAuthTokens): void { this.update({ tokens, expired: undefined }) }

  /** Outside an interactive connect, needing the browser means the connection expired. */
  redirectToAuthorization(url: URL): void {
    if (this.interactive) this.openExternal(url.href)
    else this.markExpired()
  }

  saveCodeVerifier(verifier: string): void { this.update({ verifier }) }

  codeVerifier(): string {
    const v = this.stored().verifier
    if (!v) throw new Error('Connexion Linear : vérificateur PKCE absent.')
    return v
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'discovery') return
    if (scope === 'verifier') { this.update({ verifier: undefined }); return }
    if (!this.interactive) { this.markExpired(); return }
    if (scope === 'all') this.store.saveLinearAuth(null)
    else if (scope === 'client') this.update({ client: undefined })
    else this.update({ tokens: undefined })
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family: -apple-system, sans-serif; text-align: center; padding-top: 4em">` +
  `<h2>${title}</h2><p>${body}</p></body></html>`

type ListenResult = 'ok' | 'busy' | 'unavailable'

function listenOn(server: Server, port: number, host: string): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (e.code === 'EADDRINUSE') resolve('busy')
      else if (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT') resolve('unavailable')
      else reject(new Error(`Connexion Linear : impossible d'attendre le retour du navigateur (${e.code ?? e.message}).`))
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve('ok')
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export interface CallbackWait {
  /** The redirect URL to register: `http://localhost:<port>/callback`. */
  url: string
  port: number
  /** Loopback addresses listened on: 127.0.0.1, and ::1 when the machine has it. */
  hosts: string[]
  code: Promise<string>
  close(): void
}

/**
 * Waits for the OAuth redirect on `http://localhost:<port>/callback`, on the loopback addresses only (127.0.0.1 and ::1:
 * `localhost` may be either), from `port` upward to the first port free on both. Only an answer carrying the `state` of
 * the authorization in progress ends the wait; anything else gets a 404.
 */
export async function waitForCallback(opts: {
  port: number
  state: () => string | undefined
  timeoutMs?: number
  tries?: number
}): Promise<CallbackWait> {
  const { port: start, state, timeoutMs = 300_000, tries = 20 } = opts
  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  code.catch(() => {}) // a rejection nobody awaits (connection authorized without the browser) is not unhandled
  const servers: Server[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let answered = false
  const close = (): void => {
    clearTimeout(timer)
    for (const s of servers) { s.closeAllConnections(); s.close() }
  }
  const fail = (e: Error): void => { answered = true; rejectCode(e); close() }

  const handler: RequestListener = (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const expected = state()
    const c = u.searchParams.get('code')
    const err = u.searchParams.get('error')
    if (answered || u.pathname !== '/callback' || !expected || u.searchParams.get('state') !== expected || (!c && !err)) {
      res.writeHead(404).end()
      return
    }
    answered = true
    res.writeHead(c ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
    const html = c
      ? page('Canopy est connecté à Linear', 'Tu peux fermer cet onglet et revenir dans Canopy.')
      : page('La connexion à Linear a échoué', `Linear a répondu : ${escapeHtml(err ?? '')}. Tu peux fermer cet onglet et réessayer depuis Canopy.`)
    res.end(html, () => {
      if (c) resolveCode(c)
      else rejectCode(new Error(`Linear a refusé la connexion : ${err}`))
      close()
    })
  }

  for (let port = start; port < start + tries; port++) {
    const v4 = createServer(handler)
    const r4 = await listenOn(v4, port, '127.0.0.1')
    if (r4 === 'busy') continue
    if (r4 === 'unavailable') throw new Error("Connexion Linear : l'adresse locale 127.0.0.1 n'est pas disponible.")
    const v6 = createServer(handler)
    let r6: ListenResult
    try { r6 = await listenOn(v6, port, '::1') } catch (e) { v4.close(); throw e }
    if (r6 === 'busy') { v4.close(); continue }
    servers.push(v4)
    if (r6 === 'ok') servers.push(v6) // no IPv6 loopback on this machine: IPv4 alone
    for (const s of servers) s.on('error', (e) => fail(e))
    timer = setTimeout(() => {
      fail(new Error(`Connexion Linear abandonnée : pas de réponse du navigateur après ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
    const hosts = servers.map((s) => (s.address() as AddressInfo).address)
    return { url: `http://localhost:${port}/callback`, port, hosts, code, close }
  }
  throw new Error(`Connexion Linear : aucun port libre entre ${start} et ${start + tries - 1}.`)
}
