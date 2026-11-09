/** `body` is null on a 304 (an `If-None-Match` hit). */
export interface JsonResponse { status: number; etag: string | null; body: unknown }

export interface Http {
  getJson(url: string, headers?: Record<string, string>): Promise<JsonResponse>
  postJson(url: string, body: unknown): Promise<unknown>
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} : ${url}`)
  }
}

/** The only services the dependency check talks to. */
const HOSTS = new Set(['api.osv.dev', 'registry.npmjs.org', 'rubygems.org', 'pypi.org'])
const MB = 1024 * 1024
/** Registry documents of big packages (all versions) exceed 32 MB; they are parsed once, then only derived info is kept. */
const maxBytes = (host: string) => (host === 'api.osv.dev' ? 32 * MB : 64 * MB)

export function assertAllowedUrl(url: string): void {
  let u: URL
  try { u = new URL(url) } catch { throw new Error('URL invalide') }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.port !== '' || u.username !== '' || u.password !== '') throw new Error(`Hôte non autorisé : ${u.hostname}`)
}

/** Real client. Redirects are errors (hosts are allow-listed) and bodies are capped: responses are untrusted. */
export function fetchHttp(timeoutMs?: number): Http {
  async function request(url: string, init: RequestInit): Promise<JsonResponse> {
    assertAllowedUrl(url)
    const max = maxBytes(new URL(url).hostname)
    const res = await fetch(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs ?? 15_000),
      headers: { 'User-Agent': 'Canopy', ...(init.headers as Record<string, string> | undefined) }
    })
    const etag = res.headers.get('etag')
    if (res.status === 304) { await res.body?.cancel(); return { status: 304, etag, body: null } }
    if (!res.ok) throw new HttpError(res.status, url)
    const declared = Number(res.headers.get('content-length'))
    if (declared > max) throw new Error('Réponse trop volumineuse')
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body?.getReader()
    for (;;) {
      const r = await reader?.read()
      if (!r || r.done) break
      size += r.value.length
      if (size > max) { await reader?.cancel(); throw new Error('Réponse trop volumineuse') }
      chunks.push(r.value)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error(`Réponse illisible : ${url}`) }
    return { status: res.status, etag, body }
  }
  return {
    getJson: (url, headers) => request(url, { headers }),
    postJson: async (url, body) => (await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body
  }
}

/** At most `n` tasks in flight; the rest wait in order. */
export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  const release = () => { active--; waiting.shift()?.() }
  return async (task) => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r))
    active++
    try { return await task() } finally { release() }
  }
}
