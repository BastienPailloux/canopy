import { afterEach, expect, test, vi } from 'vitest'
import type {
  CanUseTool, getSessionMessages, listSessions, Options, PermissionResult, PermissionUpdate, Query, SDKMessage,
  SDKSessionInfo, SDKUserMessage, SessionMessage, SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../../../src/main/sessions/SessionManager'
import type { SessionEvents } from '../../../src/shared/api'
import type { PermissionRequest } from '../../../src/shared/types'

/** A `query` stand-in: the test drives what the session sees. */
class FakeQuery {
  readonly inputs: SDKUserMessage[] = []
  readonly interrupt = vi.fn(async () => undefined)
  readonly setPermissionMode = vi.fn(async () => undefined)
  readonly setModel = vi.fn(async () => undefined)
  readonly supportedCommands = vi.fn(async (): Promise<SlashCommand[]> => [])
  readonly supportedModels = vi.fn(async () => [{ value: 'opus', displayName: 'Opus', description: '' }])
  readonly close = vi.fn()
  private readonly events: Array<{ msg?: unknown; err?: Error; end?: boolean }> = []
  private wake: (() => void) | undefined

  constructor(readonly prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void this.readInput()
  }

  private async readInput(): Promise<void> {
    for await (const m of this.prompt) this.inputs.push(m)
  }

  private enqueue(e: { msg?: unknown; err?: Error; end?: boolean }): void {
    this.events.push(e)
    this.wake?.()
  }

  emit(msg: unknown): void { this.enqueue({ msg }) }
  fail(err: Error): void { this.enqueue({ err }) }
  end(): void { this.enqueue({ end: true }) }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const e = this.events.shift()
      if (!e) {
        await new Promise<void>((r) => { this.wake = r })
        continue
      }
      if (e.err) throw e.err
      if (e.end) return
      yield e.msg as SDKMessage
    }
  }

  /** Calls the host's `canUseTool` the way the SDK does. */
  ask(toolName: string, requestId: string, o: { suggestions?: PermissionUpdate[]; input?: Record<string, unknown>; signal?: AbortSignal; extra?: object } = {}): Promise<PermissionResult | null> {
    const canUseTool = this.options.canUseTool as CanUseTool
    return canUseTool(toolName, o.input ?? { command: 'touch a' }, {
      signal: o.signal ?? new AbortController().signal,
      suggestions: o.suggestions,
      toolUseID: `tool-${requestId}`,
      requestId,
      ...o.extra
    })
  }
}

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' }
const ADD_RULES: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch a *' }], behavior: 'allow', destination: 'localSettings' }
const SET_MODE: PermissionUpdate = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
const ADD_DIRS: PermissionUpdate = { type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' }
const content = (text: string) => ({ text })
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

let manager: SessionManager | undefined
afterEach(() => { manager?.stopAll(); manager = undefined; vi.restoreAllMocks() })

interface Harness {
  m: SessionManager
  queries: FakeQuery[]
  states: SessionEvents['state'][]
  permissions: PermissionRequest[]
  stateOf(localId: string): string | undefined
  listSessions: ReturnType<typeof vi.fn<typeof listSessions>>
  getSessionMessages: ReturnType<typeof vi.fn<typeof getSessionMessages>>
}

function setup(o: { query?: (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => FakeQuery; env?: NodeJS.ProcessEnv; executable?: () => string | undefined; isTrusted?: (cwd: string) => boolean | Promise<boolean>; disk?: Partial<SDKSessionInfo>[] } = {}): Harness {
  const queries: FakeQuery[] = []
  const states: SessionEvents['state'][] = []
  const permissions: PermissionRequest[] = []
  const list = vi.fn<typeof listSessions>(async () => (o.disk ?? []) as SDKSessionInfo[])
  const messages = vi.fn<typeof getSessionMessages>(async () => [])
  const query = o.query ?? ((p) => new FakeQuery(p.prompt, p.options))
  const m = new SessionManager({
    query: ((p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const q = query(p)
      queries.push(q)
      return q as unknown as Query
    }) as never,
    listSessions: list,
    getSessionMessages: messages,
    env: () => o.env ?? { PATH: '/x' },
    pathToClaudeCodeExecutable: o.executable,
    isTrusted: o.isTrusted
  })
  m.on('state', (s) => states.push(s))
  m.on('permission', (p) => permissions.push(p))
  manager = m
  return {
    m, queries, states, permissions, listSessions: list, getSessionMessages: messages,
    stateOf: (id) => states.filter((s) => s.localId === id).at(-1)?.state
  }
}

test('sessions are independent: an error in one leaves the other running', async () => {
  const h = setup()
  const a = h.m.start('/a', { content: content('one') })
  const b = h.m.start('/b', { content: content('two') })
  expect(a).not.toBe(b)
  h.queries[0].fail(new Error('boom'))
  await tick()
  expect(h.stateOf(a)).toBe('error')
  expect(h.stateOf(b)).toBe('running')
  h.queries[1].emit(SUCCESS)
  await tick()
  expect(h.stateOf(b)).toBe('idle')
  h.m.send(b, content('still here'))
  await tick()
  expect(h.queries[1].inputs).toHaveLength(2)
  expect(h.stateOf(b)).toBe('running')
})

test('state: running on send, idle on result, stopped after stop', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  await tick()
  expect(h.stateOf(id)).toBe('running')
  h.queries[0].emit(SUCCESS)
  await tick()
  expect(h.stateOf(id)).toBe('idle')
  h.m.send(id, content('again'))
  expect(h.stateOf(id)).toBe('running')
  h.m.stop(id)
  expect(h.stateOf(id)).toBe('stopped')
})

test('state events carry the sessionId known from start', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  await tick()
  const sessionId = h.queries[0].options.sessionId
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(h.states[0].sessionId).toBe(sessionId)
})

