# Raccourcis clavier (CAN-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Global keyboard shortcuts (screens, worktrees, new session, new worktree, quick ticket, dictation, help) usable from any screen.

**Architecture:** One table in `src/shared/shortcuts.ts` drives both the macOS app menu (`src/main/menu.ts`, accelerators, greyed entries) and the help modal. A menu click is broadcast as `menu:shortcut` with the shortcut id. The renderer runs it through a pure dispatcher (`src/renderer/shell/shortcuts.ts`) that reads and writes the Zustand stores. Menu accelerators take priority over Monaco and xterm, which is why the menu is used and not a `keydown` listener.

**Tech Stack:** Electron menu API, React 19, Zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-keyboard-shortcuts-design.md`

## Global Constraints

- User-visible text in French with « » quotes. Code, identifiers and comments in English.
- TDD: each test is written and seen failing before its code (CLAUDE.md).
- No semicolons, single quotes, 2 spaces.
- IPC: declared in `src/shared/api.ts`, exposed in `src/preload/index.ts`, handled in `src/main/ipc.ts`.
- While a modal is open (`document.querySelector('[aria-modal="true"]')`), every shortcut of this spec is ignored.
- « Repo actif » = `useApp.getState().repo`, « worktree actif » = `useApp.getState().worktree`.
- Exact accelerators (Electron syntax):

| id | accelerator | menu | label | needs |
|---|---|---|---|---|
| `view-sessions` | `CmdOrCtrl+1` | go | `Sessions` | repo |
| `view-code` | `CmdOrCtrl+2` | go | `Code` | repo |
| `view-tickets` | `CmdOrCtrl+3` | go | `Tickets` | repo |
| `view-mockups` | `CmdOrCtrl+4` | go | `Maquettes` | repo |
| `worktree-next` | `Ctrl+Tab` | go | `Worktree suivant` | worktree |
| `worktree-previous` | `Ctrl+Shift+Tab` | go | `Worktree précédent` | worktree |
| `new-worktree` | `CmdOrCtrl+Shift+N` | file | `Nouveau worktree…` | repo |
| `new-session` | `CmdOrCtrl+T` | file | `Nouvelle session` | worktree |
| `new-ticket` | `CmdOrCtrl+Shift+T` | file | `Nouveau ticket…` | repo |
| `dictation` | `CmdOrCtrl+Shift+D` | file | `Dicter un message` | worktree |
| `help` | `CmdOrCtrl+Shift+H` | help | `Raccourcis clavier` | none |

## Review Focus

- A shortcut pressed while focus is in Monaco or in the terminal must still act. The E2E for ⌘1–4 presses the keys with focus in the code editor.
- A shortcut pressed with a modal open (new worktree, quick ticket, help, ⌘K bar) must do nothing behind it. Test in Task 3 (`runShortcut` with `modalOpen: true`) and E2E in Task 4.
- ⌃⇥ on an orphan worktree, or a list of one, must not throw. It goes to the first worktree, or stays put. Test in Task 3.
- ⌘T must never drop the current draft: it adds a tab, and the draft stays in its own tab. Test in Task 3.
- No repo open: nothing throws, and the entries are greyed. Tests in Tasks 2 and 3.

---

### Task 1: Shortcut table and app menu

**Files:**
- Create: `src/shared/shortcuts.ts`
- Modify: `src/main/menu.ts`, `src/main/index.ts:233-237`
- Test: `tests/main/shortcuts.test.ts` (vitest only includes tests/main, tests/renderer, tests/scripts), `tests/main/menu.test.ts`

**Interfaces:**
- Produces:
  - `export type ShortcutId = 'view-sessions' | 'view-code' | 'view-tickets' | 'view-mockups' | 'worktree-next' | 'worktree-previous' | 'new-worktree' | 'new-session' | 'new-ticket' | 'dictation' | 'help'`
  - `export interface Shortcut { id: ShortcutId; accelerator: string; label: string; menu: 'go' | 'file' | 'help'; needs: 'repo' | 'worktree' | null }`
  - `export const SHORTCUTS: readonly Shortcut[]`, with the values of the Global Constraints table, in that order.
  - `export function displayKeys(accelerator: string): string` → macOS glyphs, modifiers in the order ⌃⌥⇧⌘: `'CmdOrCtrl+Shift+N'` → `'⇧⌘N'`, `'Ctrl+Tab'` → `'⌃⇥'`, `'Ctrl+Shift+Tab'` → `'⌃⇧⇥'`, `'CmdOrCtrl+1'` → `'⌘1'`.
  - `MenuOptions` gains `onShortcut: (id: ShortcutId) => void`. Each menu item has `id: \`shortcut:${id}\``.
  - Event `menu:shortcut`, payload `ShortcutId`.

