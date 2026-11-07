import type { ReleaseNotes } from '../../src/shared/update.ts'

export type Bump = 'major' | 'minor' | 'patch' | null

export interface Commit {
  subject: string
  body: string
}

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?: (.+)$/

/** Returns null for subjects that are not Conventional Commits (merges, free text). */
export function parseCommit(c: Commit): { type: string; breaking: boolean; description: string } | null {
  const m = CONVENTIONAL.exec(c.subject)
  if (!m) return null
  const breaking = m[3] === '!' || /^BREAKING[ -]CHANGE:/m.test(c.body)
  return { type: m[1], breaking, description: m[4] }
}

function bumpFor(commits: Commit[]): Bump {
  let bump: Bump = null
  for (const c of commits) {
    const p = parseCommit(c)
    if (!p) continue
    if (p.breaking) return 'major'
    if (p.type === 'feat') bump = 'minor'
    else if ((p.type === 'fix' || p.type === 'perf') && bump === null) bump = 'patch'
  }
  return bump
}

/** First release is always 1.0.0; afterwards the highest bump among the commits wins. */
export function nextVersion(lastTag: string | null, commits: Commit[]): string | null {
  if (lastTag === null) return '1.0.0'
  const bump = bumpFor(commits)
  if (!bump) return null
  const [major, minor, patch] = lastTag.replace(/^v/, '').split('.').map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function notesFor(version: string, date: string, commits: Commit[], first: boolean): ReleaseNotes {
  if (first) return { version, date, features: ['Première version'], fixes: [] }
  const features: string[] = []
  const fixes: string[] = []
  for (const c of commits) {
    const p = parseCommit(c)
    if (!p) continue
    if (p.type === 'fix' || p.type === 'perf') fixes.push(capitalize(p.description))
    // A breaking change makes the release, whatever its type: it must be in the notes.
    else if (p.type === 'feat' || p.breaking) features.push(capitalize(p.description))
  }
  return { version, date, features, fixes }
}

export function renderMarkdown(n: ReleaseNotes): string {
  const section = (title: string, items: string[]): string | null =>
    items.length ? `## ${title}\n\n${items.map((i) => `- ${i}`).join('\n')}\n` : null
  return [section('Nouveautés', n.features), section('Corrections', n.fixes)]
    .filter((s): s is string => s !== null)
    .join('\n')
}
