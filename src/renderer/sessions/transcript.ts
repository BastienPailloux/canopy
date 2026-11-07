import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { UserContent } from '../../shared/types'

export type UserImage = NonNullable<UserContent['images']>[number]

export type TranscriptItem =
  | { kind: 'user'; text: string; images: UserImage[] }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
    kind: 'tool'
    id: string
    name: string
    input: Record<string, unknown>
    result?: string
    isError?: boolean
    running: boolean
    /** Seconds, while running, when the SDK reports it. */
    elapsed?: number
  }
  | { kind: 'notice'; text: string }

export interface Transcript {
  items: TranscriptItem[]
  /** Index in `items` of each block, by `message.id:position`. */
  blocks: Record<string, number>
  /** Blocks met so far per `message.id`: the SDK sends one `assistant` per block, each holding only that block. */
  blockCounts: Record<string, number>
  /** The `message.id` each assistant uuid came with, to see a message sent again. */
  assistantIds: Record<string, string>
  /** Index in `items` of each tool, by tool_use id. */
  tools: Record<string, number>
  /** Message being streamed: stream events only carry the block position. */
  streamId?: string
}

/** Stream and history share these fields, the rest depends on the message. */
interface LooseMessage {
  type?: string
  uuid?: string
  subtype?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  isReplay?: boolean
  content?: unknown
  tool_use_id?: string
  elapsed_time_seconds?: number
  event?: StreamEvent
  message?: { id?: string; content?: unknown }
}

interface StreamEvent {
  type?: string
  index?: number
  delta?: { type?: string; text?: string }
  message?: { id?: string }
}

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { media_type?: string; data?: string }
}

export const emptyTranscript = (): Transcript => ({ items: [], blocks: {}, blockCounts: {}, assistantIds: {}, tools: {} })

