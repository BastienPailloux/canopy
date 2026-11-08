# Tickets dans l'app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local tickets in `.tickets/` (out of git), Tickets screen and edit screen per the mockup, one-click launch into a new or existing worktree, and full stacked-branch handling.

**Architecture:** The main process owns `.tickets/` of each repo's main checkout: pure format functions, a store that serializes writes per file and merges field patches onto what is on disk, a chokidar watcher, IPC `tickets:*`. Launch is one main-process IPC that does the git work and writes the ticket; the renderer then switches to Sessions and sends the launch prompt through the existing `askClaude`. Branch bases live in `AppStore` next to `repoBases`.

**Tech Stack:** Electron, React 19, TypeScript, zustand, chokidar, vitest, Playwright. New dependency: `yaml` (front matter).

**Spec:** `docs/superpowers/specs/2026-11-08-tickets-design.md` (parent: `2026-11-07-canopy-design.md`). Mockup: screens 3 and 3b of `docs/mockups/canopy-maquettes.html` (local, git-ignored); screenshots in `.playwright-mcp/shot-tickets.png`, `shot-ticket-edit.png`.

## Global Constraints

- Tickets are read and written only in the main checkout of a repo (`mainWorktreeRoot`), never in a worktree.
- `.tickets/` never enters git: `/.tickets/` in `.git/info/exclude` (common dir) before the first write; never touch `.gitignore`.
- Ticket file: `.tickets/<ID>.md`; archived: `.tickets/archive/<ID>.md`; config: `.tickets/config.json` `{ "prefix": string, "next": number }`.
- Statuses (file → label): `backlog` Backlog, `todo` À faire, `in_progress` En cours, `in_review` En revue, `done` Terminé.
- Priorities (file → label): `urgent` Urgente, `high` Haute, `medium` Moyenne, `low` Basse, `none` Aucune.
- ID `<PREFIX>-<n>`; one counter for all prefixes; never reuse a number, archived included.
- Branch name `<type>/<slug>`, type in `feat | fix | chore | docs | refactor | test`, default `feat`. No first name, no ID.
- No disk access from the renderer; every IPC argument validated in main like `ipc.ts` does (`assertPath`, etc.).
- UI copy in French, as in the mockup. Out of scope: anything Linear, "Préciser avec Claude", linked mockups, comments/activity, assignee/estimate/cycle, delete.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A ticket file hand-edited into invalid YAML → listed as unreadable with its file name, never overwritten (Task 2 test `unreadable files are reported, not rewritten`).
- Outside edit of one field while the user types another → both survive (Task 2 test `patch keeps fields changed on disk`).
- Launch where the branch name already exists or git refuses → ticket untouched, error shown (Task 5 test `failed launch writes nothing`).
- Launch into an existing worktree with uncommitted files → files set aside under the source branch, recoverable (Task 4 test `startBranchIn sets dirty files aside`).
- Repo with no `.tickets/` at all, or a deleted `config.json` → empty list, next ID recomputed from files including `archive/` (Task 2 test `next id survives a lost config`).

---

### Task 1: Ticket model and file format

**Files:**
- Create: `src/shared/tickets.ts`, `src/main/tickets/format.ts`
- Test: `tests/main/tickets/format.test.ts`, `tests/renderer/ticketNames.test.ts`
- Modify: `package.json` (add `yaml`)

**Interfaces:**
- Produces (`src/shared/tickets.ts`):
  - `type TicketStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done'`, `STATUS_LABEL: Record<TicketStatus, string>`, `STATUS_ORDER: TicketStatus[]` = `['in_progress','in_review','todo','backlog','done']`
  - `type TicketPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'`, `PRIORITY_LABEL`
  - `interface Subtask { title: string; done: boolean }`
  - `interface TicketFields { title: string; description: string; status: TicketStatus; priority: TicketPriority; labels: string[]; subtasks: Subtask[]; branch?: string; worktree?: string; base?: string }`
  - `interface Ticket extends TicketFields { id: string; created: string; updated: string; archived: boolean }`
  - `type TicketListEntry = { kind: 'ticket'; ticket: Ticket } | { kind: 'unreadable'; file: string; error: string }`
  - `BRANCH_TYPES = ['feat','fix','chore','docs','refactor','test'] as const`
  - `branchSlug(title: string): string`, `defaultPrefix(repoName: string): string`, `launchPrompt(t: Ticket): string`
