# Modèles de tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-fill every new local ticket from an editable Markdown template (a context-focused default plus per-type templates), managed in a dedicated « Modèles de tickets » screen.

**Architecture:** Pure template format + defaults in `src/main/tickets/templates.ts`; storage methods on `TicketStore` (reusing its guard/prepare/serial) under `.tickets/templates/`; four IPC methods; the ticket draft gets a template selector driven by a pure `templateDraft.ts`; a modal `TemplatesDialog.tsx` edits templates with autosave.

**Tech Stack:** Electron, TypeScript strict, React 19, Zustand, `yaml`, chokidar, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-ticket-templates-design.md`

## Global Constraints

- Code, identifiers, comments in English; all UI text in French with « » quotes (CLAUDE.md).
- Style: 2 spaces, single quotes, no semicolons, relative ESM imports.
- TDD: every step that adds production code is preceded by a failing test.
- Templates live in `<main checkout>/.tickets/templates/<slug>.md`, never tracked by git; reuse `TicketStore.guard`/`prepare`.
- Slug: `^[a-z0-9-]{1,50}$`, computed from `name` at creation only, never changed by a rename; collision → `-2`, `-3`…
- `name` required, ≤ 50 chars (`MAX_TEMPLATE_NAME = 50`). Other fields share the ticket limits (`MAX_DESCRIPTION`, `MAX_LABELS`, `MAX_LABEL`, `MAX_SUBTASKS`, `MAX_TITLE` for subtask titles).
- Default template: `defaultTemplate` key in `.tickets/config.json`; missing or unknown → first template by order. « Aucun » is never the default.
- Order: `order` front-matter number ascending; templates without `order` after, by `name` (`localeCompare` 'fr').
- Built-in templates written only when `.tickets/templates/` does not exist; a deleted template never comes back.
- Status of a templated draft is always `backlog`; the title is never touched by a template.
- The selector exists only while the draft has no id **[Bastien]**.
- Commit messages: Conventional Commits, scope `tickets`. Commit only if Bastien asked for commits in this session (CLAUDE.md).

## Review Focus

- **Hand-edited template file with bad YAML or missing `name`** → listed as unreadable with its error, never overwritten, absent from the draft selector (Task 2 test `lists an unreadable template without touching it`).
- **`setPrefix` or ticket creation after a default template was chosen** → `defaultTemplate` survives in `config.json` (Task 2 test `keeps defaultTemplate when the prefix changes or a ticket is created`).
- **Two templates named alike (« Bug » and « bug! »)** → distinct slugs `bug`, `bug-2`; a rename keeps the file (Task 2 test `creates bug-2 when bug exists and keeps the slug on rename`).
- **Slug coming from the renderer with `../` or uppercase** → refused in main before any fs call (Task 3 test `refuses a slug that is not a-z0-9-`).
- **Default template deleted** → falls back to the first one, draft still pre-filled (Task 2 test `falls back to the first template when the default is gone`).

---

### Task 1: Template format and built-in templates

**Files:**
- Modify: `src/shared/tickets.ts`
- Create: `src/main/tickets/templates.ts`
- Test: `tests/main/tickets/templates.test.ts`

**Interfaces:**
- Produces (in `src/shared/tickets.ts`):
  - `export const MAX_TEMPLATE_NAME = 50`
  - `export const TEMPLATE_SLUG_RE = /^[a-z0-9-]{1,50}$/`
  - `export interface TemplateFields { name: string; order?: number; description: string; priority: TicketPriority; labels: string[]; subtasks: Subtask[] }`
  - `export interface TicketTemplate extends TemplateFields { slug: string }`
  - `export type TemplateListEntry = { kind: 'template'; template: TicketTemplate } | { kind: 'unreadable'; file: string; error: string }`
  - `export interface TemplateList { entries: TemplateListEntry[]; defaultSlug: string | null }` (`null` only when there is no readable template)
  - `export function templateSlug(name: string): string` — NFD, strip accents, lowercase, non `[a-z0-9]` → `-`, trim dashes, cut to 50, `'modele'` when empty.
  - `export function sortTemplates(list: TicketTemplate[]): TicketTemplate[]`
- Produces (in `src/main/tickets/templates.ts`):
  - `parseTemplate(text: string, slug: string): TicketTemplate` (throws `Champ « name » invalide`, `Priorité inconnue : x`, `Front matter manquant`)
  - `serializeTemplate(t: TemplateFields): string` — front matter `name`, `priority` (omitted when `none`), `labels` (flow, omitted when empty), `order` (when set), then description, then `## Sous-tâches` checklist when any.
  - `BUILTIN_TEMPLATES: { slug: string; fields: TemplateFields }[]` — slugs `contexte`, `fonctionnalite`, `bug`, `refacto`, orders 1–4, content per spec §3 « Modèles fournis ».

