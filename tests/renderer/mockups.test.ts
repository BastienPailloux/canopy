import { describe, expect, it } from 'vitest'
import {
  artifactUrlsIn, editPrompt, launchMockupsSection, mockupLine, pageTitle, parseArtifactUrl, publishedUrls, shownStatus,
  type Mockup,
} from '../../src/shared/mockups'
import type { Ticket, TicketStatus } from '../../src/shared/tickets'

const SHORT = 'WcXTxNhxSWaDL28ttqjZye'
const UUID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'

const mockup = (over: Partial<Mockup> = {}): Mockup => ({
  id: SHORT, url: `https://claude.ai/artifact/${SHORT}`, title: 'Scanner', kind: 'web', status: 'todo',
  added: '2026-11-08T10:00:00Z', updated: '2026-11-08T10:00:00Z', ...over,
})

const ticket = (status: TicketStatus, archived = false): Ticket => ({
  id: 'DPP-12', title: 't', description: '', status, priority: 'none', labels: [], subtasks: [],
  created: '', updated: '', archived,
})

describe('parseArtifactUrl', () => {
  it('accepts a short id and canonicalizes it', () => {
    expect(parseArtifactUrl(`https://claude.ai/artifact/${SHORT}`)).toEqual({ id: SHORT, url: `https://claude.ai/artifact/${SHORT}` })
  })

  it('takes the last 22 characters after a title', () => {
    expect(parseArtifactUrl(`https://claude.ai/artifact/scanner-gtin-${SHORT}`)?.id).toBe(SHORT)
  })

  it('accepts a code/artifact UUID, with or without title', () => {
    const want = { id: UUID, url: `https://claude.ai/code/artifact/${UUID}` }
    expect(parseArtifactUrl(`https://claude.ai/code/artifact/${UUID}`)).toEqual(want)
    expect(parseArtifactUrl(`https://claude.ai/code/artifact/ecran-scan-${UUID}`)).toEqual(want)
    expect(parseArtifactUrl(`https://claude.ai/artifact/${UUID.toUpperCase()}`)).toEqual(want)
  })

  it('canonicalizes a short id under code/ to /artifact/', () => {
    expect(parseArtifactUrl(`https://claude.ai/code/artifact/${SHORT}`)?.url).toBe(`https://claude.ai/artifact/${SHORT}`)
  })

  it('drops query and hash', () => {
    expect(parseArtifactUrl(`https://claude.ai/artifact/${SHORT}?v=2#top`)?.url).toBe(`https://claude.ai/artifact/${SHORT}`)
  })

  it('refuses other hosts, schemes and paths', () => {
    for (const raw of [
      `http://claude.ai/artifact/${SHORT}`,
      `https://www.claude.ai/artifact/${SHORT}`,
      `https://claude.ai.evil.com/artifact/${SHORT}`,
      `https://evil.com/artifact/${SHORT}`,
      `https://claude.ai:8443/artifact/${SHORT}`,
      `https://user@claude.ai/artifact/${SHORT}`,
      `https://claude.ai/chat/${SHORT}`,
      `https://claude.ai/artifact/${SHORT}/extra`,
      'https://claude.ai/artifact/tooShort123',
      'https://claude.ai/artifact/abc-WcXTxNhxSWaDL28ttqjZ_e',
      'not a url',
      '',
    ]) expect(parseArtifactUrl(raw), raw).toBeNull()
  })
})

describe('artifactUrlsIn', () => {
  it('finds canonical urls, de-duplicated, in order', () => {
    const text = `Voici https://claude.ai/code/artifact/${UUID}. Et (https://claude.ai/artifact/x-${SHORT}?a=1), ` +
      `encore https://claude.ai/artifact/${SHORT} et https://evil.com/artifact/${SHORT}.`
    expect(artifactUrlsIn(text)).toEqual([`https://claude.ai/code/artifact/${UUID}`, `https://claude.ai/artifact/${SHORT}`])
  })

  it('finds nothing in plain text', () => {
    expect(artifactUrlsIn('rien ici')).toEqual([])
  })
})