- Produces (`src/main/tickets/format.ts`): `parseTicket(text: string, fileId: string): Ticket` (throws on invalid), `serializeTicket(t: Ticket, extra?: Record<string, unknown>): string`, `unknownFields(text: string): Record<string, unknown>`

- [ ] **Step 1: Write failing tests**

`format.test.ts`:
- `round-trips a full ticket`: `parseTicket(serializeTicket(t), t.id)` deep-equals `t` for a ticket with labels `['DPP','Textile']`, two subtasks (one done), multi-line description containing a `## Notes` heading, and branch/worktree/base set.
- `subtasks section is optional`: a file without `## Sous-tâches` parses with `subtasks: []` and the whole body as description.
- `only the last "## Sous-tâches" heading is reserved`: description keeps an earlier heading of the same name.
- `throws on invalid front matter` (`title: [unclosed`), and on unknown status `status: wip`.
- `keeps unknown front-matter keys`: `serializeTicket(parseTicket(x), unknownFields(x))` still contains `linear_id: ABC-1`.
- `id comes from the file name when missing from front matter`.

`ticketNames.test.ts`:
- `branchSlug('Export JSON-LD du passeport textile')` → `'export-json-ld-du-passeport'` (5 words max); `branchSlug('Évite l’accès « spécial » !!')` → `'evite-l-acces-special'`; `branchSlug('   ')` → `'ticket'`.
- `defaultPrefix('canopy')` → `'CAN'`; `defaultPrefix('dpp-api')` → `'DPP'`; `defaultPrefix('42')` → `'TKT'`.
- `launchPrompt` of `DPP-12` contains `DPP-12 : Export…`, the description, and only the undone subtasks as `- [ ] …`; no subtasks section when all are done.

- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/format.test.ts tests/renderer/ticketNames.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement.** `npm i yaml`. File layout as in the spec section 4: `---\n<yaml>---\n<description>\n\n## Sous-tâches\n- [x] …`. Subtasks = the checklist after the last `## Sous-tâches` line; lines there that are not `- [ ]`/`- [x]` stay in the description. `branchSlug`: NFD + strip diacritics, lowercase, non-alnum → `-`, trim dashes, first 5 words. `defaultPrefix`: first 3 ASCII letters uppercased, else `TKT`.

- [ ] **Step 4: Run tests** — Expected: PASS. Run `npm run typecheck` — no errors.

- [ ] **Step 5: Commit** `feat(tickets): ticket model and markdown format`

---

### Task 2: Ticket store in the main process

**Files:**
- Create: `src/main/tickets/store.ts`
- Modify: `src/main/git/worktrees.ts` (export `ensureExcluded(repo, entry)`; existing caller passes `/.worktrees/`)
- Test: `tests/main/tickets/store.test.ts`

**Interfaces:**
- Consumes: Task 1 format functions; `mainWorktreeRoot(dir)`.
- Produces `class TicketStore` (one instance per app, keyed internally by main root):
  - `list(repo: string): Promise<TicketListEntry[]>` — non-archived only; does not read `archive/`.
  - `get(repo: string, id: string): Promise<Ticket>`
  - `create(repo: string, fields: TicketFields): Promise<Ticket>` — allocates the ID, sets `created`/`updated`.
  - `patch(repo: string, id: string, changes: Partial<TicketFields>): Promise<Ticket>` — reads the file now, applies only the keys in `changes`, keeps unknown keys, bumps `updated`.
  - `duplicate(repo: string, id: string): Promise<Ticket>` — title + ` (copie)`, status `backlog`, no branch/worktree/base.
  - `archive(repo: string, id: string): Promise<void>` — sets `archived`, moves to `archive/`.
  - `config(repo: string): Promise<{ prefix: string; next: number }>`, `setPrefix(repo: string, prefix: string): Promise<void>` (validates `/^[A-Z][A-Z0-9]{0,9}$/`).
  - `labels(repo: string): Promise<string[]>` — distinct labels of listed tickets, sorted.

