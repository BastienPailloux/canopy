import { isValidPackageName, type Dep, type PackageInfo } from '../../shared/deps'
import { createLimiter, type Http } from './http'

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
    return { url: `https://registry.npmjs.org/${b === undefined ? e(a) : `${e(a).replace('%40', '@')}%2f${e(b)}`}`, headers: { Accept: 'application/vnd.npm.install-v1+json' } }
  }
  if (d.ecosystem === 'RubyGems') return { url: `https://rubygems.org/api/v1/versions/${e(d.name)}.json` }
  return { url: `https://pypi.org/pypi/${e(d.name.toLowerCase().replace(/[-_.]+/g, '-'))}/json` }
}

/** Registry lookups with a 6 h in-memory cache (keyed by URL) and at most 6 requests in flight. */
export function createRegistry(o: { now?: () => number }) {
  const now = o.now ?? Date.now
  const limit = createLimiter(6)
  const cache = new Map<string, { at: number; value: Promise<unknown> }>()
  return {
    async packageInfo(http: Http, d: Dep): Promise<PackageInfo> {
      if (d.private || !isValidPackageName(d.ecosystem, d.name)) throw new Error('Nom de paquet invalide')
      const { url, headers } = request(d)
      let hit = cache.get(url)
      if (!hit || now() - hit.at >= TTL_MS) {
        const value = limit(() => http.getJson(url, headers))
        hit = { at: now(), value }
        cache.set(url, hit)
        value.catch(() => { if (cache.get(url) === hit) cache.delete(url) })
      }
      const j = await hit.value
      const version = d.version ?? ''
      if (d.ecosystem === 'RubyGems') return gemInfo(j, version)
      if (typeof j !== 'object' || j === null) throw new Error(`Réponse inattendue : ${url}`)
      return d.ecosystem === 'npm' ? npmInfo(j as Raw, version) : pypiInfo(j as Raw, version)
    }
  }
}

const shared = createRegistry({})
export const packageInfo = (http: Http, d: Dep): Promise<PackageInfo> => shared.packageInfo(http, d)