- [ ] **Step 1: Write failing tests**

`tests/main/shortcuts.test.ts`:
- `every accelerator is unique` (a Set of accelerators has the same size as `SHORTCUTS`).
- `displayKeys renders macOS glyphs`: the 4 examples above.
- `no shortcut takes a key the code editor or macOS already uses`: none of the accelerators is in `['CmdOrCtrl+/', 'CmdOrCtrl+Shift+3', 'CmdOrCtrl+Shift+4', 'CmdOrCtrl+Shift+5', 'CmdOrCtrl+K', 'CmdOrCtrl+P', 'CmdOrCtrl+Shift+F', 'CmdOrCtrl+W', 'CmdOrCtrl+D', 'CmdOrCtrl+Shift+K']`.

`tests/main/menu.test.ts` (update the `items` helper to pass `onShortcut`):
- `each shortcut is a menu item that reports its id`: for every `s` of `SHORTCUTS`, exactly one item has `id === \`shortcut:${s.id}\``, `accelerator === s.accelerator` and `label === s.label`. Its `click()` calls `onShortcut(s.id)`.
- `the go menu is labelled Aller and holds the screens and worktrees`: a top-level item `label: 'Aller'` whose submenu ids are the 6 `menu: 'go'` ones.
- `the help menu holds the shortcut list`: a top-level item with `role: 'help'` and `label: 'Aide'` contains `shortcut:help`.

- [ ] **Step 2: Run** `npx vitest run tests/main/shortcuts.test.ts tests/main/menu.test.ts`. Expected: FAIL (module not found, missing items).

- [ ] **Step 3: Implement** `src/shared/shortcuts.ts` and the menu.
  - The « Aller » menu goes between « Présentation » and « Fenêtre ».
  - In « Fichier », the 4 `file` shortcuts come before « Fermer l'onglet », followed by a separator.
  - « Aide » goes last (`role: 'help'` lets macOS add its search field).
  - In `index.ts`: `onShortcut: (id) => broadcast('menu:shortcut', id)`.

- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(shell): add keyboard shortcuts to the app menu`.

### Task 2: Grey the entries the context does not allow

**Files:**
- Create: `src/main/shortcutMenu.ts`
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/renderer/App.tsx`
- Test: `tests/main/shortcutMenu.test.ts`

**Interfaces:**
- Consumes: `SHORTCUTS`, the `shortcut:<id>` menu ids (Task 1).
- Produces:
  - `export interface ShortcutContext { repo: boolean; worktree: boolean }` in `src/shared/shortcuts.ts`.
  - `export function shortcutEnabled(s: Shortcut, ctx: ShortcutContext): boolean` in `src/shared/shortcuts.ts`.
  - `export function applyShortcutContext(menu: { getMenuItemById(id: string): { enabled: boolean } | null } | null, ctx: ShortcutContext): void` in `src/main/shortcutMenu.ts`.
  - API `reportShortcutContext(ctx: ShortcutContext): Promise<void>`, channel `shortcuts:context`. Main validates the two booleans, then calls `applyShortcutContext(Menu.getApplicationMenu(), ctx)`.

- [ ] **Step 1: Write failing tests**
  - `shortcutEnabled`: `needs: null` is always true; `'repo'` follows `ctx.repo`; `'worktree'` follows `ctx.worktree`.
  - `applyShortcutContext`, with a fake menu holding a `{ enabled }` object per id: with `{ repo: false, worktree: false }`, only `shortcut:help` stays enabled. With `{ repo: true, worktree: false }`, `new-session`, `dictation` and `worktree-*` are disabled and the rest enabled. A `null` menu, or a missing item, does not throw.
