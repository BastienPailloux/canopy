import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { PRIORITIES } from '../../shared/tickets'
import { MOCKUP_STATUSES } from '../../shared/mockups'
import { createCanopyTools, type CanopyToolDeps, type CanopyToolName } from './canopyTools'

const KEY = 'Ticket key: `local:CAN-4` for a local ticket, `linear:ENG-482` for a Linear one.'

const DESCRIPTIONS: Record<CanopyToolName, string> = {
  list_tickets:
    'Lists the tickets of this repo: local ones (`.tickets/`) and the Linear issues assigned to the user. ' +
    '`query` searches, ignoring case and accents, the title and description of local tickets and the title and labels of Linear ones. ' +
    'Done and canceled tickets are left out unless `includeDone`. Always search here before creating a ticket, to avoid a duplicate, ' +
    'then open the candidates with `get_ticket`: Linear rows carry no description.',
  get_ticket:
    `Reads one ticket in full: description, parent, children, linked mockups, and for Linear the statuses and labels of its team. ${KEY} ` +
    'Linked mockups are claude.ai artifacts: read them with the `Artifact` tool and compare them with the ticket and the code. ' +
    'A mockup may be outdated or not feasible: report a mismatch in the conversation, write it in the ticket if useful, ' +
    'and never edit a mockup unless the user asks.',
  list_mockups: 'Lists the mockups of this repo (claude.ai artifacts), optionally those of one local ticket (`ticket`) or the unlinked ones.',
  create_ticket:
    'Creates a ticket, or a sub-ticket with `parent` (a key of the same source). Search with `list_tickets` first to avoid a duplicate. ' +
    'Local statuses: backlog, todo, in_progress, in_review, done; a Linear status is given by its name. ' +
    'A Linear issue is assigned to the user and goes in the team of its parent, else the only team of the user\'s issues, ' +
    'else the one named by `team` (Linear team name), which is required when the user has no assigned Linear issue and no parent is given. Returns the new key.',
  update_ticket:
    `Changes the given fields of a ticket. ${KEY} \`description\` is the full wanted text, not a diff; \`labels\` is the full wanted set. ` +
    '`parent` (a key, or null to detach) is for local tickets only. Linear edits are queued and sent like the user\'s; the result says if they were sent. ' +
    'Only Linear issues assigned to the user or created in this session can be changed.',
  link_mockup:
    'Links a mockup (id or claude.ai artifact URL, added to the registry if new) to a local ticket, unlinks it with `ticket: null`, ' +
    'or changes its status.',
}

const READ_ONLY: CanopyToolName[] = ['list_tickets', 'get_ticket', 'list_mockups']

const key = z.string().describe(KEY)

const SHAPES = {
  list_tickets: {
    query: z.string().optional(),
    source: z.enum(['local', 'linear']).optional(),
    status: z.string().optional(),
    includeDone: z.boolean().optional(),
  },
  get_ticket: { key },
  list_mockups: {
    ticket: z.string().optional().describe('Local ticket key.'),
    unlinked: z.boolean().optional(),
  },
  create_ticket: {
    source: z.enum(['local', 'linear']),
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
    labels: z.array(z.string()).optional(),
    status: z.string().optional(),
    parent: z.string().nullable().optional().describe('Key of the parent ticket, same source.'),
    team: z.string().optional().describe('Linear team name: required when the user has no assigned Linear issue and no parent is given.'),
  },
  update_ticket: {
    key,
    title: z.string().optional(),
    description: z.string().optional().describe('Full wanted text.'),
    status: z.string().optional(),
    priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
    labels: z.array(z.string()).optional().describe('Full wanted set.'),
    parent: z.string().nullable().optional().describe('Local parent key, or null to detach. Local tickets only.'),
  },
  link_mockup: {
    mockup: z.string().describe('Mockup id or claude.ai artifact URL.'),
    ticket: z.string().nullable().optional().describe('Local ticket key, or null to unlink.'),
    status: z.enum(MOCKUP_STATUSES as [string, ...string[]]).optional(),
  },
} satisfies Record<CanopyToolName, z.ZodRawShape>

async function run(handler: (args: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await handler(args)) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

/** The `canopy` MCP server of one session: thin SDK wiring over `createCanopyTools`. */
export function createCanopyServer(deps: CanopyToolDeps): McpSdkServerConfigWithInstance {
  const handlers = createCanopyTools(deps)
  const names = Object.keys(SHAPES) as CanopyToolName[]
  return createSdkMcpServer({
    name: 'canopy',
    // Claude must see them without searching for tools, or it would never think of them.
    alwaysLoad: true,
    tools: names.map((name) => tool(name, DESCRIPTIONS[name], SHAPES[name], (args) => run(handlers[name], args as Record<string, unknown>), {
      ...(READ_ONLY.includes(name) ? { annotations: { readOnlyHint: true } } : {}),
    })),
  })
}