Reuse `splitFrontMatter`/`splitBody` from `format.ts`: export them there instead of copying (they are already pure).

- [ ] **Step 1: Write the failing tests** in `tests/main/tickets/templates.test.ts`:
  - `round-trips a template`: `parseTemplate(serializeTemplate(f), 'bug')` deep-equals `{ ...f, slug: 'bug' }` for `f = { name: 'Bug', order: 2, description: '### Contexte\nOù.', priority: 'high', labels: ['bug'], subtasks: [{ title: 'Écrire un test qui reproduit le bug', done: false }] }`.
  - `defaults priority to none and labels to empty`: `parseTemplate('---\nname: X\n---\nbody\n', 'x')` → `priority: 'none'`, `labels: []`, `subtasks: []`, no `order`.
  - `refuses a template without name`: `parseTemplate('---\n---\nbody', 'x')` throws `/name/`.
  - `templateSlug`: `'Bug'`→`'bug'`, `'Fonctionnalité'`→`'fonctionnalite'`, `'  !! '`→`'modele'`, `'a'.repeat(80)` has length 50, all results match `TEMPLATE_SLUG_RE`.
  - `sortTemplates`: `[{name:'B'},{name:'a',order:2},{name:'C',order:1}]` → names `['C','a','B']`.
  - `built-ins`: `BUILTIN_TEMPLATES.map(t => t.slug)` equals `['contexte','fonctionnalite','bug','refacto']`; each `serializeTemplate` re-parses to the same fields; the `contexte` description contains `### Contexte` and `### Critères d'acceptation`; `bug` has label `bug` and one subtask.
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/templates.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the shared types/functions and `templates.ts` as listed in Interfaces.
- [ ] **Step 4: Run** the same command plus `npx vitest run tests/main/tickets/format.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(tickets): add ticket template format and built-in templates`

---

### Task 2: Template storage in TicketStore

**Files:**
- Modify: `src/main/tickets/store.ts`
- Test: `tests/main/tickets/templateStore.test.ts` (same setup as `store.test.ts`: `createRepo({ dirName: 'canopy' })`, `new TicketStore()`)

**Interfaces:**
- Consumes: Task 1 (`parseTemplate`, `serializeTemplate`, `BUILTIN_TEMPLATES`, `templateSlug`, `sortTemplates`, types).
- Produces (methods on `TicketStore`):
  - `templates(repo: string): Promise<TemplateList>` — seeds built-ins when `.tickets/templates/` is missing (after `prepare`), lists `*.md` sorted with `sortTemplates`, unreadable files after the readable ones.
  - `saveTemplate(repo: string, slug: string | null, f: TemplateFields): Promise<TicketTemplate>` — `null` creates (slug from `templateSlug(f.name)`, suffix `-2`… using `writeNew`); otherwise rewrites that file atomically (throws `Modèle introuvable : <slug>` if missing). Key the serial chain `#templates`.
  - `deleteTemplate(repo: string, slug: string): Promise<void>`
  - `setDefaultTemplate(repo: string, slug: string): Promise<void>` — throws `Modèle introuvable` when the file does not exist.
