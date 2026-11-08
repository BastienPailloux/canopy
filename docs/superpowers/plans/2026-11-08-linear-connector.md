# Connecteur Linear — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linear tickets assigned to Bastien appear in the Tickets screen mixed with local tickets, can be edited (comments included) and launched like a local ticket, through the official Linear MCP server.

**Architecture:** The main process owns one MCP client to `https://mcp.linear.app/mcp` (OAuth with dynamic client registration, tokens encrypted with `safeStorage` in `AppStore`). Every tool answer is validated by hand-written parsers. A sync module keeps a disk cache of the list and never empties it on error. An edit queue on disk turns description edits into `save_issue` `patch` operations and never drops an edit. Launch reuses the git half of the local launch; links branch↔Linear issue live in `AppStore`. The renderer merges local and Linear entries under a `TicketKey` that includes the source.

**Tech Stack:** Electron, React 19, TypeScript, zustand, vitest, Playwright. New dependency: `@modelcontextprotocol/sdk` `1.32.2`.

**Spec:** `docs/superpowers/specs/2026-11-08-linear-connector-design.md` (step 2: `2026-11-08-tickets-design.md`; parent: `2026-11-07-canopy-design.md`). Working spike: `/tmp/canopy-linear-spike/spike.mjs` (OAuth + `listTools`/`callTool`, outside the repo; read it, do not copy its shortcuts).

## Global Constraints

- Only the Linear MCP server, `https://mcp.linear.app/mcp`; no GraphQL, no API key.
- OAuth: dynamic client registration, PKCE S256, `token_endpoint_auth_method: 'none'`, scope `read write`, redirect `http://localhost:<port>/callback`, callback server listening on all local interfaces (IPv4 and IPv6).
- Tokens, refresh token and client info encrypted with `safeStorage`; never written in clear (`EncryptionUnavailableError` like the API key).
- One Linear workspace connected at a time; the connection belongs to the app, Linear tickets show in every repo; no repo↔workspace association, no warning.
- Listed: issues with `assignee: "me"`, plus issues launched in the active repo whose branch still exists. Status type `canceled` hidden.
- Status groups: `triage`, `backlog` → Backlog; `unstarted` → À faire; `started` whose name contains `review`, `revue` or `QA` (case-insensitive) → En revue; other `started` → En cours; `completed` → Terminé; `canceled` → hidden.
- Priority value 0–4 → `none`, `urgent`, `high`, `medium`, `low`.
- Filters: statut, source (`Toutes sources` / `Linear` / `Local`), priorité, recherche (titre et identifiant). No team or label filter.
- Editable: title, description, status (team's real statuses, Linear's order), priority, labels (existing ones only), assignee. Read-only: team, cycle, project. Sub-issues listed, open on click. Comments read + add, no edit/delete. "Ouvrir dans Linear ↗", "Copier le lien". No estimate, no Duplicate, no Archive.
- Sending: status, priority, labels, assignee as soon as changed; title and description on field blur and editor close, never while typing.
- Branch name: `<type>/<identifier lowercased>-<branchSlug(title)>`, e.g. `feat/eng-482-export-csv`. Not Linear's `gitBranchName`.
- No "Passer En cours" checkbox for Linear launches.
- Launch prompt: identifier, URL, title, readable description, then exactly: `Le reste du ticket (commentaires, sous-tickets, pièces jointes) est accessible via le MCP Linear.`
- Sessions use Claude Code's own MCP config; Canopy injects nothing.
- Refresh: every 3 min while the Tickets screen is visible, on window focus, after each edit, and on ⟳.
- An error never empties the list; an unreadable answer is an error; an unsent edit is never dropped.
- UI copy in French. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Same identifier local and Linear (`CAN-7` both sides) → two distinct rows, opening/launching each hits its own source (Task 8 test `local and linear CAN-7 stay distinct`).
- Description edited by a colleague elsewhere in the text while Bastien edits → both kept; edited in the same passage → conflict shown, nothing sent (Task 5 tests `colleague edit elsewhere is kept`, `same passage is a conflict`).
- Quit or crash with an unsent Linear edit → still pending at next start and resent when connected (Task 5 test `pending edits survive a restart`).
- Token refresh fails while the list is shown → cached list stays, banner "Connexion Linear expirée — Reconnecter" (Task 4 test `expired token keeps the cached list`).
- Description holding `<linear-image>` / `<linear-embed>` tags, edited in another paragraph → tags byte-identical after save (Task 5 test `linear tags survive an unrelated edit`).

