# Outils Canopy pour Claude (serveur MCP interne) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Claude session launched by Canopy an in-process MCP server `canopy` to list, read, create and update local and Linear tickets (sub-tickets included) and link mockups, without permission prompts; add real local sub-tickets.

**Architecture:** Pure tool logic in `src/main/mcp/canopyTools.ts` (deps injected: `TicketStore`, `MockupStore`, `LinearClient`, `LinearEdits`, `LinearSync`, a mode getter). A thin SDK wrapper `src/main/mcp/canopyServer.ts` builds a `createSdkMcpServer` per session; `SessionManager` receives it as a factory dep and passes it in `options.mcpServers`. Local tickets gain a `parent` front-matter field, validated in `TicketStore`, shown in `TicketEditor`.

**Tech Stack:** Electron, TypeScript strict, `@anthropic-ai/claude-agent-sdk` ^0.3.319 (`createSdkMcpServer`, `tool`), zod 4, `@modelcontextprotocol/sdk` 1.32.2 (`InMemoryTransport`, `Client` for the fake query), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-canopy-mcp-design.md`

## Global Constraints

- Server name `canopy`; tools `list_tickets`, `get_ticket`, `list_mockups`, `create_ticket`, `update_ticket`, `link_mockup` (so `mcp__canopy__<tool>`).
- No permission prompt for `mcp__canopy__*` in any mode; in mode `plan` the three write tools fail with an error.
- Ticket key = `TicketKey` (`local:CAN-4`, `linear:ENG-482`), from `src/shared/tickets.ts`.
- Linear writes: modifications only through `LinearEdits.save` (queue, description as `patch`); never send a full description on update.
- Linear search only among issues assigned to Bastien (`LinearSync.state().issues`).
- Parent and child share the same source; no cycle; parent must be a non-archived existing ticket.
- Tool descriptions in English; error messages and every UI text in French with « » quotes.
- Code style: 2 spaces, single quotes, no semicolons, ESM relative imports.
- TDD for every task; `npm run typecheck && npm test` green before each commit; `npm run test:e2e` at the end.
- Conventional Commits, scope per domain (`tickets`, `sessions`, `linear`, `mcp`).

## Review Focus

1. Bastien has an unsent Linear edit on the issue Claude updates → Bastien's text must survive (merge chains them). Test in Task 7.
2. Linear disconnected/expired/offline while Claude calls a Linear tool → clear French error, local tools still work, `list_tickets` still returns local tickets. Test in Task 5.
3. Mode switched to `plan` mid-session → writes refused at once (mode read per call, not at start). Test in Task 8.
4. A `.tickets/` file hand-edited with `parent: CAN-999` (missing) or a cycle written by hand → list/read never crash; editor shows « CAN-999 (introuvable) ». Tests in Tasks 1 and 3.
5. Claude passes a mockup URL never registered to `link_mockup` → it is added then linked, not refused. Test in Task 6.

---

### Task 0: Capture Linear creation (Bastien, manual, non-blocking)

The real `save_issue` create answer and a non-null `parentId` shape are unknown (`tests/fixtures/linear/README.md`). Tasks 4 and 7 assume the create answer has the same shape as the update answer (full issue) and that `parentId` is the parent identifier string.

- [ ] Ask Bastien to create a test issue and a sub-issue through the Linear MCP (`save_issue` without `id`, then with `parentId`), save the raw answers as `tests/fixtures/linear/save_issue_create.json` and `save_issue_create_child.json`, and add a line to the README. If the shapes differ from the assumption, adjust `parse.ts` and Task 4's replay before merging.

### Task 1: `parent` field on local tickets (model and file)

**Files:**
- Modify: `src/shared/tickets.ts` (`TicketFields`)
- Modify: `src/main/tickets/format.ts` (`KNOWN`, `parseTicket`, `serializeTicket`)
- Test: `tests/main/tickets/format.test.ts`

**Interfaces:**
- Produces: `TicketFields.parent?: string` (local ticket id, `TICKET_ID_RE`).

- [ ] **Step 1: Write the failing tests** in `format.test.ts`:
  - `parses and writes parent`: text with `parent: CAN-3` → `parseTicket(...).parent === 'CAN-3'`; `serializeTicket` of it contains the line `parent: CAN-3` and round-trips.
  - `ignores an invalid parent`: `parent: 'not an id'` or `parent: 12` → `parent` undefined, no throw.
  - `parent is not an unknown field`: `unknownFields(text)` has no `parent` key.
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/format.test.ts` — Expected: FAIL (`parent` undefined).
- [ ] **Step 3: Implement**: add `parent?: string` to `TicketFields` with JSDoc « local id of the parent ticket »; add `'parent'` to `KNOWN`; parse with `optStr` + `TICKET_ID_RE` test; serialize after `base`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): store a parent on local tickets`

### Task 2: Parent validation in `TicketStore` and IPC

**Files:**
- Modify: `src/main/tickets/store.ts` (`create`, `patch`)
- Modify: `src/main/tickets/ticketIpc.ts` (`FIELD_KEYS`, `parseFields`)
- Test: `tests/main/tickets/store.test.ts`, existing ticketIpc tests if any (`grep -rl parseFields tests`)

**Interfaces:**
- Consumes: `TicketFields.parent` (Task 1).
- Produces: `TicketStore.create(repo, f)` and `TicketStore.patch(repo, id, changes)` reject an invalid parent; in `patch`, `{ parent: undefined }` present as a key removes the parent (same rule as `branch`/`worktree`/`base`). New `TicketStore.children(repo: string, id: string): Promise<Ticket[]>` — non-archived tickets whose `parent === id`, sorted by id.

- [ ] **Step 1: Write the failing tests** in `store.test.ts` (real temp repo, `tests/helpers/repo.ts`):
  - `creates a sub-ticket`: create A, create B with `parent: A.id` → `get(B).parent === A.id`; `children(repo, A.id)` → `[B]`.
  - `refuses a missing parent`: `create({... parent: 'CAN-99'})` rejects with `Parent introuvable : CAN-99`.
  - `refuses itself as parent`: `patch(A, { parent: A.id })` rejects with `Un ticket ne peut pas être son propre parent`.
  - `refuses a cycle`: A ← B (B.parent = A); `patch(A, { parent: B.id })` rejects with `Ce parent créerait une boucle : ${B.id}`.
  - `refuses an archived parent`: archive A; create with `parent: A.id` rejects with `Parent introuvable : ${A.id}` (archived tickets are not in `.tickets/`).
  - `removes the parent`: `patch(B, { parent: undefined })` → `get(B).parent` undefined.
  - `keeps children of a missing parent readable`: write B with `parent: CAN-999` by hand → `list` and `get` return it with that parent.
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `private async checkParent(root: string, id: string | undefined, parent: string): Promise<void>` called in `create` and `patch` when `parent` is set: walk up `parent` links from `parent` reading `.tickets/<id>.md` (stop at a missing file or after 1000 steps), fail if `id` is met. Add `'parent'` to the deletable keys in `patch`. In `ticketIpc.ts`, add `'parent'` to `FIELD_KEYS` and accept `string` matching `ID_RE`, or `null` (mapped to `undefined` key-present, to remove).
- [ ] **Step 4: Run** the store and IPC tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): validate the parent of a local ticket`

