import { describe, expect, it } from 'vitest'
import { checkPrTitle } from '../../scripts/ci/prTitle.ts'

describe('checkPrTitle', () => {
  it.each([
    'feat(tickets): launch a ticket into a new worktree',
    'fix: start branch without upstream',
    'refactor(sessions)!: drop legacy transcript format',
    'chore(deps): bump vite from 8.0.0 to 8.1.0',
    'chore(deps-dev): bump the dev-dependencies group with 3 updates',
    'ci: bump actions/checkout from 4 to 5',
    'ci: add pull request checks',
    'docs(release): document release approval and repository rulesets',
    'perf(code): add CI cache'
  ])('accepts %s', (title) => {
    expect(checkPrTitle(title)).toBeNull()
  })

  it('rejects free text', () => {
    expect(checkPrTitle('Ajouter une CI robuste')).toMatch(/Conventional Commit/)
  })

  it('rejects an unknown type', () => {
    expect(checkPrTitle('feature: add ci')).toMatch(/« feature »/)
  })

  it('rejects an upper-case scope', () => {
    expect(checkPrTitle('feat(Tickets): add ci')).toMatch(/scope/)
  })

  it('rejects a capitalized description', () => {
    expect(checkPrTitle('feat: Add ci')).toMatch(/minuscule/)
  })

  it('rejects a description starting with an accented capital', () => {
    expect(checkPrTitle('feat: Éditer les tickets')).toMatch(/minuscule/)
  })

  it('rejects an empty scope', () => {
    expect(checkPrTitle('feat(): add ci')).toMatch(/scope vide/)
  })

  it('rejects a trailing period', () => {
    expect(checkPrTitle('fix: start branch.')).toMatch(/point final/)
  })

  it('rejects an empty title', () => {
    expect(checkPrTitle('')).toMatch(/Conventional Commit/)
  })
})
