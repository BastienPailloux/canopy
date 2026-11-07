import { randomUUID } from 'node:crypto'
import type { Options, PermissionResult, Query, query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Test-only stand-in for the SDK's `query`, so E2E tests run no real session.
 * It mimics the observed stream: one `assistant` per block, no echo of the user's message, `system/init` on each turn.
 * The first word of a message picks the scenario, see `turn`.
 */

const STEP_MS = 60
const LONG_TURNS = 400
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

interface Turn {
  options: Options
  sessionId: string
  signal: AbortSignal
}

function base(sessionId: string): { uuid: string; session_id: string; parent_tool_use_id: null } {
  return { uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null }
}

const as = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage

function initMessage(t: Turn): SDKMessage {
  return as({ ...base(t.sessionId), type: 'system', subtype: 'init', tools: [], terminal_slash_commands: ['doctor'] })
}

function resultMessage(t: Turn): SDKMessage {
  return t.signal.aborted
    ? as({ ...base(t.sessionId), type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: [] })
    : as({ ...base(t.sessionId), type: 'result', subtype: 'success', is_error: false, result: '' })
}

function assistant(t: Turn, id: string, block: Record<string, unknown>): SDKMessage {
  return as({ ...base(t.sessionId), type: 'assistant', message: { id, role: 'assistant', content: [block] } })
}

function toolResult(t: Turn, toolUseId: string, content: string, isError: boolean): SDKMessage {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }
  return as({ ...base(t.sessionId), type: 'user', message: { role: 'user', content: [block] } })
}

async function* streamText(t: Turn, words: string[], stepMs: number): AsyncGenerator<SDKMessage> {
  const id = randomUUID()
  const stream = (event: Record<string, unknown>): SDKMessage => as({ ...base(t.sessionId), type: 'stream_event', event })
  yield stream({ type: 'message_start', message: { id } })
  let text = ''
  for (const word of words) {
    if (t.signal.aborted) return
    text += word
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } })
    if (stepMs > 0) await pause(stepMs)
  }
  yield assistant(t, id, { type: 'text', text })
}

async function ask(t: Turn, toolName: string, input: Record<string, unknown>, suggestions: unknown[]): Promise<PermissionResult> {
  const id = randomUUID()
  const decision = await t.options.canUseTool!(toolName, input, {
    signal: t.signal,
    toolUseID: id,
    requestId: randomUUID(),
    suggestions,
    description: `Fake ${toolName}`
  } as unknown as Parameters<NonNullable<Options['canUseTool']>>[2])
  return decision ?? { behavior: 'deny', message: 'Aucune décision.' }
}

async function* useTool(t: Turn, name: string, input: Record<string, unknown>, suggestions: unknown[], output: string): AsyncGenerator<SDKMessage> {
  const id = randomUUID()
  yield assistant(t, randomUUID(), { type: 'tool_use', id, name, input })
  const decision = await ask(t, name, input, suggestions)
  if (t.signal.aborted) return
  const denied = decision.behavior === 'deny'
  const answered = name === 'AskUserQuestion' && !denied
    ? `Réponses : ${JSON.stringify(decision.updatedInput?.answers)}`
    : output
  yield toolResult(t, id, denied ? decision.message : answered, denied)
  yield* streamText(t, [denied ? 'Refus reçu.' : 'Outil terminé.'], 0)
}

const BASH_RULE = { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] }

const QUESTIONS = {
  questions: [
    { question: 'Quelle couleur ?', header: 'Couleur', multiSelect: false, options: [{ label: 'Rouge', description: 'Chaud' }, { label: 'Bleu', description: 'Froid' }] },
    { question: 'Quelles tailles ?', header: 'Tailles', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }, { label: 'L', description: '' }] }
  ]
}

async function* turn(t: Turn, text: string): AsyncGenerator<SDKMessage> {
  yield initMessage(t)
  const scenario = text.split(/\s/)[0]
  if (scenario === 'lent') {
    yield* streamText(t, Array.from({ length: 40 }, (_, i) => `mot${i + 1} `), STEP_MS)
  } else if (scenario === 'outil') {
    yield* useTool(t, 'Bash', { command: 'ls -la' }, [BASH_RULE], 'total 0')
  } else if (scenario === 'ecrire') {
    yield* useTool(t, 'Write', { file_path: 'note.txt', content: 'bonjour\n' }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'ok')
  } else if (scenario === 'question') {
    yield* useTool(t, 'AskUserQuestion', QUESTIONS, [], '')
  } else if (scenario === 'erreur') {
    throw new Error('panne simulée')
  } else if (scenario === 'long') {
    for (let i = 1; i <= LONG_TURNS; i++) yield* streamText(t, [`Réponse ${i}`], 0)
  } else {
    yield* streamText(t, ['Réponse ', 'à : ', text], 0)
  }
  yield resultMessage(t)
}

const COMMANDS = [
  { name: 'compact', description: 'Résume la conversation', argumentHint: '' },
  { name: 'context', description: 'Affiche le contexte', argumentHint: '' }
]
const MODELS = [
  { value: 'default', displayName: 'Par défaut', description: '' },
  { value: 'haiku', displayName: 'Haiku', description: '' }
]

const messageText = (m: SDKUserMessage): string => {
  const { content } = m.message
  if (typeof content === 'string') return content
  return (content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : [])).join('\n')
}

export const fakeQuery: typeof query = ({ prompt, options = {} }) => {
  const sessionId = options.resume ?? options.sessionId ?? randomUUID()
  let controller = new AbortController()

  async function* run(): AsyncGenerator<SDKMessage, void> {
    for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
      controller = new AbortController()
      yield* turn({ options, sessionId, signal: controller.signal }, messageText(message))
    }
  }

  const generator = run()
  const extra = {
    interrupt: async () => { controller.abort() },
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    supportedCommands: async () => [...COMMANDS, { name: 'doctor', description: '', argumentHint: '' }, { name: '__internal', description: '', argumentHint: '' }],
    supportedModels: async () => MODELS,
    close: () => { controller.abort() }
  }
  return Object.assign(generator, extra) as unknown as Query
}

/** The real `query`, unless a test asked for the fake. A packaged app ignores that request. */
export function selectQuery(real: typeof query, o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): typeof query {
  return !o.isPackaged && o.env.CANOPY_FAKE_QUERY ? fakeQuery : real
}