- [ ] **Step 2: Run** `npx vitest run tests/main/shortcutMenu.test.ts tests/main/shortcuts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions and the IPC. In `App.tsx`, add a `useEffect` that subscribes to `useApp` and calls `reportShortcutContext({ repo: s.repo !== null, worktree: s.worktree !== null })` only when the key changes (same "send only on change" pattern as `connectUnsaved`).
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shell): grey shortcuts that need a repo or a worktree`.

### Task 3: Renderer dispatcher: screens, worktrees, new session, new worktree

**Files:**
- Create: `src/renderer/shell/shortcuts.ts`
- Modify: `src/renderer/store.ts`, `src/renderer/App.tsx`, `src/renderer/shell/WorktreeList.tsx`
- Test: `tests/renderer/shortcuts.test.ts`, `tests/renderer/store.test.ts`, `tests/e2e/shortcuts.spec.ts` (new)

**Interfaces:**
- Consumes: `ShortcutId`, event `menu:shortcut` (Task 1).
- Produces:
  - In `useApp`: `dialog: AppDialog | null`, `setDialog: (d: AppDialog | null) => void`, with `export type AppDialog = 'new-worktree' | 'new-ticket' | 'shortcuts'`.
  - `export function nextWorktree(paths: string[], current: string | null, step: 1 | -1): string | null` in `src/renderer/shell/shortcuts.ts`.
  - `export interface ShortcutDeps { modalOpen: () => boolean; newTab: (cwd: string) => string; startDictation: () => void }`.
  - `export function runShortcut(id: ShortcutId, deps: ShortcutDeps): void`. It reads and writes `useApp`. `dictation` calls `deps.startDictation()` (filled in Task 6; a no-op until then).
  - `export function connectShortcuts(): () => void`. It subscribes `window.canopy.on('menu:shortcut', …)`, checks the payload is a known id, and calls `runShortcut` with the real deps (`modalOpen` = `[aria-modal="true"]` query, `newTab` from `sessionStore`).

- [ ] **Step 1: Write failing tests** in `tests/renderer/shortcuts.test.ts`. Reset `useApp` with `useApp.setState` before each test, as `store.test.ts` does.
  - `nextWorktree`:
    - `(['a','b','c'], 'b', 1)` → `'c'`; `(['a','b','c'], 'c', 1)` → `'a'`; `(['a','b','c'], 'a', -1)` → `'c'`.
    - current absent from the list (orphan) → `'a'`.
    - `([], 'x', 1)` → `null`; `(['a'], 'a', 1)` → `'a'`.
  - `view shortcuts switch the screen`: `view-code` sets `view: 'code'`. The same for the 4 screens.
  - `worktree-next walks the active repo list only`: `worktrees` holds 2 paths of the active repo, `worktree` is the first. After `worktree-next`, `worktree` is the second, and `repo` is unchanged.
  - `new-session opens a tab on the active worktree and shows Sessions`: `newTab` spy called with the active worktree, and `view === 'sessions'`.
  - `new-worktree and new-ticket and help open their dialog`: `dialog` becomes `'new-worktree'`, `'new-ticket'` and `'shortcuts'` respectively.
  - `nothing happens behind a modal`: with `modalOpen: () => true`, every id leaves `view`, `worktree` and `dialog` unchanged and calls no dep.
  - `without a repo nothing throws`: `repo: null, worktree: null`. Every id runs without an exception, and `newTab` is not called.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/shortcuts.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Worktree list for ⌃⇥: `useApp.getState().worktrees.map((w) => w.path)`, i.e. the active repo's list, without the « espace » entry or orphans. Apply the result with `setWorktree`.
  - `new-session`: `newTab(worktree)`, then `setView('sessions')`.
  - `WorktreeList`: replace the local `creating` state with `useApp` `dialog === 'new-worktree'`. The « + » button calls `setDialog('new-worktree')`, and `onClose` / `onCreated` call `setDialog(null)` (the existing `sync` stays).
  - The Tickets and Maquettes screens do not mount the sidebar. On those screens, `App.tsx` renders `NewWorktreeDialog` itself when `dialog === 'new-worktree'`, with `onCreated: (path) => { setDialog(null); setWorktree(path) }`. The sidebar syncs when it mounts again.
  - In `App.tsx`: `useEffect(() => connectShortcuts(), [])`.
