import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { attachmentNote } from '../../src/shared/attachments'
import { describe, expect, it } from 'vitest'
import { addNotice, addUser, dropLast, emptyTranscript, reduceTranscript, settle, type Transcript } from '../../src/renderer/sessions/transcript'

let uuids = 0

const SESSION = 'session-1'

function msg(m: Record<string, unknown>): SDKMessage {
  return { uuid: `u${++uuids}`, session_id: SESSION, parent_tool_use_id: null, ...m } as unknown as SDKMessage
}
const stream = (event: Record<string, unknown>): SDKMessage => msg({ type: 'stream_event', event })
const messageStart = (id: string): SDKMessage => stream({ type: 'message_start', message: { id } })
const textDelta = (index: number, text: string): SDKMessage =>
  stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const assistant = (id: string, ...content: unknown[]): SDKMessage =>
  msg({ type: 'assistant', message: { id, role: 'assistant', content } })
const user = (content: unknown, extra: Record<string, unknown> = {}): SDKMessage =>
  msg({ type: 'user', message: { role: 'user', content }, ...extra })
const toolUse = (id: string, name = 'Read', input: Record<string, unknown> = { file_path: 'a.ts' }): unknown =>
  ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown = 'ok', extra: Record<string, unknown> = {}): unknown =>
  ({ type: 'tool_result', tool_use_id: id, content, ...extra })
const emptyThinking = { type: 'thinking', thinking: '', signature: 'sig' }
const result = msg({ type: 'result', subtype: 'success', is_error: false, result: '' })

const run = (messages: (SDKMessage | SessionMessage)[], from: Transcript = emptyTranscript()): Transcript =>
  messages.reduce(reduceTranscript, from)