test.each([['with a message', 'hi', 'running'], ['with empty content', '', 'idle']])(
  'the first state event comes after start returned, %s',
  async (_name, text, state) => {
    const h = setup()
    const id = h.m.start('/a', { content: content(text) })
    expect(h.states).toEqual([])
    await tick()
    expect(h.states).toEqual([{ localId: id, state, sessionId: h.queries[0].options.sessionId }])
  }
)

test('stop before the deferred first state reports only stopped', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.m.stop(id)
  await tick()
  expect(h.states.map((s) => s.state)).toEqual(['stopped'])
})

test('messages are relayed with their localId', async () => {
  const h = setup()
  const seen: SessionEvents['message'][] = []
  h.m.on('message', (e) => seen.push(e))
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'assistant', message: {} })
  await tick()
  expect(seen).toEqual([{ localId: id, msg: { type: 'assistant', message: {} } }])
})

test('a throwing listener does not stop the session', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = setup()
  h.m.on('message', () => { throw new Error('window gone') })
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'assistant', message: {} })
  h.queries[0].emit(SUCCESS)
  await tick()
  expect(h.stateOf(id)).toBe('idle')
  expect(log).toHaveBeenCalled()
})

test('a generator error sets error and reports its message', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].fail(new Error('Claude Code process exited with code 1'))
  await tick()
  expect(h.states.at(-1)).toMatchObject({ localId: id, state: 'error', error: 'Claude Code process exited with code 1' })
})

test('cwd removed while running: generator error gives error, no unhandled exception', async () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const h = setup()
    const id = h.m.start('/gone', { content: content('hi') })
    h.queries[0].fail(new Error('spawn ENOENT'))
    await tick()
    await tick()
    expect(h.stateOf(id)).toBe('error')
    expect(h.m.activity('/gone')).toBe('idle')
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

test('a generator that ends by itself closes the session as stopped', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit(SUCCESS)
  h.queries[0].end()
  await tick()
  expect(h.stateOf(id)).toBe('stopped')
  expect(() => h.m.send(id, content('late'))).toThrow()
})

