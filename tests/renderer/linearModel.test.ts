import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ticketKey, parseTicketKey } from '../../src/shared/tickets'
import {
  statusGroup, priorityFromValue, linearBranchName, readableDescription, linearLaunchPrompt, LINEAR_MCP_NOTE,
  type LinearIssue,
} from '../../src/shared/linear'

function fixtureDescription(name: string): string {
  const raw = JSON.parse(readFileSync(`tests/fixtures/linear/${name}`, 'utf8'))
  return JSON.parse(raw.content[0].text).description
}

describe('statusGroup', () => {
  it('maps every type', () => {
    expect(statusGroup({ type: 'triage', name: 'Triage' })).toBe('backlog')
    expect(statusGroup({ type: 'backlog', name: 'Backlog' })).toBe('backlog')
    expect(statusGroup({ type: 'unstarted', name: 'Todo' })).toBe('todo')
    expect(statusGroup({ type: 'started', name: 'In Progress' })).toBe('in_progress')
    expect(statusGroup({ type: 'started', name: 'In Review' })).toBe('in_review')
    expect(statusGroup({ type: 'started', name: 'QA' })).toBe('in_review')
    expect(statusGroup({ type: 'started', name: 'Code revue' })).toBe('in_review')
    expect(statusGroup({ type: 'completed', name: 'Done' })).toBe('done')
    expect(statusGroup({ type: 'canceled', name: 'Canceled' })).toBeNull()
  })
})

describe('priorityFromValue', () => {
  it('maps 0-4 and falls back to none', () => {
    expect([0, 1, 2, 3, 4, 7].map(priorityFromValue)).toEqual(['none', 'urgent', 'high', 'medium', 'low', 'none'])
  })
})

describe('linearBranchName', () => {
  it('builds type/id-slug', () => {
    const i = { id: 'ENG-482', title: 'Export CSV des factures' }
    expect(linearBranchName(i)).toBe('feat/eng-482-export-csv-des-factures')
    expect(linearBranchName(i, 'fix')).toBe('fix/eng-482-export-csv-des-factures')
  })
})

describe('readableDescription', () => {
  it('turns an image tag into markdown', () => {
    expect(readableDescription('<linear-image>{"type":"image","attrs":{"src":"https://u/x","title":"a.png"}}</linear-image>'))
      .toBe('![a.png](https://u/x)')
  })
  it('turns a video embed into a link', () => {
    expect(readableDescription('a <linear-embed node-type="video">{"src":"https://u/v","title":"v.mp4"}</linear-embed> b'))
      .toBe('a [vidéo : v.mp4](https://u/v) b')
  })
  it('turns other embeds into a file link', () => {
    expect(readableDescription('<linear-embed node-type="file">{"src":"https://u/f","title":"f.pdf"}</linear-embed>'))
      .toBe('[fichier : f.pdf](https://u/f)')
  })
  it('leaves malformed or src-less tags untouched', () => {
    const bad = '<linear-image>{not json</linear-image>'
    const noSrc = '<linear-embed node-type="video">{"title":"x"}</linear-embed>'
    expect(readableDescription(bad)).toBe(bad)
    expect(readableDescription(noSrc)).toBe(noSrc)
  })
  it('handles the real tags of CAN-1 and CAN-3', () => {
    const d1 = readableDescription(fixtureDescription('get_issue_CAN-1.json'))
    expect(d1).toContain('[vidéo : LinearH264Version_1.mp4](https://uploads.linear.app/')
    expect(d1).toContain('![contactlinear (1).gif](https://uploads.linear.app/')
    expect(d1).not.toContain('<linear-')
    expect(readableDescription(fixtureDescription('get_issue_CAN-3.json'))).not.toContain('<linear-image>')
  })
})

describe('linearLaunchPrompt', () => {
  const issue = {
    id: 'ENG-482', title: 'Export', url: 'https://linear.app/x/issue/ENG-482', description: 'Do <linear-image>{"attrs":{"src":"https://u/x","title":"a"}}</linear-image>',
  } as LinearIssue
  it('assembles the prompt', () => {
    expect(linearLaunchPrompt(issue)).toBe(
      'Ticket ENG-482 : Export\nhttps://linear.app/x/issue/ENG-482\n\nDo ![a](https://u/x)\n\n' + LINEAR_MCP_NOTE)
  })
  it('drops an empty description', () => {
    expect(linearLaunchPrompt({ ...issue, description: '  ' })).toBe(
      'Ticket ENG-482 : Export\nhttps://linear.app/x/issue/ENG-482\n\n' + LINEAR_MCP_NOTE)
  })
})

describe('ticketKey', () => {
  it('round-trips', () => {
    expect(parseTicketKey(ticketKey('linear', 'ENG-482'))).toEqual({ source: 'linear', id: 'ENG-482' })
    expect(parseTicketKey(ticketKey('local', 'CAN-1'))).toEqual({ source: 'local', id: 'CAN-1' })
    expect(parseTicketKey('nope')).toBeNull()
    expect(parseTicketKey('github:1')).toBeNull()
    expect(parseTicketKey('linear:')).toBeNull()
  })
})