- [ ] **Step 1: Write failing tests** (temp repo via `tests/helpers/repo.ts` `createRepo`):
- `create writes .tickets/CAN-1.md in the main checkout`: called with a worktree path of the repo, the file lands under the main root, not the worktree.
- `excludes .tickets from git`: after `create`, `.git/info/exclude` contains `/.tickets/` once (twice `create` → still once) and `git status --porcelain` is empty.
- `ids increment across prefix changes`: create → `CAN-1`, `setPrefix('DPP')`, create → `DPP-2`.
- `next id survives a lost config`: create 3, archive `CAN-3`, delete `config.json`, create → `CAN-4`.
- `patch keeps fields changed on disk`: create; edit the file on disk to change `priority: low`; `patch(…, { title: 'New' })` → result has title `New` and priority `low`.
- `concurrent patches on one ticket both land`: `Promise.all([patch({title}), patch({labels})])` → both applied.
- `unreadable files are reported, not rewritten`: write `.tickets/BAD-1.md` with invalid YAML; `list` returns an `unreadable` entry with `file: 'BAD-1.md'`; file bytes unchanged.
- `archive moves the file and hides it from list`.
- `list on a repo without .tickets is empty and creates nothing`.

- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/store.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `TicketStore` in `src/main/tickets/store.ts`.** Serialize writes per `<root>/<id>` with a promise chain map. Next ID = max(config.next, 1 + highest number found in `.tickets/*.md` and `.tickets/archive/*.md`, any prefix). Atomic writes (tmp + rename), like `AppStore.save`. Call `ensureExcluded(root, '/.tickets/')` before the first write.

- [ ] **Step 4: Run tests** — Expected: PASS; `npx vitest run tests/main/git` still PASS.

- [ ] **Step 5: Commit** `feat(tickets): store tickets in the main checkout, out of git`

---

### Task 3: Ticket IPC, watcher and branch bases

**Files:**
- Create: `src/main/tickets/ticketIpc.ts`, `src/main/tickets/watch.ts`
- Modify: `src/main/appStore.ts`, `src/main/ipc.ts` (register; record base in `worktree:create`), `src/main/index.ts` (create `TicketStore`), `src/shared/api.ts`, `src/preload/index.ts`
- Test: `tests/main/appStore.test.ts`, `tests/main/tickets/watch.test.ts`

**Interfaces:**
- `AppStore`: state `branchBases: Record<string /*main root*/, Record<string /*branch*/, string /*base*/>>`, sanitized like `repoBases`; `branchBase(root: string, branch: string): string | undefined`, `setBranchBase(root: string, branch: string, base: string | null): void`, `pruneBranchBases(root: string, existing: string[]): void`.
- `watchTickets(root: string, onChange: () => void): () => void` — chokidar on `<root>/.tickets`, depth 0, 150 ms debounce, tolerates the folder not existing yet (watch the root with `depth: 0` filtered to `.tickets`).
- `CanopyApi` additions (channels `tickets:<name>`):
  - `listTickets(repo): Promise<TicketListEntry[]>`, `getTicket(repo, id): Promise<Ticket>`, `createTicket(repo, fields: TicketFields): Promise<Ticket>`, `patchTicket(repo, id, changes: Partial<TicketFields>): Promise<Ticket>`, `duplicateTicket(repo, id): Promise<Ticket>`, `archiveTicket(repo, id): Promise<void>`, `ticketConfig(repo): Promise<{ prefix: string; next: number }>`, `setTicketPrefix(repo, prefix): Promise<void>`, `ticketLabels(repo): Promise<string[]>`
  - `watchTickets(repo): Promise<void>` — one watched repo per window at a time; emits `tickets:changed` `{ repo: string /*main root*/ }`.
  - `branchBase(cwd): Promise<{ base: string } | { lost: string } | null>` — base remembered for the branch checked out at `cwd`. `lost`: that base no longer exists locally; it is forgotten after this answer. Null: none.
  - `worktree:list` calls `pruneBranchBases(root, <local branches>)` so entries of deleted branches go.
- `worktree:create` with a `base` that is not the repo's default base name records `setBranchBase(root, branch, base)`.