test('waits on permission, then resumes on allow', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const input = { command: 'touch a' }
  const answer = h.queries[0].ask('Bash', 'r1', {
    input,
    suggestions: [ADD_RULES],
    extra: { description: 'Creates a', decisionReason: 'needs approval', blockedPath: '/etc/a', title: '' }
  })
  expect(h.permissions).toEqual([{
    requestId: 'r1', localId: id, toolName: 'Bash', input, canAlways: true, toolUseID: 'tool-r1',
    description: 'Creates a', decisionReason: 'needs approval', blockedPath: '/etc/a'
  }])
  expect(h.stateOf(id)).toBe('waiting')
  expect(h.m.activity('/a')).toBe('waiting')
  h.m.resolvePermission('r1', { allow: true })
  expect(await answer).toEqual({ behavior: 'allow', updatedInput: input })
  expect(h.stateOf(id)).toBe('running')
  expect(h.m.activity('/a')).toBe('working')
})

test('allow forwards updatedInput, as AskUserQuestion needs', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('AskUserQuestion', 'r1', { input: { questions: [] } })
  const updatedInput = { questions: [], answers: { 'Which color?': 'Blue' } }
  h.m.resolvePermission('r1', { allow: true, updatedInput })
  expect(await answer).toEqual({ behavior: 'allow', updatedInput })
})

test('deny returns the message', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Bash', 'r1')
  h.m.resolvePermission('r1', { allow: false, message: 'Non' })
  expect(await answer).toEqual({ behavior: 'deny', message: 'Non' })
})

test('stays waiting until every parallel request is answered', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const first = h.queries[0].ask('Bash', 'r1')
  const second = h.queries[0].ask('Bash', 'r2')
  h.m.resolvePermission('r1', { allow: true })
  await first
  expect(h.stateOf(id)).toBe('waiting')
  h.m.resolvePermission('r2', { allow: true })
  await second
  expect(h.stateOf(id)).toBe('running')
})

test('always:true forwards only addRules suggestions', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const input = { command: 'touch a' }
  const answer = h.queries[0].ask('Bash', 'r1', { input, suggestions: [SET_MODE, ADD_RULES, ADD_DIRS] })
  h.m.resolvePermission('r1', { allow: true, always: true })
  expect(await answer).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: [ADD_RULES] })
})

test('allow without always forwards no permission update', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Bash', 'r1', { suggestions: [ADD_RULES] })
  h.m.resolvePermission('r1', { allow: true })
  expect(await answer).not.toHaveProperty('updatedPermissions')
})

test.each([
  ['absent', undefined],
  ['empty', []],
  ['setMode only', [SET_MODE]]
])('canAlways is false when suggestions are %s', async (_name, suggestions) => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Write', 'r1', { suggestions })
  expect(h.permissions[0].canAlways).toBe(false)
  h.m.resolvePermission('r1', { allow: true, always: true })
  expect(await answer).not.toHaveProperty('updatedPermissions')
})

test('suppressAlwaysAllowRule forbids a persistent rule even with addRules', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Bash', 'r1', { suggestions: [ADD_RULES], extra: { suppressAlwaysAllowRule: true } })
  expect(h.permissions[0].canAlways).toBe(false)
  h.m.resolvePermission('r1', { allow: true, always: true })
  expect(await answer).not.toHaveProperty('updatedPermissions')
})

test('pendingPermissions lists open requests across sessions, for a reloaded window', async () => {
  const h = setup()
  h.m.start('/a', { content: content('one') })
  h.m.start('/b', { content: content('two') })
  expect(h.m.pendingPermissions()).toEqual([])
  const first = h.queries[0].ask('Bash', 'r1')
  void h.queries[1].ask('Write', 'r2')
  expect(h.m.pendingPermissions()).toEqual(h.permissions)
  h.m.resolvePermission('r1', { allow: true })
  await first
  expect(h.m.pendingPermissions().map((p) => p.requestId)).toEqual(['r2'])
})

test('resolvePermission ignores an unknown request', () => {
  const h = setup()
  expect(() => h.m.resolvePermission('nope', { allow: true })).not.toThrow()
})

