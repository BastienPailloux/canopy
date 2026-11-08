// Captures raw answers of the Linear MCP server into tests/fixtures/linear/.
//   node scripts/linear-capture.mjs capture            (read-only calls)
//   node scripts/linear-capture.mjs patch <ISSUE-ID>   (save_issue `patch` probes on ONE issue; WRITES)
// Needs a browser login on the personal workspace (team CAN). State lives in /tmp/canopy-linear-capture/
// and is deleted at the end. SDK: resolved from the repo if installed, else from LINEAR_SDK_DIR
// (default /tmp/canopy-linear-spike/node_modules/@modelcontextprotocol/sdk).
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

async function importSdk(sub) {
  try {
    return await import(`@modelcontextprotocol/sdk/${sub}`)
  } catch {
    const dir = process.env.LINEAR_SDK_DIR ?? '/tmp/canopy-linear-spike/node_modules/@modelcontextprotocol/sdk'
    return import(pathToFileURL(join(dir, 'dist/esm', sub)).href)
  }
}
const { Client } = await importSdk('client/index.js')
const { StreamableHTTPClientTransport } = await importSdk('client/streamableHttp.js')
const { UnauthorizedError } = await importSdk('client/auth.js')

const MODE = process.argv[2]
const PATCH_ID = process.argv[3]
if (MODE !== 'capture' && !(MODE === 'patch' && PATCH_ID)) {
  console.error('Usage: node scripts/linear-capture.mjs capture | patch <ISSUE-ID>')
  process.exit(2)
}

const SERVER = new URL('https://mcp.linear.app/mcp')
const PORT = 33418
const REDIRECT = `http://localhost:${PORT}/callback`
const TEAM = 'CAN'
const STATE_DIR = new URL('file:///tmp/canopy-linear-capture/')
const OUT_DIR = new URL('../tests/fixtures/linear/', import.meta.url)
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(OUT_DIR, { recursive: true })

const load = (k) => { const f = new URL(`${k}.json`, STATE_DIR); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined }
const save = (k, v) => writeFileSync(new URL(`${k}.json`, STATE_DIR), JSON.stringify(v, null, 2), { mode: 0o600 })

// Emails other than the logged-in user's are anonymised before writing fixtures.
let ownEmail = null
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const anonymise = (s) => s.replace(EMAIL_RE, (m) => (ownEmail && m.toLowerCase() === ownEmail.toLowerCase() ? m : 'user@example.com'))
const dump = (name, v) => writeFileSync(new URL(name, OUT_DIR), anonymise(JSON.stringify(v, null, 2)) + '\n')
const text = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

const provider = {
  get redirectUrl() { return REDIRECT },
  get clientMetadata() {
    return {
      client_name: 'Canopy (capture)', redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: MODE === 'patch' ? 'read write' : 'read',
    }
  },
  clientInformation: () => load('client'),
  saveClientInformation: (i) => save('client', i),
  tokens: () => load('tokens'),
  saveTokens: (t) => save('tokens', t),
  saveCodeVerifier: (v) => save('verifier', v),
  codeVerifier: () => load('verifier'),
  redirectToAuthorization(url) {
    console.log('\nOuvre ce lien pour autoriser :\n' + url.href + '\n')
    execFile('open', [url.href], () => {})
  },
}

// Callback server: started only when auth is needed, closed right after. No host => dual-stack (IPv6 matters for "localhost").
function waitForCode() {
  let srv, timer
  const p = new Promise((resolve, reject) => {
    srv = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT)
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
      const code = u.searchParams.get('code'); const err = u.searchParams.get('error')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(code ? '<h2>Canopy : connecté, tu peux fermer cet onglet.</h2>' : `<h2>Erreur : ${err}</h2>`)
      code ? resolve(code) : reject(new Error(err ?? 'pas de code'))
    }).listen(PORT)
    srv.on('error', reject)
    timer = setTimeout(() => reject(new Error('timeout 5 min')), 300_000)
  })
  const stop = () => { clearTimeout(timer); srv?.closeAllConnections?.(); srv?.close() }
  p.then(stop, stop)
  return p
}

