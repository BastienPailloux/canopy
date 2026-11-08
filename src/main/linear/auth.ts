import { createServer, type Server } from 'node:http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AppStore, LinearAuthState } from '../appStore'

type AuthStore = Pick<AppStore, 'linearAuth' | 'saveLinearAuth'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** OAuth state of the Linear MCP connection, kept encrypted in the app store. Opens the browser only through `openExternal`. */
export class LinearAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly store: AuthStore,
    private readonly redirect: string,
    private readonly openExternal: (url: string) => void,
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

  private stored(): LinearAuthState { return this.store.linearAuth() ?? {} }

  private update(patch: Partial<Record<keyof LinearAuthState, unknown>>): void {
    const next: Record<string, unknown> = { ...this.stored(), ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    this.store.saveLinearAuth(Object.keys(next).length > 0 ? (next as LinearAuthState) : null)
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

  tokens(): OAuthTokens | undefined {
    const t = this.stored().tokens
    return isRecord(t) && typeof t.access_token === 'string' ? (t as unknown as OAuthTokens) : undefined
  }

  saveTokens(tokens: OAuthTokens): void { this.update({ tokens }) }

  redirectToAuthorization(url: URL): void { this.openExternal(url.href) }

  saveCodeVerifier(verifier: string): void { this.update({ verifier }) }

  codeVerifier(): string {
    const v = this.stored().verifier
    if (!v) throw new Error('Connexion Linear : vérificateur PKCE absent.')
    return v
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.store.saveLinearAuth(null)
    else if (scope === 'client') this.update({ client: undefined })
    else if (scope === 'tokens') this.update({ tokens: undefined })
    else if (scope === 'verifier') this.update({ verifier: undefined })
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family: -apple-system, sans-serif; text-align: center; padding-top: 4em">` +
  `<h2>${title}</h2><p>${body}</p></body></html>`

/** Waits for the OAuth redirect on `http://localhost:<port>/callback`. Listens without host: dual stack, `localhost` may be ::1 or 127.0.0.1. */
export function waitForCallback(port: number, timeoutMs = 300_000): { url: string; code: Promise<string>; close(): void } {
  const url = `http://localhost:${port}/callback`
  let server: Server | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = (): void => {
    clearTimeout(timer)
    server?.closeAllConnections()
    server?.close()
  }
  const code = new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', url)
      const c = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      if (u.pathname !== '/callback' || (!c && !err)) { res.writeHead(404).end(); return }
      res.writeHead(c ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      const html = c
        ? page('Canopy est connecté à Linear', 'Tu peux fermer cet onglet et revenir dans Canopy.')
        : page('La connexion à Linear a échoué', `Linear a répondu : ${escapeHtml(err ?? '')}. Tu peux fermer cet onglet et réessayer depuis Canopy.`)
      res.end(html, () => {
        if (c) resolve(c)
        else reject(new Error(`Linear a refusé la connexion : ${err}`))
        close()
      })
    })
    server.on('error', reject)
    server.listen(port)
    timer = setTimeout(() => {
      reject(new Error(`Connexion Linear abandonnée : pas de réponse du navigateur après ${Math.round(timeoutMs / 1000)} s.`))
      close()
    }, timeoutMs)
  })
  code.catch(() => {}) // a rejection nobody awaits (connection authorized without the browser) is not unhandled
  return { url, code, close }
}

/** First port from `start` upward that can be listened on (no host, like `waitForCallback`). */
export async function freePort(start: number, tries = 20): Promise<number> {
  for (let port = start; port < start + tries; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(port, () => s.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error(`Connexion Linear : aucun port libre entre ${start} et ${start + tries - 1}.`)
}
