import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PrCheck, PrDetail, PrThread } from '../../src/shared/pr'
import type { Ticket, TicketListEntry } from '../../src/shared/tickets'
import { checksSummary, defaultMethod, mergeStatus, defaultSubject, isConventional, linkedTicket, mergeGates, reviewerChoices, sessionText, tabCounts } from '../../src/renderer/pr/mergeModel'

const fixture = (): PrDetail => (JSON.parse(readFileSync('tests/fixtures/gh/pr.json', 'utf8')) as { detail: PrDetail }).detail
const thread = (id: string, resolved: boolean): PrThread =>
  ({ id, path: 'a.ts', line: 1, startLine: null, diffHunk: '', resolved, outdated: false, comments: [] })

describe('tabCounts', () => {
  it('tabCounts counts unresolved threads and failed checks', () => {
    const pr: PrDetail = {
      ...fixture(),
      timeline: [
        { kind: 'thread', at: '1', thread: thread('a', false) },
        { kind: 'thread', at: '2', thread: thread('b', true) },
        { kind: 'thread', at: '3', thread: thread('c', false) }
      ],
      checks: [
        { name: 'lint', detail: '', outcome: 'success', durationMs: 1, url: null, run: null },
        { name: 'e2e', detail: '', outcome: 'failure', durationMs: 1, url: null, run: null },
        { name: 'build', detail: '', outcome: 'pending', durationMs: null, url: null, run: null }
      ]
    }
    const c = tabCounts(pr)
    expect(c.openThreads).toBe(2)
    expect(c.commits).toBe(pr.commits.length)
    expect(c.checks).toEqual({ ok: 1, total: 3 })
    expect(c.files).toBe(pr.files.length)
    expect(c.alert).toEqual({ conv: true, checks: true })
  })

  it('counts neutral (skipped) checks as passed, as GitHub does', () => {
    const pr: PrDetail = {
      ...fixture(),
      checks: [
        { name: 'lint', detail: '', outcome: 'success', durationMs: 1, url: null, run: null },
        { name: 'deploy', detail: '', outcome: 'neutral', durationMs: 1, url: null, run: null }
      ]
    }
    expect(tabCounts(pr).checks).toEqual({ ok: 2, total: 2 })
    expect(tabCounts(pr).alert.checks).toBe(false)
  })

  it('raises no alert once every thread is resolved and no check failed', () => {
    const pr: PrDetail = {
      ...fixture(),
      timeline: [{ kind: 'thread', at: '1', thread: thread('a', true) }],
      checks: [{ name: 'build', detail: '', outcome: 'pending', durationMs: null, url: null, run: null }]
    }
    expect(tabCounts(pr).alert).toEqual({ conv: false, checks: false })
  })
})

describe('checksSummary', () => {
  const c = (outcome: PrCheck['outcome']): PrCheck => ({ name: 'x', detail: '', outcome, durationMs: null, url: null, run: null })
  it('says all pass, counting neutral as passed', () => {
    expect(checksSummary([c('success'), c('neutral')])).toBe('Tous les checks passent')
  })
  it('counts failures with ok/total', () => {
    expect(checksSummary([c('success'), c('failure'), c('success')])).toBe('1 check en échec · 2/3 réussis')
    expect(checksSummary([c('failure'), c('failure')])).toBe('2 checks en échec · 0/2 réussis')
  })
  it('says running while one is pending and none failed', () => {
    expect(checksSummary([c('success'), c('pending')])).toBe('Checks en cours · 1/2 réussis')
  })
})

describe('linkedTicket', () => {
  const local = (branch: string): TicketListEntry => ({ kind: 'ticket', ticket: { id: 'T-1', title: 'Local one', branch } as Ticket })
  const link = { branch: 'feat/x', worktree: '/w', base: 'main' }

  it('linkedTicket prefers the Linear link and falls back to a local ticket on the branch', () => {
    expect(linkedTicket('feat/x', { 'CAN-5': link }, [local('feat/x')])).toEqual({ source: 'linear', id: 'CAN-5' })
    expect(linkedTicket('feat/x', {}, [local('feat/x')])).toEqual({ source: 'local', id: 'T-1', title: 'Local one' })
    expect(linkedTicket('feat/x', { 'CAN-5': { ...link, branch: 'feat/y' } }, [local('feat/y'), { kind: 'unreadable', file: 'a.md', error: 'x' }])).toBeNull()
  })
})