- [ ] **Step 1: Write failing tests**: appStore `remembers and prunes branch bases` (set two, prune with one existing → one left; bad shapes in file reset to `{}`); watch `fires once for a burst of writes in .tickets` and `fires when .tickets is created after watching started`.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement**, validating every argument in `ticketIpc.ts` (ids `/^[A-Z][A-Z0-9]*-\d+$/`, statuses/priorities against the enums, labels strings ≤ 50 chars, `changes` keys limited to `TicketFields`).
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tickets): IPC, live refresh and remembered branch bases`

---

### Task 4: Git operations for launch

**Files:**
- Modify: `src/main/git/switchBranch.ts`, `src/main/git/refs.ts`
- Test: `tests/main/git/switchBranch.test.ts`, `tests/main/git/refs.test.ts`

**Interfaces:**
- `startBranchIn(cwd: string, branch: string, base: string, o?: { trusted?: boolean }): Promise<void>` — fails if `branch` exists; dirty files stashed with the existing `canopy:<source>` tag; `git switch -c <branch> <base>`; on failure, restores the stash and rethrows.
- `mostAdvancedBranch(repo: string, defaultRef: string): Promise<{ branch: string; ahead: number } | null>` — among branches checked out in non-main worktrees: max `aheadCount`, tie → latest commit (`git log -1 --format=%ct`); null if none ahead.

- [ ] **Step 1: Write failing tests**: `startBranchIn sets dirty files aside` (dirty file on `feat/a`, start `feat/b` from `main` → clean tree on `feat/b`; `switchBranch(cwd,'feat/a')` brings the file back); `startBranchIn refuses an existing branch` (rejects, tree and branch unchanged); `mostAdvancedBranch picks most commits ahead, then most recent` (worktrees at 2, 3, 3 commits ahead, the later 3 wins); returns null when all are at 0.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/main/git` — PASS.
- [ ] **Step 5: Commit** `feat(git): start a branch in an existing worktree, find the most advanced branch`

---

### Task 5: Launch in the main process

**Files:**
- Create: `src/main/tickets/launch.ts`
- Modify: `src/main/tickets/ticketIpc.ts`, `src/shared/api.ts`, `src/preload/index.ts`
- Test: `tests/main/tickets/launch.test.ts`

**Interfaces:**
- Shared types:
  - `type LaunchTarget = { kind: 'new'; base: string } | { kind: 'existing'; worktree: string; base: string }`
  - `interface LaunchRequest { id: string; branch: string; target: LaunchTarget; setInProgress: boolean }`
  - `interface LaunchCandidate { path: string; branch: string | null; free: boolean; reason?: 'main' | 'working' | 'waiting'; dirty: number; sessions: number }`
- `CanopyApi.launchCandidates(repo): Promise<{ worktrees: LaunchCandidate[]; advanced: { branch: string; ahead: number } | null }>`
- `CanopyApi.launchTicket(repo, req: LaunchRequest): Promise<{ worktree: string; ticket: Ticket }>`
- `launchTicket(deps: { tickets: TicketStore; store: AppStore; activity: (cwd: string) => 'waiting'|'working'|'idle'; sessions: (cwd: string) => number; trusted: (cwd: string) => Promise<boolean> }, repo: string, req: LaunchRequest)`

Order: validate branch (`git check-ref-format --branch`, not existing locally) → git work (`createWorktree` with `name` = branch with `/` → `-`, or `startBranchIn`; an `existing` target that is not `free` is refused) → `setBranchBase` when base ≠ default → `patch` ticket `{ branch, worktree, base, status? }`.

- [ ] **Step 1: Write failing tests**: `new worktree launch links the ticket` (worktree exists at `.worktrees/feat-export-jsonld`, ticket has branch/worktree/base, status `in_progress`); `setInProgress false keeps the status`; `failed launch writes nothing` (branch already exists → rejects, ticket file bytes unchanged, no worktree created); `refuses a worktree that is not free` (activity `working` → rejects); `stacked launch remembers the base` (`base: 'feat/a'` → `store.branchBase(root, branch) === 'feat/a'`); `candidates mark main and busy worktrees`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat(tickets): launch a ticket into a new or existing worktree`

---

### Task 6: Renderer store and Tickets tab

**Files:**
- Create: `src/renderer/tickets/ticketStore.ts`, `src/renderer/tickets/tickets.css`
- Modify: `src/renderer/store.ts` (`View` adds `'tickets'`; `openTicket: string | null` with `setOpenTicket(id: string | null)`; `selectedTicket: string | null`), `src/renderer/shell/Header.tsx` (tab with count), `src/renderer/App.tsx` (tickets view full width, no sidebar)
- Test: `tests/renderer/ticketStore.test.ts`

**Interfaces:**
- `useTickets` (zustand): `{ repo: string | null; entries: TicketListEntry[]; error: string | null }`; `connectTickets(): () => void` (follows `useApp.repo`, calls `watchTickets`, reloads on `tickets:changed`); `openCount(entries): number` (not `done`); `groupByStatus(entries, filter: 'all' | TicketStatus): { status: TicketStatus; tickets: Ticket[] }[]` (STATUS_ORDER, empty groups dropped).

- [ ] **Step 1: Write failing tests** for `openCount` and `groupByStatus` (order, empty groups dropped, `done` last, filter `todo` returns one group).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; Header tab label `Tickets` with count badge as in the mockup; App renders `<TicketsScreen/>` or `<TicketEditor/>` (Tasks 7, 8; stub them now) across the body width when `view === 'tickets'`.
- [ ] **Step 4: Run** `npx vitest run tests/renderer` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tickets): tickets tab and renderer store`