---

### Task 1: Reference answers and `patch` behaviour

Manual task with Bastien: needs his browser login on the **personal** workspace `canopy` (team `CAN`), never the work one.

**Files:**
- Create: `scripts/linear-capture.mjs`, `tests/fixtures/linear/*.json`, `tests/fixtures/linear/README.md`

- [ ] **Step 1: Ask Bastien to enrich the personal workspace**: one issue with a long Markdown description containing an image (→ `<linear-image>`), priority High, 2 labels, in a current cycle and a project; one issue with 2 sub-issues and 2 comments; one issue in a `started` status named "In Review"; one canceled issue; one issue not assigned to him. All assigned to him except the last.
- [ ] **Step 2: Write `scripts/linear-capture.mjs`** from the spike: same OAuth, state in `/tmp/canopy-linear-capture/` (deleted at the end), `process.exit(0)` when done. It saves to `tests/fixtures/linear/` the raw `callTool` results of: `whoami`, `list_issues {assignee:"me",limit:50}`, `list_issues {assignee:"me",limit:2}` (pagination), `get_issue` with the field list of Task 3 for each issue, `get_issue` on an unknown id (`CAN-9999`), `list_comments`, `list_issue_statuses {team:"CAN"}`, `list_issue_labels {team:"CAN"}`, `list_users`, and `tools.json` (`listTools`). Emails other than Bastien's replaced by `user@example.com`.
- [ ] **Step 3: Probe `save_issue` `patch` on one fixture issue** (write access, personal workspace only, ask Bastien first): `replace` with a unique anchor, `replace` with an anchor present twice, `replace` with a missing anchor, `insert_before`/`insert_after`, two ops at once with one failing. Save each result as `patch-*.json`, restore the description at the end.
- [ ] **Step 4: Write `README.md`**: what each file is, the observed `patch` behaviour (op names, error text for missing/duplicate anchor, atomicity), the exact shape of `labels`, `assignee`, `parentId`, sub-issues and `cycle` in `get_issue`. If `patch` does not behave as needed, write it here: Task 5 then uses the fallback of the spec (full description only if unchanged upstream).
- [ ] **Step 5: Commit** `test: Linear MCP reference answers`.

### Task 2: Shared Linear model

**Files:**
- Create: `src/shared/linear.ts`
- Modify: `src/shared/tickets.ts` (add `TicketKey`)
- Test: `tests/renderer/linearModel.test.ts`

**Interfaces:**
- Produces (`src/shared/tickets.ts`): `type TicketSource = 'local' | 'linear'`; `type TicketKey = \`${TicketSource}:${string}\``; `ticketKey(source: TicketSource, id: string): TicketKey`; `parseTicketKey(k: string): { source: TicketSource; id: string } | null`.
- Produces (`src/shared/linear.ts`):
  - `type LinearStatusType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'`
  - `interface LinearStatus { id: string; name: string; type: LinearStatusType }`
  - `interface LinearUser { id: string; name: string }`
  - `interface LinearIssue { id: string /* ENG-482 */; uuid: string; title: string; description: string; url: string; status: LinearStatus; priority: TicketPriority; labels: string[]; assignee: LinearUser | null; team: { id: string; name: string }; parentId: string | null; cycle: string | null; project: string | null; updatedAt: string }`
  - `interface LinearComment { id: string; author: string; body: string; createdAt: string }`
  - `interface LinearIssueDetail extends LinearIssue { children: Pick<LinearIssue, 'id' | 'title' | 'status'>[]; comments: LinearComment[] }`
  - `statusGroup(s: Pick<LinearStatus, 'name' | 'type'>): TicketStatus | null` (null = hidden)
  - `priorityFromValue(v: number): TicketPriority`
  - `linearBranchName(issue: Pick<LinearIssue, 'id' | 'title'>, type?: string): string`
  - `readableDescription(md: string): string` — Linear tags → `![title](src)` for images, `[vidéo](src)` / `[fichier : name](src)` for embeds, anything unknown left as is.
  - `linearLaunchPrompt(i: LinearIssue): string`
  - `LINEAR_MCP_NOTE = 'Le reste du ticket (commentaires, sous-tickets, pièces jointes) est accessible via le MCP Linear.'`

