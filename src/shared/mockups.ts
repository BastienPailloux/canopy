import type { Ticket } from './tickets'

export type MockupKind = 'phone' | 'web'
export type MockupStatus = 'todo' | 'wip' | 'done'

export const MOCKUP_KINDS: MockupKind[] = ['phone', 'web']
export const MOCKUP_STATUSES: MockupStatus[] = ['todo', 'wip', 'done']

/** Limit main enforces on a mockup title. */
export const MAX_MOCKUP_TITLE = 200

export interface Mockup {
  /** The artifact id of the URL: 22 alphanumerics, or a lowercase UUID. */
  id: string
  /** Canonical URL, see `parseArtifactUrl`. */
  url: string
  title: string
  kind: MockupKind
  status: MockupStatus
  /** Local ticket id; absent when the mockup is linked to none. */
  ticket?: string
  /** Set once the user typed a title: the page title then no longer overrides it. */
  titleSet?: boolean
  added: string
  updated: string
}

export type MockupFields = Pick<Mockup, 'title' | 'kind' | 'status' | 'ticket' | 'titleSet'>

/**
 * A patch: `ticket: null` removes the link. `auto`: the title comes from the page, not the user; it is then left
 * alone once the user named the mockup (`titleSet`).
 */
export type MockupChanges = Partial<Omit<MockupFields, 'ticket'>> & { ticket?: string | null; auto?: boolean }

/** The rectangle of the 4b area, in window content pixels. */
export interface MockupViewBounds { x: number; y: number; width: number; height: number }

/** Payload of the `mockups:title` event: the page title of the mockup shown, Claude suffix removed. */
export interface MockupTitleEvent { url: string; title: string }
/** Payload of the `mockups:viewError` event: the mockup's main frame failed to load. */
export interface MockupViewErrorEvent { url: string; error: string }

/** A registry that cannot be read is reported, never overwritten. */
export type MockupList = { kind: 'ok'; mockups: Mockup[] } | { kind: 'unreadable'; error: string }

export const MOCKUP_STATUS_LABEL: Record<MockupStatus, string> = {
  todo: 'Pas commencée',
  wip: 'En cours de dev',
  done: 'Implémentée',
}

export const MOCKUP_STATUS_COLOR: Record<MockupStatus, { bg: string; fg: string }> = {
  done: { bg: '#12261A', fg: '#7EE29A' },
  wip: { bg: '#2A2410', fg: '#F0CB6E' },
  todo: { bg: '#1E2127', fg: '#C9CED5' },
}

const UUID_TAIL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const SHORT_ID_RE = /^[A-Za-z0-9]{22}$/
/** Ids `parseArtifactUrl` produces: 22 alphanumerics or a lowercase UUID. */
export const MOCKUP_ID_RE = /^([A-Za-z0-9]{22}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/**
 * Accepts `https://claude.ai/artifact/<seg>` and `https://claude.ai/code/artifact/<seg>`, where `<seg>` is
 * `[<title>-]<id>`. The id is the trailing UUID, else the last 22 characters (alphanumerics only).
 * Query and hash are dropped. Canonical url: `/artifact/<id>` for short ids, `/code/artifact/<uuid>` for UUIDs.
 */
export function parseArtifactUrl(raw: string): { id: string; url: string } | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.host !== 'claude.ai' || u.username !== '' || u.password !== '') return null
  const m = /^\/(?:code\/)?artifact\/([^/]+)\/?$/.exec(u.pathname)
  if (!m) return null
  const seg = m[1]
  const uuid = UUID_TAIL_RE.exec(seg)
  if (uuid) {
    const id = uuid[1].toLowerCase()
    return { id, url: `https://claude.ai/code/artifact/${id}` }
  }
  if (seg.length < 22) return null
  const id = seg.slice(-22)
  if (!SHORT_ID_RE.test(id)) return null
  return { id, url: `https://claude.ai/artifact/${id}` }
}

