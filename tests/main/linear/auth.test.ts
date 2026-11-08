import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { LinearAuthProvider, freePort, waitForCallback } from '../../../src/main/linear/auth'
import type { LinearAuthState } from '../../../src/main/appStore'

const memoryStore = (initial: LinearAuthState | null = null) => {
  let s = initial
  return {
    linearAuth: () => (s === null ? null : structuredClone(s)),
    saveLinearAuth: (next: LinearAuthState | null) => { s = next === null ? null : structuredClone(next) },
    get raw() { return s },
  }
}

const REDIRECT = 'http://localhost:33418/callback'

describe('waitForCallback', () => {
  for (const host of ['[::1]', '127.0.0.1']) {
    it(`callback resolves the code on ${host}`, async () => {
      const port = await freePort(41_000)
      const cb = waitForCallback(port)
      try {
        expect(cb.url).toBe(`http://localhost:${port}/callback`)
        const res = await fetch(`http://${host}:${port}/callback?code=abc-123`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        expect(await res.text()).toContain('Canopy est connecté à Linear')
        await expect(cb.code).resolves.toBe('abc-123')
      } finally { cb.close() }
    })
  }

  it('callback with error rejects with it', async () => {
    const port = await freePort(41_100)
    const cb = waitForCallback(port)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=%3Cb%3Enope%3C%2Fb%3E`)
      const html = await res.text()
      expect(html).toContain('access_denied')
      expect(html).not.toContain('<b>nope</b>')
      await expect(cb.code).rejects.toThrow(/access_denied/)
    } finally { cb.close() }
  })

  it('other paths are 404 and keep waiting', async () => {
    const port = await freePort(41_200)
    const cb = waitForCallback(port)
    try {
      expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404)
      await fetch(`http://127.0.0.1:${port}/callback?code=late`)
      await expect(cb.code).resolves.toBe('late')
    } finally { cb.close() }
  })

  it('times out', async () => {
    const port = await freePort(41_300)
    const cb = waitForCallback(port, 50)
    await expect(cb.code).rejects.toThrow(/Linear/)
    cb.close()
  })

  it('frees the port once closed', async () => {
    const port = await freePort(41_400)
    const cb = waitForCallback(port)
    await fetch(`http://127.0.0.1:${port}/callback?code=x`)
    await cb.code
    cb.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(await freePort(port)).toBe(port)
  })
})

describe('freePort', () => {
  it('skips a busy port', async () => {
    const start = await freePort(41_500)
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(start, r))
    try {
      expect(await freePort(start)).toBeGreaterThan(start)
    } finally { busy.close() }
  })
})

describe('LinearAuthProvider', () => {
  it('provider keeps client, tokens and verifier through the store', async () => {
    const store = memoryStore()
    const opened: string[] = []
    const p = new LinearAuthProvider(store, REDIRECT, (u) => opened.push(u))
    expect(p.redirectUrl).toBe(REDIRECT)
    expect(p.clientMetadata.redirect_uris).toEqual([REDIRECT])
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none')
    expect(await p.clientInformation()).toBeUndefined()
    expect(await p.tokens()).toBeUndefined()

    await p.saveClientInformation({ client_id: 'cid', redirect_uris: [REDIRECT] })
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' })
    await p.saveCodeVerifier('verif')
    await p.redirectToAuthorization(new URL('https://linear.app/oauth/authorize?x=1'))
    expect(opened).toEqual(['https://linear.app/oauth/authorize?x=1'])

    const again = new LinearAuthProvider(store, REDIRECT, () => {})
    expect(await again.clientInformation()).toEqual({ client_id: 'cid', redirect_uris: [REDIRECT] })
    expect(await again.tokens()).toEqual({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' })
    expect(await again.codeVerifier()).toBe('verif')
  })

  it('a client registered for another redirect URL is dropped with its tokens', async () => {
    const store = memoryStore({ client: { client_id: 'cid', redirect_uris: [REDIRECT] }, tokens: { access_token: 'at', token_type: 'Bearer' }, verifier: 'v' })
    const p = new LinearAuthProvider(store, 'http://localhost:33419/callback', () => {})
    expect(await p.clientInformation()).toBeUndefined()
    expect(store.raw).toEqual({ verifier: 'v' })
  })

  it('invalidateCredentials clears what the SDK asks', async () => {
    const full = { client: { client_id: 'cid', redirect_uris: [REDIRECT] }, tokens: { access_token: 'at', token_type: 'Bearer' }, verifier: 'v' }
    const store = memoryStore(full)
    const p = new LinearAuthProvider(store, REDIRECT, () => {})
    await p.invalidateCredentials('tokens')
    expect(store.raw).toEqual({ client: full.client, verifier: 'v' })
    await p.invalidateCredentials('verifier')
    expect(store.raw).toEqual({ client: full.client })
    await p.invalidateCredentials('all')
    expect(store.raw).toBeNull()
  })

  it('no stored verifier is an error', async () => {
    const p = new LinearAuthProvider(memoryStore(), REDIRECT, () => {})
    expect(() => p.codeVerifier()).toThrow()
  })
})
