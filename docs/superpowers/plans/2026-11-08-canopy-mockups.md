# Maquettes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mockups tab (screen 4), reduced edit screen with embedded claude.ai view and a Claude conversation (4b), and the mockup ↔ ticket link (3b section, launch option).

**Architecture:** The main process owns `<main checkout>/.mockups/mockups.json` (out of git) through a `MockupStore` mirroring `TicketStore` (serialized writes, atomic write, guard, chokidar watch, IPC `mockups:*`). A `MockupViewManager` in main holds one `WebContentsView` per window on partition `persist:claude-ai`; the renderer drives it with URL + bounds over IPC. The 4b conversation is an ordinary session tab in the repo's main checkout, rendered with the existing `Conversation`; its own small composer prefixes the mockup context. All sessions get `CLAUDE_CODE_ARTIFACT=1`.

**Tech Stack:** Electron (`WebContentsView`), React 19, TypeScript, zustand, chokidar, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-mockups-design.md`. Mockup: screens 4, 4b and the « Maquettes liées » section of 3b in `docs/mockups/canopy-maquettes.html` (local, git-ignored). Unpacked HTML of each screen: `/tmp/maq/p4/template.html`, `/tmp/maq/p4b/template.html`, `/tmp/maq/p3b/template.html` (styles inline: reuse colors, spacing, radii).

## Global Constraints

- Registry read/written only in the main checkout (`mainWorktreeRoot`); `/.mockups/` added to `.git/info/exclude` (`ensureExcluded`) before the first write; never touch `.gitignore`.
- Registry file `{ "version": 1, "mockups": Mockup[] }`; unknown top-level keys and unknown mockup keys preserved on rewrite.
- `Mockup = { id, url, title, kind: 'phone'|'web', status: 'todo'|'wip'|'done', ticket?: string, titleSet?: boolean, added, updated }`. `titleSet: true` once the user typed a title (then page title no longer overrides).
- Mockup URL accepted: `https://claude.ai/artifact/<seg>` or `https://claude.ai/code/artifact/<seg>` (host exactly `claude.ai`, https only). `<seg>` may be `[<title>-]<id>`: the id is the trailing UUID (`8-4-4-4-12` hex) if the segment ends with one, else its last 22 characters, which must be `[A-Za-z0-9]` (segment shorter than 22 → invalid). Query/hash dropped. Canonical url: `https://claude.ai/artifact/<id>` for 22-char ids, `https://claude.ai/code/artifact/<uuid>` for UUIDs.
- No disk access from the renderer; every IPC argument validated in main.
- UI copy in French, as in the mockup. Out of scope: screens list, versions, compare, comments, zoom, export, real thumbnails, screen 5, deleting on claude.ai.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npm run typecheck` (or `npx tsc --noEmit -p .` per `package.json`) and `npx vitest run` before each commit.

## Review Focus

- Hand-broken `mockups.json` → shown as an error, never overwritten (Task 2 test).
- Adding the same URL twice → one entry (Task 2 test).
- The native view never covers a Canopy modal, and is hidden when leaving 4b (Task 5).
- A `publish` result with another artifact URL registers it with the same ticket (Task 6, pure fn test).
- Launch with « Joindre les maquettes liées » → prompt contains each URL (Task 7 test).

---

### Task 1: Shared model and pure functions

**Files:** Create `src/shared/mockups.ts`; Test `tests/renderer/mockups.test.ts`.

**Produces:**
- Types `MockupKind`, `MockupStatus`, `Mockup`, `MockupFields = Pick<Mockup,'title'|'kind'|'status'|'ticket'|'titleSet'>`, `MockupList = { kind: 'ok'; mockups: Mockup[] } | { kind: 'unreadable'; error: string }`.
- `MOCKUP_STATUS_LABEL` (`todo` Pas commencée, `wip` En cours de dev, `done` Implémentée), colors `{ bg, fg }` from the mockup (`done #12261A/#7EE29A`, `wip #2A2410/#F0CB6E`, `todo #1E2127/#C9CED5`).
- `parseArtifactUrl(raw: string): { id: string; url: string } | null`.
- `artifactUrlsIn(text: string): string[]` (canonical, de-duplicated, order kept).
- `shownStatus(m: Mockup, ticket: Ticket | undefined): MockupStatus` (backlog/todo→todo, in_progress/in_review→wip, done→done; no ticket → `m.status`).
- `pageTitle(raw: string): string` (trim, drop trailing ` | Claude` / ` - Claude` / ` — Claude`).
- `mockupLine(m): string` = `Maquette : <title> — <url>`.
- `editPrompt(o: { url?: string; text: string; first: boolean; variant: boolean }): string` — first message: context (mockup URL, read with `Artifact` action `read`, edit, republish with `url: <url>` to update in place; with `variant`, publish a new artifact without `url` instead; no URL = create a new mockup with `Artifact` `publish` and give its link); later messages: just the text, plus variant instruction when ticked.
- `launchMockupsSection(ms: Mockup[]): string` = `Maquettes liées (à lire avec l'outil Artifact, action read) :\n- <title> — <url>`.
- `publishedUrls(item: TranscriptItem-like {name,input,result,isError,running}): string[]` — Artifact tool, finished, not error, action absent or `publish` → `artifactUrlsIn(result)` plus `input.url` canonical if present.