test('signal aborted during a wait withdraws the request', async () => {
  const h = setup()
  const cancelled: SessionEvents['permissionCancelled'][] = []
  h.m.on('permissionCancelled', (e) => cancelled.push(e))
  const id = h.m.start('/a', { content: content('hi') })
  const ctrl = new AbortController()
  const answer = h.queries[0].ask('Bash', 'r1', { signal: ctrl.signal })
  expect(h.stateOf(id)).toBe('waiting')
  ctrl.abort()
  expect(await answer).toMatchObject({ behavior: 'deny' })
  expect(cancelled).toEqual([{ requestId: 'r1', localId: id }])
  expect(h.stateOf(id)).toBe('running')
  expect(h.m.activity('/a')).toBe('working')
  expect(() => h.m.resolvePermission('r1', { allow: true })).not.toThrow()
})

test('a signal already aborted never prompts', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Bash', 'r1', { signal: AbortSignal.abort() })
  expect(await answer).toMatchObject({ behavior: 'deny' })
  expect(h.permissions).toEqual([])
})

test('result during a wait does not override waiting, and abort then lands on idle', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const ctrl = new AbortController()
  const answer = h.queries[0].ask('Bash', 'r1', { signal: ctrl.signal })
  h.queries[0].emit(SUCCESS)
  await tick()
  expect(h.stateOf(id)).toBe('waiting')
  ctrl.abort()
  await answer
  expect(h.stateOf(id)).toBe('idle')
})

test('stop answers pending requests and withdraws them', async () => {
  const h = setup()
  const cancelled: SessionEvents['permissionCancelled'][] = []
  h.m.on('permissionCancelled', (e) => cancelled.push(e))
  const id = h.m.start('/a', { content: content('hi') })
  const answer = h.queries[0].ask('Bash', 'r1')
  h.m.stop(id)
  expect(await answer).toMatchObject({ behavior: 'deny' })
  expect(cancelled).toEqual([{ requestId: 'r1', localId: id }])
  expect(h.stateOf(id)).toBe('stopped')
})

test('canUseTool after the session closed is denied without prompting', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.m.stop(id)
  expect(await h.queries[0].ask('Bash', 'r1')).toMatchObject({ behavior: 'deny' })
  expect(h.permissions).toEqual([])
})

test('query throwing synchronously gives error, no exception, after start returned', async () => {
  const h = setup({ query: () => { throw new Error('spawn ENOTDIR') } })
  const id = h.m.start('/a', { content: content('hi') })
  expect(typeof id).toBe('string')
  expect(h.stateOf(id)).toBeUndefined()
  await tick()
  expect(h.states.at(-1)).toMatchObject({ localId: id, state: 'error', error: 'spawn ENOTDIR' })
  expect(h.m.activity('/a')).toBe('idle')
})

test('result with is_error after an interruption is idle', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' })
  await tick()
  expect(h.stateOf(id)).toBe('idle')
})

test('interrupted while streaming is idle too', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' })
  await tick()
  expect(h.stateOf(id)).toBe('idle')
})

test('connection error (subtype success, is_error true) is error and keeps its reason', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })
  await tick()
  expect(h.states.at(-1)).toMatchObject({ localId: id, state: 'error', error: 'Not logged in' })
  h.queries[0].fail(new Error('Claude Code process exited with code 1'))
  await tick()
  expect(h.states.at(-1)).toMatchObject({ localId: id, state: 'error', error: 'Not logged in' })
})

test('an error result without text reports its errors', async () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['one', 'two'] })
  await tick()
  expect(h.states.at(-1)).toMatchObject({ state: 'error', error: 'one\ntwo' })
})

test('a new turn after an error result forgets its reason', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'result', subtype: 'success', is_error: true, result: 'Overloaded' })
  await tick()
  h.m.send(id, content('retry'))
  h.queries[0].fail(new Error('process exited'))
  await tick()
  expect(h.states.at(-1)).toMatchObject({ state: 'error', error: 'process exited' })
})

test('a generator that throws after stop stays stopped', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  await tick()
  h.m.stop(id)
  h.queries[0].fail(new Error('Claude Code returned an error result'))
  await tick()
  expect(h.stateOf(id)).toBe('stopped')
  expect(h.states.filter((s) => s.state === 'error')).toEqual([])
})

