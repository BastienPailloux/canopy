import { afterEach, expect, test, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { hasLinearServer, SessionManager } from '../../../src/main/sessions/SessionManager'
import { parseStartOptions } from '../../../src/main/sessions/validate'
import type { SessionEvents } from '../../../src/shared/api'

const TEXT = 'Claude n’a pas accès à Linear dans cette session.'
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

class Fake {
  private readonly events: unknown[] = []
  private wake: (() => void) | undefined
  readonly close = vi.fn()
  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) { void (async () => { for await (const _m of prompt) { /* drain */ } })() }
  emit(msg: unknown): void { this.events.push(msg); this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const e = this.events.shift()
      if (e === undefined) { await new Promise<void>((r) => { this.wake = r }); continue }
      yield e as SDKMessage
    }
  }
}

let manager: SessionManager | undefined
afterEach(() => { manager?.stopAll(); manager = undefined })

function setup(): { m: SessionManager; q: Fake[]; notices: SessionEvents['notice'][] } {
  const q: Fake[] = []
  const notices: SessionEvents['notice'][] = []
  const m = new SessionManager({
    query: ((p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => { const f = new Fake(p.prompt, p.options); q.push(f); return f as unknown as Query }) as never,
    listSessions: (async () => []) as never,
    getSessionMessages: (async () => []) as never,
    env: () => ({}),
    isTrusted: () => true
  })
  m.on('notice', (n) => notices.push(n))
  manager = m
  return { m, q, notices }
}

const init = (servers: unknown): object => ({ type: 'system', subtype: 'init', mcp_servers: servers })

test('hasLinearServer needs a connected server named linear', () => {
  expect(hasLinearServer([{ name: 'plugin:design:linear', status: 'needs-auth' }])).toBe(false)
  expect(hasLinearServer([{ name: 'linear', status: 'connected' }])).toBe(true)
  expect(hasLinearServer([{ name: 'claude.ai Linear', status: 'connected' }])).toBe(true)
  expect(hasLinearServer([{ name: 'github', status: 'connected' }])).toBe(false)
  expect(hasLinearServer([])).toBe(false)
})

test('notice sent once with expectLinear and no server', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: { text: 'hi' }, expectLinear: true })
  h.q[0].emit(init([{ name: 'github', status: 'connected' }]))
  h.q[0].emit(init([]))
  await tick()
  expect(h.notices).toEqual([{ localId: id, text: TEXT }])
})

test('no notice when Linear is connected', async () => {
  const h = setup()
  h.m.start('/a', { content: { text: 'hi' }, expectLinear: true })
  h.q[0].emit(init([{ name: 'linear', status: 'connected' }]))
  await tick()
  expect(h.notices).toEqual([])
})

test('no notice without expectLinear', async () => {
  const h = setup()
  h.m.start('/a', { content: { text: 'hi' } })
  h.q[0].emit(init([]))
  await tick()
  expect(h.notices).toEqual([])
})

test('expectLinear is validated as an optional boolean', () => {
  expect(parseStartOptions({ content: { text: 'x' }, expectLinear: true }).expectLinear).toBe(true)
  expect(parseStartOptions({ content: { text: 'x' } })).not.toHaveProperty('expectLinear')
  expect(() => parseStartOptions({ content: { text: 'x' }, expectLinear: 'yes' })).toThrow()
})