const URL_CANDIDATE_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[^\s<>"'`()[\]{}]+/gi

/** Canonical artifact URLs found in `text`, de-duplicated, in order of appearance. */
export function artifactUrlsIn(text: string): string[] {
  const out: string[] = []
  for (const [match] of text.matchAll(URL_CANDIDATE_RE)) {
    // Sentence punctuation right after a link is not part of it.
    const parsed = parseArtifactUrl(match.replace(/[.,;:!?*_]+$/, ''))
    if (parsed && !out.includes(parsed.url)) out.push(parsed.url)
  }
  return out
}

/** A linked ticket decides the status; an archived one counts as no ticket. */
export function shownStatus(m: Mockup, ticket: Ticket | undefined): MockupStatus {
  if (!ticket || ticket.archived) return m.status
  switch (ticket.status) {
    case 'backlog':
    case 'todo':
      return 'todo'
    case 'in_progress':
    case 'in_review':
      return 'wip'
    case 'done':
      return 'done'
  }
}

/** The page title of an artifact, without claude.ai's ` | Claude` suffix. */
export function pageTitle(raw: string): string {
  return raw.trim().replace(/\s+[|\-—]\s+Claude$/, '').trim()
}

/**
 * A mockup as prompt data: its title JSON-quoted (it may come from the page's <title>, so quotes and newlines are
 * escaped and it cannot pass for an instruction), then its URL.
 */
function quotedMockup(m: Pick<Mockup, 'title' | 'url'>): string {
  return `${JSON.stringify(m.title)} — ${m.url}`
}

export function mockupLine(m: Pick<Mockup, 'title' | 'url'>): string {
  return `Maquette : ${quotedMockup(m)}`
}

const VARIANT_HINT = "Publie le résultat comme une nouvelle maquette (outil Artifact, action publish, sans url) : l'originale reste intacte, et donne le lien de la nouvelle."

/**
 * The message the edit screen sends. The first one carries the context (which mockup, how to read and republish it);
 * later ones are the user's text, plus the variant instruction when it is ticked.
 */
export function editPrompt(o: { url?: string; text: string; first: boolean; variant: boolean }): string {
  const text = o.text.trim()
  if (!o.first) return o.variant ? `${text}\n\n${VARIANT_HINT}` : text
  if (o.url === undefined) {
    return [
      "Crée une nouvelle maquette avec l'outil Artifact (action publish) selon la demande ci-dessous, puis donne son lien.",
      '',
      text,
    ].join('\n')
  }
  const publish = o.variant
    ? VARIANT_HINT
    : `Republie-la ensuite avec l'outil Artifact (action publish) en passant url: ${o.url}, pour la mettre à jour sur place.`
  return [
    `Maquette : ${o.url}`,
    `Lis-la avec l'outil Artifact (action read), puis modifie-la selon la demande ci-dessous. ${publish}`,
    '',
    text,
  ].join('\n')
}

/** The launch prompt's list of linked mockups; empty when there are none. */
export function launchMockupsSection(ms: Pick<Mockup, 'title' | 'url'>[]): string {
  if (ms.length === 0) return ''
  return ["Maquettes liées (à lire avec l'outil Artifact, action read) :", ...ms.map((m) => `- ${quotedMockup(m)}`)].join('\n')
}

/** The transcript's tool item, as far as this module needs it (no renderer import). */
export interface ToolItemLike {
  name: string
  input?: unknown
  result?: string
  isError?: boolean
  running?: boolean
}

/** Canonical URLs a finished, successful Artifact `publish` call produced or updated. */
export function publishedUrls(item: ToolItemLike): string[] {
  if (item.name !== 'Artifact' || item.running || item.isError) return []
  const input = typeof item.input === 'object' && item.input !== null ? (item.input as Record<string, unknown>) : {}
  if (input.action !== undefined && input.action !== 'publish') return []
  const out = artifactUrlsIn(item.result ?? '')
  const given = typeof input.url === 'string' ? parseArtifactUrl(input.url) : null
  if (given && !out.includes(given.url)) out.push(given.url)
  return out
}
