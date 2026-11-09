import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createCanopyServer } from '../../../src/main/mcp/canopyServer'
import type { CanopyToolDeps } from '../../../src/main/mcp/canopyTools'

let client: Client
let deps: CanopyToolDeps

beforeEach(async () => {
  deps = {
    repoRoot: '/repo',
    mode: () => 'default',
    tickets: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      children: vi.fn(async () => []),
      create: vi.fn(async (_root: string, f: { title: string }) => ({ id: 'CAN-9', ...f })),
      patch: vi.fn(),
    } as unknown as CanopyToolDeps['tickets'],
    mockups: { list: vi.fn(async () => ({ kind: 'ok', mockups: [] })), add: vi.fn(), patch: vi.fn() } as unknown as CanopyToolDeps['mockups'],
    linear: { connection: () => ({ state: 'disconnected', missingTools: [] }) } as unknown as CanopyToolDeps['linear'],
    edits: { save: vi.fn(), pending: () => [] },
    sync: { state: () => ({ issues: [] }) as never, refresh: vi.fn() },
  }
  const server = createCanopyServer(deps)
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.instance.connect(a), client.connect(b)])
})
afterEach(() => client.close())

const text = (r: Awaited<ReturnType<Client['callTool']>>): string => (r.content as { type: string; text: string }[])[0].text

test('the canopy server lists the six tools, read ones annotated read-only, always loaded', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual(['create_ticket', 'get_ticket', 'link_mockup', 'list_mockups', 'list_tickets', 'update_ticket'])
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()
  expect(readOnly).toEqual(['get_ticket', 'list_mockups', 'list_tickets'])
  expect(tools.every((t) => t._meta?.['anthropic/alwaysLoad'] === true)).toBe(true)
  const create = tools.find((t) => t.name === 'create_ticket')!
  expect(create.description).toContain('required when the user has no assigned Linear issue and no parent is given')
  expect(Object.keys(create.inputSchema.properties ?? {}).sort()).toEqual(['description', 'labels', 'parent', 'priority', 'source', 'status', 'team', 'title'])
  expect(tools.find((t) => t.name === 'update_ticket')!.description).toContain('Only Linear issues assigned to the user or created in this session can be changed.')
})

test('a thrown error comes back as an error result with its French message', async () => {
  const r = await client.callTool({ name: 'get_ticket', arguments: { key: 'bad' } })
  expect(r.isError).toBe(true)
  expect(text(r)).toBe('Clé de ticket invalide : bad')
})

test('a successful call returns its value as JSON text', async () => {
  const r = await client.callTool({ name: 'create_ticket', arguments: { source: 'local', title: 'New' } })
  expect(r.isError).toBeFalsy()
  expect(JSON.parse(text(r))).toEqual({ key: 'local:CAN-9' })
  expect(deps.tickets.create).toHaveBeenCalledWith('/repo', expect.objectContaining({ title: 'New' }))
})

test('the plan-mode guard still applies through the server', async () => {
  deps.mode = () => 'plan'
  const r = await client.callTool({ name: 'create_ticket', arguments: { source: 'local', title: 'New' } })
  expect(r.isError).toBe(true)
  expect(text(r)).toMatch(/^Mode plan/)
})