test('stop closes both the input queue and the query', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const inputDone = (async () => { for await (const _ of h.queries[0].prompt); })()
  h.m.stop(id)
  await inputDone
  expect(h.queries[0].close).toHaveBeenCalledOnce()
})

test('stop on an unknown session is a no-op', () => {
  expect(() => setup().m.stop('nope')).not.toThrow()
})

test('messages arriving after stop are dropped', async () => {
  const h = setup()
  const seen: unknown[] = []
  h.m.on('message', (e) => seen.push(e))
  const id = h.m.start('/a', { content: content('hi') })
  await tick()
  h.m.stop(id)
  h.queries[0].emit(SUCCESS)
  await tick()
  expect(seen).toEqual([])
  expect(h.stateOf(id)).toBe('stopped')
})

test('start with a live resumeId returns the existing localId without a second query', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi'), resumeId: 'abc' })
  expect(h.m.start('/a', { content: content(''), resumeId: 'abc' })).toBe(id)
  expect(h.queries).toHaveLength(1)
  await tick()
  expect(h.queries[0].inputs).toHaveLength(1)
})

test('start with a live resumeId delivers the message to the existing session', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const sessionId = h.queries[0].options.sessionId
  expect(h.m.start('/a', { content: content('next'), resumeId: sessionId })).toBe(id)
  await tick()
  expect(h.queries).toHaveLength(1)
  expect(h.queries[0].inputs).toHaveLength(2)
})

test('start with the resumeId of an ended session starts a new query', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi'), resumeId: 'abc' })
  h.m.stop(id)
  expect(h.m.start('/a', { content: content('back'), resumeId: 'abc' })).not.toBe(id)
  expect(h.queries).toHaveLength(2)
})

test('commands drops terminal commands and internal names', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  const cmd = (name: string): SlashCommand => ({ name, description: '', argumentHint: '' })
  h.queries[0].supportedCommands.mockResolvedValue([cmd('doctor'), cmd('__remote-workflow'), cmd('compact'), cmd('loop')])
  h.queries[0].emit({ type: 'system', subtype: 'init', terminal_slash_commands: ['doctor', 'color'] })
  await tick()
  expect((await h.m.commands(id)).map((c) => c.name)).toEqual(['compact', 'loop'])
})

test('commandsChanged fires on the first init only, so the UI can refetch', async () => {
  const h = setup()
  const seen: SessionEvents['commandsChanged'][] = []
  h.m.on('commandsChanged', (e) => seen.push(e))
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].emit({ type: 'system', subtype: 'init', terminal_slash_commands: ['doctor'] })
  h.queries[0].emit({ type: 'system', subtype: 'init', terminal_slash_commands: ['doctor'] })
  await tick()
  expect(seen).toEqual([{ localId: id }])
})

test('an init without terminal_slash_commands keeps the known ones', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  h.queries[0].supportedCommands.mockResolvedValue([{ name: 'doctor', description: '', argumentHint: '' }])
  h.queries[0].emit({ type: 'system', subtype: 'init', terminal_slash_commands: ['doctor'] })
  h.queries[0].emit({ type: 'system', subtype: 'init' })
  await tick()
  expect(await h.m.commands(id)).toEqual([])
})

test('commands and models are empty for an unknown session', async () => {
  const h = setup()
  expect(await h.m.commands('nope')).toEqual([])
  expect(await h.m.models('nope')).toEqual([])
})

test('models lists what the session supports', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  expect((await h.m.models(id)).map((m) => m.value)).toEqual(['opus'])
})

test('send after result pushes to the same queue, with no new query', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('one') })
  h.queries[0].emit(SUCCESS)
  await tick()
  h.m.send(id, content('two'))
  await tick()
  expect(h.queries).toHaveLength(1)
  expect(h.queries[0].inputs.map((i) => i.message.content)).toEqual([
    [{ type: 'text', text: 'one' }],
    [{ type: 'text', text: 'two' }]
  ])
})

