# Vérification des dépendances — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canopy vérifie en continu les dépendances (JS, Ruby, Python) de chaque projet du sélecteur, signale en rouge les mises à jour critiques (faille haute/critique, version plus maintenue) et lance Claude sur une sélection.

**Architecture:** Process principal : `src/main/deps/` lit les lockfiles sur la branche de base (après un `git fetch` non interactif), interroge OSV et les registres publics derrière une interface `Http` injectable, calcule un `DepsReport` par dépôt, le persiste et émet `deps:changed`. Les règles de criticité et le prompt sont des fonctions pures dans `src/shared/deps.ts`. Renderer : store Zustand `depsStore`, onglet « Dépendances », bandeau, icône du sélecteur. Le lancement réutilise `startTicketBranch` et une partie « Où lancer » extraite de `LaunchPanel`.

**Tech Stack:** Electron 45, TypeScript strict, React 19, Zustand, Vitest, Playwright, `yaml` (déjà présent), `smol-toml` (nouveau, pur JS).

**Spec:** `docs/superpowers/specs/2026-11-09-dependency-check-design.md`

## Global Constraints

- Textes visibles en français avec « » ; code, identifiants et commentaires en anglais. 2 espaces, quotes simples, pas de point-virgule.
- TDD : chaque étape de code est précédée d'un test qui échoue pour la bonne raison.
- Spawn uniquement `git` via `git()` de `src/main/git/exec.ts` (tableau d'arguments). Aucun nouveau binaire, donc rien à ajouter en `asarUnpack`.
- Le renderer n'accède au réseau et au disque que via `window.canopy`.
- Tout `repo` reçu par IPC est un chemin absolu (`assertPath` comme `ticketIpc.ts`) ramené à `mainWorktreeRoot`.
- Jamais envoyer à OSV ni aux registres le nom d'une dépendance privée ou locale (spec, « Périmètre analysé »).
- Seuils : rouge dès la gravité `high` ; sans étiquette, CVSS ≥ 9 = `critical`, ≥ 7 = `high`, ≥ 4 = `moderate`, sinon `low` ; sans étiquette ni score = `unknown` (orange). `MAJORS_BEHIND = 2`, `STALE_YEARS = 2`, `CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`.
- Hôtes : `https://api.osv.dev`, `https://registry.npmjs.org`, `https://rubygems.org`, `https://pypi.org`.
- Commits en Conventional Commits, scope `deps`. Pas de commit de `out/`, `.superpowers/`, etc.

## Review Focus

1. **Lockfile illisible ou au format inattendu** (yarn berry, lockfile npm v1, `requirements.txt` avec `-r`/`-e`/marqueurs d'environnement) : l'unité est signalée en erreur dans le rapport (« Fichier illisible : <chemin> »), le reste du dépôt est vérifié. Testé dans les tâches 2 et 3 (`returns an error unit for a corrupt lockfile`).
2. **Un registre répond 404, 429 ou expire pour un paquet** : ce paquet garde son entrée du rapport précédent et le rapport porte l'erreur. Aucun paquet n'apparaît ou ne disparaît à cause d'une erreur réseau. Testé en tâche 6 (`keeps the previous entry when a lookup fails`).
3. **Dépôt sans remote ni branche de base distante** : pas de fetch, lecture de la base locale, aucune erreur affichée. Testé en tâche 4 (`skips the fetch without a remote`).
4. **Gros dépôt, des centaines de dépendances** : requêtes OSV par lots de 1000 max (`querybatch`), concurrence registre bornée à 6, et un seul dépôt vérifié à la fois. Testé en tâche 5 (`splits OSV queries in batches of 1000`) et en tâche 7 (`checks repos one after another`).
5. **Le projet affiché change pendant une vérification** : le résultat est rangé sous son dépôt, jamais sous le dépôt affiché. Le bandeau ne montre que le dépôt affiché. Testé en tâche 10 (`banner follows the displayed repo`).

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/shared/deps.ts` | types, classification, CVSS 3.x, textes « pourquoi », prompt, nom de branche |
| `src/main/deps/parse/js.ts` | `package-lock.json` (v1–v3), `pnpm-lock.yaml`, `yarn.lock` (v1 et berry) |
| `src/main/deps/parse/ruby.ts` | `Gemfile.lock` |
| `src/main/deps/parse/python.ts` | `uv.lock`, `poetry.lock` (+ `pyproject.toml`), `Pipfile.lock`, `requirements*.txt` |
| `src/main/deps/source.ts` | fetch de la base, recherche et lecture des lockfiles via git, unités |
| `src/main/deps/http.ts` | interface `Http`, implémentation `fetch` avec délai |
| `src/main/deps/osv.ts` | failles via OSV |
| `src/main/deps/registries.ts` | npm, RubyGems, PyPI |
| `src/main/deps/check.ts` | assemble un `DepsReport` pour un dépôt |
| `src/main/deps/service.ts` | planification, persistance, bandeau fermé, événements |
| `src/main/deps/replay.ts` | `Http` factice pour `CANOPY_FAKE_DEPS` |
| `src/main/deps/depsIpc.ts` | handlers IPC et lancement |
| `src/renderer/deps/*` | store, écran, bandeau, dialogue de lancement, styles |
| `src/renderer/tickets/LaunchWhere.tsx` | partie « Où lancer » extraite de `LaunchPanel` |
| `tests/fixtures/deps/` | réponses OSV/registres capturées pour E2E |

---

### Task 1: Types et règles partagées

**Files:**
- Create: `src/shared/deps.ts`
- Test: `tests/main/deps/rules.test.ts` (Vitest n'inclut que `tests/main`, `tests/renderer` et `tests/scripts`)

**Interfaces:**
- Produces:
```ts
export type Ecosystem = 'npm' | 'RubyGems' | 'PyPI'
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'
export type Level = 'critical' | 'soon' | 'later'          // Critique / À prévoir / Peut attendre
/** A dependency as read from a lockfile. `private`: never sent to any service. */
export interface Dep { ecosystem: Ecosystem; name: string; version: string | null; manifest: string; private: boolean; via?: string[] }
export interface Advisory { id: string; package: string; severity: Severity; summary: string; fixed: string | null; url: string }
export interface PackageInfo { latest: string | null; deprecated: string | null; yanked: boolean; inactive: boolean; lastRelease: string | null }
export interface DepEntry {
  key: string                                // `${ecosystem}:${manifest}:${name}`
  ecosystem: Ecosystem; name: string; manifest: string
  installed: string | null; target: string | null
  level: Level | 'private' | 'pinless'       // pinless: requirements line without ==
  reason: string                             // French, shown as is
  advisories: Advisory[]; registryUrl: string | null
}
export interface DepsReport {
  repo: string; checkedAt: number | null; entries: DepEntry[]
  errors: string[]                           // French, shown under the table
  baseRef: string | null; manifests: number  // 0: « Aucun fichier de dépendances reconnu »
}
export const MAJORS_BEHIND = 2
export const STALE_YEARS = 2
export function severityFromCvss(vector: string): Severity                 // CVSS:3.0/3.1 only; anything else 'unknown'
export function depKey(d: Pick<Dep, 'ecosystem' | 'manifest' | 'name'>): string
export function classify(d: Dep, advisories: Advisory[], info: PackageInfo | null, now: number): DepEntry | null  // null: up to date
export function criticalKeys(r: DepsReport): string[]
export function defaultDepsBranch(entries: DepEntry[], today: Date): string
export function depsLaunchPrompt(entries: DepEntry[]): string
```

- [ ] **Step 1: Write the failing tests** in `tests/main/deps/rules.test.ts`:
  - `severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')` → `'critical'` (9.8) ; `'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H'` → `'high'` (7.5) ; `'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N'` → `'low'` (3.1) ; `'CVSS:4.0/AV:N/…'` → `'unknown'`.
  - `classify` : une faille `high` → `level: 'critical'`, `reason` commence par `'Faille haute'` ; `info.deprecated = 'use foo'` → `'critical'`, reason `'Déprécié : use foo'` ; `info.yanked` → `'critical'`, `'Version retirée par l\'auteur'` ; `inactive` (statut PyPI) → `'critical'`, `'Projet déclaré inactif'` ; faille `moderate` → `'soon'` ; faille `unknown` → `'soon'`, `'Faille de gravité inconnue'` ; `installed 3.0.0, latest 5.1.0` → `'soon'`, `'2 versions majeures de retard'` ; `lastRelease` à plus de 2 ans de `now` → `'soon'`, `'Aucune publication depuis 2023'` ; `installed 5.0.1, latest 5.0.8` → `'later'`, `'Correctifs disponibles'` ; à jour et rien d'autre → `null` ; `private: true` → `level 'private'`, `'Source privée ou locale : non vérifiée'` ; `version: null` → `'pinless'`, `'Version non épinglée'`.
  - Raison la plus grave seulement : faille `critical` + déprécié → reason de la faille critique.
  - `target` : dernière version stable, sauf faille dont `fixed` est dans la même majeure que l'installée → `fixed`.
  - Faille arrivée via une transitive (`advisory.package !== d.name`) → reason `'Faille critique dans minimist (via mkdirp)'`.
  - `defaultDepsBranch` : sélection avec une faille → `'fix/deps-2026-11-09'`, sinon `'chore/deps-2026-11-09'`.
  - `depsLaunchPrompt` contient, pour chaque entrée, écosystème, `manifest`, `installed → target`, la raison, les ids d'avis, et la consigne (outil du projet, corriger, tester, signaler plutôt que forcer une majeure risquée, préparer la PR).
- [ ] **Step 2:** `npx vitest run tests/main/deps/rules.test.ts` → FAIL, module introuvable.
- [ ] **Step 3: Implement** `src/shared/deps.ts`. CVSS 3.x : formule de base officielle (FIRST, section 7.1, avec `roundup`). Comparaison de versions : segments numériques (`/\d+/g`), suffisant pour npm, gems et PEP 440 courants. Ordre de gravité des raisons : faille critique > faille haute > déprécié > retirée > inactif > faille modérée/faible/inconnue > majeures de retard > inactivité > correctifs.
- [ ] **Step 4:** même commande → PASS. `npm run typecheck` → OK.
- [ ] **Step 5: Commit** `feat(deps): classify dependency updates by criticality`

---

### Task 2: Parseurs JavaScript

**Files:**
- Create: `src/main/deps/parse/js.ts`
- Test: `tests/main/deps/parse/js.test.ts`

**Interfaces:**
- Consumes: `Dep` (Task 1).
- Produces:
```ts
/** `files` maps repo-relative paths of one directory's manifest/lockfile to their text. */
export interface Unit { dir: string; ecosystem: Ecosystem; deps: Dep[]; transitive: Dep[]; error?: string }
export function parsePackageLock(dir: string, lockText: string): Unit
export function parsePnpmLock(dir: string, pkgJson: string, lockText: string): Unit
export function parseYarnLock(dir: string, pkgJson: string, lockText: string): Unit
```
`deps` = directes, `transitive` = les autres paquets publics du lockfile avec `via` = chaîne des directes qui les amènent (npm seulement ; vide pour pnpm et yarn).

- [ ] **Step 1: Write the failing tests** (lockfiles écrits en ligne dans le test) :
  - `package-lock` v3 : directes lues dans `packages[""]` (`dependencies` + `devDependencies` + `optionalDependencies`) et dans chaque entrée sans `node_modules/` (workspaces) ; version prise de `packages["node_modules/<nom>"]` ; `manifest` = `<dir>/package.json`.
  - transitive : `a → b → minimist` produit `minimist` avec `via: ['a']`.
  - `resolved` hors `https://registry.npmjs.org/`, ou `link: true`, ou version commençant par `file:`/`git+` → `private: true`.
  - lockfile v1 (`dependencies` imbriquées) lu aussi.
  - `pnpm-lock.yaml` v9 : `importers['.'].dependencies[nom].version` ; `link:`/`file:` → privé.
  - `yarn.lock` v1 (format texte) et berry (YAML, clé `"nom@npm:^1.0.0"`) : version de la directe trouvée par son descripteur dans `package.json` ; `workspace:`/`portal:`/`patch:` → privé.
  - `returns an error unit for a corrupt lockfile` : JSON invalide → `{ deps: [], error: 'Fichier illisible : package-lock.json' }`.
- [ ] **Step 2:** `npx vitest run tests/main/deps/parse/js.test.ts` → FAIL.
- [ ] **Step 3: Implement.** YAML via `yaml` (`parse`). Le parseur `yarn.lock` v1 est écrit à la main : blocs « en-tête non indenté terminé par `:` » + ligne `version "x"`.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(deps): read JavaScript lockfiles`

---

### Task 3: Parseurs Ruby et Python

**Files:**
- Create: `src/main/deps/parse/ruby.ts`, `src/main/deps/parse/python.ts`
- Modify: `package.json` (ajout `smol-toml`)
- Test: `tests/main/deps/parse/ruby.test.ts`, `tests/main/deps/parse/python.test.ts`

**Interfaces:**
- Consumes: `Unit` (Task 2), `Dep`.
- Produces:
```ts
export function parseGemfileLock(dir: string, lockText: string): Unit
export function parseUvLock(dir: string, lockText: string): Unit
export function parsePoetryLock(dir: string, pyproject: string | null, lockText: string): Unit
export function parsePipfileLock(dir: string, lockText: string): Unit
export function parseRequirements(dir: string, file: string, text: string): Unit
```

- [ ] **Step 1: Write the failing tests:**
  - `Gemfile.lock` : directes = section `DEPENDENCIES` (`rails (~> 7.1)` → `rails`, `!` final retiré) ; versions dans `specs:` des blocs `GEM` ; gem d'un bloc `GIT`/`PATH`, ou d'un `GEM` dont `remote:` n'est pas `https://rubygems.org/` → privé ; transitives avec `via` à partir des sous-dépendances indentées (6 espaces) ; `manifest` = `<dir>/Gemfile`.
  - `uv.lock` : directes = `dependencies` du `[[package]]` dont `source = { editable = "." }` ou `virtual = "."` ; `source.registry` différent de `https://pypi.org/simple` → privé.
  - `poetry.lock` : directes = clés de `[tool.poetry.dependencies]` et `[project].dependencies` du `pyproject.toml` (sans `python`) ; `[package.source]` présent avec un type autre que `legacy` pointant sur PyPI → privé.
  - `Pipfile.lock` : `default` + `develop`, `"==1.2.3"` → `1.2.3` ; `index` différent de `pypi` (selon `_meta.sources`) → privé.
  - `requirements*.txt` : `nom==1.2` épinglé ; `nom>=1` → `version: null` ; lignes `-r`, `-e`, `git+`, URL, chemins ignorées sauf `-e`/URL listées en privé ; `--index-url` autre que PyPI rend **tout le fichier** privé ; marqueurs `; python_version<"3.9"` retirés ; noms normalisés PEP 503 (`Foo_Bar` → `foo-bar`).
  - `returns an error unit for a corrupt lockfile` pour TOML invalide.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.** `npm install smol-toml` (dépendance de prod, pur JS). TOML via `parse` de `smol-toml`.
- [ ] **Step 4:** → PASS ; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(deps): read Ruby and Python lockfiles`

---

### Task 4: Lecture sur la branche de base

**Files:**
- Create: `src/main/deps/source.ts`
- Modify: `src/main/git/exec.ts` (ajout `env?: NodeJS.ProcessEnv` et `timeoutMs?: number` à `GitOptions`, transmis à `execFile`)
- Test: `tests/main/deps/source.test.ts`, `tests/main/git/exec.test.ts` (cas `env` et `timeoutMs`)

**Interfaces:**
- Consumes: parseurs des tâches 2–3, `cachedBaseRef`, `git`.
- Produces:
```ts
export interface Inventory { repo: string; baseRef: string | null; units: Unit[]; notes: string[] }  // notes: French, e.g. fetch failure
/** Fetches the base branch non-interactively, then reads every recognized lockfile at it. */
export async function readInventory(repo: string, o?: { fetch?: boolean; fetchTimeoutMs?: number }): Promise<Inventory>
export const EXCLUDED_DIRS: string[]   // ['node_modules', 'vendor', '.venv', '.worktrees']
```

- [ ] **Step 1: Write the failing tests** (vrais repos, `tests/helpers/repo.ts`, avec `remote: true` quand utile) :
  - lit `package-lock.json` et `Gemfile.lock` commités sur la base, y compris dans un sous-dossier ; ignore `node_modules/x/package-lock.json` et `.worktrees/…`.
  - lit la **base**, pas le checkout : un `package-lock.json` modifié non commité dans le checkout principal n'est pas vu.
  - fetch : un commit poussé sur le remote par un autre clone est vu après `readInventory`.
  - `skips the fetch without a remote` : dépôt sans remote → base locale lue, `notes` vide.
  - fetch en échec (URL de remote invalide) → lecture de la ref existante, `notes = ['Branche de base non rafraîchie : …']`.
  - pas de lockfile → `units: []`.
  - Priorité Python dans un même dossier : `uv.lock` > `poetry.lock` > `Pipfile.lock` > `requirements*.txt`. Priorité JS : `package-lock.json` > `pnpm-lock.yaml` > `yarn.lock`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.** `git fetch --quiet --no-tags <remote> <branche>` avec `env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }` et `timeoutMs: 30_000`, uniquement si `baseRef.ref` est distant (`origin/…`). Liste : `git ls-tree -r --name-only <ref>` filtré par nom de fichier. Lecture : `git show <ref>:<chemin>`.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(deps): read lockfiles from the fetched base branch`

---

### Task 5: Clients réseau et rejeu

**Files:**
- Create: `src/main/deps/http.ts`, `src/main/deps/osv.ts`, `src/main/deps/registries.ts`, `src/main/deps/replay.ts`, `tests/fixtures/deps/README.md` et fixtures JSON
- Test: `tests/main/deps/osv.test.ts`, `tests/main/deps/registries.test.ts`, `tests/main/deps/replay.test.ts`

**Interfaces:**
- Consumes: `Dep`, `Advisory`, `PackageInfo`, `severityFromCvss`.
- Produces:
```ts
export interface Http { getJson(url: string, headers?: Record<string, string>): Promise<unknown>; postJson(url: string, body: unknown): Promise<unknown> }
export function fetchHttp(timeoutMs?: number): Http          // throws HttpError { status } on non-2xx
export class HttpError extends Error { constructor(readonly status: number, url: string) }
export async function advisoriesFor(http: Http, deps: Dep[]): Promise<Map<string /*depKey of queried dep*/, Advisory[]>>
export async function packageInfo(http: Http, d: Dep): Promise<PackageInfo>
export function replayHttp(dir: string): Http                // reads `<dir>/<host>/<path>.json`; missing file → HttpError 404
export function selectDepsHttp(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): Http
```

- [ ] **Step 1: Write the failing tests** (`Http` simulé en mémoire) :
  - `advisoriesFor` ne reçoit jamais un dep `private` ni sans version (assert sur les corps postés).
  - `splits OSV queries in batches of 1000` : 1500 deps → 2 `postJson('https://api.osv.dev/v1/querybatch', …)`.
  - Chaque id renvoyé est détaillé une fois par `GET /v1/vulns/<id>`, même partagé par plusieurs paquets. Gravité : `database_specific.severity` (`CRITICAL`/`HIGH`/`MODERATE`/`MEDIUM`/`LOW`), sinon vecteur `severity[].score` de type `CVSS_V3`, sinon `'unknown'`. `fixed` = premier événement `fixed` de la plage qui couvre la version. `url` = `https://osv.dev/vulnerability/<id>`.
  - `packageInfo` npm : `GET https://registry.npmjs.org/<nom encodé>` avec `Accept: application/vnd.npm.install-v1+json` ; `latest` = `dist-tags.latest` ; `deprecated` = `versions[installed].deprecated` ; `lastRelease` = `modified` ; nom scopé encodé `@scope%2fname`.
  - RubyGems : `GET https://rubygems.org/api/v1/versions/<gem>.json` ; `latest` = première non `prerelease` ; installée absente de la liste → `yanked` ; `lastRelease` = `created_at` le plus récent.
  - PyPI : `GET https://pypi.org/pypi/<nom>/json` ; `latest` = `info.version` ; tous les fichiers de `releases[installed]` `yanked` → `yanked` ; classifier `Development Status :: 7 - Inactive` → `inactive` ; `lastRelease` = `upload_time_iso_8601` max.
  - Concurrence registre ≤ 6 (compteur dans le faux `Http`).
  - `replayHttp` relit `tests/fixtures/deps/registry.npmjs.org/left-pad.json` ; `selectDepsHttp` renvoie `fetchHttp` si `isPackaged` même avec `CANOPY_FAKE_DEPS`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.** `packageInfo` garde en mémoire chaque réponse de registre 6 h (clé = URL), ce qui évite de tout redemander entre deux dépôts qui partagent des paquets. Pas de cache disque : les rapports persistés (Task 7) suffisent à afficher l'état au démarrage. `fetchHttp` utilise `fetch` global + `AbortSignal.timeout(timeoutMs ?? 15_000)` et un `User-Agent: Canopy`. Fixtures : un projet exemple (voir Task 12) avec `tar 6.1.11` (faille critique), `request 2.88.2` (déprécié), `electron 33.2.0` (majeures de retard), `zustand 5.0.1` (correctifs) ; `README.md` explique la disposition des fichiers.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(deps): query OSV and package registries`

---

### Task 6: Assemblage d'un rapport

**Files:**
- Create: `src/main/deps/check.ts`
- Test: `tests/main/deps/check.test.ts`

**Interfaces:**
- Consumes: `readInventory`, `advisoriesFor`, `packageInfo`, `classify`.
- Produces:
```ts
export interface CheckDeps { http: Http; now: () => number; inventory?: typeof readInventory }
export async function checkRepo(deps: CheckDeps, repo: string, previous: DepsReport | null): Promise<DepsReport>
```

- [ ] **Step 1: Write the failing tests** (`inventory` et `http` simulés) :
  - Une faille sur une transitive npm est rattachée à la directe de `via[0]`. La directe passe en `critical` avec la raison de la tâche 1.
  - Entrées triées : `critical`, `soon`, `later`, `pinless`, `private`, puis par nom.
  - `keeps the previous entry when a lookup fails` : `packageInfo` en erreur pour `lodash` → l'entrée de `previous` pour cette clé est conservée telle quelle, et `errors` contient `'npm : lodash non vérifié (HTTP 429)'`.
  - OSV entièrement en échec → toutes les entrées de `previous` gardent leurs avis, `errors` contient `'Failles non vérifiées : …'`, et aucune entrée ne perd son niveau `critical`.
  - Erreurs d'unité (fichier illisible) et `notes` de l'inventaire recopiées dans `errors`.
  - `manifests` = nombre d'unités ; `baseRef` recopié ; `checkedAt = now()`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(deps): build a dependency report per repo`

---

### Task 7: Service : planification, persistance, bandeau

**Files:**
- Create: `src/main/deps/service.ts`
- Test: `tests/main/deps/service.test.ts`

**Interfaces:**
- Consumes: `checkRepo`, `criticalKeys`.
- Produces:
```ts
export interface DepsServiceDeps {
  check: (repo: string, previous: DepsReport | null) => Promise<DepsReport>
  /** Repos to watch: every git repo behind the picker's recent entries (a folder answers for the repos it holds). */
  repos: () => Promise<{ entry: string; repos: string[] }[]>
  file: string                      // userData/deps-reports.json
  now: () => number
  setInterval: typeof setInterval
  broadcast: (event: string, payload: unknown) => void
}
export interface DepsService {
  start(): void                     // loads the file, broadcasts nothing, checks every repo, then every CHECK_INTERVAL_MS
  report(repo: string): DepsReport | null
  recheck(repo: string): Promise<DepsReport>
  /** Critical count of `path` (an entry or a repo), without `except` and its own repos. */
  critical(path: string, except?: string): number
  /** Whether the banner shows for `repo`: some critical key not in the dismissed set. */
  bannerFor(repo: string): boolean
  dismissBanner(repo: string): void // stores the current critical keys
  checking(repo: string): boolean
}
export const CHECK_INTERVAL_MS: number
export function createDepsService(d: DepsServiceDeps): DepsService
```
Fichier : `{ version: 1, reports: Record<repo, DepsReport>, dismissed: Record<repo, string[]> }`, écrit de façon atomique (tmp + rename, comme les autres fichiers de `userData`).

- [ ] **Step 1: Write the failing tests:**
  - `checks repos one after another` : jamais deux `check` en cours ; tous les dépôts des entrées sont vérifiés.
  - Après `CHECK_INTERVAL_MS`, tous revérifiés ; `recheck` pendant un passage n'en lance pas un second pour ce dépôt (même promesse).
  - Chaque rapport stocké émet `broadcast('deps:changed', { repo })`.
  - Rapports relus du fichier au `start()`, avant toute vérification ; fichier corrompu → ignoré, jamais réécrit avant un nouveau rapport.
  - `critical(entry)` additionne les dépôts de l'entrée ; `critical(entry, except)` exclut `except`.
  - `bannerFor` : vrai avec une critique ; faux après `dismissBanner` ; redevient vrai si une **nouvelle** clé critique apparaît ; reste faux si une critique disparaît.
  - Un dépôt retiré des entrées n'est plus vérifié, et son rapport est oublié.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(deps): check every recent repo in the background`

---

### Task 8: IPC, preload et câblage

**Files:**
- Create: `src/main/deps/depsIpc.ts`
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/index.ts`
- Test: `tests/main/deps/depsIpc.test.ts`

**Interfaces:**
- Consumes: `DepsService`, `startTicketBranch`, `LaunchDeps`, `findRepos` (`src/main/workspace.ts`), `store.recentRepos`.
- Produces (dans `CanopyApi`) :
```ts
/** The last report of the repo holding `repo` (main root); null before its first check. */
depsReport(repo: string): Promise<DepsReport | null>
depsRecheck(repo: string): Promise<DepsReport>
/** Critical dependencies in `path` (a recent entry or a repo), without `except`. */
depsCritical(path: string, except?: string): Promise<number>
depsBanner(repo: string): Promise<boolean>
depsDismissBanner(repo: string): Promise<void>
/** Starts `req.branch` like a ticket launch; nothing is written in the repo. */
depsLaunch(repo: string, req: { branch: string; target: LaunchTarget }): Promise<{ worktree: string }>
```
Événement `deps:changed` `{ repo }`.

- [ ] **Step 1: Write the failing tests** (handlers appelés directement via une fonction `handle` injectée, comme `registerLinearIpc`) :
  - chemin relatif ou non-chaîne → rejet `'Chemin invalide'` pour chaque méthode.
  - `depsLaunch` crée la branche dans un nouveau worktree d'un vrai repo ; nom de branche invalide → `'Nom de branche invalide : "…"'`.
  - `depsReport` d'un worktree renvoie le rapport du checkout principal.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement** `registerDepsIpc({ handle, service, launch })`. Dans `index.ts`, créer le service avec `check: (repo, prev) => checkRepo({ http: selectDepsHttp({ isPackaged: app.isPackaged, env: process.env }), now: Date.now }, repo, prev)`, `repos` à partir de `store.recentRepos` + `findRepos` pour les dossiers qui ne sont pas des dépôts, `file: join(app.getPath('userData'), 'deps-reports.json')`. Appeler `start()` après création de la fenêtre et `recheck` de tous les dépôts sur `powerMonitor 'resume'` (comme Linear). Les ajouts de dépôts récents déclenchent la vérification du nouveau dépôt.
- [ ] **Step 4:** → PASS ; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(deps): expose dependency reports to the window`

---

### Task 9: Extraire « Où lancer » de LaunchPanel

**Files:**
- Create: `src/renderer/tickets/LaunchWhere.tsx`
- Modify: `src/renderer/tickets/LaunchPanel.tsx`
- Test: `tests/e2e/tickets.spec.ts` doit rester vert sans modification. Si `tests/renderer/` contient des tests de `LaunchPanel`, ils restent verts.

**Interfaces:**
- Produces:
```ts
/** The « Où lancer » cards and the branch name field; reports the launch target, null while it cannot launch. */
export function LaunchWhere(props: {
  repo: string; refs: RepoRefs; branch: string; onBranch: (b: string) => void
  onTarget: (t: LaunchTarget | null) => void
}): React.JSX.Element
```

- [ ] **Step 1:** Refactor sans changement de comportement. Déplacer l'état `where`, `newBase`, `picked`, `baseEdit`, `candidates`, le chargement de `launchCandidates`, le calcul de `target`, `taken`, et le JSX de la section « Où lancer » et du champ de branche. `LaunchPanel` garde le ticket, les options et le bouton.
- [ ] **Step 2:** `npm run build && npx playwright test tests/e2e/tickets.spec.ts tests/e2e/linear.spec.ts` → PASS ; `npm run typecheck`.
- [ ] **Step 3: Commit** `refactor(tickets): extract the launch target picker`

---

### Task 10: Écran « Dépendances », bandeau, lancement

**Files:**
- Create: `src/renderer/deps/depsStore.ts`, `src/renderer/deps/DepsScreen.tsx`, `src/renderer/deps/DepsBanner.tsx`, `src/renderer/deps/DepsLaunchDialog.tsx`, `src/renderer/deps/deps.css`, `src/renderer/deps/depsModel.ts`
- Modify: `src/renderer/store.ts` (`View` += `'deps'`), `src/renderer/shell/Header.tsx`, `src/renderer/App.tsx`
- Test: `tests/renderer/deps/depsModel.test.ts`

**Interfaces:**
- Consumes: API de la tâche 8, `LaunchWhere`, `askClaude`, `defaultDepsBranch`, `depsLaunchPrompt`, `showLaunched` (à exporter de `launchFlow.ts`).
- Produces:
```ts
// depsModel.ts (pure)
export function initialSelection(entries: DepEntry[]): Set<string>           // keys of level 'critical'
export function bannerText(entries: DepEntry[], repoName: string): string    // spec wording, « … et N autres » past 3 names
export function levelLabel(l: DepEntry['level']): string                     // 'Critique' | 'À prévoir' | 'Peut attendre' | 'Non vérifiée' | 'Non épinglée'
export function lastCheckText(r: DepsReport, now: number): string            // « Dernière vérification : il y a 3 h »
```

- [ ] **Step 1: Write the failing tests** pour `depsModel.ts` :
  - `bannerText([tar faille critique, request déprécié], 'canopy')` → `'2 dépendances critiques dans canopy : faille critique dans tar, request n\'est plus maintenu'` ; 5 critiques → les 3 premières puis `' … et 2 autres'` ; 1 critique → singulier `'1 dépendance critique'`.
  - `initialSelection` ne coche ni `private` ni `pinless`.
- [ ] **Step 2:** `npx vitest run tests/renderer/deps` → FAIL.
- [ ] **Step 3: Implement.**
  - `depsStore` : `report`, `banner`, `checking` pour le dépôt affiché ; recharge sur `deps:changed` du dépôt affiché (comparaison sur la racine principale) et au changement de dépôt.
  - En-tête : onglet `Dépendances` après `Maquettes`, badge rouge (`.count.critical`, `background: var(--del)`) avec le nombre d'entrées `critical`.
  - `DepsBanner` sous l'en-tête dans `App.tsx`, sur toutes les vues : texte `bannerText`, bouton « Voir » (→ `setView('deps')`), croix (`aria-label="Fermer l'alerte"` → `depsDismissBanner`). `data-testid="deps-banner"`.
  - `DepsScreen` : tableau de la maquette A (cocher, paquet, fichier si plusieurs `manifest`, installée, cible, criticité, pourquoi). Liens avis/registre via l'ouverture externe existante. Case « tout cocher ». Pied : « N sélectionnées », « Revérifier » (désactivé pendant `checking`), « Lancer Claude sur la mise à jour » (désactivé si 0). Liste `errors` sous le tableau. États vides : « Tout est à jour » + `lastCheckText`, « Aucun fichier de dépendances reconnu », « Première vérification en cours… ».
  - `DepsLaunchDialog` (modale, `useModal`) : récapitulatif des paquets, `LaunchWhere` avec la branche `defaultDepsBranch(sélection, new Date())`, case « Démarrer Claude » cochée. Au lancement : `depsLaunch`, puis `showLaunched`, puis `askClaude(worktree, depsLaunchPrompt(sélection))`. Erreur affichée dans la modale.
- [ ] **Step 4:** → PASS ; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(deps): show outdated dependencies and launch Claude on a selection`

---

### Task 11: Icône dans le sélecteur de dépôt

**Files:**
- Modify: `src/renderer/shell/RepoPicker.tsx`, CSS associé
- Test: couvert par l'E2E de la tâche 12

**Interfaces:**
- Consumes: `depsCritical(path, except?)`, événement `deps:changed`.

- [ ] **Step 1: Implement**, à côté de `useAttention`, un `useDepsAlerts(repo, folder)` de même forme (`{ critical: Set<string>; elsewhere: boolean }`), rafraîchi sur `deps:changed`. Icône triangle rouge (`var(--del)`), `role="img"`. Dans la liste : `aria-label="Dépendances critiques à mettre à jour"`. Sur le bouton fermé : `aria-label="Dépendances critiques dans un autre dépôt"`, `data-testid="repo-deps-alert"`. Elle s'affiche à côté du badge d'attention existant, sans le remplacer.
- [ ] **Step 2:** `npm run typecheck`.
- [ ] **Step 3: Commit** `feat(deps): flag repos with critical updates in the repo picker`

---

### Task 12: E2E et documentation

**Files:**
- Create: `tests/e2e/deps.spec.ts`, `tests/helpers/fakeDeps.ts` (si utile)
- Modify: `CLAUDE.md` (variables `CANOPY_FAKE_DEPS`, module `src/main/deps/`, hôtes réseau), `docs/superpowers/specs/2026-11-09-dependency-check-design.md` (statut « validé »)

- [ ] **Step 1: Write the spec** (`CANOPY_FAKE_QUERY=1`, `CANOPY_FAKE_DEPS=tests/fixtures/deps`). Repo de test avec remote et un `package-lock.json` des 4 paquets de la tâche 5 commité sur `main` :
  - bandeau visible sur Sessions avec `2 dépendances critiques`, badge `2` sur l'onglet ;
  - « Voir » ouvre l'onglet ; `tar` et `request` cochés, `electron` et `zustand` non ;
  - croix → bandeau masqué, badge toujours `2` ; relance de l'app → bandeau toujours masqué ;
  - second repo critique dans `recentRepos` → `repo-deps-alert` visible sur le bouton du sélecteur ;
  - `banner follows the displayed repo` : changement de dépôt vers un repo sans critique → bandeau absent ;
  - « Lancer Claude sur la mise à jour » → modale, branche `fix/deps-<date>`, lancement → vue Sessions sur le nouveau worktree et premier message contenant `tar` et `request`.
- [ ] **Step 2:** `npm run test:e2e -- tests/e2e/deps.spec.ts` → PASS.
- [ ] **Step 3:** `npm run typecheck && npm test && npm run test:e2e` → tout vert.
- [ ] **Step 4: Commit** `test(deps): cover dependency alerts end to end`, puis `docs: document the dependency check in CLAUDE.md`.