### Task 3: Sub-tickets in the ticket screens

**Files:**
- Modify: `src/renderer/tickets/TicketEditor.tsx`, `TicketsScreen.tsx` (or `listModel.ts`), `ticketStore.ts`, `tickets.css`
- Modify: `src/shared/tickets.ts` (`launchPrompt`), `src/renderer/tickets/launchFlow.ts`
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/tickets/ticketIpc.ts` only if a `tickets:children` call is needed (prefer deriving children and parent title from the list already in `ticketStore`).
- Test: `tests/main/...` none; `tests/renderer/tickets/listModel.test.ts` if list logic changes; `tests/e2e/tickets.spec.ts`

**Interfaces:**
- Consumes: `Ticket.parent` (Task 1), store validation (Task 2).
- Produces: `launchPrompt(t: Ticket, parent?: Pick<Ticket, 'id' | 'title'>): string` — adds the line `Ticket parent : ${parent.id} : ${parent.title}` right after the first line when `parent` is given.

- [ ] **Step 1: Write the failing tests**:
  - Vitest on `launchPrompt` (existing test file for `src/shared/tickets.ts`, else `tests/main/shared/tickets.test.ts` mirroring where shared tests live): with parent → second paragraph is `Ticket parent : CAN-3 : Export`.
  - E2E `tickets.spec.ts` `sub-tickets`: create ticket « Export », create ticket « Export CSV », in its editor pick « Export » in the « Parent » select → editor shows `Sous-ticket de <id> · Export`; open « Export » → section « Sous-tickets » lists « Export CSV »; click it → its editor opens; list row of « Export CSV » shows the parent id. The « Parent » select of « Export » does not offer « Export CSV » (descendant).
  - E2E `missing parent`: write a ticket file with `parent: TKT-999` → editor shows `TKT-999 (introuvable)`.
- [ ] **Step 2: Run** `npx vitest run <shared test>` and `npx playwright test tests/e2e/tickets.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**: parent line (button opening the parent with `setOpenTicket(ticketKey('local', id))`), « Sous-tickets » section styled like `SubIssues` in `LinearEditor.tsx` (`done / total`, status label from `STATUS_LABEL`), « Parent » select (options: « Aucun » + non-archived local tickets minus self and descendants; saving goes through the existing editor save path), parent id under the title in the list, `launchFlow.ts` passes the parent found in the ticket list.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): show and edit local sub-tickets`

### Task 4: Create a Linear issue (client and replay)

**Files:**
- Modify: `src/main/linear/client.ts`, `src/main/linear/replay.ts`, `src/main/linear/edits.ts` (export `PRIORITY_VALUE`)
- Test: `tests/main/linear/client.test.ts`, replay tests (where `createReplayCaller`/equivalent is tested; `grep -rl replay tests/main`)

**Interfaces:**
- Produces: `LinearClient.createIssue(args: { title: string; team: string; description?: string; parentId?: string; priority?: TicketPriority; labels?: string[]; state?: string }): Promise<LinearIssue>` — calls `save_issue` with those args, `priority` mapped through `PRIORITY_VALUE`, plus `assignee: 'me'`, never `id`; answer parsed with `parseIssue`.
- Produces: `export const PRIORITY_VALUE` from `edits.ts`.

- [ ] **Step 1: Write the failing tests**:
  - client: `createIssue` sends `save_issue` with `{ title, team, assignee: 'me', priority: 2 }` for `priority: 'high'` and no `id` key; returns the parsed issue.
  - replay: `save_issue` without `id` and with `team` creates `CAN-<max+1>`, assigned to the `whoami` user, status of type `unstarted` (or `state` given), `parentId` kept; a following `list_issues {assignee:'me'}` includes it and `list_issues {parentId}` of the parent lists it. Without `team` → `isError` `Error: team is required when creating.`
- [ ] **Step 2: Run** `npx vitest run tests/main/linear` — Expected: FAIL.
- [ ] **Step 3: Implement** both; replay `listIssues` must filter by `parentId` on the in-memory list so created children show up.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(linear): create an issue`