test('a message sent during a turn keeps the session running once its turn streams', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('one') })
  h.m.send(id, content('two'))
  h.queries[0].emit(SUCCESS)
  h.queries[0].emit({ type: 'stream_event', event: {} })
  await tick()
  expect(h.stateOf(id)).toBe('running')
})

test('send on an ended session throws rather than losing the message', () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('one') })
  h.m.stop(id)
  expect(() => h.m.send(id, content('two'))).toThrow()
})

test('images follow the text as base64 blocks', async () => {
  const h = setup()
  h.m.start('/a', { content: { text: 'color?', images: [{ mediaType: 'image/png', base64: 'AAAA' }] } })
  await tick()
  expect(h.queries[0].inputs[0]).toMatchObject({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'color?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
      ]
    }
  })
})

test('an image with no text sends no empty text block', async () => {
  const h = setup()
  h.m.start('/a', { content: { text: '', images: [{ mediaType: 'image/png', base64: 'AAAA' }] } })
  await tick()
  expect(h.queries[0].inputs[0].message.content).toHaveLength(1)
})

test('empty content sends nothing and leaves the session idle', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content(''), resumeId: 'abc' })
  await tick()
  expect(h.queries[0].inputs).toEqual([])
  expect(h.stateOf(id)).toBe('idle')
})

test('resumeId is passed as options.resume, without sessionId', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi'), resumeId: 'abc' })
  expect(h.queries[0].options.resume).toBe('abc')
  expect(h.queries[0].options).not.toHaveProperty('sessionId')
})

test('an empty resumeId counts as absent', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi'), resumeId: '' })
  expect(h.queries[0].options).not.toHaveProperty('resume')
  expect(h.queries[0].options.sessionId).toMatch(/^[0-9a-f-]{36}$/)
})

test('options for a new session', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi'), model: 'opus', mode: 'plan', trusted: true })
  const o = h.queries[0].options
  expect(o).toMatchObject({ cwd: '/a', includePartialMessages: true, permissionMode: 'plan', model: 'opus' })
  expect(typeof o.canUseTool).toBe('function')
  expect(o).not.toHaveProperty('resume')
  expect(o).not.toHaveProperty('settingSources')
  expect(o).not.toHaveProperty('pathToClaudeCodeExecutable')
})

test('permissionMode defaults to default, and model stays unset', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  expect(h.queries[0].options.permissionMode).toBe('default')
  expect(h.queries[0].options).not.toHaveProperty('model')
})

test('pathToClaudeCodeExecutable comes from the constructor', () => {
  const h = setup({ executable: () => '/App/app.asar.unpacked/claude' })
  h.m.start('/a', { content: content('hi') })
  expect(h.queries[0].options.pathToClaudeCodeExecutable).toBe('/App/app.asar.unpacked/claude')
})

test('a failing executable lookup is reported by start, not thrown', async () => {
  const h = setup({ executable: () => { throw new Error('binary not found') } })
  const id = h.m.start('/a', { content: content('hi') })
  await tick()
  expect(h.states.at(-1)).toMatchObject({ localId: id, state: 'error', error: 'binary not found' })
  expect(h.queries).toEqual([])
})

test('an untrusted session loads user settings only', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi') })
  expect(h.queries[0].options.settingSources).toEqual(['user'])
})

test('a trusted session leaves settingSources undefined', () => {
  const h = setup()
  h.m.start('/a', { content: content('hi'), trusted: true })
  expect(h.queries[0].options).not.toHaveProperty('settingSources')
})

test('isTrusted defaults to untrusted', async () => {
  const m = new SessionManager({ query: vi.fn() as never, listSessions: vi.fn(), getSessionMessages: vi.fn(), env: () => ({}) })
  expect(await m.isTrusted('/a')).toBe(false)
})

test('isTrusted asks the injected check, sync or async', async () => {
  expect(await setup({ isTrusted: (cwd) => cwd === '/a' }).m.isTrusted('/a')).toBe(true)
  expect(await setup({ isTrusted: async () => true }).m.isTrusted('/b')).toBe(true)
  expect(await setup({ isTrusted: () => false }).m.isTrusted('/a')).toBe(false)
})

