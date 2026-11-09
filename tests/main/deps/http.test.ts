import { afterEach, describe, expect, test, vi } from 'vitest'
import { fetchHttp } from '../../../src/main/deps/http'

const MB = 1024 * 1024
afterEach(() => { vi.unstubAllGlobals() })

/** A JSON string body of about `mb` MB, streamed in 1 MB chunks, without content-length. */
function bigBody(mb: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(MB).fill(0x61)
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i === 0) c.enqueue(new TextEncoder().encode('"'))
      if (i < mb) c.enqueue(chunk)
      else { c.enqueue(new TextEncoder().encode('"')); c.close() }
      i++
    }
  })
}

describe('fetchHttp', () => {
  test('refuses redirects', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('fetch failed: redirect')
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fetchHttp().getJson('https://registry.npmjs.org/a')).rejects.toThrow('redirect')
    expect(fetch.mock.calls[0][1].redirect).toBe('error')
  })

  test('refuses a declared size over the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-length': String(65 * MB) } })))
    await expect(fetchHttp().getJson('https://registry.npmjs.org/a')).rejects.toThrow('Réponse trop volumineuse')
  })

  test('caps streamed bodies: 32 MB for OSV, 64 MB for registry documents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bigBody(33))))
    await expect(fetchHttp().getJson('https://api.osv.dev/v1/vulns/X')).rejects.toThrow('Réponse trop volumineuse')
    const ok = await fetchHttp().getJson('https://registry.npmjs.org/a')
    expect(ok.status).toBe(200)
    expect((ok.body as string).length).toBe(33 * MB)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bigBody(65))))
    await expect(fetchHttp().getJson('https://registry.npmjs.org/a')).rejects.toThrow('Réponse trop volumineuse')
  }, 30_000)

  test('returns the ETag, sends conditional headers and passes a 304 through', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      if (h['If-None-Match'] === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      return new Response('{"a":1}', { headers: { etag: '"v1"' } })
    })
    vi.stubGlobal('fetch', fetch)
    const h = fetchHttp()
    expect(await h.getJson('https://registry.npmjs.org/a')).toEqual({ status: 200, etag: '"v1"', body: { a: 1 } })
    expect(await h.getJson('https://registry.npmjs.org/a', { 'If-None-Match': '"v1"' })).toEqual({ status: 304, etag: '"v1"', body: null })
    expect((fetch.mock.calls[1][1].headers as Record<string, string>)['User-Agent']).toBe('Canopy')
  })
})