describe('reduceTranscript', () => {
  it('accumulates partial deltas, then the final block replaces them without a duplicate', () => {
    const streaming = run([messageStart('m1'), textDelta(0, 'Bon'), textDelta(0, 'jour')])
    expect(streaming.items).toEqual([{ kind: 'assistant', text: 'Bonjour', streaming: true }])

    const done = run([assistant('m1', { type: 'text', text: 'Bonjour !' })], streaming)
    expect(done.items).toEqual([{ kind: 'assistant', text: 'Bonjour !', streaming: false }])
  })

  it('keys blocks by message id and position: one assistant per block does not overwrite the previous', () => {
    const t = run([
      assistant('m1', { type: 'text', text: 'un' }),
      assistant('m1', { type: 'text', text: 'deux' })
    ])
    expect(t.items.map((i) => i.kind === 'assistant' && i.text)).toEqual(['un', 'deux'])
  })

  it('matches a final block to its stream position when an empty thinking block came first', () => {
    const t = run([
      messageStart('m1'),
      textDelta(1, 'parti'),
      assistant('m1', emptyThinking),
      assistant('m1', { type: 'text', text: 'partiel fini' }),
      assistant('m1', toolUse('t1'))
    ])
    expect(t.items).toHaveLength(2)
    expect(t.items[0]).toEqual({ kind: 'assistant', text: 'partiel fini', streaming: false })
    expect(t.items[1].kind).toBe('tool')
  })

  it('keeps two streamed messages apart', () => {
    const t = run([
      messageStart('m1'), textDelta(0, 'a'), assistant('m1', { type: 'text', text: 'a' }),
      messageStart('m2'), textDelta(0, 'b'), assistant('m2', { type: 'text', text: 'b' })
    ])
    expect(t.items.map((i) => i.kind === 'assistant' && i.text)).toEqual(['a', 'b'])
  })

  it('ignores empty thinking blocks', () => {
    expect(run([assistant('m1', emptyThinking)]).items).toEqual([])
  })

  it('creates a running card on tool_use and completes it on the matching tool_result', () => {
    const running = run([assistant('m1', toolUse('t1'))])
    expect(running.items).toEqual([
      { kind: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, running: true }
    ])
    const done = run([user([toolResult('t1', 'contenu')])], running)
    expect(done.items).toEqual([
      { kind: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, result: 'contenu', isError: false, running: false }
    ])
  })

  it('completes parallel tools whose results arrive out of order', () => {
    const t = run([
      assistant('m1', toolUse('t1')),
      assistant('m1', toolUse('t2')),
      user([toolResult('t2', 'deux')])
    ])
    expect(t.items.map((i) => i.kind === 'tool' && i.running)).toEqual([true, false])
    const done = run([user([toolResult('t1', 'un')])], t)
    expect(done.items.map((i) => i.kind === 'tool' && i.result)).toEqual(['un', 'deux'])
  })

  it('reads is_error, and takes its absence as false', () => {
    const t = run([
      assistant('m1', toolUse('t1')),
      assistant('m1', toolUse('t2')),
      user([toolResult('t1')]),
      user([toolResult('t2', 'boom', { is_error: true })])
    ])
    expect(t.items.map((i) => i.kind === 'tool' && i.isError)).toEqual([false, true])
  })

  it('flattens a tool_result made of content blocks', () => {
    const t = run([
      assistant('m1', toolUse('t1')),
      user([toolResult('t1', [{ type: 'text', text: 'ligne' }, { type: 'image', source: {} }])])
    ])
    expect(t.items[0]).toMatchObject({ result: 'ligne\n[image]' })
  })

  it('ignores a tool_result whose tool_use is gone, as after /compact', () => {
    expect(run([user([toolResult('gone')])]).items).toEqual([])
  })

  it('shows local command output as a notice, not as a user message', () => {
    const t = run([user('<local-command-stdout>Set model to \u001b[1mhaiku\u001b[22m</local-command-stdout>', { isReplay: true })])
    expect(t.items).toEqual([{ kind: 'notice', text: 'Set model to haiku' }])
  })

  it('shows the system form of local command output as a notice', () => {
    const t = run([msg({ type: 'system', subtype: 'local_command_output', content: 'sortie' })])
    expect(t.items).toEqual([{ kind: 'notice', text: 'sortie' }])
  })

  it('never shows synthetic or replayed user text as a user message', () => {
    const t = run([
      user([{ type: 'text', text: 'Base directory for this skill' }], { isSynthetic: true }),
      user('rejoué', { isReplay: true })
    ])
    expect(t.items).toEqual([])
  })

  it('recognizes in history, by text alone, what must not read as a user message', () => {
    const t = run([
      user('<command-name>/context</command-name>\n<command-args></command-args>'),
      user('<command-message>context</command-message>\n<command-name>/context</command-name>'),
      user('<local-command-caveat>Caveat: ignore</local-command-caveat>'),
      user('<local-command-stdout></local-command-stdout>'),
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      user('Skill /loop is already loaded above'),
      user('This session is being continued from a previous conversation that ran out of context.')
    ])
    expect(t.items).toEqual([
      { kind: 'notice', text: 'Commande /context' },
      { kind: 'notice', text: 'Commande /context' },
      { kind: 'notice', text: 'Interrompu.' },
      { kind: 'notice', text: 'Conversation reprise depuis son résumé.' }
    ])
  })

  it('turns compact_boundary into a notice', () => {
    const t = run([msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1 } })])
    expect(t.items).toEqual([{ kind: 'notice', text: 'Conversation compactée.' }])
  })

  it('ignores a repeated system/init', () => {
    const init = msg({ type: 'system', subtype: 'init', tools: [] })
    const before = run([assistant('m1', { type: 'text', text: 'a' })])
    expect(run([init, init], before).items).toEqual(before.items)
  })

  it('ignores an unknown message without failing', () => {
    expect(run([msg({ type: 'quelque_chose' }), msg({ type: 'system', subtype: 'inconnu' }), stream({ type: 'ping' })]).items).toEqual([])
  })

  it('leaves subagent messages to their Agent card', () => {
    const t = run([msg({ type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'm9', content: [{ type: 'text', text: 'sous-agent' }] } })])
    expect(t.items).toEqual([])
  })

  it('reports the elapsed time of a running tool, and drops it on completion', () => {
    const running = run([
      assistant('m1', toolUse('t1', 'Bash', { command: 'sleep 9' })),
      msg({ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 12 })
    ])
    expect(running.items[0]).toMatchObject({ running: true, elapsed: 12 })
    expect(run([user([toolResult('t1')])], running).items[0]).not.toHaveProperty('elapsed')
  })

  it('stops every streaming text and running tool on result, as after an interruption', () => {
    const t = run([messageStart('m1'), textDelta(0, 'coupé'), assistant('m2', toolUse('t1')), result])
    expect(t.items).toEqual([
      { kind: 'assistant', text: 'coupé', streaming: false },
      { kind: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, running: false }
    ])
  })

  it('does not change its input', () => {
    const before = run([messageStart('m1'), textDelta(0, 'a')])
    const copy = structuredClone(before)
    run([textDelta(0, 'b'), assistant('m1', { type: 'text', text: 'ab' }), result], before)
    expect(before).toEqual(copy)
  })
})