- Changes `Config` to `{ prefix: string; next: number; defaultTemplate?: string }`; every `config.json` write (`setPrefix`, `create`, `setDefaultTemplate`) merges into the parsed file instead of replacing it. `config()` return type unchanged for the renderer (`prefix`, `next`).
- `guard` also checks `.tickets/templates` is a real directory inside the repo.

- [ ] **Step 1: Write the failing tests:**
  - `seeds the built-in templates once`: first `templates()` → 4 entries, `defaultSlug: 'contexte'`, files exist; `deleteTemplate('bug')` then `templates()` → 3 entries, no `bug.md`.
  - `does not seed when the folder exists empty`: `mkdir .tickets/templates` → `templates()` returns `{ entries: [], defaultSlug: null }`.
  - `creates bug-2 when bug exists and keeps the slug on rename`: `saveTemplate(null, {name:'bug!',…})` → slug `bug-2`; `saveTemplate('bug-2', {name:'Autre',…})` → slug `bug-2`, file `bug-2.md` holds `name: Autre`.
  - `lists an unreadable template without touching it`: write `oops.md` = `'no front matter'` → entry `{ kind: 'unreadable', file: 'oops.md' }`, file content unchanged.
  - `falls back to the first template when the default is gone`: `setDefaultTemplate('bug')`, `deleteTemplate('bug')` → `defaultSlug: 'contexte'`.
  - `keeps defaultTemplate when the prefix changes or a ticket is created`: `setDefaultTemplate('refacto')`, `setPrefix('ABC')`, `create(fields())` → `templates()` `defaultSlug: 'refacto'`.
  - `setDefaultTemplate refuses an unknown slug`: rejects `/Modèle introuvable/`.
  - `refuses a tracked .tickets/templates`: commit a file under `.tickets/templates/` → `templates()` rejects `/suivi par git/` (existing guard message).
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/templateStore.test.ts` — expect FAIL (methods missing).
- [ ] **Step 3: Implement** the methods and the config merge.
- [ ] **Step 4: Run** `npx vitest run tests/main/tickets` — expect PASS (store tests unchanged).
- [ ] **Step 5: Commit** `feat(tickets): store ticket templates beside local tickets`

---

### Task 3: IPC, preload, API and watch

**Files:**
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/tickets/ticketIpc.ts`, `src/main/tickets/watch.ts` (only if the test below fails)
- Modify: `src/main/tickets/templates.ts` (validator)
- Test: `tests/main/tickets/templates.test.ts`, `tests/main/tickets/watch.test.ts`

**Interfaces:**
- Consumes: Task 2 methods.
- Produces in `CanopyApi` (preload channel in parentheses):
  - `ticketTemplates(repo: string): Promise<TemplateList>` (`tickets:templates`)
  - `saveTicketTemplate(repo: string, slug: string | null, fields: TemplateFields): Promise<TicketTemplate>` (`tickets:saveTemplate`)
  - `deleteTicketTemplate(repo: string, slug: string): Promise<void>` (`tickets:deleteTemplate`)
  - `setDefaultTicketTemplate(repo: string, slug: string): Promise<void>` (`tickets:setDefaultTemplate`)
- Produces in `templates.ts`: `parseTemplateFields(raw: unknown): TemplateFields` and `assertTemplateSlug(s: unknown): asserts s is string` (throws `Modèle invalide`). Unknown keys refused, like `parseFields`; `order` must be a finite integer when present.
- Template changes reuse the existing `tickets:changed` event: no new event.

- [ ] **Step 1: Write the failing tests:**
  - `refuses a slug that is not a-z0-9-`: `assertTemplateSlug` throws for `'../x'`, `'Bug'`, `''`, `'a'.repeat(51)`, `3`; passes for `'bug-2'`.
  - `parseTemplateFields`: throws for empty `name`, `name` of 51 chars, unknown key `slug`, `priority: 'x'`, `order: 1.5`, 21 labels; returns a clean copy for a valid object (subtasks keep only `title`/`done`).
  - `watch.test.ts`, `fires when a template is written`: `mkdir .tickets/templates`, `watchTickets`, write `.tickets/templates/bug.md` → `calls >= 1`.