---

### Task 7: Tickets screen (3) and launch panel

**Files:**
- Create: `src/renderer/tickets/TicketsScreen.tsx`, `src/renderer/tickets/LaunchPanel.tsx`, `src/renderer/tickets/launchFlow.ts`
- Test: `tests/renderer/launchFlow.test.ts`

**Interfaces:**
- `defaultBranchName(t: Ticket, type?: string): string` → `` `${type ?? 'feat'}/${branchSlug(t.title)}` ``
- `runLaunch(repo: string, req: LaunchRequest, o: { startClaude: boolean; prompt: string }): Promise<void>` — calls `launchTicket`, rescans worktrees (existing `useWorktrees` refresh), `setWorktree(result.worktree)`, `setView('sessions')`, then `askClaude(result.worktree, prompt)` if `startClaude`.

Screen per mockup screen 3 minus the source switch and sync line: header `Mes tickets` + `+ Nouveau ticket` + filters `Tous · n / À faire · n / En cours · n / Backlog · n`; groups; rows `id · titre · priorité · labels · (branche liée existante ? lien : ▶ Lancer)`; `done` group collapsed (`Terminé · n`, click to expand); unreadable entries as a warning row `Fichier illisible : BAD-1.md`. Right panel: empty state `Choisis un ticket pour le lancer.`; else id, title, `priorité · labels`, link `Voir et modifier le ticket`, `OÙ LANCER` radios, base select (new: default base + `codeBranches`), worktree select (existing: candidates, non-free disabled with reason `checkout principal` / `Claude travaille` / `attend ta réponse`; shows `n fichiers mis de côté`, `n sessions`), `Base auto` = `advanced.branch` editable, `La plus avancée : n commits d'avance sur <default>`; branch type select + name input (error `Cette branche existe déjà` from `codeBranches`); two checkboxes; button `Lancer <ID>` with ⌘↵; launch errors shown in the panel.

- [ ] **Step 1: Write failing tests** for `defaultBranchName` and `runLaunch` (mocked `window.canopy`: on success calls in order launchTicket → setView('sessions') → askClaude; with `startClaude: false` no askClaude; on rejection, view unchanged and error rethrown).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** components, matching mockup spacing and colors from `theme.css`.
- [ ] **Step 4: Run** `npx vitest run tests/renderer` and `npm run typecheck` — PASS; `npm run dev` and compare against `.playwright-mcp/shot-tickets.png`.
- [ ] **Step 5: Commit** `feat(tickets): tickets list and one-click launch panel`

---

### Task 8: Ticket editor (3b)

**Files:**
- Create: `src/renderer/tickets/TicketEditor.tsx`, `src/renderer/tickets/editorSave.ts`
- Test: `tests/renderer/editorSave.test.ts`

**Interfaces:**
- `createSaver(save: (changes: Partial<TicketFields>) => Promise<void>, delayMs = 500): { change(c: Partial<TicketFields>): void; flush(): Promise<void> }` — merges pending changes key by key, one `save` per pause; `flush` on unmount/view change.
- Draft new ticket: `openTicket === 'new'`; `createTicket` on first non-empty title, then the editor switches to the real id.