### Task 5: Canopy read tools

**Files:**
- Create: `src/main/mcp/canopyTools.ts`
- Test: `tests/main/mcp/canopyTools.test.ts`

**Interfaces:**
- Consumes: `TicketStore.list/get/children` (Task 2), `MockupStore.list`, `LinearClient.connection/issue/teamOptions`, `LinearSync.state`, `LinearEdits.pending`.
- Produces:

```ts
export type CanopyToolName = 'list_tickets' | 'get_ticket' | 'list_mockups' | 'create_ticket' | 'update_ticket' | 'link_mockup'
export const WRITE_TOOLS: CanopyToolName[] // ['create_ticket', 'update_ticket', 'link_mockup']
export interface CanopyToolDeps {
  repoRoot: string
  mode: () => PermissionMode
  tickets: Pick<TicketStore, 'list' | 'get' | 'children' | 'create' | 'patch'>
  mockups: Pick<MockupStore, 'list' | 'add' | 'patch'>
  linear: Pick<LinearClient, 'connection' | 'issue' | 'issueBrief' | 'teamOptions' | 'createIssue'>
  edits: Pick<LinearEdits, 'save' | 'pending'>
  sync: Pick<LinearSync, 'state' | 'refresh'>
}
/** Each handler resolves to a JSON-serialisable value or throws an Error whose message (French) goes back to Claude. */
export function createCanopyTools(deps: CanopyToolDeps): Record<CanopyToolName, (args: Record<string, unknown>) => Promise<unknown>>
```