- [ ] Write failing tests for each fn (valid/invalid URLs incl. `claude.ai/code/artifact/<uuid>`, query/hash, other hosts, `http:`; status mapping; title suffix; prompts contain URL / variant text; publishedUrls ignores `read`, errors and running).
- [ ] Implement, run vitest, commit `feat(mockups): mockup model and pure helpers`.

### Task 2: MockupStore, watch, IPC, preload

**Files:** Create `src/main/mockups/store.ts`, `src/main/mockups/mockupIpc.ts`, `src/main/mockups/watch.ts` (or generalize `src/main/tickets/watch.ts` with a `dir` parameter — preferred, keep `watchTickets` export); Modify `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/shared/api.ts`; Test `tests/main/mockups/store.test.ts`.

**Produces (store):** `list(repo): Promise<MockupList>`, `add(repo, url, fields?: Partial<MockupFields>): Promise<Mockup>` (existing id → returns existing, patched with given ticket if it had none), `patch(repo, id, changes: Partial<MockupFields>)` (`ticket: null` removes the link; `title` sets `titleSet: true` unless `titleSet` explicitly given), `remove(repo, id)`, `unlinkTicket` not needed. Same guards as `TicketStore.guard` for `.mockups`. Unreadable JSON: `list` returns `unreadable`, writes throw « mockups.json illisible : … » and do not touch the file.