describe('shownStatus', () => {
  it('follows the ticket', () => {
    const m = mockup({ status: 'done' })
    expect(shownStatus(m, ticket('backlog'))).toBe('todo')
    expect(shownStatus(m, ticket('todo'))).toBe('todo')
    expect(shownStatus(m, ticket('in_progress'))).toBe('wip')
    expect(shownStatus(m, ticket('in_review'))).toBe('wip')
    expect(shownStatus(mockup(), ticket('done'))).toBe('done')
  })

  it('falls back to its own status without ticket or with an archived one', () => {
    expect(shownStatus(mockup({ status: 'wip' }), undefined)).toBe('wip')
    expect(shownStatus(mockup({ status: 'wip' }), ticket('done', true))).toBe('wip')
  })
})

describe('pageTitle', () => {
  it('drops the Claude suffix and trims', () => {
    expect(pageTitle('  Scanner GTIN | Claude ')).toBe('Scanner GTIN')
    expect(pageTitle('Scanner - Claude')).toBe('Scanner')
    expect(pageTitle('Scanner — Claude')).toBe('Scanner')
    expect(pageTitle('Claude')).toBe('Claude')
    expect(pageTitle('Scanner Claude')).toBe('Scanner Claude')
  })
})

describe('prompts', () => {
  const url = `https://claude.ai/artifact/${SHORT}`

  it('mockupLine', () => {
    expect(mockupLine(mockup())).toBe(`Maquette : Scanner — ${url}`)
  })

  it('first edit message gives the url, how to read it and to republish in place', () => {
    const p = editPrompt({ url, text: 'Bouton plus gros', first: true, variant: false })
    expect(p).toContain(url)
    expect(p).toContain('action read')
    expect(p).toContain(`url: ${url}`)
    expect(p).toContain('Bouton plus gros')
  })

  it('first edit message as a variant publishes a new artifact', () => {
    const p = editPrompt({ url, text: 'Bouton plus gros', first: true, variant: true })
    expect(p).toContain('action read')
    expect(p).toContain('nouvelle maquette')
    expect(p).toContain('sans url')
    expect(p).not.toContain(`url: ${url}`)
  })

  it('without url asks to create one and give its link', () => {
    const p = editPrompt({ text: 'Un écran de scan', first: true, variant: false })
    expect(p).toContain('action publish')
    expect(p).toContain('lien')
    expect(p).toContain('Un écran de scan')
  })

  it('later messages are the text, plus the variant hint when ticked', () => {
    expect(editPrompt({ url, text: ' Encore ', first: false, variant: false })).toBe('Encore')
    const v = editPrompt({ url, text: 'Encore', first: false, variant: true })
    expect(v.startsWith('Encore\n\n')).toBe(true)
    expect(v).toContain('sans url')
  })

  it('launchMockupsSection lists each mockup', () => {
    const other = mockup({ title: 'Résultat', url: `https://claude.ai/code/artifact/${UUID}` })
    expect(launchMockupsSection([mockup(), other])).toBe(
      "Maquettes liées (à lire avec l'outil Artifact, action read) :\n" +
      `- Scanner — ${url}\n- Résultat — https://claude.ai/code/artifact/${UUID}`)
    expect(launchMockupsSection([])).toBe('')
  })
})

describe('publishedUrls', () => {
  const url = `https://claude.ai/artifact/${SHORT}`
  const other = `https://claude.ai/code/artifact/${UUID}`
  const item = (over: Record<string, unknown> = {}) => ({
    kind: 'tool', id: 't1', name: 'Artifact', input: { action: 'publish' }, result: `Publié : ${other}`, running: false, ...over,
  })

  it('reads the result and the given url', () => {
    expect(publishedUrls(item({ input: { action: 'publish', url: `${url}?x=1` } }))).toEqual([other, url])
    expect(publishedUrls(item({ input: {} }))).toEqual([other])
    expect(publishedUrls(item({ input: { url }, result: `ok ${url}` }))).toEqual([url])
  })

  it('ignores read, errors, running calls and other tools', () => {
    expect(publishedUrls(item({ input: { action: 'read', url } }))).toEqual([])
    expect(publishedUrls(item({ isError: true }))).toEqual([])
    expect(publishedUrls(item({ running: true, result: undefined }))).toEqual([])
    expect(publishedUrls(item({ name: 'Bash' }))).toEqual([])
  })
})