Arguments arrive already validated by the zod schemas of Task 8; handlers still check keys (`TICKET_ID_RE`) since they are the security boundary.

- [ ] **Step 1: Write the failing tests** (real temp repo for local; fakes for Linear objects built from `tests/fixtures/linear` via the replay caller where convenient):
  - `list_tickets` returns local and Linear rows `{ key, title, status, priority, labels, parent?, children? (local only), branch? }`; `parent` of a local row is `local:<id>`, of a Linear row `linear:<parentId>`.
  - `query: 'export'` matches a local ticket by description and a Linear ticket by title or label, case- and accent-insensitive (`'Évolution'` matches `'evolution'`).
  - done excluded by default: local `done`, Linear status type `completed`/`canceled`; `includeDone: true` keeps them.
  - `source: 'local'` skips Linear entirely (no call).
  - `status: 'todo'` keeps local tickets with status `todo` and Linear tickets whose status name equals it, case-insensitive.
  - Linear not connected (`connection().state !== 'connected'`) → local rows plus `linearError: 'Canopy n'est pas connecté à Linear.'`; no throw.
  - unreadable local files listed in `unreadable: [{ file, error }]`.
  - `get_ticket` local: all fields, `parent: { key, title } | { key, missing: true }`, `children`, `mockups: [{ id, title, url, kind, status }]` (from `MockupStore.list` filtered by `ticket`).
  - `get_ticket` Linear: detail from `linear.issue`, `children` keys `linear:<id>`, `statuses` and `labels` from `teamOptions(team.id)`; with a pending edit from `edits.pending()`, title/description/labels are the pending values (`description.text`, `labels.next`) and `pending: true`.
  - `get_ticket` with a malformed key → throws `Clé de ticket invalide : <key>`.
  - `list_mockups` with `ticket: 'local:CAN-1'` / `unlinked: true` filters; unreadable registry → throws its error.