async function connect() {
  const mk = () => ({
    transport: new StreamableHTTPClientTransport(SERVER, { authProvider: provider }),
    client: new Client({ name: 'canopy-capture', version: '0.0.0' }),
  })
  let { transport, client } = mk()
  try {
    await client.connect(transport); return client
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e
    const codeP = waitForCode(); codeP.catch(() => {})
    const code = await codeP
    await transport.finishAuth(code)
    ;({ transport, client } = mk()) // fresh transport after finishAuth
    await client.connect(transport); return client
  }
}

let client
async function call(name, args, file) {
  const t0 = Date.now()
  try {
    const r = await client.callTool({ name, arguments: args })
    if (file) dump(file, r)
    console.log(`${name} ${JSON.stringify(args).slice(0, 120)} -> ${file ?? '-'} (${Date.now() - t0} ms, isError=${!!r.isError})`)
    return r
  } catch (e) {
    console.log(`${name} FAILED: ${e.message}`)
    if (file) dump(file, { error: e.message })
    return undefined
  }
}

const ID_RE = new RegExp(`\\b${TEAM}-\\d+\\b`, 'g')
const idsIn = (s) => [...new Set(s.match(ID_RE) ?? [])]
const tryJson = (s) => { try { return JSON.parse(s) } catch { return undefined } }
function findCursor(r) {
  const j = tryJson(text(r))
  if (j && typeof j === 'object' && (j.cursor || j.nextCursor)) return j.cursor ?? j.nextCursor
  const m = text(r).match(/"?(?:next)?[cC]ursor"?\s*[:=]\s*"?([^"\s,}]+)"?/)
  return m && m[1] !== 'null' ? m[1] : undefined
}

const GET_FIELDS = ['id', 'uuid', 'title', 'description', 'priority', 'url', 'updatedAt', 'status', 'statusType',
  'labels', 'assignee', 'assigneeId', 'parentId', 'team', 'teamId', 'cycleId', 'project']