Layout per mockup 3b minus Linear-only parts: breadcrumb `Mes tickets / <ID>` + `Dupliquer`; `Titre`; description textarea with B / • / `</>` buttons inserting `**…**`, `- `, `` `…` ``; `Sous-tâches d / n` with check, inline rename, delete, `+ Ajouter`; right column Statut, Priorité selects, Labels chips + `+` (datalist from `ticketLabels`); `Développement` block (linked branch → button opening Sessions on that worktree; else `Aucun worktree pour l'instant.` + `▶ Lancer <ID>` → `setView('tickets')`, `selectedTicket = id`, `openTicket = null`); `Archiver le ticket` at the bottom (back to list). When `tickets:changed` brings a newer version, fields not pending in the saver take the disk value.

- [ ] **Step 1: Write failing tests**: `coalesces changes into one save` (fake timers; title then labels within 500 ms → one call with both keys); `flush saves pending changes immediately`; `later change of a key wins`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/renderer`, `npm run typecheck` — PASS; compare with `.playwright-mcp/shot-ticket-edit.png`.
- [ ] **Step 5: Commit** `feat(tickets): ticket editor with autosave`

---

### Task 9: Stacked bases in Code and Sessions, ticket badge, prefix setting

**Files:**
- Modify: `src/renderer/code/CodeScreen.tsx`, `src/renderer/sessions/SidePanel.tsx`, `src/renderer/sessions/panelPrompts.ts`, `src/renderer/shell/WorktreeList.tsx`, `src/renderer/shell/Settings.tsx`
- Test: `tests/renderer/panelPrompts.test.ts`

**Interfaces:**
- `prPrompt(target?: string): string` replaces `PR_PROMPT`: no target → `'Crée une PR pour cette branche.'` (unchanged); target → `` `Crée une PR pour cette branche, avec \`${target}\` comme branche cible.` ``
- Code comparison select: when `branchBase(cwd)` is set, first option group `Base de la branche` with that branch, then the others; default comparison stays the default branch.
- SidePanel: shows `Cible : <base>` above `Créer la PR` when a branch base exists, and sends `prPrompt(base)`.
- `{ lost }` from `branchBase`: Code shows the notice `La base « <lost> » n'existe plus : retour à la branche par défaut.` (same slot as `baseNotice`), and the PR targets the default branch.
- WorktreeList: entry whose branch equals a listed ticket's `branch` shows the ticket ID chip; click → `setView('tickets')`, `setOpenTicket(id)`.
- Settings: section `Tickets` for the active repo: prefix input (validation message `Lettres majuscules et chiffres, 10 au plus, commençant par une lettre`), note `S'applique aux nouveaux tickets.`

- [ ] **Step 1: Write failing test** `prPrompt` both cases.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tickets): stacked branch bases in Code and PR, ticket badge, prefix setting`

---

### Task 10: End-to-end

**Files:**
- Create: `tests/e2e/tickets.spec.ts` (pattern of `tests/e2e/workspace.spec.ts`: temp repo, `CANOPY_FAKE_QUERY=1`, temp `--user-data-dir`, repo pre-trusted or trust dialog accepted)

- [ ] **Step 1: Write tests**:
  - `create and edit a ticket`: Tickets tab → `+ Nouveau ticket` → title → description → add subtask → back; list shows `REP-1` (repo folder `repo`) under Backlog; `.tickets/REP-1.md` exists in the repo; `git status --porcelain` empty.
  - `launch into a new worktree`: select ticket → `Lancer REP-1` → view is Sessions on `feat/<slug>` worktree, a session tab received the prompt containing `REP-1`; list shows the branch link; ticket status En cours.
  - `launch into an existing worktree with uncommitted changes`: worktree `feat/a` with a dirty file → existing-worktree option shows `1 fichier mis de côté` → launch → that worktree is on the new branch; `git stash list` has `canopy:feat/a`.
  - `stacked base shows in Code and PR`: after the previous launch from base `feat/a`, Code comparison select offers `feat/a` first; side panel shows `Cible : feat/a`.
  - `hand-edited ticket refreshes the list`: rewrite the title in the file → list updates within 2 s.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tickets.spec.ts` — Expected: PASS (fix code, not tests, on failure).
- [ ] **Step 3: Run the full suite** `npm test && npm run typecheck && npm run test:e2e` — all PASS.
- [ ] **Step 4: Commit** `test(tickets): end-to-end create, edit, launch`
