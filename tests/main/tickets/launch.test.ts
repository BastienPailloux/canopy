import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { launchCandidates, launchTicket, type LaunchDeps } from '../../../src/main/tickets/launch'
import { TicketStore } from '../../../src/main/tickets/store'
import type { Ticket } from '../../../src/shared/tickets'
import { createRepo, type TestRepo } from '../../helpers/repo'

const env = {
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString()

let repo: TestRepo
let tickets: TicketStore
let store: AppStore
let ticket: Ticket
let activity: Record<string, 'waiting' | 'working' | 'idle'>
let deps: LaunchDeps

beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  tickets = new TicketStore()
  store = new AppStore(join(await mkdtemp(join(tmpdir(), 'canopy-launch-')), 'state.json'))
  ticket = await tickets.create(repo.path, {
    title: 'Export JSON-LD', description: '', status: 'todo', priority: 'none', labels: [], subtasks: []
  })
  activity = {}
  deps = {
    tickets, store,
    activity: (cwd) => activity[cwd] ?? 'idle',
    sessions: (cwd) => (activity[cwd] ? 1 : 0),
    trusted: async () => false
  }
})
afterEach(() => repo.cleanup())

const ticketFile = (): string => join(repo.path, '.tickets', `${ticket.id}.md`)
const addWorktree = (name: string, branch: string): string => {
  const path = join(repo.path, '..', name)
  git(repo.path, 'worktree', 'add', '-b', branch, path)
  return execFileSync('realpath', [path]).toString().trim()
}

describe('launchTicket', () => {
  it('new worktree launch links the ticket', async () => {
    const r = await launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'feat/export-jsonld', target: { kind: 'new', base: 'main' }, setInProgress: true
    })
    const wt = join(await realpath(repo.path), '.worktrees', 'feat-export-jsonld')
    expect(r.worktree).toBe(wt)
    expect(existsSync(wt)).toBe(true)
    expect(git(wt, 'branch', '--show-current').trim()).toBe('feat/export-jsonld')
    const t = await tickets.get(repo.path, ticket.id)
    expect(t).toMatchObject({ branch: 'feat/export-jsonld', worktree: wt, base: 'main', status: 'in_progress' })
    expect(r.ticket).toMatchObject({ branch: 'feat/export-jsonld', worktree: wt, status: 'in_progress' })
    // Default base: nothing to remember.
    expect(store.branchBase(repo.path, 'feat/export-jsonld')).toBeUndefined()
  })

  it('setInProgress false keeps the status', async () => {
    await launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'feat/export-jsonld', target: { kind: 'new', base: 'main' }, setInProgress: false
    })
    expect((await tickets.get(repo.path, ticket.id)).status).toBe('todo')
  })

  it('failed launch writes nothing', async () => {
    git(repo.path, 'branch', 'feat/taken')
    const before = await readFile(ticketFile())
    await expect(launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'feat/taken', target: { kind: 'new', base: 'main' }, setInProgress: true
    })).rejects.toThrow(/existe déjà/)
    expect(await readFile(ticketFile())).toEqual(before)
    expect(existsSync(join(repo.path, '.worktrees', 'feat-taken'))).toBe(false)
  })

  it('refuses an invalid branch name', async () => {
    const before = await readFile(ticketFile())
    await expect(launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'feat/a..b', target: { kind: 'new', base: 'main' }, setInProgress: true
    })).rejects.toThrow(/invalide/)
    expect(await readFile(ticketFile())).toEqual(before)
  })

  it('starts the branch in a free existing worktree', async () => {
    const wt = addWorktree('wt', 'old')
    const r = await launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'fix/thing', target: { kind: 'existing', worktree: wt, base: 'main' }, setInProgress: true
    })
    expect(r.worktree).toBe(wt)
    expect(git(wt, 'branch', '--show-current').trim()).toBe('fix/thing')
    expect(await tickets.get(repo.path, ticket.id)).toMatchObject({ branch: 'fix/thing', worktree: wt, base: 'main' })
  })

  it('refuses a worktree that is not free', async () => {
    const wt = addWorktree('wt', 'old')
    activity[wt] = 'working'
    const before = await readFile(ticketFile())
    await expect(launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'fix/thing', target: { kind: 'existing', worktree: wt, base: 'main' }, setInProgress: true
    })).rejects.toThrow()
    expect(git(wt, 'branch', '--show-current').trim()).toBe('old')
    expect(await readFile(ticketFile())).toEqual(before)
  })

  it('refuses the main checkout and an unknown worktree', async () => {
    const main = await realpath(repo.path)
    await expect(launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'fix/thing', target: { kind: 'existing', worktree: main, base: 'main' }, setInProgress: true
    })).rejects.toThrow()
    await expect(launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'fix/thing', target: { kind: 'existing', worktree: '/nowhere', base: 'main' }, setInProgress: true
    })).rejects.toThrow()
    expect(git(main, 'branch', '--show-current').trim()).toBe('main')
  })

  it('stacked launch remembers the base', async () => {
    git(repo.path, 'branch', 'feat/a')
    await launchTicket(deps, repo.path, {
      id: ticket.id, branch: 'feat/b', target: { kind: 'new', base: 'feat/a' }, setInProgress: true
    })
    expect(store.branchBase(await realpath(repo.path), 'feat/b')).toBe('feat/a')
    expect((await tickets.get(repo.path, ticket.id)).base).toBe('feat/a')
  })

  it('a relaunch replaces the linked branch', async () => {
    await launchTicket(deps, repo.path, { id: ticket.id, branch: 'feat/one', target: { kind: 'new', base: 'main' }, setInProgress: true })
    await launchTicket(deps, repo.path, { id: ticket.id, branch: 'feat/two', target: { kind: 'new', base: 'main' }, setInProgress: true })
    expect((await tickets.get(repo.path, ticket.id)).branch).toBe('feat/two')
  })
})

describe('launchCandidates', () => {
  it('candidates mark main and busy worktrees', async () => {
    const free = addWorktree('free', 'b1')
    const busy = addWorktree('busy', 'b2')
    const asking = addWorktree('asking', 'b3')
    activity[busy] = 'working'
    activity[asking] = 'waiting'
    git(free, 'commit', '--allow-empty', '-m', 'ahead')
    execFileSync('sh', ['-c', 'echo x > new.txt'], { cwd: free })
    const { worktrees, advanced } = await launchCandidates(deps, repo.path)
    const by = Object.fromEntries(worktrees.map((w) => [w.path, w]))
    expect(by[await realpath(repo.path)]).toMatchObject({ free: false, reason: 'main', branch: 'main' })
    expect(by[free]).toMatchObject({ free: true, branch: 'b1', dirty: 1, sessions: 0 })
    expect(by[free].reason).toBeUndefined()
    expect(by[busy]).toMatchObject({ free: false, reason: 'working', sessions: 1 })
    expect(by[asking]).toMatchObject({ free: false, reason: 'waiting' })
    expect(advanced).toEqual({ branch: 'b1', ahead: 1 })
  })
})