**IPC:** `mockups:list|add|patch|remove|watch` (watch emits `canopy:event` `mockups:changed` `{ repo }` like tickets). Validation: absolute repo path, id `^([A-Za-z0-9]{22}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, url via `parseArtifactUrl`, fields whitelist, title 1..200 chars, ticket matches ticket ID regex or null.

**Preload/API:** `listMockups`, `addMockup`, `patchMockup`, `removeMockup`, `watchMockups`.

- [ ] Tests: empty repo → `{kind:'ok', mockups:[]}`; add creates file + exclude entry; add same URL twice → one entry; patch keeps unknown keys; broken JSON → unreadable and add rejects without rewriting; tracked `.mockups` refused.
- [ ] Implement, wire, typecheck, vitest, commit `feat(mockups): local registry in the main checkout`.

### Task 3: Artifact tool in every session

**Files:** Modify `src/main/sessions/SessionManager.ts` (`options()` env: `CLAUDE_CODE_ARTIFACT: '1'`); Test: extend the existing SessionManager options test in `tests/main/sessions/`.

- [ ] Test the env passed to `query` contains `CLAUDE_CODE_ARTIFACT === '1'`; implement; commit `feat(sessions): enable the Artifact tool`.

### Task 4: Embedded claude.ai view (main)

**Files:** Create `src/main/mockups/view.ts`; Modify `src/main/ipc.ts` or `index.ts`, preload, api; Test `tests/main/mockups/view.test.ts` (pure parts).

**Produces:** `MockupViewManager` keyed by `webContents.id` of the host window: `show(sender, url, bounds)`, `setBounds(sender, bounds)`, `hide(sender)`, `reload(sender)`. Creates `new WebContentsView({ webPreferences: { partition: 'persist:claude-ai', sandbox: true, contextIsolation: true, nodeIntegration: false } })`, adds it to the window's `contentView`, `setBounds` with integer-rounded rect clamped ≥ 0. Same url → no reload. `setWindowOpenHandler` → `openExternalUrl` + deny. `page-title-updated` → `sender.send('canopy:event', 'mockups:title', { url, title })`; `did-fail-load` → `mockups:viewError`. Destroy on window close. In e2e (`CANOPY_FAKE_QUERY`), env `CANOPY_MOCKUP_VIEW_URL` replaces the loaded URL (tests use `about:blank`).
**IPC:** `mockupView:show|bounds|hide|reload`; validate url with `parseArtifactUrl` (or the e2e override), bounds finite numbers.
**Pure, tested:** `clampBounds(b)`.

- [ ] Test `clampBounds`; implement; commit `feat(mockups): embedded claude.ai view`.

### Task 5: Mockups tab, gallery and detail (screen 4)

**Files:** Create `src/renderer/mockups/mockupStore.ts` (like `ticketStore.ts`: `useMockups { repo, list, error, loaded }`, `connectMockups()`), `MockupsScreen.tsx`, `MockupCard.tsx` (gabarit phone/web, from p4 template), `AddMockupDialog.tsx`, `mockups.css`; Modify `src/renderer/store.ts` (`View` adds `'mockups'`, state `openMockup: string | 'new' | null`, `selectedMockup`, cleared on repo switch like tickets), `Header.tsx` (tab « Maquettes »), `App.tsx` (route, `connectMockups`); Test `tests/renderer/mockupStore.test.ts` (filters: `filterMockups(list, filter, ctx)` for `all | worktree | noTicket`).

Behaviour per spec §6 Écran 4. « Joindre à la session en cours »: `attachToSession(cwd, line)` appends to the active tab draft (`ensureTab`, `setDraftText`), sets worktree + view sessions. « Lancer un worktree depuis la maquette »: with ticket → `setView('tickets')`, `setSelectedTicket(id)`, `setOpenTicket(null)` (the Tickets screen opens the launch panel for the selected ticket — check `TicketsScreen` and reuse its selection mechanism); without → `createTicket` then `patchMockup(ticket)` then same. Dialog uses `useModal` like other dialogs.

- [ ] Tests for filter fn; implement; check visually against p4 (Playwright MCP screenshot optional); commit `feat(mockups): mockups gallery`.

### Task 6: Edit screen (4b)

**Files:** Create `src/renderer/mockups/MockupEditor.tsx`, `MockupWebView.tsx` (placeholder div; `ResizeObserver` + window resize → `mockupView:bounds`; `MutationObserver` on `document.body` for `[aria-modal="true"]` → hide/show; unmount → hide), `mockupChat.ts` (map mockupId|'new' → session tab id, in memory; `sendEdit(mockup|null, text, variant)` creates the tab with `newTab(mainCheckout)` the first time, `setDraftText` + `submit`; `watchPublishes(tabId, onUrls)` subscribes to `useSessions`, calls `publishedUrls` on each newly finished tool item once). Modify `src/renderer/App.tsx` route.

Behaviour per spec §6 Écran 4b: header (title, status pill, « Recharger », « Ouvrir dans claude.ai » via existing external-link API), Claude tab = `<Conversation tab>` + own composer (label « Décris la modification », textarea, « Créer une variante », « Appliquer ⌘↵ »), Propriétés tab (Nom, Ticket lié select, Statut disabled when ticket, Branche, Gabarit, « Retirer de Canopy » with confirm), footer « Envoyer à la session <branch> ». On publish URLs: same id → `mockupView:reload`; other ids → `addMockup` with same ticket/kind; in `'new'` mode the first URL becomes the mockup (`setOpenMockup(id)`, chat map re-keyed). Page title events → `patchMockup({ title, titleSet: false })` when `!titleSet` and different.

- [ ] Unit-test `mockupChat` publish detection with a fake `useSessions` state (no duplicate callbacks for the same tool id); implement; commit `feat(mockups): edit a mockup with Claude`.

### Task 7: Ticket links (3b, launch)

**Files:** Create `src/renderer/tickets/LinkedMockups.tsx`; Modify `TicketEditor.tsx` (section after subtasks), `LaunchPanel.tsx` (checkbox « Joindre les maquettes liées (n) », default on), `launchFlow.ts` (`runLaunch(..., { startClaude, mockups })` appends `launchMockupsSection` to the prompt); Test `tests/renderer/launchFlow.test.ts` extended.

« + Lier ou générer une maquette » menu: unlinked mockups (click → `patchMockup({ticket})`), « Coller un lien claude.ai… » (AddMockupDialog with ticket preset), « Générer avec Claude » (`setView('mockups')`, `setOpenMockup('new')` with a pending ticket for the new mockup). Chip « × » unlinks.

- [ ] Test prompt with/without mockups; implement; commit `feat(mockups): link mockups and tickets`.

### Task 8: e2e

**Files:** Create `tests/e2e/mockups.spec.ts` (pattern of `tickets.spec.ts`, env `CANOPY_FAKE_QUERY=1`, `CANOPY_MOCKUP_VIEW_URL=about:blank`).

- [ ] Add a mockup by link from the gallery → card shown, `.mockups/mockups.json` written, `git status --porcelain` clean.
- [ ] Create a ticket, link the mockup from 3b → card shows the ticket ID; « Sans ticket » filter hides it.
- [ ] Open 4b → Propriétés shows the ticket; « Retirer de Canopy » removes it.
- [ ] Commit `test(mockups): e2e`.