const asBlocks = (content: unknown): Block[] => {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

function resultText(content: unknown): string {
  return asBlocks(content).map((b) => (b.type === 'text' ? b.text ?? '' : `[${b.type ?? 'contenu'}]`)).join('\n')
}

function append(t: Transcript, item: TranscriptItem): Transcript {
  return { ...t, items: [...t.items, item] }
}

/** Replaces the item at `index`. */
function replace(t: Transcript, index: number, item: TranscriptItem): Transcript {
  const items = t.items.slice()
  items[index] = item
  return { ...t, items }
}

/** Replaces the block's item if it has one, else appends it and records where. */
function putBlock(t: Transcript, key: string, item: TranscriptItem): Transcript {
  const index = t.blocks[key]
  if (index !== undefined) return replace(t, index, item)
  return { ...append(t, item), blocks: { ...t.blocks, [key]: t.items.length } }
}

function onStreamEvent(t: Transcript, event: StreamEvent | undefined): Transcript {
  if (event?.type === 'message_start') return { ...t, streamId: event.message?.id }
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta' || !t.streamId) return t
  const key = `${t.streamId}:${event.index ?? 0}`
  const index = t.blocks[key]
  const current = index === undefined ? undefined : t.items[index]
  const text = (current?.kind === 'assistant' ? current.text : '') + (event.delta.text ?? '')
  return putBlock(t, key, { kind: 'assistant', text, streaming: true })
}

function onAssistant(t: Transcript, message: LooseMessage['message'], uuid: string | undefined): Transcript {
  const id = message?.id ?? ''
  // After /compact the CLI sends the last message again: same uuid, new id. Blocks of one message share both.
  if (uuid !== undefined && t.assistantIds[uuid] !== undefined && t.assistantIds[uuid] !== id) return t
  let next = t
  let position = t.blockCounts[id] ?? 0
  for (const block of asBlocks(message?.content)) {
    const key = `${id}:${position++}`
    if (block.type === 'text' && block.text) {
      next = putBlock(next, key, { kind: 'assistant', text: block.text, streaming: false })
    } else if (block.type === 'tool_use' && block.id) {
      next = putBlock(next, key, { kind: 'tool', id: block.id, name: block.name ?? '', input: block.input ?? {}, running: true })
      next = { ...next, tools: { ...next.tools, [block.id]: next.blocks[key] } }
    }
  }
  return {
    ...next,
    blockCounts: { ...next.blockCounts, [id]: position },
    assistantIds: uuid === undefined ? next.assistantIds : { ...next.assistantIds, [uuid]: id }
  }
}

function completeTool(t: Transcript, block: Block): Transcript {
  const index = t.tools[block.tool_use_id ?? '']
  const item = index === undefined ? undefined : t.items[index]
  if (item?.kind !== 'tool') return t
  const { elapsed: _elapsed, ...tool } = item
  return replace(t, index, { ...tool, result: resultText(block.content), isError: block.is_error === true, running: false })
}

const LOCAL_OUTPUT = /^\s*<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/
const COMMAND = /^\s*<command-(?:name|message)>/
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/
const INTERRUPTED = /^\s*\[Request interrupted by user/
const CONTINUED = /^\s*This session is being continued from a previous conversation/
const HIDDEN = [/^\s*<local-command-caveat>/, /^\s*Skill \/\S+ is already loaded above/]

/**
 * What a user message that is not the user's own words shows as: a notice text, or `''` for nothing.
 * Undefined for a real message. History has no `isSynthetic` or `isReplay`: only the text tells.
 */
function hostText(text: string): string | undefined {
  const output = LOCAL_OUTPUT.exec(text)
  if (output) return stripAnsi(output[1]).trim()
  if (COMMAND.test(text)) return `Commande ${COMMAND_NAME.exec(text)?.[1] ?? ''}`.trim()
  if (INTERRUPTED.test(text)) return 'Interrompu.'
  if (CONTINUED.test(text)) return 'Conversation reprise depuis son résumé.'
  return HIDDEN.some((re) => re.test(text)) ? '' : undefined
}

function onUser(t: Transcript, msg: LooseMessage): Transcript {
  const blocks = asBlocks(msg.message?.content)
  const next = blocks.filter((b) => b.type === 'tool_result').reduce(completeTool, t)

  const text = blocks.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n')
  const images = blocks.flatMap((b): UserImage[] =>
    b.type === 'image' && b.source?.data ? [{ mediaType: b.source.media_type ?? 'image/png', base64: b.source.data }] : [])
  if (text === '' && images.length === 0) return next

  const notice = hostText(text)
  if (notice !== undefined) return notice === '' ? next : addNotice(next, notice)
  if (msg.isSynthetic || msg.isReplay) return next
  return append(next, { kind: 'user', text, images })
}

function onSystem(t: Transcript, msg: LooseMessage): Transcript {
  if (msg.subtype === 'compact_boundary') return addNotice(t, 'Conversation compactée.')
  if (msg.subtype !== 'local_command_output' || typeof msg.content !== 'string') return t
  const text = stripAnsi(msg.content).trim()
  return text === '' ? t : addNotice(t, text)
}

function onToolProgress(t: Transcript, msg: LooseMessage): Transcript {
  const index = t.tools[msg.tool_use_id ?? '']
  const item = index === undefined ? undefined : t.items[index]
  if (item?.kind !== 'tool' || !item.running) return t
  return replace(t, index, { ...item, elapsed: msg.elapsed_time_seconds })
}

/** Folds one message of the stream or of the history into the transcript. Unknown messages change nothing. */
export function reduceTranscript(state: Transcript, msg: SDKMessage | SessionMessage): Transcript {
  const m = msg as LooseMessage
  // A subagent's work is summed up by its Agent card, as in the CLI.
  if (m.parent_tool_use_id) return state
  switch (m.type) {
    case 'stream_event': return onStreamEvent(state, m.event)
    case 'assistant': return onAssistant(state, m.message, m.uuid)
    case 'user': return onUser(state, m)
    case 'system': return onSystem(state, m)
    case 'tool_progress': return onToolProgress(state, m)
    case 'result': return settle(state)
    default: return state
  }
}

/** The stream does not echo what is sent, so the composer adds it. */
export function addUser(t: Transcript, content: UserContent): Transcript {
  return append(t, { kind: 'user', text: content.text, images: content.images ?? [] })
}

export function addNotice(t: Transcript, text: string): Transcript {
  return append(t, { kind: 'notice', text })
}

/** Takes back what was added for a message that was not sent. Nothing can follow it then. */
export function dropLast(t: Transcript, item: TranscriptItem | undefined): Transcript {
  return item !== undefined && t.items.at(-1) === item ? { ...t, items: t.items.slice(0, -1) } : t
}

/** Nothing is in progress any more: the turn ended, whether or not each block got its last message. */
export function settle(t: Transcript): Transcript {
  const inProgress = (i: TranscriptItem): boolean => (i.kind === 'assistant' && i.streaming) || (i.kind === 'tool' && i.running)
  if (!t.items.some(inProgress)) return t
  return {
    ...t,
    items: t.items.map((i): TranscriptItem => {
      if (i.kind === 'assistant' && i.streaming) return { ...i, streaming: false }
      if (i.kind !== 'tool' || !i.running) return i
      const { elapsed: _elapsed, ...tool } = i
      return { ...tool, running: false }
    })
  }
}
