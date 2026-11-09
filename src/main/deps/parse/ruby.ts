import { posix } from 'node:path'
import type { Dep } from '../../../shared/deps'
import type { Unit } from './js'

const RUBYGEMS = 'https://rubygems.org/'
const SECTIONS = new Set(['GEM', 'GIT', 'PATH', 'DEPENDENCIES', 'PLATFORMS', 'BUNDLED WITH', 'RUBY VERSION', 'CHECKSUMS'])

interface Spec { version: string; private: boolean; children: string[] }

const join = (...parts: string[]) => posix.join(...parts.filter(Boolean))
const dep = (name: string, version: string | null, manifest: string, priv: boolean, via?: string[]): Dep =>
  ({ ecosystem: 'RubyGems', name, version, manifest, private: priv, ...(via ? { via } : {}) })

/** `1.16.0-arm64-darwin` -> `1.16.0`: platform variants of one gem share a version. */
const stripPlatform = (v: string) => v.replace(/^(\d[^-]*)-.+$/, '$1')

export function parseGemfileLock(dir: string, lockText: string): Unit {
  try {
    const specs = new Map<string, Spec>()
    const direct: string[] = []
    const banged = new Set<string>()
    let section = ''
    let known = false
    let remotes: string[] = []
    let inSpecs = false
    let current: Spec | null = null
    // Remotes come before `specs:`, so the private flag of a block is only known once it is read.
    const isPrivate = () => section !== 'GEM' || remotes.length === 0 || !remotes.every((r) => r === RUBYGEMS)
    for (const line of lockText.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (!line.startsWith(' ')) {
        section = line.trim()
        if (SECTIONS.has(section)) known = true
        remotes = []; inSpecs = false; current = null
        continue
      }
      if (section === 'DEPENDENCIES') {
        const m = /^ {2}([^\s!(]+)/.exec(line)
        if (m && !direct.includes(m[1])) direct.push(m[1])
        if (m && /!\s*$/.test(line)) banged.add(m[1])
        continue
      }
      if (section !== 'GEM' && section !== 'GIT' && section !== 'PATH') continue
      const remote = /^ {2}remote: (.+)$/.exec(line)
      if (remote) { remotes.push(remote[1].trim()); continue }
      if (/^ {2}specs:\s*$/.test(line)) { inSpecs = true; continue }
      if (!inSpecs) continue
      const spec = /^ {4}(\S+) \((.+)\)\s*$/.exec(line)
      if (spec) {
        const existing = specs.get(spec[1])
        current = existing ?? { version: stripPlatform(spec[2]), private: isPrivate(), children: [] }
        if (!existing) specs.set(spec[1], current)
        continue
      }
      const child = /^ {6}([^\s(]+)/.exec(line)
      if (child && current && !current.children.includes(child[1])) current.children.push(child[1])
    }
    if (!known) throw new Error('no section')

    const manifest = join(dir, 'Gemfile')
    const deps: Dep[] = []
    const transitive = new Map<string, Dep>()
    for (const name of direct) {
      const s = specs.get(name)
      deps.push(dep(name, s?.version ?? null, manifest, s?.private ?? banged.has(name)))
      if (!s || s.private) continue
      const seen = new Set([name])
      const queue = [name]
      while (queue.length) {
        for (const child of specs.get(queue.shift()!)!.children) {
          const cs = specs.get(child)
          if (!cs || cs.private || seen.has(child)) continue
          seen.add(child)
          queue.push(child)
          if (direct.includes(child)) continue
          transitive.set(`${name}\0${child}\0${cs.version}`, dep(child, cs.version, manifest, false, [name]))
        }
      }
    }
    return { dir, ecosystem: 'RubyGems', deps, transitive: [...transitive.values()] }
  } catch {
    return { dir, ecosystem: 'RubyGems', deps: [], transitive: [], error: `Fichier illisible : ${join(dir, 'Gemfile.lock')}` }
  }
}