- [ ] **Step 1: Write failing tests**
  - `statusGroup maps every type`: the table of Global Constraints, including `{type:'started',name:'In Review'}` → `in_review`, `{type:'started',name:'QA'}` → `in_review`, `{type:'started',name:'Code revue'}` → `in_review`, `{type:'started',name:'In Progress'}` → `in_progress`, `canceled` → `null`.
  - `priorityFromValue`: `0→none, 1→urgent, 2→high, 3→medium, 4→low`, `7→none`.
  - `linearBranchName`: `{id:'ENG-482',title:'Export CSV des factures'}` → `feat/eng-482-export-csv-des-factures`; with type `fix` → `fix/eng-482-…`.
  - `readableDescription`: an `<linear-image>{"type":"image","attrs":{"src":"https://u/x","title":"a.png"}}</linear-image>` becomes `![a.png](https://u/x)`; malformed JSON inside a tag leaves the tag untouched.
  - `linearLaunchPrompt` equals `'Ticket ENG-482 : Export\nhttps://linear.app/x/issue/ENG-482\n\n<readable description>\n\n' + LINEAR_MCP_NOTE`; empty description drops its paragraph.
  - `ticketKey round-trips` and `parseTicketKey('nope')` → `null`.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/linearModel.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the interfaces above. Exact tag shapes come from Task 1's README.
- [ ] **Step 4: Run** the test → PASS. `npm run typecheck` → no error.
- [ ] **Step 5: Commit** `feat(linear): shared model, status groups and branch name`.

### Task 3: Answer parsers

**Files:**
- Create: `src/main/linear/parse.ts`
- Test: `tests/main/linear/parse.test.ts`

**Interfaces:**
- Consumes: Task 2 types, Task 1 fixtures.
- Produces:
  - `class LinearFormatError extends Error` (message names the tool and the field: `Réponse Linear inattendue (list_issues : status)`)
  - `ISSUE_FIELDS: string[]` — the `fields` passed to `get_issue`/`list_issues`: `id, uuid, title, description, priority, url, updatedAt, status, statusType, labels, assignee, assigneeId, parentId, team, teamId, cycleId, project`.
  - `toolJson(tool: string, r: CallToolResult): unknown` — throws `LinearError` with Linear's text when `isError`, `LinearFormatError` when no text block or invalid JSON.
  - `parseIssueList(v: unknown): { issues: LinearIssue[]; cursor: string | null }`
  - `parseIssue(v: unknown): LinearIssue`, `parseChildren(v: unknown)`, `parseComments(v: unknown): LinearComment[]`, `parseStatuses(v: unknown): LinearStatus[]`, `parseLabels(v: unknown): string[]`, `parseUsers(v: unknown): LinearUser[]`, `parseWhoami(v: unknown): { workspace: string; email: string; userId: string }`
  - `class LinearError extends Error { notFound: boolean }`

