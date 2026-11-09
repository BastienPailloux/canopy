export interface Http {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>
  postJson(url: string, body: unknown): Promise<unknown>
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} : ${url}`)
  }
}

/** The only services the dependency check talks to. */
const HOSTS = new Set(['api.osv.dev', 'registry.npmjs.org', 'rubygems.org', 'pypi.org'])
const MAX_BYTES = 32 * 1024 * 1024

export function assertAllowedUrl(url: string): void {
  let u: URL
  try { u = new URL(url) } catch { throw new Error('URL invalide') }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.port !== '' || u.username !== '' || u.password !== '') throw new Error(`Hôte non autorisé : ${u.hostname}`)
}

/** Real client. Redirects are errors (hosts are allow-listed) and bodies are capped: responses are untrusted. */
export function fetchHttp(timeoutMs?: number): Http {
  async function request(url: string, init: RequestInit): Promise<unknown> {
    assertAllowedUrl(url)
    const res = await fetch(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs ?? 15_000),
      headers: { 'User-Agent': 'Canopy', ...(init.headers as Record<string, string> | undefined) }
    })
    if (!res.ok) throw new HttpError(res.status, url)
    const declared = Number(res.headers.get('content-length'))
    if (declared > MAX_BYTES) throw new Error('Réponse trop volumineuse')
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body?.getReader()
    for (;;) {
      const r = await reader?.read()
      if (!r || r.done) break
      size += r.value.length
      if (size > MAX_BYTES) { await reader?.cancel(); throw new Error('Réponse trop volumineuse') }
      chunks.push(r.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error(`Réponse illisible : ${url}`) }
  }
  return {
    getJson: (url, headers) => request(url, { headers }),
    postJson: (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