- [ ] **Step 2: Run** `npx vitest run tests/main/tickets/templates.test.ts tests/main/tickets/watch.test.ts` — expect FAIL. If the watch test passes already, keep it as a guard and skip the `watch.ts` change.
- [ ] **Step 3: Implement** the validators, the four `handle(...)` lines (each `assertPath(repo)` first, then slug/fields checks), the preload entries, the API declarations with short JSDoc. If the watch test failed, raise chokidar `depth` in `watchFolder` to 2.
- [ ] **Step 4: Run** `npx vitest run tests/main/tickets && npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(tickets): expose ticket templates over IPC`

---

### Task 4: Draft logic for applying a template

**Files:**
- Create: `src/renderer/tickets/templateDraft.ts`
- Test: `tests/renderer/templateDraft.test.ts`

**Interfaces:**
- Consumes: `TicketTemplate`, `TicketFields` from `src/shared/tickets.ts`.
- Produces:
  - `type DraftContent = Pick<TicketFields, 'description' | 'priority' | 'labels' | 'subtasks'>`
  - `templateContent(t: TicketTemplate | null): DraftContent` — `null` (« Aucun ») → `{ description: '', priority: 'none', labels: [], subtasks: [] }`; subtasks copied with `done: false`.
  - `applyTemplate<T extends TicketFields>(draft: T, t: TicketTemplate | null): T` — replaces the four fields, keeps `title` and every other field, sets `status: 'backlog'`.
  - `isUntouched(draft: TicketFields, applied: DraftContent): boolean` — deep-equal on the four fields (priority counts: a changed priority is an edit, my call).

- [ ] **Step 1: Write the failing tests:** `applyTemplate` keeps a typed title and sets the template's description/labels/priority/subtasks; `applyTemplate(d, null)` empties them; `isUntouched` is true right after `applyTemplate`, false after editing the description, a label, the priority, or ticking a subtask.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/templateDraft.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `templateDraft.ts`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(tickets): apply a template to a ticket draft`

---

### Task 5: Template selector in the new-ticket draft

**Files:**
- Modify: `src/renderer/tickets/TicketEditor.tsx`, `src/renderer/tickets/tickets.css`
- Test: `tests/e2e/ticket-templates.spec.ts` (copy `launch`/`beforeEach`/`afterEach` helpers from `tests/e2e/tickets.spec.ts`)

**Interfaces:**
- Consumes: Task 3 `window.canopy.ticketTemplates`, Task 4 functions.
- Produces: in the draft (`props.id === 'new'` and `idRef.current === null`), a `<select aria-label="Modèle">` listing readable templates in order then « Aucun » (value `''`), initialised to `defaultSlug`, and a button « Gérer les modèles… » that opens the templates screen (Task 6 wires it; here it calls an `onManageTemplates` prop that Task 6 provides — until then hide the button).
- Behaviour: on open, load templates and `show(applyTemplate(DRAFT, defaultTemplate))`, remembering `applied = templateContent(t)`. On change: if `isUntouched(local.current, applied)` apply directly, else `window.confirm('Remplacer le contenu par le modèle « X » ? Ce que tu as écrit sera perdu.')` (« Aucun » for null) and apply only on OK. Apply goes through `show()` so the draft saver sees it; nothing is written to disk without a title (existing `draftToCreate` rule). Use the existing confirm mechanism of the editor if it has one instead of `window.confirm`.
- Hidden once the draft gets an id.

