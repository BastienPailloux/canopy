import type { query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { fakeQuery, selectQuery } from '../../../src/main/sessions/fakeQuery'

const real = (() => { throw new Error('not called') }) as unknown as typeof query

describe('selectQuery', () => {
  it('uses the real query without the variable', () => {
    expect(selectQuery(real, { isPackaged: false, env: {} })).toBe(real)
    expect(selectQuery(real, { isPackaged: false, env: { CANOPY_FAKE_QUERY: '' } })).toBe(real)
  })

  it('selects the fake with the variable in development', () => {
    expect(selectQuery(real, { isPackaged: false, env: { CANOPY_FAKE_QUERY: '1' } })).toBe(fakeQuery)
  })

  it('never selects the fake in a packaged app', () => {
    expect(selectQuery(real, { isPackaged: true, env: { CANOPY_FAKE_QUERY: '1' } })).toBe(real)
  })
})

describe('canopy scenario', () => {
  async function* prompt(text: string): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage
  }

  async function run(text: string, mcpServers: Record<string, unknown>): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = []
    for await (const m of fakeQuery({ prompt: prompt(text), options: { mcpServers } as never })) out.push(m as never)
    return out
  }

  function stub(): { instance: McpServer; calls: unknown[] } {
    const calls: unknown[] = []
    const instance = new McpServer({ name: 'canopy', version: '1' })
    instance.registerTool('list_tickets', { inputSchema: { query: z.string().optional() } }, async (args) => {
      calls.push(args)
      return { content: [{ type: 'text' as const, text: 'two tickets' }] }
    })
    instance.registerTool('boom', {}, async () => ({ isError: true, content: [{ type: 'text' as const, text: 'nope' }] }))
    return { instance, calls }
  }

  it('calls the tool and yields its tool_use then its tool_result', async () => {
    const { instance, calls } = stub()
    const messages = await run('canopy list_tickets {"query":"csv"}', { canopy: { type: 'sdk', name: 'canopy', instance } })
    const use = messages.flatMap((m) => m.message?.content ?? []).find((b: any) => b.type === 'tool_use')
    expect(use.name).toBe('mcp__canopy__list_tickets')
    expect(use.input).toEqual({ query: 'csv' })
    const result = messages.flatMap((m) => m.message?.content ?? []).find((b: any) => b.type === 'tool_result')
    expect(result).toMatchObject({ tool_use_id: use.id, content: 'two tickets' })
    expect(result.is_error).toBeUndefined()
    expect(calls).toEqual([{ query: 'csv' }])
    expect(messages.at(-1)!.type).toBe('result')
    expect(messages[0].mcp_servers).toEqual([{ name: 'canopy', status: 'connected' }])
  })

  it('flags an error result', async () => {
    const { instance } = stub()
    const messages = await run('canopy boom', { canopy: { type: 'sdk', name: 'canopy', instance } })
    const result = messages.flatMap((m) => m.message?.content ?? []).find((b: any) => b.type === 'tool_result')
    expect(result).toMatchObject({ content: 'nope', is_error: true })
  })

  it('connects once for several turns', async () => {
    const { instance, calls } = stub()
    async function* two(): AsyncGenerator<SDKUserMessage> {
      yield* prompt('canopy list_tickets {}')
      yield* prompt('canopy list_tickets {}')
    }
    for await (const _ of fakeQuery({ prompt: two(), options: { mcpServers: { canopy: { type: 'sdk', name: 'canopy', instance } } } as never })) void _
    expect(calls).toHaveLength(2)
  })
})