- [ ] **Step 1: Write failing tests** against every fixture: each parses; `list_issues` fixture gives the issue count of the fixture with `status.type` set; the unknown-id fixture gives `LinearError` with `notFound: true`; a copy of the list fixture with `status` removed from one issue throws `LinearFormatError` mentioning `status`; `{"issues":[],"hasNextPage":false}` parses to `[]` (an empty list is not an error); a text block that is not JSON throws `LinearFormatError`.
- [ ] **Step 2: Run** `npx vitest run tests/main/linear/parse.test.ts` → FAIL.
- [ ] **Step 3: Implement** with plain type guards like `ticketIpc.ts` (no new validation library). Unknown extra fields are ignored; a missing or mistyped field used by Canopy throws.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): validate MCP answers`.

### Task 4: Connection, OAuth and client

**Files:**
- Create: `src/main/linear/auth.ts`, `src/main/linear/client.ts`, `tests/helpers/fakeLinear.ts`
- Modify: `src/main/appStore.ts` (encrypted `linearAuth` blob), `package.json` (`@modelcontextprotocol/sdk@1.32.2`)
- Test: `tests/main/linear/auth.test.ts`, `tests/main/linear/client.test.ts`, `tests/main/appStore.test.ts`

**Interfaces:**
- Produces (`appStore.ts`): `linearAuth(): LinearAuthState | null`, `saveLinearAuth(s: LinearAuthState | null): void` (throws `EncryptionUnavailableError` with message `Le trousseau macOS n'est pas disponible : la connexion Linear n'a pas été enregistrée.`); `LinearAuthState = { client?: unknown; tokens?: unknown; verifier?: string }` stored as one base64 ciphertext.
- Produces (`auth.ts`): `class LinearAuthProvider implements OAuthClientProvider` (ctor `(store: Pick<AppStore,'linearAuth'|'saveLinearAuth'>, redirectUrl: string, openExternal: (url: string) => void)`); `waitForCallback(port: number, timeoutMs = 300_000): { url: string; code: Promise<string>; close(): void }` — listens without host (dual stack), answers the browser with a French HTML page.
- Produces (`client.ts`):
  - `interface McpCaller { listTools(): Promise<{ name: string; inputSchema: unknown }[]>; callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>; close(): Promise<void> }`
  - `REQUIRED_TOOLS = ['whoami','list_issues','get_issue','save_issue','list_comments','save_comment','list_issue_statuses','list_issue_labels','list_users']`
  - `interface LinearConnection { state: 'disconnected' | 'connected' | 'expired'; workspace?: string; email?: string; missingTools: string[] }`
  - `class LinearClient` (ctor `(open: (interactive: boolean) => Promise<McpCaller>)`): `connect(): Promise<LinearConnection>` (interactive OAuth), `resume(): Promise<LinearConnection>` (stored tokens only, never opens a browser), `disconnect(): Promise<void>` (clears `linearAuth`), `connection(): LinearConnection`, `listMine(): Promise<LinearIssue[]>` (follows `cursor`), `issue(id): Promise<LinearIssueDetail>` (get_issue + children via `list_issues {parentId}` or the field Task 1 found + list_comments), `issueBrief(id): Promise<LinearIssue>`, `teamOptions(teamId): Promise<{ statuses: LinearStatus[]; labels: string[]; users: LinearUser[] }>`, `save(id: string, args: Record<string, unknown>): Promise<LinearIssue>`, `comment(id: string, body: string): Promise<LinearComment>`.
  - Any `UnauthorizedError` after a refresh attempt sets state `expired` and rethrows `LinearExpiredError`.
- Produces (`tests/helpers/fakeLinear.ts`): `fakeLinear(opts?: { fixtures?: string; failWith?: Error; mutate?: (tool, args) => unknown }): McpCaller & { calls: { name: string; args: unknown }[] }` replaying Task 1 fixtures, with `save_issue`/`save_comment` applied to an in-memory copy.

- [ ] **Step 1: Write failing tests**
  - appStore: `linear auth is never stored in clear` (state file does not contain the token string), `unreadable linear auth reads as null`.
  - auth: `callback resolves the code on ::1 and 127.0.0.1` (two runs, `fetch` on each address), `callback with error rejects with it`, `provider keeps client, tokens and verifier through the store`.
  - client: `listMine follows the cursor` (fake with 2-per-page), `missing tool is reported` (fake whose `listTools` lacks `save_issue` → `missingTools: ['save_issue']`), `expired token keeps the cached list` (lives in Task 6; here: `UnauthorizedError` → `connection().state === 'expired'` and `LinearExpiredError`), `resume never opens the browser`.
- [ ] **Step 2: Run** `npx vitest run tests/main/linear tests/main/appStore.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The real `open` builds `StreamableHTTPClientTransport(new URL(LINEAR_MCP_URL), { authProvider })` and a `Client({ name: 'canopy', version })`; on `UnauthorizedError` in interactive mode, await `waitForCallback`, `transport.finishAuth(code)`, reconnect with a fresh transport (as the spike). Port: first free from 33418 upward; the redirect URL is registered with the client, so a different port re-registers (clear `client` in the state).
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(linear): OAuth connection and MCP client`.

### Task 5: Edit queue and description patches

**Files:**
- Create: `src/main/linear/descriptionPatch.ts`, `src/main/linear/edits.ts`
- Test: `tests/main/linear/descriptionPatch.test.ts`, `tests/main/linear/edits.test.ts`

**Interfaces:**
- Consumes: `LinearClient.issueBrief`, `LinearClient.save` (Task 4).
- Produces (`descriptionPatch.ts`):
  - `type PatchOp = { op: 'replace'; old_string: string; new_string: string } | { op: 'insert_before' | 'insert_after'; anchor: string; text: string }` (names as found in Task 1)
  - `diffToPatch(base: string, mine: string): PatchOp[]` — common prefix/suffix, one op for the changed middle, context widened (whole lines) until the anchor occurs once in `base`; `[]` when equal.
  - `rebase(base: string, mine: string, remote: string): { kind: 'clean'; ops: PatchOp[] } | { kind: 'conflict'; remote: string }` — clean when `remote === base`, or every anchor of `diffToPatch(base, mine)` occurs exactly once in `remote`.
- Produces (`edits.ts`):
  - `type LinearChange = { title?: string; description?: { base: string; text: string }; statusId?: string; priority?: TicketPriority; labels?: string[]; assigneeId?: string | null }`
  - `type SaveResult = { kind: 'sent'; issue: LinearIssue } | { kind: 'pending'; reason: string } | { kind: 'conflict'; field: 'description'; remote: string; mine: string }`
  - `class LinearEdits` (ctor `(file: string, client: Pick<LinearClient,'issueBrief'|'save'>)`): `save(id: string, c: LinearChange): Promise<SaveResult>`, `pending(): { id: string; change: LinearChange; error: string }[]`, `retryAll(): Promise<void>`, `discard(id: string): void` (only on Bastien's explicit choice), `onChange(l: () => void): () => void`.
  - Pending queue in `<userData>/linear-pending.json`, written atomically before each send, removed entry after success; changes to the same issue merge key by key.

- [ ] **Step 1: Write failing tests**
  - `diffToPatch`: equal → `[]`; one word changed in a 3-paragraph text → one `replace` whose `old_string` occurs once in base; appended paragraph → `insert_after` anchored on the last line; a changed line identical to another line elsewhere → anchor widened to stay unique.
  - `colleague edit elsewhere is kept`: base `A\n\nB`, mine `A2\n\nB`, remote `A\n\nB2` → clean; applying ops to remote gives `A2\n\nB2`.
  - `same passage is a conflict`: remote `A3\n\nB` → `conflict`, nothing sent (fake `calls` has no `save_issue`).
  - `linear tags survive an unrelated edit`: base holding a `<linear-image>…</linear-image>` paragraph, edit in another paragraph → the tag text is outside every `old_string` and byte-identical in the result.
  - `failed send stays pending`: fake throws network error → `{kind:'pending'}`, `pending()` length 1, file holds it.
  - `pending edits survive a restart`: new `LinearEdits` on the same file → `pending()` still holds it; `retryAll()` with a working fake sends it and empties the file.
  - `fields are sent only when changed`: `save(id,{priority:'high'})` → one `save_issue` with `{id, priority: 2}` and nothing else.
- [ ] **Step 2: Run** `npx vitest run tests/main/linear/descriptionPatch.test.ts tests/main/linear/edits.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Before sending a description, `issueBrief(id)` gives `remote`, then `rebase`. Linear priority values for sending are the inverse of `priorityFromValue`. If Task 1 found `patch` unusable: send `description: mine` only when `remote === base`, else conflict (same tests, the "elsewhere" one then expects a conflict — update it and note it in the commit).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): edit queue with description patches`.

### Task 6: Sync, cache and departures

**Files:**
- Create: `src/main/linear/sync.ts`
- Test: `tests/main/linear/sync.test.ts`

**Interfaces:**
- Consumes: `LinearClient.listMine`, `LinearClient.issueBrief`, `LinearClient.connection`.
- Produces:
  - `interface Departure { id: string; title: string; reason: 'reassigned' | 'canceled' | 'missing' }`
  - `interface LinearListState { issues: LinearIssue[]; fetchedAt: string | null; error: string | null; expired: boolean; departures: Departure[] }`
  - `class LinearSync` (ctor `(file: string, client, extra: () => string[] /* launched ids to keep */)`): `state(): LinearListState`, `refresh(): Promise<LinearListState>`, `ackDepartures(ids: string[]): void`, `onChange(l): () => void`.
  - Cache `<userData>/linear-cache.json` `{ issues, fetchedAt }`; `disconnect` deletes it (Task 8 wires that).

- [ ] **Step 1: Write failing tests**
  - `error keeps the last list`: refresh OK (3 issues), then fake throws → `issues.length === 3`, `error` set, `fetchedAt` unchanged.
  - `unreadable answer is an error, not an empty list`: fake returns non-JSON → same as above.
  - `expired token keeps the cached list`: `LinearExpiredError` → `expired: true`, issues kept.
  - `cache survives a restart`: new `LinearSync` on the same file → `state().issues` from disk before any refresh.
  - `departure reasons`: an issue gone from `listMine` is looked up with `issueBrief`: other assignee → `reassigned`; status type `canceled` → `canceled`; `LinearError notFound` → `missing`; status `completed` → not a departure, kept in the list.
  - `launched issue stays listed`: `extra()` returns `['ENG-9']`, not in `listMine` → fetched with `issueBrief` and kept, no departure.
  - `canceled issues are not listed`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** One refresh at a time (a call during one returns the same promise).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): list sync with cache and departures`.