- [ ] **Step 1: Write the failing e2e tests** in `ticket-templates.spec.ts`:
  - `new ticket starts from the default template`: click « + Nouveau ticket » → description field contains `### Contexte`; select « Modèle » shows « Contexte ».
  - `switching template without edits replaces silently`: select « Bug » → description contains `### Étapes pour reproduire`, label `bug` visible, no dialog.
  - `switching template after an edit asks first`: type in description, select « Refacto », dismiss dialog → typed text still there; select again, accept → description contains `### Problème actuel`.
  - `selector disappears once the ticket has a title`: type a title → after save, `.tickets/REP-1.md` contains `### Contexte` and the « Modèle » select is gone.
  - `Aucun gives an empty ticket`: select « Aucun » → description empty.
- [ ] **Step 2: Run** `npm run build && npx playwright test tests/e2e/ticket-templates.spec.ts` — expect FAIL (no « Modèle » select).
- [ ] **Step 3: Implement** the selector in `TicketEditor.tsx` and its styles.
- [ ] **Step 4: Run** the same command and `npx playwright test tests/e2e/tickets.spec.ts` — expect PASS (existing ticket specs that assume an empty draft description may need updating to select « Aucun » or to expect the template text; adapt them, do not weaken assertions).
- [ ] **Step 5: Commit** `feat(tickets): pick a template when creating a ticket`

---

### Task 6: « Modèles de tickets » screen

**Files:**
- Create: `src/renderer/tickets/TemplatesDialog.tsx`
- Modify: `src/renderer/shell/Settings.tsx`, `src/renderer/tickets/TicketEditor.tsx` (wire « Gérer les modèles… »), `src/renderer/store.ts` (only if a flag is needed to open the dialog from the editor), `src/renderer/tickets/tickets.css`, `CLAUDE.md` (Tickets bullet: « modèles dans `.tickets/templates/` »)
- Test: `tests/e2e/ticket-templates.spec.ts`

**Interfaces:**
- Consumes: Task 3 API; `useModal` (`src/renderer/shell/useModal.ts`); `createSaver` from `editorSave.ts` for the debounced autosave (500 ms like the editor); `applyFormat` from `descriptionTools.ts` for the description toolbar.
- Produces: `export function TemplatesDialog({ repo, onClose }: { repo: string; onClose: () => void }): React.JSX.Element`, `role="dialog"`, `aria-label="Modèles de tickets"`.
- Layout per spec §4: left list (name, badge « Par défaut », buttons « + Nouveau modèle », « Dupliquer », « Supprimer » with confirm « Supprimer le modèle « X » ? », « Définir par défaut », « Monter », « Descendre »), right editor (Nom, Description, Étiquettes, Priorité, Sous-tâches). Unreadable files listed with their error, not editable. Reorder rewrites `order` 1..n on every readable template. Reloads on `tickets:changed` for this repo. Errors shown in `role="alert"`.
- Settings: in the existing « Tickets » block, a button « Modèles de tickets… » that opens the dialog (Settings stays open underneath or closes — builder's call, keep `useModal` stacking working).

- [ ] **Step 1: Write the failing e2e tests:**
  - `edits a template and uses it`: open Réglages → « Modèles de tickets… » → select « Bug », change description to `### Reproduction\nTODO` → wait for `.tickets/templates/bug.md` to contain `### Reproduction`; close, « + Nouveau ticket », select « Bug » → description contains `### Reproduction`.
  - `creates a template and makes it the default`: « + Nouveau modèle », name `Spike`, « Définir par défaut » → `.tickets/templates/spike.md` exists, `config.json` has `"defaultTemplate": "spike"`; new ticket starts with « Spike » selected.
  - `deletes a template`: « Supprimer » on « Refacto », confirm → file gone, absent from the draft selector.
  - `opens from the draft`: « Gérer les modèles… » in a new ticket opens the dialog.
- [ ] **Step 2: Run** `npm run build && npx playwright test tests/e2e/ticket-templates.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** `TemplatesDialog.tsx`, the Settings button, the editor link, the CLAUDE.md line.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run test:e2e` — expect all PASS.
- [ ] **Step 5: Commit** `feat(tickets): manage ticket templates in a dedicated screen` (CLAUDE.md change in a separate `docs: document ticket templates` commit)