test('isTrusted fails closed', async () => {
  expect(await setup({ isTrusted: async () => { throw new Error('not a git repo') } }).m.isTrusted('/gone')).toBe(false)
})

test('env keeps process.env under the login env and drops ELECTRON_RUN_AS_NODE', () => {
  vi.stubEnv('USER', 'someone')
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  try {
    const h = setup({ env: { PATH: '/x', ELECTRON_RUN_AS_NODE: '1' } })
    h.m.start('/a', { content: content('hi') })
    const env = h.queries[0].options.env
    expect(env).toMatchObject({ PATH: '/x', USER: 'someone' })
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('interrupt, setMode and setModel reach the query', async () => {
  const h = setup()
  const id = h.m.start('/a', { content: content('hi') })
  await h.m.interrupt(id)
  await h.m.setMode(id, 'acceptEdits')
  await h.m.setModel(id, 'haiku')
  expect(h.queries[0].interrupt).toHaveBeenCalledOnce()
  expect(h.queries[0].setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  expect(h.queries[0].setModel).toHaveBeenCalledWith('haiku')
})

test('list: a live session shows live:true, without a duplicate from disk', async () => {
  const h = setup({ disk: [] })
  const id = h.m.start('/a', { content: content('hi') })
  const sessionId = h.queries[0].options.sessionId as string
  h.listSessions.mockResolvedValue([
    { sessionId, summary: 'From disk', lastModified: 10, gitBranch: 'main' },
    { sessionId: 'old', summary: 'Summary', customTitle: 'Renamed', lastModified: 5 }
  ])
  expect(await h.m.list('/a')).toEqual([
    { sessionId, title: 'From disk', lastModified: 10, gitBranch: 'main', live: true, state: 'running' },
    { sessionId: 'old', title: 'Renamed', lastModified: 5, gitBranch: undefined, live: false, state: 'stopped' }
  ])
  expect(h.listSessions).toHaveBeenCalledWith({ dir: '/a', includeWorktrees: false })
  h.m.stop(id)
})

test('list: a live session not yet on disk appears first, titled by its first message', async () => {
  const h = setup({ disk: [{ sessionId: 'old', summary: 'Old', lastModified: 5 }] })
  h.m.start('/a', { content: content('fix the bug') })
  h.m.start('/other', { content: content('elsewhere') })
  const rows = await h.m.list('/a')
  expect(rows.map((r) => [r.title, r.live])).toEqual([['fix the bug', true], ['Old', false]])
  expect(rows[0].sessionId).toBe(h.queries[0].options.sessionId)
})

test('history reads the session from its project directory', async () => {
  const h = setup()
  const msgs = [{ type: 'user', uuid: 'u' }] as SessionMessage[]
  h.getSessionMessages.mockResolvedValue(msgs)
  expect(await h.m.history('/a', 'abc')).toBe(msgs)
  expect(h.getSessionMessages).toHaveBeenCalledWith('abc', { dir: '/a' })
})

test('activity takes the most urgent state among the sessions of a cwd', async () => {
  const h = setup()
  expect(h.m.activity('/a')).toBe('idle')
  const a = h.m.start('/a', { content: content('one') })
  h.m.start('/a', { content: content('two') })
  h.m.start('/b', { content: content('three') })
  expect(h.m.activity('/a')).toBe('working')
  void h.queries[0].ask('Bash', 'r1')
  expect(h.m.activity('/a')).toBe('waiting')
  expect(h.m.activity('/b')).toBe('working')
  h.m.stop(a)
  h.queries[1].emit(SUCCESS)
  await tick()
  expect(h.m.activity('/a')).toBe('idle')
})

test('stopAll closes everything', () => {
  const h = setup()
  const a = h.m.start('/a', { content: content('one') })
  const b = h.m.start('/b', { content: content('two') })
  h.m.stopAll()
  expect(h.stateOf(a)).toBe('stopped')
  expect(h.stateOf(b)).toBe('stopped')
  for (const q of h.queries) expect(q.close).toHaveBeenCalledOnce()
  expect(h.m.activity('/a')).toBe('idle')
})