- [ ] **Step 2: Run** `npx vitest run tests/main/mcp/canopyTools.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three read handlers; `parseKey(key: string): { source: TicketSource; id: string }` exported for Tasks 6–7. Normalise for search with `normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): read tickets and mockups for Claude`

### Task 6: Local write tools and mockup linking

**Files:**
- Modify: `src/main/mcp/canopyTools.ts`
- Test: `tests/main/mcp/canopyTools.test.ts`

**Interfaces:**
- Consumes: `parseKey` (Task 5), `TicketStore.create/patch`, `MockupStore.add/patch`, `parseArtifactUrl`.
- Produces: handlers `create_ticket`, `update_ticket` (local branch), `link_mockup`; the plan-mode guard applied to every `WRITE_TOOLS` handler.

- [ ] **Step 1: Write the failing tests**:
  - `create_ticket {source:'local', title, parent:'local:CAN-1'}` → file exists with `parent: CAN-1`; returns `{ key: 'local:CAN-2' }`. Defaults: `status 'backlog'`, `priority 'none'`, `labels []`, `subtasks []`.
  - `parent` of the other source (`linear:...` for a local ticket) → `Le parent doit venir de la même source que le ticket.`
  - `update_ticket` local with `title`, `description`, `status`, `priority`, `labels`, `parent: null` → patched; no field → `Rien à modifier.`; invalid status → `Statut inconnu : <s>. Statuts possibles : backlog, todo, in_progress, in_review, done`; title over `MAX_TITLE` → `Titre invalide`.
  - store errors (cycle, missing parent) come back unchanged.
  - `mode: () => 'plan'` → every write throws `Mode plan : Canopy ne modifie rien tant que la session est en mode plan.`, nothing written; reads still work.
  - `link_mockup` by id with `ticket: 'local:CAN-1'`, `status: 'wip'` → registry updated; `ticket: null` unlinks; an unregistered claude.ai URL → added then linked; unknown ticket → `Ticket introuvable : CAN-9`; a `linear:` ticket → `Une maquette ne se lie qu'à un ticket local.`
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): let Claude create and update local tickets`

### Task 7: Linear write tools

**Files:**
- Modify: `src/main/mcp/canopyTools.ts`
- Test: `tests/main/mcp/canopyTools.test.ts` (with a real `LinearEdits` on a temp file and the replay caller, so `merge` and `patch` run for real)

**Interfaces:**
- Consumes: `LinearClient.issueBrief/teamOptions/createIssue` (Task 4), `LinearEdits.save/pending`, `LinearSync.state/refresh`, `PRIORITY_VALUE`.

- [ ] **Step 1: Write the failing tests**:
  - `update_ticket linear description` → the replay log shows `save_issue` with `patch` and no `description` key; returns `{ result: 'enregistré' }`.
  - **pending edit kept** (Review Focus 1): Bastien's `edits.save(id, { description: { base: A, text: B } })` left queued (replay `failFile` makes Linear down), then Claude `update_ticket` with description C → `edits.pending()` change is `{ base: A, text: C }` where C was built by Claude from B (test: Claude's text = B + '\nligne de Claude'); after Linear is back and `retryAll`, Linear's description equals that text. Same for labels (base = pending `next`).
  - result mapping: `pending` → `{ result: 'en attente : <reason>' }`; `conflict` → `{ result: 'conflit avec une modification d'un collègue : la description n'a pas été envoyée' }`.
  - status by name, case-insensitive → `statusId` from `teamOptions`; unknown → `Statut inconnu : <s>. Statuts possibles : <names joined by ', '>`.
  - `parent` on a Linear update → `Le parent d'un ticket Linear existant ne se change pas depuis Canopy.`
  - `create_ticket linear` with `parent: 'linear:CAN-3'` → `createIssue` with `team` = CAN-3's team id and `parentId: 'CAN-3'`; then `sync.refresh` called; returns `{ key: 'linear:CAN-<n>' }`.
  - team resolution without parent: one team in `sync.state().issues` → that team; several and no `team` arg → `Précise l'équipe Linear : <names>`; `team` arg not among them → same message.
  - Linear not connected → `Canopy n'est pas connecté à Linear.` for both tools.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**: description `base` = pending `description.text` ?? `issueBrief(id).description`; labels `base` = pending `labels.next` ?? fresh issue labels.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): let Claude create and update Linear tickets`

### Task 8: Plug the `canopy` server into sessions

**Files:**
- Create: `src/main/mcp/canopyServer.ts`
- Modify: `src/main/sessions/SessionManager.ts` (`SessionManagerDeps`, `start`, `options`, `askPermission` or `canUseTool` closure; remove `expectLinear`)
- Modify: `src/main/index.ts` (one shared `MockupStore` passed to `registerIpc` and to the server factory; factory closes over `tickets`, `linearClient`, `linearEdits`, `linearSync`)
- Remove: `LINEAR_NOTICE` / `hasLinearServer` / `expectLinear` in `src/shared/linear.ts`, `src/renderer/sessions/sessionStore.ts`, `src/shared/api.ts` (`StartSessionOptions.expectLinear`) and callers (`grep -rn "expectLinear\|LINEAR_NOTICE\|hasLinearServer" src tests`); delete `tests/main/sessions/linearNotice.test.ts`; adapt `tests/e2e/linear.spec.ts` assertions on the notice.
- Test: `tests/main/mcp/canopyServer.test.ts`, `tests/main/sessions/SessionManager.test.ts`

**Interfaces:**
- Consumes: `createCanopyTools`, `CanopyToolDeps`, `WRITE_TOOLS` (Tasks 5–7).
- Produces:
  - `export function createCanopyServer(deps: CanopyToolDeps): McpSdkServerConfigWithInstance` — `createSdkMcpServer({ name: 'canopy', alwaysLoad: true, tools })`, one `tool(name, description, zodShape, handler)` per tool; handler returns `{ content: [{ type: 'text', text: JSON.stringify(value) }] }` or, on throw, `{ content: [{ type: 'text', text: err.message }], isError: true }`. Read tools get `annotations: { readOnlyHint: true }`.
  - `SessionManagerDeps.canopyServer?: (ctx: { repoRoot: string; mode: () => PermissionMode }) => McpSdkServerConfigWithInstance`.
  - `options()` adds `mcpServers: { canopy }` and `allowedTools: ['mcp__canopy']` when the dep exists; `canUseTool` resolves `{ behavior: 'allow', updatedInput: input }` for `toolName.startsWith('mcp__canopy__')` without a prompt.

- [ ] **Step 1: Write the failing tests**:
  - `canopyServer.test.ts`: connect a `Client` to `createCanopyServer(fakeDeps).instance` over `InMemoryTransport.createLinkedPair()`; `listTools` gives the six names; `callTool('get_ticket', { key: 'bad' })` → `isError: true`, text `Clé de ticket invalide : bad`; a successful call returns JSON text.
  - `SessionManager.test.ts`: with a `canopyServer` dep, the `options` passed to the injected `query` contain `mcpServers.canopy` and `allowedTools` `['mcp__canopy']`; the factory got `repoRoot` from `start(cwd, { repoRoot })` (default `cwd`); its `mode()` returns the new mode after `setMode(localId, 'plan')` (Review Focus 3); `canUseTool('mcp__canopy__create_ticket', …)` resolves allow and emits no permission request.
- [ ] **Step 2: Run** `npx vitest run tests/main/mcp tests/main/sessions` — Expected: FAIL.
- [ ] **Step 3: Implement**; zod shapes mirror Task 5–7 arguments (`key: z.string()`, `source: z.enum(['local','linear'])`, `priority: z.enum(PRIORITIES)`, `labels: z.array(z.string())`, `parent: z.string().nullable().optional()`, …). Tool descriptions (English) must tell Claude: search with `list_tickets` before creating to avoid duplicates; open candidates with `get_ticket`; `get_ticket` returns linked mockups to read with the `Artifact` tool and to compare with the ticket and the code; report a mismatch in the conversation, write it in the ticket if useful, never edit a mockup unless asked; `update_ticket.description` is the full wanted text.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sessions): give Claude the Canopy tools`