describe('reviewerChoices', () => {
  const suggested = [
    { login: 'camille-r', kind: 'user' as const, hint: 'A modifié ces fichiers' },
    { login: 'acme/core', kind: 'team' as const, hint: 'Équipe' }
  ]

  it('offers Copilot, keeps people who already reviewed, drops pending ones and filters', () => {
    const current = [{ login: 'camille-r', kind: 'user' as const, status: 'approved' as const }, { login: 'acme/core', kind: 'team' as const, status: 'pending' as const }]
    const logins = (q: string): string[] => reviewerChoices(suggested, current, q).map((c) => c.login)
    expect(logins('')).toEqual(['camille-r', 'copilot'])
    expect(logins('COP')).toEqual(['copilot'])
    expect(logins('modifié')).toEqual(['camille-r'])
  })
})

describe('sessionText', () => {
  it('names the session state and falls back to no session', () => {
    expect(sessionText('running')).toBe('Claude travaille')
    expect(sessionText('draft')).toBe('Aucune session en cours')
    expect(sessionText(undefined)).toBe('Aucune session en cours')
  })
})

describe('merge panel', () => {
  const gate = (pr: PrDetail, id: string) => mergeGates(pr).find((g) => g.id === id)

  it('squash by default, else the first allowed method', () => {
    const pr = fixture()
    expect(defaultMethod(pr)).toBe('squash')
    expect(defaultMethod({ ...pr, repo: { ...pr.repo, methods: ['rebase', 'merge'] } })).toBe('rebase')
    expect(defaultSubject(pr)).toBe('feat(products): look up passports by GTIN (#87)')
  })

  it('a BEHIND branch offers updateBranch', () => {
    const pr: PrDetail = { ...fixture(), mergeStateStatus: 'BEHIND' }
    expect(gate(pr, 'branch')).toMatchObject({ ok: 'wait', blocking: true, action: 'updateBranch' })
    // Clean: up to date, no action.
    expect(gate({ ...pr, mergeStateStatus: 'CLEAN' }, 'branch')).toMatchObject({ ok: true, blocking: false })
    expect(gate({ ...pr, mergeStateStatus: 'CLEAN' }, 'branch')?.action).toBeUndefined()
    // Conflicts block whatever else is green.
    expect(gate({ ...pr, mergeStateStatus: 'DIRTY' }, 'branch')).toMatchObject({ ok: false, blocking: true })
  })

  it('a draft blocks with ready', () => {
    const pr: PrDetail = { ...fixture(), state: 'draft', mergeStateStatus: 'DRAFT' }
    expect(mergeGates(pr)[0]).toMatchObject({ id: 'draft', ok: false, blocking: true, action: 'ready' })
    expect(gate({ ...pr, state: 'open', mergeStateStatus: 'CLEAN' }, 'draft')).toBeUndefined()
  })

  it('UNSTABLE blocks nothing: a failing check the repo does not require is informative', () => {
    const pr = fixture()
    expect(pr.mergeStateStatus).toBe('UNSTABLE')
    expect(gate(pr, 'checks')).toMatchObject({ ok: false, blocking: false, action: 'fixChecks' })
    expect(gate(pr, 'threads')).toMatchObject({ ok: false, blocking: false, action: 'showConversation' })
    expect(mergeGates(pr).some((g) => g.blocking)).toBe(false)
  })

  it('BLOCKED: the review and checks block, threads only when nothing else explains it', () => {
    const pr: PrDetail = { ...fixture(), mergeStateStatus: 'BLOCKED' }
    expect(gate(pr, 'review')).toMatchObject({ ok: false, blocking: true })
    expect(gate(pr, 'checks')).toMatchObject({ blocking: true })
    expect(gate(pr, 'threads')).toMatchObject({ blocking: false })
    const green: PrDetail = { ...pr, reviewDecision: 'APPROVED', checks: [] }
    expect(gate(green, 'threads')).toMatchObject({ ok: false, blocking: true })
  })

  it('BLOCKED with every gate green says GitHub still blocks, not ready', () => {
    const green: PrDetail = { ...fixture(), mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', checks: [], timeline: [] }
    expect(mergeGates(green).some((g) => g.blocking)).toBe(false)
    expect(mergeStatus(green)).toBe('GitHub bloque encore le merge (règles de protection de la branche)')
    expect(mergeStatus({ ...green, mergeStateStatus: 'CLEAN' })).toBe('Prêt à merger')
    expect(mergeStatus({ ...green, mergeStateStatus: 'DIRTY' })).toBe('Merge bloqué tant que les points ci-dessus ne sont pas réglés')
    expect(mergeStatus({ ...green, autoMerge: true })).toBe('Auto-merge activé : mergera dès que tout est vert')
  })

  it('isConventional accepts feat(git)!: x and refuses Update stuff', () => {
    expect(isConventional('feat(git)!: x')).toBe(true)
    expect(isConventional('fix: handle a 404')).toBe(true)
    expect(isConventional('Update stuff')).toBe(false)
    expect(isConventional('feat(Git): x')).toBe(false)
    expect(isConventional('feat:x')).toBe(false)
  })
})
