import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isValidPackageName, type Dep, type PackageInfo } from '../../shared/deps'
import { createLimiter, type Http, type JsonResponse } from './http'

const TTL_MS = 6 * 60 * 60 * 1000
type Raw = Record<string, any>
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const newest = (dates: (string | null)[]): string | null => {
  const ok = dates.filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)))
  return ok.length ? ok.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null
}

function npmInfo(j: Raw, version: string): PackageInfo {
  const v = j.versions?.[version]
  return { latest: str(j['dist-tags']?.latest), deprecated: str(v?.deprecated), yanked: false, inactive: false, lastRelease: str(j.modified) }
}

function gemInfo(j: unknown, version: string): PackageInfo {
  const list: Raw[] = Array.isArray(j) ? j : []
  return {
    latest: str(list.find((x) => x?.prerelease === false)?.number), deprecated: null,
    yanked: !list.some((x) => x?.number === version), inactive: false, lastRelease: newest(list.map((x) => str(x?.created_at)))
  }
}

function pypiInfo(j: Raw, version: string): PackageInfo {
  const files: Raw[] = Array.isArray(j.releases?.[version]) ? j.releases[version] : []
  const all: Raw[] = Object.values(j.releases ?? {}).flat() as Raw[]
  return {
    latest: str(j.info?.version), deprecated: null,
    yanked: files.length > 0 && files.every((f) => f?.yanked === true),
    inactive: Array.isArray(j.info?.classifiers) && j.info.classifiers.includes('Development Status :: 7 - Inactive'),
    lastRelease: newest(all.map((f) => str(f?.upload_time_iso_8601)))
  }
}

function request(d: Dep): { url: string; headers?: Record<string, string> } {
  const e = encodeURIComponent
  if (d.ecosystem === 'npm') {
    // Scoped names keep the slash encoded in lowercase, as the registry documents.
    const [a, b] = d.name.startsWith('@') ? d.name.split('/') : [d.name, undefined]
    return { url: `https://registry.npmjs.org/${b === undefined ? e(a) : `@${e(a.slice(1))}%2f${e(b)}`}`, headers: { Accept: 'application/vnd.npm.install-v1+json' } }
  }
  if (d.ecosystem === 'RubyGems') return { url: `https://rubygems.org/api/v1/versions/${e(d.name)}.json` }
  return { url: `https://pypi.org/pypi/${e(d.name.toLowerCase().replace(/[-_.]+/g, '-'))}/json` }
}

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The fields each registry must send: anything else (an error page, a moved API) must not read as « up to date ». */
function wellFormed(d: Dep, j: unknown): boolean {
  if (d.ecosystem === 'RubyGems') return Array.isArray(j) && j.length > 0 && j.every((x) => isRaw(x) && typeof x.number === 'string')
  if (!isRaw(j)) return false
  if (d.ecosystem === 'npm') return isRaw(j['dist-tags']) && typeof j['dist-tags'].latest === 'string' && isRaw(j.versions)
  return isRaw(j.info) && typeof j.info.version === 'string' && isRaw(j.releases)
}

function derive(d: Dep, j: unknown, url: string): PackageInfo {
  if (!wellFormed(d, j)) throw new Error(`Réponse inattendue : ${url}`)
  const version = d.version ?? ''
  if (d.ecosystem === 'RubyGems') return gemInfo(j, version)
  return d.ecosystem === 'npm' ? npmInfo(j as Raw, version) : pypiInfo(j as Raw, version)
}

/** Expired entries are kept a while: their ETag spares a full download. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 10_000
interface Entry { at: number; etag: string | null; info: PackageInfo }

const isInfo = (v: unknown): v is PackageInfo => {
  if (typeof v !== 'object' || v === null) return false
  const i = v as Record<string, unknown>
  const strOrNull = (x: unknown) => x === null || typeof x === 'string'
  return strOrNull(i.latest) && strOrNull(i.deprecated) && strOrNull(i.lastRelease) && typeof i.yanked === 'boolean' && typeof i.inactive === 'boolean'
}
const isEntry = (v: unknown): v is Entry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.at === 'number' && (e.etag === null || typeof e.etag === 'string') && isInfo(e.info)
}

/**
 * Registry lookups: at most 6 requests in flight, derived info (never the documents, which reach tens of MB)
 * cached per package and version for 6 h, then revalidated with the ETag. With `file`, the cache survives a restart.
 */
export function createRegistry(o: { now?: () => number; file?: string; schedule?: (fn: () => void) => void; log?: (msg: string, err: unknown) => void }) {
  const now = o.now ?? Date.now
  const log = o.log ?? ((msg: string, err: unknown) => console.error(msg, err))
  const schedule = o.schedule ?? ((fn: () => void) => { setTimeout(fn, 2000).unref() })
  const limit = createLimiter(6)
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Promise<JsonResponse>>()
  let loaded = false
  let saving = false

  function load(): void {
    loaded = true
    if (!o.file) return
    try {
      const raw = JSON.parse(readFileSync(o.file, 'utf8'))
      if (raw?.version !== 1 || typeof raw.entries !== 'object' || raw.entries === null) return
      for (const [k, v] of Object.entries(raw.entries as Record<string, unknown>)) if (isEntry(v)) cache.set(k, v)
    } catch { /* missing or corrupt: start empty */ }
  }

  function save(): void {
    saving = false
    if (!o.file) return
    const keep = [...cache.entries()].filter(([, e]) => now() - e.at < KEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES)
    try {
      const tmp = `${o.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(keep) }))
      renameSync(tmp, o.file)
    } catch (e) {
      log('deps: cannot write the registry cache', e)
    }
  }

  /** One request per URL and validator at a time: the same package in several manifests is fetched once. */
  function get(http: Http, url: string, headers: Record<string, string> | undefined, etag: string | null): Promise<JsonResponse> {
    const k = `${url}\0${etag ?? ''}`
    let p = inflight.get(k)
    if (!p) {
      p = limit(() => http.getJson(url, etag === null ? headers : { ...headers, 'If-None-Match': etag }))
      inflight.set(k, p)
      void p.catch(() => undefined).finally(() => { inflight.delete(k) })
    }
    return p
  }

  return {
    async packageInfo(http: Http, d: Dep): Promise<PackageInfo> {
      if (d.private || !isValidPackageName(d.ecosystem, d.name)) throw new Error('Nom de paquet invalide')
      if (!loaded) load()
      const { url, headers } = request(d)
      const key = `${d.ecosystem}\0${d.name}\0${d.version ?? ''}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < TTL_MS) return hit.info
      const res = await get(http, url, headers, hit?.etag ?? null)
      let info: PackageInfo
      if (res.status === 304) {
        if (!hit) throw new Error(`Réponse inattendue : ${url}`)
        info = hit.info
      } else info = derive(d, res.body, url)
      cache.set(key, { at: now(), etag: res.etag, info })
      if (!saving) { saving = true; schedule(save) }
      return info
    }
  }
}

const shared = createRegistry({})
export const packageInfo = (http: Http, d: Dep): Promise<PackageInfo> => shared.packageInfo(http, d)
