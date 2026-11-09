import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fetchHttp, HttpError, type Http } from './http'

/** Raw path segment is the file name; its decoded form must not climb or smuggle separators. */
function fileFor(dir: string, url: string): string {
  const u = new URL(url)
  const segs = u.pathname.replace(/^\//, '').split('/')
  for (const raw of segs) {
    let dec: string
    try { dec = decodeURIComponent(raw) } catch { throw new Error('Chemin de rejeu invalide') }
    if (raw === '' || dec.includes('\0') || dec.includes('\\') || dec.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error('Chemin de rejeu invalide')
  }
  const last = segs.length - 1
  if (!segs[last].endsWith('.json')) segs[last] += '.json'
  return join(dir, u.hostname, ...segs)
}

async function read(file: string, url: string): Promise<unknown> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch { throw new HttpError(404, url) }
  return JSON.parse(text)
}

/** Replays captured answers, see tests/fixtures/deps/README.md. */
export function replayHttp(dir: string): Http {
  return {
    getJson: async (url) => read(fileFor(dir, url), url),
    async postJson(url, body) {
      if (url !== 'https://api.osv.dev/v1/querybatch') throw new HttpError(404, url)
      const map = (await read(fileFor(dir, url), url)) as Record<string, unknown[]>
      const queries = (body as { queries: { package: { name: string; ecosystem: string }; version: string }[] }).queries
      return {
        results: queries.map((q) => {
          const key = `${q.package.ecosystem}:${q.package.name}@${q.version}`
          const vulns = Object.hasOwn(map, key) ? map[key] : []
          return vulns.length ? { vulns } : {}
        })
      }
    }
  }
}

export function selectDepsHttp(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): Http {
  const dir = o.isPackaged ? undefined : o.env.CANOPY_FAKE_DEPS
  return dir ? replayHttp(resolve(dir)) : fetchHttp()
}
