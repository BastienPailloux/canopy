import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReleaseNotes } from '../../src/shared/update.ts'
import { nextVersion, notesFor, renderMarkdown, type Commit } from './versioning.ts'

const root = join(import.meta.dirname, '..', '..')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function commitsBetween(range: string): Commit[] {
  return git('log', range, '--no-merges', '--format=%s%x1f%b%x1e')
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ''] = r.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
}

function lastTag(): string | null {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*').trim() || null
  } catch {
    return null
  }
}

const tag = lastTag()
const version = nextVersion(tag, commitsBetween(tag ? `${tag}..HEAD` : 'HEAD'))
const output = process.env.GITHUB_OUTPUT

if (!version) {
  if (output) appendFileSync(output, 'version=\n')
  else console.log('version=')
  process.exit(0)
}

const date = new Date().toISOString().slice(0, 10)
const current = notesFor(version, date, tag ? commitsBetween(`${tag}..HEAD`) : [], tag === null)

// Full history, newest first: rebuilt from the existing tags, each against its predecessor.
const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean)
const history: ReleaseNotes[] = [current]
tags.forEach((t, i) => {
  const prev = tags[i + 1]
  const tagDate = git('log', '-1', '--format=%cs', t).trim()
  history.push(notesFor(t.slice(1), tagDate, prev ? commitsBetween(`${prev}..${t}`) : [], !prev))
})

mkdirSync(join(root, 'dist-notes'), { recursive: true })
writeFileSync(join(root, 'dist-notes', 'notes.md'), renderMarkdown(current))
writeFileSync(join(root, 'src', 'shared', 'releases.json'), JSON.stringify(history, null, 2) + '\n')
if (output) appendFileSync(output, `version=${version}\n`)
else console.log(`version=${version}`)