### Task 9: Fake query scenario and E2E

**Files:**
- Modify: `src/main/sessions/fakeQuery.ts`
- Test: `tests/main/sessions/fakeQuery.test.ts`, new `tests/e2e/canopy-tools.spec.ts`

**Interfaces:**
- Consumes: `options.mcpServers.canopy.instance` (Task 8).
- Produces: scenario `canopy <tool> <json args>`: connects once per query a `Client` to the instance via `InMemoryTransport`, calls the tool, yields an assistant `tool_use` block named `mcp__canopy__<tool>` then the `tool_result` (error flag from `isError`), then a result message. `system/init` lists `mcp_servers: [{ name: 'canopy', status: 'connected' }]` when the server is present.

- [ ] **Step 1: Write the failing tests**:
  - `fakeQuery.test.ts`: with a stub server instance, message `canopy list_tickets {}` yields a `tool_use` named `mcp__canopy__list_tickets` and a `tool_result` with the tool's text.
  - E2E `canopy-tools.spec.ts`: create ticket « Export »; in a session on the repo send `canopy create_ticket {"source":"local","title":"Export CSV","parent":"local:<id>"}`; open Tickets → « Export CSV » listed with the parent id, and « Export » shows it under « Sous-tickets ». Second test with `CANOPY_FAKE_LINEAR=tests/fixtures/linear`: `canopy create_ticket {"source":"linear","title":"Export PDF","parent":"linear:CAN-3"}` → appears in the Linear list.
- [ ] **Step 2: Run** `npx vitest run tests/main/sessions/fakeQuery.test.ts` and `npm run build && npx playwright test tests/e2e/canopy-tools.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then the full `npm run test:e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `test(mcp): drive the Canopy tools from the fake session`

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (Architecture: `src/main/mcp/` « serveur MCP `canopy` donné aux sessions : tickets locaux et Linear, maquettes » ; Commands paragraph: fake query scenario `canopy <outil> <json>`), `tests/fixtures/linear/README.md` (create support in replay).

- [ ] **Step 1:** Edit both files.
- [ ] **Step 2: Run** `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 3: Commit** `docs: describe the canopy MCP server`