### Task 7: Linear links and launch in main

**Files:**
- Modify: `src/main/tickets/launch.ts` (extract the git half), `src/main/appStore.ts` (`linearLinks`)
- Create: `src/main/linear/launch.ts`
- Test: `tests/main/tickets/launch.test.ts`, `tests/main/linear/launch.test.ts`

**Interfaces:**
- Produces (`launch.ts`): `startTicketBranch(deps: LaunchDeps, root: string, branch: string, target: LaunchTarget): Promise<string /* worktree */>` — `checkNewBranch`, create/start, `setBranchBase`; `launchTicket` now calls it (behaviour unchanged).
- Produces (`appStore.ts`): `linearLinks(root: string): Record<string, { branch: string; worktree: string; base: string }>`, `setLinearLink(root: string, id: string, link | null): void`; `pruneBranchBases` also prunes `linearLinks` whose branch is gone.
- Produces (`src/main/linear/launch.ts`): `interface LinearLaunchRequest { id: string; branch: string; target: LaunchTarget }`; `launchLinear(deps: LaunchDeps & { linear: Pick<LinearClient,'issueBrief'> }, repo: string, req: LinearLaunchRequest): Promise<{ worktree: string; issue: LinearIssue }>` — writes nothing in Linear.

- [ ] **Step 1: Write failing tests**: existing `launch.test.ts` passes unchanged after the extraction; `linear launch links branch and issue` (link stored, no `save_issue` call); `failed linear launch stores no link` (branch exists); `relaunch replaces the link`.
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/launch.test.ts tests/main/linear/launch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): launch a Linear ticket`.

### Task 8: IPC, preload and wiring

**Files:**
- Create: `src/main/linear/linearIpc.ts`
- Modify: `src/main/index.ts`, `src/shared/api.ts`, `src/preload/index.ts` (follow the `tickets` entries), `src/main/quit.ts` (pending edits count as unsaved)
- Test: `tests/main/linear/linearIpc.test.ts`

**Interfaces:**
- Produces (`window.canopy`, channels `linear:*`):
  - `linearConnection(): Promise<LinearConnection>`, `linearConnect(): Promise<LinearConnection>`, `linearDisconnect(force?: boolean): Promise<void>` — deletes auth and cache, keeps `linearLinks`; refuses with `Des modifications Linear n'ont pas été envoyées.` when `pending()` is not empty, unless `force`
  - `linearList(repo: string): Promise<LinearListState>` (extra = linked ids of that repo whose branch exists), `linearRefresh(repo: string): Promise<LinearListState>`, `linearAckDepartures(ids: string[]): Promise<void>`
  - `linearIssue(id: string): Promise<LinearIssueDetail>`, `linearTeamOptions(teamId: string)`
  - `linearSave(id: string, c: LinearChange): Promise<SaveResult>`, `linearPending(): Promise<{ id: string; error: string }[]>`, `linearDiscard(id: string): Promise<void>`, `linearComment(id: string, body: string): Promise<LinearComment>`
  - `linearLaunch(repo: string, req: LinearLaunchRequest): Promise<{ worktree: string; issue: LinearIssue }>`, `linearLinks(repo: string): Promise<Record<string, { branch: string; worktree: string; base: string }>>`
  - Event `linear:changed` `{}` on any sync, pending or connection change.
