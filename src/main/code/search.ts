import { spawn } from 'node:child_process'
import { sep } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import type { SearchHit } from '../../shared/types'
import { DEFAULT_SEARCH_LIMIT } from '../../shared/types'

export interface SearchOptions {
  /** `q` is a regular expression. Default: a literal text. */
  regex?: boolean
  caseSensitive?: boolean
  /** Default `DEFAULT_SEARCH_LIMIT`. */
  limit?: number
  /** Aborting kills the process and rejects with an `AbortError`. */
  signal?: AbortSignal
}

/** In a packaged app the binary lives next to the archive, not inside it. */
const RG = rgPath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)

const MAX_STDERR = 4000
/** A minified line must not flood the IPC. Columns still refer to the whole line. */
const MAX_TEXT = 500
/** A line of output longer than this is dropped: a repo's content is untrusted. */
const MAX_PENDING = 8 * 1024 * 1024

function abortError(): Error {
  const e = new Error('Recherche annulée')
  e.name = 'AbortError'
  return e
}

/** What ripgrep says on stderr, as one readable line. */
function readableError(stderr: string, regex: boolean): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const reason = lines.find((l) => l.startsWith('error:'))?.slice('error:'.length).trim() ?? lines[0] ?? 'erreur inconnue'
  return regex ? `Expression régulière invalide : ${reason}` : `Recherche impossible : ${reason}`
}

interface RgText { text?: string; bytes?: string }
const bytesOf = (t: RgText): Buffer => (t.text !== undefined ? Buffer.from(t.text) : Buffer.from(t.bytes ?? '', 'base64'))

/** At most `budget` hits of one `match` message of `rg --json`: one per occurrence on the line. */
function hitsOf(data: { path: RgText; lines: RgText; line_number: number; submatches: { start: number }[] }, budget: number): SearchHit[] {
  const path = bytesOf(data.path).toString().replace(/^\.\//, '')
  const line = bytesOf(data.lines)
  const text = line.toString().replace(/\r?\n$/, '').slice(0, MAX_TEXT)
  const hits: SearchHit[] = []
  // ripgrep counts bytes; editors count UTF-16 units. Each column continues from the previous one.
  let column = 1
  let at = 0
  for (const m of data.submatches.slice(0, budget)) {
    column += line.subarray(at, m.start).toString().length
    at = m.start
    hits.push({ path, line: data.line_number, column, text })
  }
  return hits
}

/**
 * Searches the text of the files under `cwd`, honoring .gitignore and never leaving `cwd` through a link.
 * Hits are ordered by path, line and column. Stops at `limit` hits.
 */
export function searchText(cwd: string, q: string, o: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = o.limit ?? DEFAULT_SEARCH_LIMIT
  if (o.signal?.aborted) return Promise.reject(abortError())
  if (q === '' || limit <= 0) return Promise.resolve([])

  const args = [
    '--json', '--no-config', '--hidden', '--max-columns', '2000', '--max-columns-preview', '--glob', '!.git', '--max-filesize', '5M',
    ...(o.regex ? [] : ['--fixed-strings']),
    o.caseSensitive ? '--case-sensitive' : '--ignore-case',
    '--', q, '.'
  ]

  return new Promise<SearchHit[]>((resolve, reject) => {
    // `.` explicit: with no path, ripgrep would read stdin when it is a pipe.
    const child = spawn(RG, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const hits: SearchHit[] = []
    let pending = ''
    let dropping = false
    let stderr = ''
    let done = false

    const finish = (end: () => void): void => {
      if (done) return
      done = true
      o.signal?.removeEventListener('abort', onAbort)
      end()
    }
    const sorted = (): SearchHit[] =>
      hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column))
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(abortError()))
    }
    o.signal?.addEventListener('abort', onAbort, { once: true })

    const take = (line: string): void => {
      if (done || line === '') return
      let msg: { type: string; data: Parameters<typeof hitsOf>[0] }
      try { msg = JSON.parse(line) } catch { return }
      if (msg.type !== 'match') return
      hits.push(...hitsOf(msg.data, limit - hits.length))
      if (hits.length >= limit) {
        child.kill()
        finish(() => resolve(sorted()))
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      // Only the new chunk is scanned for line ends.
      let start = 0
      for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
        if (dropping) dropping = false
        else take(pending + chunk.slice(start, nl))
        pending = ''
        start = nl + 1
      }
      if (dropping) return
      if (pending.length + chunk.length - start > MAX_PENDING) {
        pending = ''
        dropping = true
      } else {
        pending += chunk.slice(start)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { if (stderr.length < MAX_STDERR) stderr += chunk })
    child.on('error', (e) => finish(() => reject(new Error(`Recherche impossible : ${e.message}`))))
    child.on('close', (code) => {
      if (!dropping) take(pending)
      finish(() => {
        // Killed from outside: the hits so far are not the answer.
        if (code === null) return reject(new Error('Recherche interrompue'))
        // 2 with a pattern ripgrep cannot compile is the user's error; 2 otherwise is unreadable files among others.
        if (code === 2 && hits.length === 0 && o.regex === true && /^(rg: )?regex parse error/m.test(stderr)) {
          return reject(new Error(readableError(stderr, true)))
        }
        resolve(sorted())
      })
    })
  })
}