- [ ] **Step 4: Run** the unit tests. Expected: PASS.
- [ ] **Step 5: Write the E2E** `tests/e2e/shortcuts.spec.ts`. Use the same launch as `tests/e2e/tickets.spec.ts` (a repo with a second worktree created by `git worktree add`, `CANOPY_FAKE_QUERY=1`). Fire shortcuts with `page.keyboard.press(…)`. If an accelerator does not fire with the window hidden, fall back to `app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), 'shortcut:view-code')` and note it in a comment.
  - `⌘2 then ⌘3 switch screens even from the code editor`: open Code, focus the editor, press `Meta+3`. The « Tickets » nav button has `aria-current="page"`.
  - `⌃⇥ goes to the next worktree`: the active `[data-testid="worktree"]` changes to the second worktree.
  - `⌘T opens a new session tab`: the session tab count goes up by 1, on the Sessions screen.
  - `⌘⇧N opens the new worktree dialog from Tickets`: on Tickets, `Meta+Shift+N` shows the dialog (`[aria-modal="true"]`). Then `Meta+1` does not change the screen. Escape closes it.
- [ ] **Step 6: Run** `npm run build && npx playwright test tests/e2e/shortcuts.spec.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(shell): switch screens and worktrees and open sessions from the keyboard`.

### Task 4: Quick ticket from anywhere

**Files:**
- Create: `src/renderer/tickets/QuickTicketDialog.tsx`
- Modify: `src/renderer/tickets/editorSave.ts` (or a new pure helper next to it), `src/renderer/App.tsx`, `src/renderer/tickets/tickets.css`
- Test: `tests/renderer/editorSave.test.ts`, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**
- Consumes: `useApp.dialog === 'new-ticket'` (Task 3), `window.canopy.createTicket(repo, fields)`, `ticketKey('local', id)`.
- Produces: `export function quickTicketFields(title: string, description: string): TicketFields | null`. It returns null when the title is blank. Otherwise it returns `{ title: title.trim(), description, status: 'backlog', priority: 'none', labels: [], subtasks: [] }`, the same defaults as the editor's `DRAFT`.

- [ ] **Step 1: Write the failing test**: `quickTicketFields('  ', 'x')` → `null`; `quickTicketFields(' Bug ', 'd')` → the object above with `title: 'Bug'`.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/editorSave.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper, then the dialog.
  - The dialog is a `<form>` with `useModal`, `aria-modal="true"`, title « Nouveau ticket », a « Titre » input (autofocus) and a « Description » textarea. ⌘↵ submits from either field, Escape closes.
  - The « Créer » button is disabled while the title is blank or the request is busy. An error shows inline without closing.
  - On success: `setDialog(null)`, the screen does not change, and a notice `role="status"` with `data-testid="quick-ticket-notice"` reads « Ticket {id} créé » with a « Ouvrir » button. It disappears after 6 s.
  - « Ouvrir » calls `setView('tickets')` then `setOpenTicket(ticketKey('local', id))`. The ticket editor saves as you type and writes its changes when it unmounts, so no extra guard is needed.
  - Rendered in `App.tsx` when `dialog === 'new-ticket'` and `repo` is set.
- [ ] **Step 4: Run** the unit test. Expected: PASS.
- [ ] **Step 5: Add E2E** `⌘⇧T creates a local ticket without leaving the screen`: from Code, press `Meta+Shift+T`, type a title, press `Meta+Enter`. Code is still current, the notice shows, and the ticket exists in `listTickets` (via `page.evaluate`). Then « Ouvrir » shows the editor with that title.
- [ ] **Step 6: Run** `npm run build && npx playwright test tests/e2e/shortcuts.spec.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(tickets): create a ticket from any screen with ⌘⇧T`.

### Task 5: Shortcut help

**Files:**
- Create: `src/renderer/shell/ShortcutHelp.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/e2e/shortcuts.spec.ts`

**Interfaces:**
- Consumes: `SHORTCUTS`, `displayKeys` (Task 1), `dialog === 'shortcuts'` (Task 3).