- Validation: `LINEAR_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/`; `LinearChange` keys checked like `parseFields`; title ≤ `MAX_TITLE`, description ≤ `MAX_DESCRIPTION`, labels ≤ `MAX_LABELS`.
- `CANOPY_FAKE_LINEAR=<fixtures dir>` makes `index.ts` use `fakeLinear`-like replay (move the replay core to `src/main/linear/replay.ts`, used by both the helper and e2e) — same pattern as `CANOPY_FAKE_QUERY`.
- On app start: `client.resume()`, then `edits.retryAll()` when connected.

- [ ] **Step 1: Write failing tests**: bad id refused; unknown `LinearChange` key refused; `disconnect refuses with pending edits`; `local and linear CAN-7 stay distinct` (here: `linearIssue('CAN-7')` hits the fake, `getTicket(repo,'CAN-7')` hits the file store, both answer their own title).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(linear): IPC and app wiring`.

### Task 9: Mixed list, filters and sync header

**Files:**
- Create: `src/renderer/tickets/linearStore.ts`, `src/renderer/tickets/listModel.ts`
- Modify: `src/renderer/tickets/TicketsScreen.tsx`, `src/renderer/tickets/ticketStore.ts`, `src/renderer/store.ts` (`selectedTicket`, `openTicket` become `TicketKey | 'new' | null`), `src/renderer/tickets/tickets.css`
- Test: `tests/renderer/listModel.test.ts`, `tests/renderer/linearStore.test.ts`, `tests/renderer/ticketStore.test.ts`

**Interfaces:**
- Produces (`listModel.ts`):
  - `type Row = { key: TicketKey; source: TicketSource; id: string; title: string; status: TicketStatus; statusName?: string /* Linear name when ≠ group label */; priority: TicketPriority; labels: string[]; pending: boolean }`
  - `interface Filters { status: 'all' | TicketStatus; source: 'all' | TicketSource; priority: 'all' | TicketPriority; query: string }`
  - `mergeRows(local: TicketListEntry[], linear: LinearIssue[], pendingIds: Set<string>): Row[]`
  - `filterRows(rows: Row[], f: Filters): Row[]` — query matches title or id, case- and accent-insensitive.
  - `groupRows(rows: Row[]): { status: TicketStatus; rows: Row[] }[]` (STATUS_ORDER, empty groups dropped)
  - `syncLabel(s: LinearListState, now: Date): string` → `Linear · synchro il y a 1 min`, `Linear · liste du 14:02 — <error>`, `Connexion Linear expirée — Reconnecter`.
- Produces (`linearStore.ts`): `useLinear` (zustand: `connection`, `list`, `pending`, `links`), `connectLinear(): () => void` — loads on start and repo change, refreshes every 180 000 ms while `view === 'tickets'`, on window `focus`, on `linear:changed`.

- [ ] **Step 1: Write failing tests**
  - `mergeRows`: `local and linear CAN-7 stay distinct` (two rows, keys `local:CAN-7` / `linear:CAN-7`); a Linear issue `started`/"QA" lands in `in_review` with `statusName: 'QA'`; `statusName` is set only when the Linear name differs from `STATUS_LABEL[group]` (`started`/"En cours" → no `statusName`).
  - `filterRows`: source `linear` keeps only Linear rows; priority `high`; query `facture` matches `Export CSV des Factures`; query `eng-48` matches `ENG-482`.
  - `syncLabel`: the three strings above for fixed dates.
  - `linearStore`: a failed refresh keeps `list.issues` (mirrors main), refresh timer stops when leaving Tickets.
  - `ticketStore`: existing tests updated to `TicketKey` selection.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: header gets the sync label + ⟳; second filter row (source segmented, priority menu, search input) only when Linear is connected; rows show badge `Linear`/`Local`, `statusName` small, `non envoyé` marker when `pending`. Departures: one dismissible notice per departure (`ENG-482 n'est plus assigné à toi`, `… a été annulé`, `… est introuvable`), dismiss calls `linearAckDepartures`. Without connection the screen is step 2's.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): mixed ticket list with filters`.

### Task 10: Linear editor

**Files:**
- Create: `src/renderer/tickets/LinearEditor.tsx`, `src/renderer/tickets/linearSave.ts`
- Modify: `src/renderer/tickets/TicketEditor.tsx` (dispatch on key source), `src/renderer/tickets/tickets.css`, `src/renderer/unsaved.ts`
- Test: `tests/renderer/linearSave.test.ts`

**Interfaces:**
- Consumes: `linearIssue`, `linearTeamOptions`, `linearSave`, `linearComment`, `readableDescription`.
- Produces (`linearSave.ts`): `createLinearSaver(id: string, base: LinearIssueDetail, send: (c: LinearChange) => Promise<SaveResult>): { field(c: Omit<LinearChange,'title'|'description'>): void /* sent now */; text(k: 'title' | 'description', v: string): void /* kept */; commit(k?: 'title' | 'description'): Promise<SaveResult | null> /* blur or close */; dirty(): boolean; onResult(l: (r: SaveResult) => void): () => void }` — description `base` is the text last read or last sent.

- [ ] **Step 1: Write failing tests**: `text is not sent while typing` (10 `text()` calls → 0 `send`); `blur sends the description once with its base`; `field changes are sent at once`; `a conflict result keeps the local text dirty`; `close commits title and description`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the screen per the spec section 6 and the `editor` mockup: header (← Retour, badge, id · équipe, Ouvrir dans Linear ↗ via the existing external-link opener, Copier le lien), title, description (Markdown textarea with step 2's toolbar; Linear tags shown through `readableDescription` in preview, left raw in the textarea), sub-issues (click opens `linear:<id>`), comments (list + "Ajouter un commentaire…", ⌘↵ sends), side column (Statut menu from `teamOptions.statuses` in their order, Priorité, Étiquettes from `labels`, Assigné from `users`, Équipe / Cycle / Projet read-only), Lancement block (branch preview + ▶ Lancer). Unassigning shows `Ce ticket quittera ta liste au prochain rafraîchissement.` Conflict: both versions side by side, "Garder la mienne" (sends `description: mine` with `base: remote`) / "Prendre celle de Linear". `unsaved.ts` counts dirty Linear editors and main's pending edits.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(linear): Linear ticket editor`.

