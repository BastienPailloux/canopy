import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { LinearAuthProvider, waitForCallback } from '../../../src/main/linear/auth'
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

const STATE = 'flow-state-1'
const wait = (port: number, timeoutMs?: number) => waitForCallback({ port, state: () => STATE, timeoutMs })
const q = (code: string, state = STATE) => `code=${code}&state=${state}`

describe('waitForCallback', () => {
  for (const host of ['[::1]', '127.0.0.1']) {
    it(`callback resolves the code on ${host}`, async () => {
      const cb = await wait(41_000)
      try {
        expect(cb.url).toBe(`http://localhost:${cb.port}/callback`)
        const res = await fetch(`http://${host}:${cb.port}/callback?${q('abc-123')}`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        expect(await res.text()).toContain('Canopy est connecté à Linear')
        await expect(cb.code).resolves.toBe('abc-123')
      } finally { cb.close() }
    })
  }

  it('listens on the loopback addresses only', async () => {
    const cb = await wait(41_050)
    try {
      expect(cb.hosts.length).toBeGreaterThan(0)
      for (const h of cb.hosts) expect(['127.0.0.1', '::1']).toContain(h)
      expect(cb.hosts).toContain('127.0.0.1')
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')
      if (lan) await expect(fetch(`http://${lan.address}:${cb.port}/callback?${q('x')}`)).rejects.toThrow()
    } finally { cb.close() }
  })

  it('callback with error rejects with it', async () => {
    const cb = await wait(41_100)
    try {
      const res = await fetch(`http://127.0.0.1:${cb.port}/callback?error=access_denied&state=${STATE}&error_description=%3Cb%3Enope%3C%2Fb%3E`)
      const html = await res.text()
      expect(html).toContain('access_denied')
      expect(html).not.toContain('<b>nope</b>')
      await expect(cb.code).rejects.toThrow(/access_denied/)
    } finally { cb.close() }
  })

  it('wrong or missing state does not end the flow; the right one does', async () => {
    const cb = await wait(41_150)
    try {
      const base = `http://127.0.0.1:${cb.port}/callback`
      expect((await fetch(`${base}?code=evil`)).status).toBe(404)
      expect((await fetch(`${base}?${q('evil', 'other')}`)).status).toBe(404)
      expect((await fetch(`${base}?error=access_denied`)).status).toBe(404)
      expect((await fetch(`${base}?error=access_denied&state=other`)).status).toBe(404)
      expect((await fetch(`${base}?${q('good')}`)).status).toBe(200)
      await expect(cb.code).resolves.toBe('good')
    } finally { cb.close() }
  })

  it('nothing is accepted before the authorization has a state', async () => {
    let state: string | undefined
    const cb = await waitForCallback({ port: 41_170, state: () => state })
    try {
      expect((await fetch(`http://127.0.0.1:${cb.port}/callback?code=x&state=`)).status).toBe(404)
      state = 's'
      await fetch(`http://127.0.0.1:${cb.port}/callback?code=x&state=s`)
      await expect(cb.code).resolves.toBe('x')
    } finally { cb.close() }
  })

  it('other paths are 404 and keep waiting', async () => {
    const cb = await wait(41_200)
    try {
      expect((await fetch(`http://127.0.0.1:${cb.port}/favicon.ico`)).status).toBe(404)
      await fetch(`http://127.0.0.1:${cb.port}/callback?${q('late')}`)
      await expect(cb.code).resolves.toBe('late')
    } finally { cb.close() }
  })

  it('times out', async () => {
    const cb = await wait(41_300, 50)
    await expect(cb.code).rejects.toThrow(/Linear/)
    cb.close()
  })

  it('frees the port once answered', async () => {
    const cb = await wait(41_400)
    await fetch(`http://127.0.0.1:${cb.port}/callback?${q('x')}`)
    await cb.code
    await new Promise((r) => setTimeout(r, 20))
    const again = await wait(cb.port)
    expect(again.port).toBe(cb.port)
    again.close()
  })

  for (const host of ['127.0.0.1', '::1']) {
    it(`skips a port busy on ${host}`, async () => {
      const first = await wait(41_500)
      first.close()
      await new Promise((r) => setTimeout(r, 20))
      const busy = createServer()
      const ok = await new Promise<boolean>((r) => { busy.once('error', () => r(false)); busy.listen(first.port, host, () => r(true)) })
      if (!ok) return // no IPv6 loopback here
      try {
        const cb = await wait(first.port)
        expect(cb.port).toBeGreaterThan(first.port)
        cb.close()
      } finally { busy.close() }
    })
  }
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

  it('state is random per flow and kept for the callback', () => {
    const p = new LinearAuthProvider(memoryStore(), REDIRECT, () => {})
    expect(p.expectedState).toBeUndefined()
    const a = p.state()
    expect(a.length).toBeGreaterThanOrEqual(16)
    expect(p.expectedState).toBe(a)
    expect(p.state()).not.toBe(a)
  })

  it('outside an interactive connect, invalidating keeps the credentials and marks expired', async () => {
    const full = { client: { client_id: 'cid', redirect_uris: [REDIRECT] }, tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' }, verifier: 'v' }
    for (const scope of ['tokens', 'client', 'all'] as const) {
      const store = memoryStore(structuredClone(full))
      const opened: string[] = []
      const p = new LinearAuthProvider(store, REDIRECT, (u) => opened.push(u), false)
      await p.invalidateCredentials(scope)
      expect(store.raw).toEqual({ ...full, expired: true })
      // the SDK's retry then finds no usable tokens and asks for the browser, which stays closed
      expect(await p.tokens()).toBeUndefined()
      await p.redirectToAuthorization(new URL('https://linear.app/oauth/authorize'))
      expect(opened).toEqual([])
    }
  })

  it('needing the browser outside an interactive connect marks expired', async () => {
    const store = memoryStore({ client: { client_id: 'cid', redirect_uris: [REDIRECT] }, tokens: { access_token: 'at', token_type: 'Bearer' } })
    const p = new LinearAuthProvider(store, REDIRECT, () => { throw new Error('must not open') }, false)
    await p.redirectToAuthorization(new URL('https://linear.app/oauth/authorize'))
    expect(store.raw?.expired).toBe(true)
    expect(store.raw?.tokens).toEqual({ access_token: 'at', token_type: 'Bearer' })
  })

  it('new tokens clear expired', async () => {
    const store = memoryStore({ client: { client_id: 'cid', redirect_uris: [REDIRECT] }, tokens: { access_token: 'old', token_type: 'Bearer' }, expired: true })
    const p = new LinearAuthProvider(store, REDIRECT, () => {})
    await p.saveTokens({ access_token: 'new', token_type: 'Bearer' })
    expect(store.raw?.expired).toBeUndefined()
    expect(await p.tokens()).toEqual({ access_token: 'new', token_type: 'Bearer' })
  })
})
