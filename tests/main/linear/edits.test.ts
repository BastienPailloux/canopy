import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LinearClient } from '../../../src/main/linear/client'
import { LinearEdits } from '../../../src/main/linear/edits'
import type { ReplayOptions } from '../../../src/main/linear/replay'
import { fakeLinear } from '../../helpers/fakeLinear'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'canopy-edits-'))
  dirs.push(d)
  return join(d, 'linear-pending.json')
}

async function setup(opts: ReplayOptions = {}) {
  const fake = fakeLinear(opts)
  const client = new LinearClient(async () => fake, { saveLinearAuth: () => {} })
  await client.connect()
  fake.calls.length = 0
  /** A colleague writing the description directly in Linear. */
  const colleague = async (id: string, description: string) => {
    await fake.callTool('save_issue', { id, description })
    fake.calls.length = 0
  }
  return { fake, client, opts, colleague }
}

const saves = (calls: { name: string; args: unknown }[]) =>
  calls.filter((c) => c.name === 'save_issue').map((c) => c.args as Record<string, unknown>)
const fileEntries = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] }).entries

describe('LinearEdits', () => {
  it('fields are sent only when changed', async () => {
    const { fake, client } = await setup()
    const edits = new LinearEdits(tmpFile(), client)
    const r = await edits.save('CAN-2', { priority: 'high' })
    expect(r).toMatchObject({ kind: 'sent', issue: { id: 'CAN-2', priority: 'high' } })
    expect(saves(fake.calls)).toEqual([{ id: 'CAN-2', priority: 2 }])
    expect(fake.calls.map((c) => c.name)).toEqual(['save_issue'])
    expect(edits.pending()).toEqual([])
  })

  it('maps status, labels, assignee and title to save_issue names', async () => {
    const { fake, client } = await setup()
    const edits = new LinearEdits(tmpFile(), client)
    const r = await edits.save('CAN-2', { title: 'New title', statusId: 'In Progress', labels: ['Bug'], assigneeId: null })
    expect(r).toMatchObject({ kind: 'sent', issue: { title: 'New title', labels: ['Bug'], assignee: null } })
    expect(saves(fake.calls)).toEqual([{ id: 'CAN-2', title: 'New title', state: 'In Progress', labels: ['Bug'], assignee: null }])
  })

  it('colleague edit elsewhere is kept', async () => {
    const { fake, client, colleague } = await setup()
    await colleague('CAN-2', 'A\n\nB')
    await colleague('CAN-2', 'A\n\nB2')
    const edits = new LinearEdits(tmpFile(), client)
    const r = await edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A2\n\nB' } })
    expect(r).toMatchObject({ kind: 'sent', issue: { description: 'A2\n\nB2' } })
    const [sent] = saves(fake.calls)
    expect(sent.description).toBeUndefined()
    expect(sent.patch).toEqual([{ op: 'replace', old_string: 'A\n', new_string: 'A2\n' }])
  })

  it('same passage is a conflict', async () => {
    const { fake, client, colleague } = await setup()
    await colleague('CAN-2', 'A3\n\nB')
    const file = tmpFile()
    const edits = new LinearEdits(file, client)
    const r = await edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A2\n\nB' } })
    expect(r).toEqual({ kind: 'conflict', field: 'description', remote: 'A3\n\nB', mine: 'A2\n\nB' })
    expect(saves(fake.calls)).toEqual([])
    // never dropped: still pending until Bastien resolves or discards
    expect(edits.pending()).toHaveLength(1)
    edits.discard('CAN-2')
    expect(edits.pending()).toEqual([])
    expect(fileEntries(file)).toEqual([])
  })

  it('an anchor vanishing between read and send re-reads once, then conflicts instead of overwriting', async () => {
    const { fake, client, colleague } = await setup()
    await colleague('CAN-2', 'A\n\nB\n\nC')
    let reads = 0
    const racing = {
      issueBrief: async (id: string) => {
        const i = await client.issueBrief(id)
        // the colleague edits B right after our first read
        if (reads++ === 0) await fake.callTool('save_issue', { id, description: 'A\n\nB colleague\n\nC' })
        return i
      },
      save: client.save.bind(client),
    }
    const edits = new LinearEdits(tmpFile(), racing)
    const r = await edits.save('CAN-2', { description: { base: 'A\n\nB\n\nC', text: 'A\n\nB mine\n\nC' } })
    expect(reads).toBe(2)
    expect(r).toEqual({ kind: 'conflict', field: 'description', remote: 'A\n\nB colleague\n\nC', mine: 'A\n\nB mine\n\nC' })
    expect((await client.issueBrief('CAN-2')).description).toBe('A\n\nB colleague\n\nC')
  })

  it('failed send stays pending', async () => {
    const { client, opts } = await setup()
    opts.failWith = new Error('fetch failed')
    const file = tmpFile()
    const edits = new LinearEdits(file, client)
    let changes = 0
    edits.onChange(() => { changes++ })
    const r = await edits.save('CAN-2', { priority: 'high' })
    expect(r.kind).toBe('pending')
    if (r.kind === 'pending') expect(r.reason).toMatch(/Linear injoignable/)
    expect(edits.pending()).toEqual([{ id: 'CAN-2', change: { priority: 'high' }, error: expect.stringMatching(/Linear injoignable/) }])
    expect(fileEntries(file)).toHaveLength(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(changes).toBeGreaterThan(0)
  })

  it('pending edits survive a restart', async () => {
    const file = tmpFile()
    const down = await setup()
    down.opts.failWith = new Error('fetch failed')
    await new LinearEdits(file, down.client).save('CAN-2', { priority: 'low', title: 'Offline title' })

    const up = await setup()
    const edits = new LinearEdits(file, up.client)
    expect(edits.pending()).toEqual([{ id: 'CAN-2', change: { priority: 'low', title: 'Offline title' }, error: expect.any(String) }])
    await edits.retryAll()
    expect(saves(up.fake.calls)).toEqual([{ id: 'CAN-2', title: 'Offline title', priority: 4 }])
    expect(edits.pending()).toEqual([])
    expect(fileEntries(file)).toEqual([])
  })

  it('changes to the same issue merge key by key', async () => {
    const { client, opts } = await setup()
    opts.failWith = new Error('fetch failed')
    const edits = new LinearEdits(tmpFile(), client)
    await edits.save('CAN-2', { priority: 'low', description: { base: 'A', text: 'A1' } })
    await edits.save('CAN-2', { title: 'T', description: { base: 'A1', text: 'A12' } })
    expect(edits.pending()[0].change).toEqual({ priority: 'low', title: 'T', description: { base: 'A', text: 'A12' } })
  })

  it('a save during an in-flight send is merged and sent after', async () => {
    const { fake, client } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = {
      issueBrief: client.issueBrief.bind(client),
      save: async (id: string, args: Record<string, unknown>) => { await gate; return client.save(id, args) },
    }
    const edits = new LinearEdits(tmpFile(), slow)
    const first = edits.save('CAN-2', { priority: 'high' })
    await new Promise((r) => setTimeout(r, 0)) // first send in flight
    const second = edits.save('CAN-2', { title: 'Later' })
    const third = edits.save('CAN-2', { priority: 'urgent' })
    await new Promise((r) => setTimeout(r, 10))
    expect(saves(fake.calls)).toEqual([])
    release()
    await expect(first).resolves.toMatchObject({ kind: 'sent' })
    await expect(second).resolves.toMatchObject({ kind: 'sent', issue: { title: 'Later', priority: 'urgent' } })
    await expect(third).resolves.toMatchObject({ kind: 'sent', issue: { title: 'Later', priority: 'urgent' } })
    expect(saves(fake.calls)).toEqual([{ id: 'CAN-2', priority: 2 }, { id: 'CAN-2', title: 'Later', priority: 1 }])
    expect(edits.pending()).toEqual([])
  })

  it('a chained description edit is rebased on the text Linear returned', async () => {
    const { fake, client, colleague } = await setup()
    await colleague('CAN-2', 'A\n\nB')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = {
      issueBrief: client.issueBrief.bind(client),
      save: async (id: string, args: Record<string, unknown>) => { await gate; return client.save(id, args) },
    }
    const edits = new LinearEdits(tmpFile(), slow)
    const first = edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A1\n\nB' } })
    await new Promise((r) => setTimeout(r, 0)) // first send in flight
    const second = edits.save('CAN-2', { description: { base: 'A1\n\nB', text: 'A1\n\nB1' } })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await first
    await expect(second).resolves.toMatchObject({ kind: 'sent', issue: { description: 'A1\n\nB1' } })
    expect(saves(fake.calls).map((s) => s.patch)).toEqual([
      [{ op: 'replace', old_string: 'A\n', new_string: 'A1\n' }],
      [{ op: 'insert_after', anchor: '\nB', text: '1' }],
    ])
  })

  it('expired connection gives a French pending reason', async () => {
    const fake = fakeLinear()
    const client = new LinearClient(async () => fake, { saveLinearAuth: () => {} })
    const edits = new LinearEdits(tmpFile(), client)
    const r = await edits.save('CAN-2', { priority: 'high' })
    expect(r).toEqual({ kind: 'pending', reason: "Linear n'est pas connecté." })
  })

  it('a corrupt file is kept aside and the queue starts empty', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    const edits = new LinearEdits(file, { issueBrief: async () => { throw new Error('x') }, save: async () => { throw new Error('x') } })
    expect(edits.pending()).toEqual([])
    const dir = join(file, '..')
    expect(readdirSync(dir).some((f) => f.startsWith('linear-pending.json.corrupt-'))).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})