### Task 11: Launch panel, settings and session notice

**Files:**
- Modify: `src/renderer/tickets/LaunchPanel.tsx`, `src/renderer/tickets/launchFlow.ts`, `src/renderer/shell/Settings.tsx`, `src/renderer/shell/WorktreeList.tsx` (ticket badge for Linear links: `ticketId` from `linearLinks` too, click opens `linear:<id>`), `src/main/sessions/SessionManager.ts`, `src/shared/sessionOptions.ts`, `src/renderer/sessions/sessionStore.ts`
- Test: `tests/renderer/launchFlow.test.ts`, `tests/main/sessions/linearNotice.test.ts`

**Interfaces:**
- Produces (`launchFlow.ts`): `runLinearLaunch(repo: string, req: LinearLaunchRequest, o: { startClaude: boolean }): Promise<void>` — like `runLaunch`, prompt `linearLaunchPrompt(issue)`, session started with `expectLinear: true`.
- Produces (`sessionOptions.ts`): `StartSessionOptions.expectLinear?: boolean`.
- Produces (`SessionManager.ts`): `hasLinearServer(servers: { name: string; status: string }[]): boolean` — true if a server whose name contains `linear` (case-insensitive) has status `connected`; on the first `system/init` of a session with `expectLinear`, if false, notify `notice` `{ localId, text: 'Claude n’a pas accès à Linear dans cette session.' }` once.

