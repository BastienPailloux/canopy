import { describe, expect, it } from 'vitest'
import {
  classify, criticalKeys, defaultDepsBranch, depKey, depsLaunchPrompt, severityFromCvss,
  type Advisory, type Dep, type DepEntry, type DepsReport, type PackageInfo
} from '../../../src/shared/deps'

const NOW = Date.UTC(2026, 10, 9)
const dep = (o: Partial<Dep> = {}): Dep => ({ ecosystem: 'npm', name: 'left-pad', version: '1.0.0', manifest: 'package-lock.json', private: false, ...o })
const info = (o: Partial<PackageInfo> = {}): PackageInfo => ({ latest: '1.0.0', deprecated: null, yanked: false, inactive: false, lastRelease: '2026-01-01T00:00:00Z', ...o })
const adv = (o: Partial<Advisory> = {}): Advisory => ({ id: 'GHSA-1', package: 'left-pad', severity: 'high', summary: 'Boom', fixed: null, url: 'https://x', ...o })

describe('severityFromCvss', () => {
  it('maps CVSS 3.x vectors', () => {
    expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe('critical')
    expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe('high')
    expect(severityFromCvss('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N')).toBe('low')
    expect(severityFromCvss('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe('critical')
  })
  it('returns unknown for other versions or garbage', () => {
    expect(severityFromCvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBe('unknown')
    expect(severityFromCvss('nope')).toBe('unknown')
  })
})

describe('depKey', () => {
  it('joins ecosystem, manifest and name', () => {
    expect(depKey(dep())).toBe('npm:package-lock.json:left-pad')
  })
})

describe('classify', () => {
  it('returns null when up to date', () => {
    expect(classify(dep(), [], info(), NOW)).toBeNull()
  })
  it('high advisory is critical', () => {
    const e = classify(dep(), [adv()], info(), NOW)!
    expect(e.level).toBe('critical')
    expect(e.reason.startsWith('Faille haute')).toBe(true)
    expect(e.key).toBe('npm:package-lock.json:left-pad')
    expect(e.registryUrl).toBe('https://www.npmjs.com/package/left-pad')
  })
  it('classifies from advisories when the registry lookup failed', () => {
    expect(classify(dep(), [adv()], null, NOW)!.level).toBe('critical')
    expect(classify(dep(), [], null, NOW)).toBeNull()
  })
  it('deprecated, yanked and inactive are critical', () => {
    const d = classify(dep(), [], info({ deprecated: 'use foo' }), NOW)!
    expect([d.level, d.reason]).toEqual(['critical', 'Déprécié : use foo'])
    const y = classify(dep(), [], info({ yanked: true }), NOW)!
    expect([y.level, y.reason]).toEqual(['critical', 'Version retirée par l\'auteur'])
    const i = classify(dep({ ecosystem: 'PyPI' }), [], info({ inactive: true }), NOW)!
    expect([i.level, i.reason]).toEqual(['critical', 'Projet déclaré inactif'])
    expect(i.registryUrl).toBe('https://pypi.org/project/left-pad/')
  })
  it('moderate and unknown advisories are soon', () => {
    const m = classify(dep(), [adv({ severity: 'moderate' })], info(), NOW)!
    expect(m.level).toBe('soon')
    expect(m.reason.startsWith('Faille modérée')).toBe(true)
    const u = classify(dep(), [adv({ severity: 'unknown' })], info(), NOW)!
    expect(u.level).toBe('soon')
    expect(u.reason.startsWith('Faille de gravité inconnue')).toBe(true)
  })
  it('majors behind is soon', () => {
    const e = classify(dep({ version: '3.0.0' }), [], info({ latest: '5.1.0' }), NOW)!
    expect([e.level, e.reason, e.target]).toEqual(['soon', '2 versions majeures de retard', '5.1.0'])
  })
  it('stale project is soon', () => {
    const e = classify(dep(), [], info({ lastRelease: '2023-03-01T00:00:00Z' }), NOW)!
    expect([e.level, e.reason]).toEqual(['soon', 'Aucune publication depuis 2023'])
  })
  it('patch available is later', () => {
    const e = classify(dep({ version: '5.0.1' }), [], info({ latest: '5.0.8' }), NOW)!
    expect([e.level, e.reason]).toEqual(['later', 'Correctifs disponibles'])
  })
  it('private and pinless deps', () => {
    const p = classify(dep({ private: true }), [], null, NOW)!
    expect([p.level, p.reason, p.registryUrl]).toEqual(['private', 'Source privée ou locale : non vérifiée', null])
    const n = classify(dep({ version: null }), [], info(), NOW)!
    expect([n.level, n.reason]).toEqual(['pinless', 'Version non épinglée'])
  })
  it('keeps only the most severe reason', () => {
    const e = classify(dep(), [adv({ severity: 'critical' })], info({ deprecated: 'x' }), NOW)!
    expect(e.reason.startsWith('Faille critique')).toBe(true)
    expect(e.reason).not.toContain('Déprécié')
  })
  it('target is the latest unless a fix exists in the installed major', () => {
    expect(classify(dep({ version: '1.2.0' }), [adv({ fixed: '1.2.5' })], info({ latest: '3.0.0' }), NOW)!.target).toBe('1.2.5')
    expect(classify(dep({ version: '1.2.0' }), [adv({ fixed: '2.0.1' })], info({ latest: '3.0.0' }), NOW)!.target).toBe('3.0.0')
  })
  it('names the transitive package', () => {
    const e = classify(dep({ name: 'mkdirp', via: ['mkdirp'] }), [adv({ package: 'minimist', severity: 'critical' })], info(), NOW)!
    expect(e.reason).toBe('Faille critique dans minimist (via mkdirp)')
  })
})

const entry = (o: Partial<DepEntry> = {}): DepEntry => ({
  key: 'npm:package-lock.json:a', ecosystem: 'npm', name: 'a', manifest: 'package-lock.json', installed: '1.0.0', target: '1.2.0',
  level: 'critical', reason: 'Faille haute : Boom', advisories: [adv({ id: 'GHSA-xyz' })], registryUrl: null, ...o
})

describe('criticalKeys', () => {
  it('lists critical entries only', () => {
    const r: DepsReport = { repo: '/r', checkedAt: 1, errors: [], baseRef: null, manifests: 1, entries: [entry(), entry({ key: 'k2', level: 'soon' })] }
    expect(criticalKeys(r)).toEqual(['npm:package-lock.json:a'])
  })
})

describe('defaultDepsBranch', () => {
  const today = new Date(2026, 10, 9)
  it('uses fix/ with a security issue, chore/ otherwise', () => {
    expect(defaultDepsBranch([entry()], today)).toBe('fix/deps-2026-11-09')
    expect(defaultDepsBranch([entry({ advisories: [] })], today)).toBe('chore/deps-2026-11-09')
  })
})

describe('depsLaunchPrompt', () => {
  it('lists entries and instructions', () => {
    const p = depsLaunchPrompt([entry()])
    for (const s of ['npm', 'package-lock.json', '1.0.0 → 1.2.0', 'Faille haute : Boom', 'GHSA-xyz']) expect(p).toContain(s)
    for (const s of ['tester', 'signaler', 'PR']) expect(p).toContain(s)
  })
})