describe('history and stream', () => {
  const images = [{ mediaType: 'image/png', base64: 'AAAA' }]

  it('give the same items once the user item is added', () => {
    const fromStream = run([
      messageStart('m1'),
      textDelta(1, 'Je '),
      textDelta(1, 'lis.'),
      msg({ type: 'system', subtype: 'init', tools: [] }),
      assistant('m1', emptyThinking),
      assistant('m1', { type: 'text', text: 'Je lis.' }),
      assistant('m1', toolUse('t1')),
      // Only the stream has tool_use_result.
      user([toolResult('t1', 'contenu')], { tool_use_result: { file: {} } }),
      messageStart('m2'),
      textDelta(0, 'Fini'),
      assistant('m2', { type: 'text', text: 'Fini.' }),
      result
    ], addUser(emptyTranscript(), { text: 'Lis a.ts', images }))

    const history = [
      { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: 'Lis a.ts' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
      ] } },
      { type: 'assistant', message: { id: 'm1', content: [emptyThinking] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Je lis.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [toolUse('t1')] } },
      { type: 'user', message: { role: 'user', content: [toolResult('t1', 'contenu')] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Fini.' }] } }
    ].map((m) => ({ uuid: `u${++uuids}`, session_id: SESSION, parent_tool_use_id: null, parent_agent_id: null, ...m })) as SessionMessage[]

    expect(settle(run(history)).items).toEqual(fromStream.items)
  })
})

describe('documents', () => {
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' }, title: 'spec.pdf' }

  it('show by name, with the note for Claude hidden', () => {
    const t = run([user([
      { type: 'text', text: 'Lis la spec' },
      pdf,
      { type: 'text', text: attachmentNote('spec.pdf', '/tmp/x/spec.pdf') }
    ])])
    expect(t.items).toEqual([{ kind: 'user', text: 'Lis la spec', images: [], documents: [{ name: 'spec.pdf' }] }])
  })

  it('a document sent alone still makes a user item', () => {
    expect(run([user([pdf])]).items).toEqual([{ kind: 'user', text: '', images: [], documents: [{ name: 'spec.pdf' }] }])
  })

  it('addUser shows the names of the documents sent', () => {
    expect(addUser(emptyTranscript(), { text: 'lis', documents: [{ name: 'spec.pdf', base64: 'AAAA' }] }).items)
      .toEqual([{ kind: 'user', text: 'lis', images: [], documents: [{ name: 'spec.pdf' }] }])
  })
})

describe('transcript helpers', () => {
  it('addUser keeps the text and images, with no images by default', () => {
    expect(addUser(emptyTranscript(), { text: 'salut' }).items).toEqual([{ kind: 'user', text: 'salut', images: [] }])
  })

  it('addNotice appends a notice', () => {
    expect(addNotice(emptyTranscript(), 'attention').items).toEqual([{ kind: 'notice', text: 'attention' }])
  })

  it('dropLast removes the given item if it is still the last one', () => {
    const t = addUser(emptyTranscript(), { text: 'salut' })
    expect(dropLast(t, t.items[0]).items).toEqual([])
    expect(dropLast(addNotice(t, 'après'), t.items[0]).items).toHaveLength(2)
  })

  it('settle returns the same transcript when nothing is in progress', () => {
    const t = addUser(emptyTranscript(), { text: 'salut' })
    expect(settle(t)).toBe(t)
  })
})

describe('a message the CLI sends again', () => {
  const text = 'Context Usage'
  const assistant = (uuid: string, id: string, t = text): SDKMessage =>
    ({ type: 'assistant', uuid, session_id: 's', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: t }] } }) as unknown as SDKMessage

  it('shows once what /compact repeats under the same uuid and a new id', () => {
    const t = [assistant('u1', 'first'), assistant('u1', 'second')].reduce(reduceTranscript, emptyTranscript())
    expect(t.items.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })

  it('still shows two messages with the same text', () => {
    const t = [assistant('u1', 'a'), assistant('u2', 'b')].reduce(reduceTranscript, emptyTranscript())
    expect(t.items.filter((i) => i.kind === 'assistant')).toHaveLength(2)
  })

  it('still adds the blocks of one message that arrive under one uuid', () => {
    const t = [assistant('u1', 'a', 'un'), assistant('u1', 'a', 'deux')].reduce(reduceTranscript, emptyTranscript())
    expect(t.items.filter((i) => i.kind === 'assistant')).toHaveLength(2)
  })
})