- [ ] **Step 1: Write failing tests**: `hasLinearServer([{name:'plugin:design:linear',status:'needs-auth'}])` → false, `[{name:'linear',status:'connected'}]` → true; `notice sent once with expectLinear and no server`; `no notice without expectLinear`; `runLinearLaunch` sends `linearLaunchPrompt` and never calls `patchTicket`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: LaunchPanel for `linear:` keys — branch prefilled with `linearBranchName`, type menu kept, no "Passer En cours" checkbox. Settings: section "Linear" — disconnected: "Connecter Linear" + `Canopy demande la lecture et l'écriture sur ton espace Linear.`; connected: `<workspace> · <email>` + "Déconnecter" (confirm when pending edits); expired: "Reconnecter"; `missingTools` non-empty: `Linear a changé : outils manquants (<list>). Certaines fonctions sont désactivées.` "Créer la PR" prompt for a branch with a Linear link adds `Mets ENG-482 dans le titre de la PR.` (find the PR prompt builder used by the Code screen).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(linear): launch panel, settings and session notice`.

### Task 12: End-to-end and manual check

**Files:**
- Create: `tests/e2e/linear.spec.ts`

- [ ] **Step 1: Write e2e** with `CANOPY_FAKE_LINEAR=tests/fixtures/linear` and `CANOPY_FAKE_QUERY=1`: list shows Linear and local rows with badges; source filter `Linear` hides local rows; open a Linear ticket, edit description, leave the field → the fake received one `save_issue` with `patch`; fake set to fail → row shows `non envoyé`, app restart → still pending, fake fixed → sent; launch a Linear ticket in a new worktree → branch `feat/<id lower>-<slug>`, Sessions opened, prompt contains `LINEAR_MCP_NOTE`.
- [ ] **Step 2: Run** `npm run test:e2e -- linear.spec.ts` → PASS; `npm test` and `npm run typecheck` → green.
- [ ] **Step 3: Manual check with Bastien on the personal workspace**: connect from Settings, list matches Linear, edit a description in Canopy and in Linear at once (other paragraph) → both kept, launch a ticket, open the PR and check Linear links it. Note any gap in the PR description.
- [ ] **Step 4: Commit** `test(linear): end-to-end`.