async function capture() {
  const me = await call('whoami', {}, 'whoami.json')
  ownEmail = text(me).match(EMAIL_RE)?.[0] ?? null
  // whoami was dumped before ownEmail was known: rewrite it now that we know which email to keep.
  if (me) dump('whoami.json', me)
  console.log('own email:', ownEmail ? 'found' : 'NOT found (all emails will be anonymised)')

  const { tools } = await client.listTools()
  dump('tools.json', tools)
  console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`)

  const mine = await call('list_issues', { assignee: 'me', limit: 50 }, 'list_issues_me.json')
  const p1 = await call('list_issues', { assignee: 'me', limit: 2 }, 'list_issues_me_page1.json')
  const cursor = findCursor(p1)
  if (cursor) await call('list_issues', { assignee: 'me', limit: 2, cursor }, 'list_issues_me_page2.json')
  else console.log('no cursor found in page 1 (no page 2 saved)')

  const ids = idsIn(text(mine))
  console.log('issues:', ids.join(', ') || '(none)')
  let commentsDone = 0
  for (const id of ids) {
    const full = await call('get_issue', { id, fields: GET_FIELDS }, `get_issue_${id}.json`)
    await call('get_issue', { id }, `get_issue_${id}_default.json`)
    // list_comments for issues; keep every one (cheap) so the commented one is surely covered.
    await call('list_comments', { issueId: id }, `list_comments_${id}.json`)
    commentsDone++
    void full
  }
  await call('get_issue', { id: `${TEAM}-9999` }, 'get_issue_unknown.json')

  // Sub-issues: probe list_issues with a parentId param if the schema has one.
  const li = tools.find((t) => t.name === 'list_issues')
  const props = Object.keys(li?.inputSchema?.properties ?? {})
  console.log('list_issues params:', props.join(', '))
  const parentParam = props.find((p) => p === 'parentId') ?? props.find((p) => /parent/i.test(p))
  if (parentParam) {
    let parent
    for (const id of ids) {
      const j = text(await client.callTool({ name: 'get_issue', arguments: { id, fields: GET_FIELDS } }))
      if (/children|sub-?issues/i.test(j)) { parent = id; break }
    }
    parent ??= ids[0]
    console.log(`list_issues with ${parentParam}=${parent}`)
    if (parent) await call('list_issues', { [parentParam]: parent }, `list_issues_children_${parent}.json`)
  } else console.log('list_issues has no parent param: skipped')

  await call('list_issue_statuses', { team: TEAM }, 'list_issue_statuses.json')
  await call('list_issue_labels', { team: TEAM }, 'list_issue_labels.json')
  await call('list_users', {}, 'list_users.json')
  console.log(`done: ${ids.length} issues, ${commentsDone} comment lists`)
}

async function patchProbes(id) {
  const { tools } = await client.listTools()
  const si = tools.find((t) => t.name === 'save_issue')
  if (!si) throw new Error('save_issue not found')
  const patchSchema = si.inputSchema?.properties?.patch
  console.log('save_issue.patch schema:', JSON.stringify(patchSchema ?? '(no patch param)', null, 2))
  if (!patchSchema) throw new Error('save_issue has no `patch` param; aborting before any write')

  const readDesc = async () => {
    const r = await client.callTool({ name: 'get_issue', arguments: { id, fields: ['id', 'description'] } })
    const j = tryJson(text(r))
    return { raw: r, desc: typeof j?.description === 'string' ? j.description : undefined }
  }
  const before = await readDesc()
  if (before.desc === undefined) throw new Error('could not read description as JSON; aborting before any write')
  const original = before.desc
  dump('patch-original.json', before.raw)
  console.log(`original description: ${original.length} chars`)

  // Anchors come from the real text: first word-ish chunk (>=4 chars) for unique/duplicate probes.
  const words = original.match(/[A-Za-zÀ-ÿ]{4,}/g) ?? []
  const counts = new Map(); for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const uniq = [...counts].find(([, n]) => n === 1)?.[0]
  const dup = [...counts].find(([, n]) => n >= 2)?.[0]
  console.log(`anchors: unique=${uniq} duplicate=${dup}`)

  // Op shape is read from the schema above; defaults below follow the plan's naming and may need a tweak
  // (set LINEAR_PATCH_SHAPE='{"op":"type","anchor":"find"...}' is not supported: edit op() if the logged schema differs).
  const op = (type, anchor, extra) => ({ op: type, find: anchor, ...extra })
  const probes = []
  if (uniq) probes.push(['replace-unique', [op('replace', uniq, { replace: `${uniq}-PROBE` })]])
  if (dup) probes.push(['replace-duplicate', [op('replace', dup, { replace: `${dup}-PROBE` })]])
  probes.push(['replace-missing', [op('replace', 'ZZ-NO-SUCH-ANCHOR-ZZ', { replace: 'x' })]])
  if (uniq) {
    probes.push(['insert-before', [{ op: 'insert_before', find: uniq, insert: 'BEFORE-PROBE ' }]])
    probes.push(['insert-after', [{ op: 'insert_after', find: uniq, insert: ' AFTER-PROBE' }]])
    probes.push(['two-ops-one-failing', [op('replace', uniq, { replace: `${uniq}-OK` }), op('replace', 'ZZ-NO-SUCH-ANCHOR-ZZ', { replace: 'x' })]])
  }

  try {
    for (const [name, ops] of probes) {
      await call('save_issue', { id, patch: { description: ops } }, `patch-${name}.json`)
      const now = await readDesc()
      console.log(`  after ${name}: ${now.desc === original ? 'unchanged' : 'CHANGED'}`)
      dump(`patch-${name}-after.json`, now.raw)
      if (now.desc !== original) await call('save_issue', { id, description: original }, null) // reset between probes
    }
  } finally {
    await call('save_issue', { id, description: original }, 'patch-restore.json')
    const end = await readDesc()
    console.log(end.desc === original ? 'RESTORED: description identical to original' : 'WARNING: description differs from original, fix by hand')
    dump('patch-restore-after.json', end.raw)
  }
}

let exitCode = 0
try {
  client = await connect()
  console.log('Connecté. Serveur :', JSON.stringify(client.getServerVersion()))
  if (MODE === 'capture') await capture(); else await patchProbes(PATCH_ID)
  await client.close()
  console.log('Fini. Résultats dans', OUT_DIR.pathname)
} catch (e) {
  console.error('ERREUR :', e?.message ?? e)
  exitCode = 1
} finally {
  rmSync(STATE_DIR, { recursive: true, force: true })
}
process.exit(exitCode)