- [ ] **Step 1: Write the failing E2E** `⌘⇧H lists every shortcut`: `Meta+Shift+H` shows a dialog titled « Raccourcis clavier ». It holds one row per `SHORTCUTS` entry, with `displayKeys(accelerator)` and `label`. Also check the existing ones: « ⌘K Rechercher », « ⌘W Fermer l'onglet », « ⌃` Terminal ». Escape closes it.
- [ ] **Step 2: Run** `npm run build && npx playwright test tests/e2e/shortcuts.spec.ts -g "⌘⇧H"`. Expected: FAIL.
- [ ] **Step 3: Implement.** A modal (`useModal`, `aria-modal="true"`) built from `SHORTCUTS`, grouped as « Écrans », « Worktrees et sessions », « Tickets », « Saisie ». A small fixed list adds the existing shortcuts that are outside the table: ⌘K « Rechercher », ⌘P « Ouvrir un fichier (Code) », ⇧⌘F « Rechercher dans les fichiers (Code) », ⌃` « Terminal », ⌘W « Fermer l'onglet », ⌘↵ « Envoyer ».
- [ ] **Step 4: Run** the E2E. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shell): show the keyboard shortcut list with ⌘⇧H`.

### Task 6: Dictation (native macOS)

The risk is lifted first. If Step 3 fails, stop this task, revert its changes, and report back to Bastien. Tasks 1–5 ship without it.

**Files:**
- Create: `src/main/dictation.ts`
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/renderer/sessions/sessionStore.ts`, `src/renderer/sessions/Composer.tsx`, `src/renderer/sessions/sessions.css`, `src/renderer/shell/shortcuts.ts`
- Test: `tests/main/dictation.test.ts`, `tests/renderer/sessionStore.test.ts`, `tests/renderer/shortcuts.test.ts`, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**
- Produces:
  - `export function startDictation(send: (action: string) => void): void` in `src/main/dictation.ts`. It calls `send('startDictation:')`. Main passes `(a) => Menu.sendActionToFirstResponder(a)`.
  - API `startDictation(): Promise<void>`, channel `dictation:start`.
  - In `sessionStore`: `focusRequest: { cwd: string; seq: number } | null` and `export function requestComposerFocus(cwd: string): void`. It runs `ensureTab(cwd)`, then bumps `seq`.
  - `runShortcut('dictation')`: `setView('sessions')`, `requestComposerFocus(worktree)`, then `deps.startDictation()` on the next frame, so the focus is set before the native call.

- [ ] **Step 1: Wire the minimal path and ask Bastien to check it by hand.**
  - Add `startDictation` (main + IPC + preload) and a mic button in the `Composer` that focuses the textarea and calls it.
  - Run `npm run dev` and ask Bastien to click the mic: macOS dictation must open and type into the composer.
  - This step is exempt from TDD because it is a feasibility spike. Its code is kept only if it works, and Step 2 then adds the tests.
- [ ] **Step 2: Write failing tests.**
  - `startDictation sends the native selector`: the spy is called with `'startDictation:'`.
  - `requestComposerFocus creates a tab if none and bumps seq`.
  - `dictation focuses the composer then starts dictation`: in `runShortcut`, `view === 'sessions'`, `focusRequest.cwd` is the active worktree, and the `startDictation` dep is called once (use fake timers or flush `requestAnimationFrame`).
  - Without a worktree, nothing is called.
- [ ] **Step 3: Run** `npx vitest run tests/main/dictation.test.ts tests/renderer/sessionStore.test.ts tests/renderer/shortcuts.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `Composer` watches `focusRequest`. When `cwd` matches its tab, it focuses `input` with the caret at the end of the text.
  - The mic button has `aria-label="Dicter"` and `title="Dicter (⇧⌘D)"`.
  - Dictated text is only inserted into the textarea, never sent.
- [ ] **Step 5: Run** the unit tests. Expected: PASS.
- [ ] **Step 6: Add E2E** `⌘⇧D focuses the composer on Sessions`: from Code, `Meta+Shift+D` → Sessions screen, and `#composer` is `document.activeElement`. Real dictation is not tested: the native call does nothing visible in the hidden window.
- [ ] **Step 7: Run** `npm run build && npx playwright test tests/e2e/shortcuts.spec.ts`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(sessions): dictate a message with native macOS dictation`.

### Task 7: Final verification

- [ ] **Step 1:** `npm run typecheck && npm test && npm run test:e2e`. Expected: all pass.
- [ ] **Step 2:** Check that `CLAUDE.md` is still accurate. Add one line under Architecture saying shortcuts live in `src/shared/shortcuts.ts` (menu + help), and commit it as `docs: mention the keyboard shortcut table`.
