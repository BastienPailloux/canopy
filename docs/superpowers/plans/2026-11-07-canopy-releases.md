# Canopy Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un push sur `master` publie une version signée, notarisée et numérotée automatiquement en GitHub Release. Chaque Canopy installé la télécharge, l'annonce, l'installe au plus tard 24 h après, sans perdre de travail non enregistré, puis montre ce qui a changé.

**Architecture:** Côté CI, un script TypeScript sans dépendance (`scripts/release/`) calcule la version et les notes depuis les commits. Un workflow GitHub Actions build, signe et notarise avec electron-builder, puis crée tag et release en une seule fois à la fin, avec `gh release create`. Côté app, le process principal pilote `electron-updater` et un calendrier pur (échéance, avertissement). Le renderer affiche le bandeau, le compte à rebours et « Quoi de neuf ». Avant un redémarrage pour mise à jour, il fournit ce qui doit être mis de côté (fichiers non enregistrés, onglets de session, brouillons). Le process principal l'écrit dans `userData`, puis le rend au renderer au lancement suivant.

**Tech Stack:** Electron 45, electron-builder 26, `electron-updater` (nouvelle dépendance), GitHub Actions (`macos-15`, arm64), `gh` CLI, Node 24 (exécution directe des `.ts` par type stripping), vitest 5.

**Spec:** `docs/superpowers/specs/2026-11-07-releases-design.md`

## Global Constraints

- macOS arm64 uniquement. Cibles `dmg` et `zip`.
- Bundle ID `io.github.bastienpailloux.canopy`, nom `Canopy` (dossier de données `~/Library/Application Support/Canopy`).
- Tag `vX.Y.Z` = source de vérité. Aucun commit de retour sur `master`. `version` de `package.json` injectée en CI seulement.
- Règles de version : `fix`/`perf` → patch, `feat` → minor, `!` ou `BREAKING CHANGE:` → major, sinon pas de release. Aucun tag existant → `v1.0.0` avec la note « Première version ».
- Release déclenchée uniquement par `push` sur `master`. Tag et release créés seulement si typecheck, tests, build, signature et notarisation ont réussi.
- Secrets Apple dans l'Environment GitHub `release` (branche `master` seulement) : `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Jamais présents pendant `npm ci`.
- Updater désactivé si `!app.isPackaged` ou en mode test caché (`hiddenWindow`).
- Vérification au lancement puis toutes les 4 h. Échéance = fin du premier téléchargement + 24 h. Avertissement 10 min avant, toujours 10 min pleines même après une veille. Une version plus récente ne repousse pas l'échéance.
- Fichiers non enregistrés : jamais écrits sur le disque par la mise à jour.
- Interface en français, style de `theme.css` (accent `#A78BFA`, attention `#E3B341`).

## Review Focus

1. Le Mac dort pendant l'échéance : au réveil, avertissement de 10 minutes pleines, pas de redémarrage immédiat (Task 4, test `sleep past deadline`).
2. Le renderer a planté ou ne répond pas quand le redémarrage forcé arrive : la mise à jour s'installe quand même après 5 s, sans mise de côté, plutôt que de rester bloquée (Task 7, test `stash timeout`).
3. Un fichier mis de côté a été supprimé ou modifié sur le disque avant la restauration : rien n'est écrasé, les modifications restent visibles et récupérables (Task 8, tests `restored draft over changed file` / `deleted file`).
4. Fichier de mise de côté corrompu, ou d'une version future au format inconnu : il est ignoré et supprimé, le lancement continue (Task 6, test `corrupt stash`).
5. Merge `develop` → `master` qui ne contient que des `chore:`/`docs:` : le workflow se termine vert sans tag ni release (Task 1, test `no release`; Task 3, condition `if`).

---

## File Structure

```
scripts/release/versioning.ts      parseCommit, nextVersion, renderNotes, releaseHistory (pur)
scripts/release/cli.ts             lit git, écrit outputs GitHub, notes.md, releases.json
.github/workflows/release.yml      pipeline
build/entitlements.mac.plist       entitlements hardened runtime
electron-builder.yml               appId, cibles, signature, notarisation, publish
docs/release.md                    guide secrets Apple + procédure première release
src/shared/releases.json           historique des notes ([] dans le repo, écrit par la CI)
src/shared/update.ts               types partagés UpdateState, Stash, ReleaseNotes
src/main/update/schedule.ts        calendrier pur : échéance, avertissement
src/main/update/stash.ts           écriture / lecture validée du fichier de mise de côté
src/main/update/updater.ts         electron-updater + schedule + séquence de redémarrage
src/main/update/whatsNew.ts        quelles notes montrer au lancement
src/main/quit.ts                   + finish(), updateDetail()
src/renderer/update/stash.ts       collectStash(), restoreStash()
src/renderer/update/UpdateBanner.tsx   bandeau + avertissement
src/renderer/update/WhatsNew.tsx       panneau « Quoi de neuf » + fichiers récupérés
src/renderer/code/drafts.ts        + allDrafts()
src/renderer/sessions/sessionStore.ts  + stashTabs(), restoreTabs()
```

---

### Task 1: Calcul de version et notes de release

**Files:**
- Create: `scripts/release/versioning.ts`, `scripts/release/cli.ts`, `src/shared/releases.json` (contenu `[]`)
- Modify: `vitest.config.ts` (ajouter `tests/scripts/**/*.test.ts`), `tsconfig.json` (`include` + `"scripts"`)
- Test: `tests/scripts/versioning.test.ts`

**Interfaces:**
- Produces:
  - `type Bump = 'major' | 'minor' | 'patch' | null`
  - `interface Commit { subject: string; body: string }`
  - `parseCommit(c: Commit): { type: string; breaking: boolean; description: string } | null` (null si pas Conventional Commits)
  - `nextVersion(lastTag: string | null, commits: Commit[]): string | null` → `'1.0.0'` si `lastTag` null, null si aucun bump
  - `interface ReleaseNotes { version: string; date: string; features: string[]; fixes: string[] }` (exporté depuis `src/shared/update.ts`, importé ici)
  - `notesFor(version: string, date: string, commits: Commit[], first: boolean): ReleaseNotes`
  - `renderMarkdown(n: ReleaseNotes): string`
  - CLI `node scripts/release/cli.ts` : écrit dans `$GITHUB_OUTPUT` `version=<x.y.z>` (ou vide), et si version : `dist-notes/notes.md` et `src/shared/releases.json` (historique complet, plus récent d'abord).

- [ ] **Step 1: Write the failing tests**

```ts
test('no tag yet gives 1.0.0 whatever the commits', () => {
  expect(nextVersion(null, [{ subject: 'chore: x', body: '' }])).toBe('1.0.0')
})
test('fix gives patch, feat minor, breaking major', () => {
  expect(nextVersion('v1.2.3', [c('fix(cli): a')])).toBe('1.2.4')
  expect(nextVersion('v1.2.3', [c('fix: a'), c('feat(shell): b')])).toBe('1.3.0')
  expect(nextVersion('v1.2.3', [c('feat!: a')])).toBe('2.0.0')
  expect(nextVersion('v1.2.3', [{ subject: 'refactor: a', body: 'BREAKING CHANGE: api' }])).toBe('2.0.0')
  expect(nextVersion('v1.2.3', [c('perf: a')])).toBe('1.2.4')
})
test('no release', () => {
  expect(nextVersion('v1.2.3', [c('chore: a'), c('docs: b'), c('Merge branch develop')])).toBeNull()
})
test('notes drop type and scope, split features and fixes', () => {
  const n = notesFor('1.3.0', '2026-11-08', [c('feat(shell): show the account'), c('fix: parse names'), c('chore: x')], false)
  expect(n).toEqual({ version: '1.3.0', date: '2026-11-08', features: ['Show the account'], fixes: ['Parse names'] })
})
test('first release notes', () => {
  expect(notesFor('1.0.0', '2026-11-08', [c('feat: a')], true)).toEqual({ version: '1.0.0', date: '2026-11-08', features: ['Première version'], fixes: [] })
})
test('markdown has French headings and omits empty sections', () => {
  expect(renderMarkdown({ version: '1.3.0', date: 'd', features: ['A'], fixes: [] })).toBe('## Nouveautés\n\n- A\n')
})
```

(`c(s)` = `{ subject: s, body: '' }`. La première lettre de la description est mise en majuscule.)

- [ ] **Step 2: Run `npx vitest run tests/scripts`** — Expected: FAIL, module introuvable.
- [ ] **Step 3: Implement `versioning.ts`** — regex Conventional Commits `^(\w+)(\([^)]*\))?(!)?: (.+)$`. Sections : `## Nouveautés`, `## Corrections`.
- [ ] **Step 4: Implement `cli.ts`** — `git describe --tags --abbrev=0 --match 'v*'` (absent → null). Commits via `git log <tag>..HEAD --no-merges --format=%s%x1f%b%x1e` (`execFileSync`, arguments en tableau). Historique : pour chaque paire de tags `git tag --list 'v*' --sort=-v:refname`, `notesFor`, puis la nouvelle en tête. Date du jour en ISO `YYYY-MM-DD`.
- [ ] **Step 5: Run `npx vitest run tests/scripts` puis `node scripts/release/cli.ts` en local avec `GITHUB_OUTPUT=/tmp/out`** — Expected: tests PASS ; `/tmp/out` contient `version=1.0.0` (aucun tag dans le repo).
- [ ] **Step 6: Restaurer `src/shared/releases.json` à `[]`, supprimer `dist-notes/`, ajouter `dist-notes` à `.gitignore`, commit** — `feat(release): compute the next version and notes from commits`

### Task 2: Packaging signé et compatible mise à jour

**Files:**
- Modify: `electron-builder.yml`, `package.json` (dépendance `electron-updater`)
- Create: `build/entitlements.mac.plist`

**Interfaces:**
- Produces: un build qui contient `Contents/Resources/app-update.yml` (provider github, owner `BastienPailloux`, repo `canopy`) et un `dist/latest-mac.yml`.

- [ ] **Step 1: `npm install electron-updater`** (dependencies, pas devDependencies).
- [ ] **Step 2: Modifier `electron-builder.yml`** :
  - `appId: io.github.bastienpailloux.canopy` ;
  - `mac.target` : `dmg` et `zip`, arm64 ;
  - supprimer `identity: null` ;
  - `hardenedRuntime: true` ;
  - `entitlements` et `entitlementsInherit` : `build/entitlements.mac.plist` ;
  - `notarize: true` ;
  - `publish: { provider: github, owner: BastienPailloux, repo: canopy, releaseType: release }`.
- [ ] **Step 3: Écrire les entitlements** — `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` (node-pty, binaires de l'agent SDK).
- [ ] **Step 4: Build local non signé** — `npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never -c.mac.notarize=false`. Expected : `dist/Canopy-0.1.0-arm64.dmg`, `dist/Canopy-0.1.0-arm64-mac.zip`, `dist/latest-mac.yml`, et `app-update.yml` dans `dist/mac-arm64/Canopy.app/Contents/Resources/`.
- [ ] **Step 5: Lancer l'app non signée buildée et vérifier que rien n'a régressé** (session Claude, terminal, recherche, `canopy .`).
- [ ] **Step 6: Commit** — `build: sign, notarize and ship update metadata`

### Task 3: Workflow de release et guide des secrets

**Files:**
- Create: `.github/workflows/release.yml`, `docs/release.md`

**Interfaces:**
- Consumes: CLI de Task 1 (`steps.next.outputs.version`), config de Task 2.

- [ ] **Step 1: Écrire `release.yml`** :
  - Déclencheur, environnement et concurrence :
    - `on: push: branches: [master]` ;
    - job `release`, `runs-on: macos-15`, `environment: release`, `permissions: contents: write` ;
    - `concurrency: { group: release, cancel-in-progress: false }`.
  - Étapes, dans l'ordre :
    1. `actions/checkout` avec `fetch-depth: 0`.
    2. `actions/setup-node` avec node 24 et cache npm.
    3. `npm ci`, sans aucun secret dans `env`.
    4. `id: next`, `node scripts/release/cli.ts`.
    5. Les étapes suivantes ont toutes `if: steps.next.outputs.version != ''`.
    6. `npm run typecheck`, puis `npm test`.
    7. `npm version $V --no-git-tag-version`.
    8. `npm run build`.
    9. Écrire `APPLE_API_KEY` dans `$RUNNER_TEMP/AuthKey.p8`.
    10. `npx electron-builder --mac --publish never`, avec en `env` de cette étape seulement : `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY=$RUNNER_TEMP/AuthKey.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
    11. Vérification : `spctl -a -vv dist/mac-arm64/Canopy.app` et `xcrun stapler validate`.
    12. `gh release create v$V --target $GITHUB_SHA --title v$V --notes-file dist-notes/notes.md` avec `dist/*.dmg dist/*.zip dist/*.blockmap dist/latest-mac.yml` (`GH_TOKEN: ${{ github.token }}`).
- [ ] **Step 2: Vérifier la syntaxe** — `npx --yes action-validator .github/workflows/release.yml` (ou `actionlint` si installé). Expected : aucune erreur.
- [ ] **Step 3: Écrire `docs/release.md`** (français), qui doit couvrir :
  - Créer le certificat Developer ID Application : CSR depuis Trousseau d'accès, puis developer.apple.com > Certificates.
  - L'exporter en `.p12` et l'encoder : `base64 -i cert.p12 | pbcopy`.
  - Créer une clé API App Store Connect d'équipe (Users and Access > Integrations > Team Keys, rôle Developer) et noter Key ID et Issuer ID.
  - Créer l'Environment `release` avec la règle « Selected branches: master » et y ajouter les 5 secrets.
  - Règle de merge : jamais de squash de `develop` vers `master`.
  - Procédure de test de mise à jour (Task 11).
- [ ] **Step 4: Commit** — `ci: release signed builds from master`

### Task 4: Calendrier de mise à jour

**Files:**
- Create: `src/main/update/schedule.ts`, `src/shared/update.ts`
- Test: `tests/main/update/schedule.test.ts`

**Interfaces:**
- Produces (dans `src/shared/update.ts`) :
  - `type UpdateState = { phase: 'none' } | { phase: 'ready'; version: string; deadline: number } | { phase: 'warning'; version: string; restartAt: number }`
- Produces (dans `schedule.ts`) :
  - `const FORCE_AFTER_MS = 24 * 3600_000`, `const WARNING_MS = 10 * 60_000`
  - `createSchedule(): { downloaded(version: string, now: number): void; tick(now: number): UpdateState; state(): UpdateState }`
  - `tick` est appelé périodiquement (30 s) et au réveil (`powerMonitor` `resume`). Il renvoie `phase: 'warning'` dès que `now >= deadline - WARNING_MS`, avec `restartAt = max(deadline, now + WARNING_MS)` fixé une fois pour toutes au premier passage en warning.
  - Le redémarrage a lieu quand `tick(now)` voit `now >= restartAt`. Il est signalé par `{ phase: 'warning', … }` avec `restartAt <= now`. C'est l'appelant qui teste `restartAt <= now`.

- [ ] **Step 1: Write the failing tests**

```ts
test('deadline is 24h after the first download', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  expect(s.tick(1000)).toEqual({ phase: 'ready', version: '1.1.0', deadline: FORCE_AFTER_MS })
})
test('a newer download replaces the version, keeps the deadline', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0); s.downloaded('1.2.0', 5 * 3600_000)
  expect(s.tick(5 * 3600_000)).toEqual({ phase: 'ready', version: '1.2.0', deadline: FORCE_AFTER_MS })
})
test('warning 10 minutes before', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  expect(s.tick(FORCE_AFTER_MS - WARNING_MS)).toEqual({ phase: 'warning', version: '1.1.0', restartAt: FORCE_AFTER_MS })
})
test('sleep past deadline gives a full 10 minutes from wake', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  const wake = FORCE_AFTER_MS + 3 * 3600_000
  expect(s.tick(wake)).toEqual({ phase: 'warning', version: '1.1.0', restartAt: wake + WARNING_MS })
  expect(s.tick(wake + 60_000)).toMatchObject({ restartAt: wake + WARNING_MS })
})
test('nothing downloaded', () => { expect(createSchedule().tick(0)).toEqual({ phase: 'none' }) })
```

- [ ] **Step 2: Run `npx vitest run tests/main/update/schedule.test.ts`** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(update): schedule the forced restart`

### Task 5: Sortie pour mise à jour dans le flux de fermeture

**Files:**
- Modify: `src/main/quit.ts`
- Test: `tests/main/quit.test.ts`

**Interfaces:**
- Produces :
  - `createQuitFlow(...)` renvoie aussi `finish(then: () => void): void`. `finish` met `quitting` à vrai, appelle `shutdown()`, puis `then()` à la place de `quit()`, sans confirmation. Ensuite, `request()` ne fait plus rien.
  - `updateDetail(c: RunningCounts): string`

- [ ] **Step 1: Write the failing tests**

```ts
test('finish stops everything and hands over without asking', () => {
  const h = setup({ sessions: 1 }); const then = vi.fn()
  h.flow.finish(then)
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.calls).toEqual(['shutdown']); expect(then).toHaveBeenCalledOnce()
  expect(h.flow.quitting).toBe(true)
})
test('update detail says what stops and that edits are kept', () => {
  expect(updateDetail({ sessions: 2, terminals: 1, buffers: 3, drafts: 1 })).toBe(
    'Redémarrer arrêtera : 2 sessions Claude en cours, 1 terminal actif. Les fichiers non enregistrés et les brouillons seront conservés.')
})
```

- [ ] **Step 2: Run `npx vitest run tests/main/quit.test.ts`** — FAIL.
- [ ] **Step 3: Implement.** Réutiliser le formatage `running` de `quitDetail`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(quit): let an update finish the app without asking`

### Task 6: Fichier de mise de côté

**Files:**
- Create: `src/main/update/stash.ts`
- Modify: `src/shared/update.ts`
- Test: `tests/main/update/stash.test.ts`

**Interfaces:**
- Produces (dans `src/shared/update.ts`) :

```ts
export interface StashedBuffer { cwd: string; path: string; text: string; version: string }
export interface StashedTab { cwd: string; sessionId?: string; title: string; draft: { text: string; images: UserImage[] }; interrupted: boolean }
export interface Stash { format: 1; buffers: StashedBuffer[]; tabs: StashedTab[] }
```

(`UserImage` = `NonNullable<UserContent['images']>[number]`, à déclarer dans `src/shared/update.ts` à partir de `UserContent` de `src/shared/types.ts`. Le renderer définit déjà le même alias dans `sessions/transcript.ts`.)
- Produces (dans `stash.ts`) :
  - `parseStash(raw: unknown): Stash` : lève une erreur si le format n'est pas 1 ou si un champ est invalide. Les entrées invalides font tout rejeter, le format étant produit par nous.
  - `writeStash(file: string, s: Stash): void` : écriture atomique, tmp + rename, comme `AppStore.save`.
  - `takeStash(file: string): Stash | null` : lit, valide et supprime le fichier dans tous les cas. Renvoie null si le fichier est absent ou invalide.

- [ ] **Step 1: Write the failing tests** — `round trip` (write puis take renvoie l'objet, le fichier n'existe plus) ; `absent gives null` ; `corrupt stash` (contenu `{oops` → null et fichier supprimé) ; `unknown format` (`format: 2` → null).
- [ ] **Step 2: Run `npx vitest run tests/main/update/stash.test.ts`** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(update): set aside unsaved work across the restart`

### Task 7: Updater dans le process principal

**Files:**
- Create: `src/main/update/updater.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts`
- Test: `tests/main/update/updater.test.ts`

**Interfaces:**
- Consumes : `createSchedule` (Task 4), `finish` / `updateDetail` (Task 5), `writeStash` / `takeStash` / `parseStash` (Task 6).
- Produces :
  - `createUpdater(deps: UpdaterDeps): { start(): void; state(): UpdateState; restart(byUser: boolean): Promise<void>; receiveStash(raw: unknown): void }`
  - `UpdaterDeps = { updater: Pick<AppUpdater, 'checkForUpdates' | 'quitAndInstall' | 'on'>; now: () => number; setInterval; broadcast: (e: string, p?: unknown) => void; counts: () => RunningCounts; confirm: (detail: string) => Promise<boolean>; finish: (then: () => void) => void; stashFile: string; stashTimeoutMs: number }`
  - Événements renderer : `update:state` (payload `UpdateState`) et `update:collectStash` (pas de payload).
  - `CanopyApi` ajoute :
    - `updateState(): Promise<UpdateState>`
    - `restartToUpdate(): Promise<void>`
    - `submitStash(s: Stash): Promise<void>`
    - `takeStash(): Promise<Stash | null>`
    - `whatsNew(): Promise<ReleaseNotes[]>` (implémenté en Task 10)
    - `markWhatsNewSeen(): Promise<void>` (implémenté en Task 10)
  - Canaux IPC : `update:state`, `update:restart`, `update:submitStash`, `update:takeStash`.

Comportement :
- `start()` :
  - `autoDownload = true`, `autoInstallOnAppQuit = true` ;
  - `checkForUpdates()` tout de suite, puis toutes les 4 h ;
  - `tick` toutes les 30 s ;
  - les erreurs sont journalisées par `console.error`, sans rien afficher.
- Sur `update-downloaded` : `schedule.downloaded(info.version, now())`, puis broadcast de l'état.
- Quand `tick` change l'état, broadcast. Quand `restartAt <= now`, appeler `restart(false)`.
- `restart(byUser)` :
  1. Si `byUser` et des sessions ou terminaux tournent : `confirm(updateDetail(counts))`. Si l'utilisateur annule, s'arrêter là.
  2. Broadcast `update:collectStash`, puis attendre `receiveStash` ou `stashTimeoutMs` (5000 en prod).
  3. Écrire le stash reçu.
  4. `finish(() => updater.quitAndInstall(false, true))`.
  5. Un deuxième appel pendant que le premier est en cours ne fait rien.

- [ ] **Step 1: Write the failing tests** (faux `updater` = `EventEmitter` + `vi.fn`, horloge contrôlée) :
  - `downloaded update is broadcast as ready` ;
  - `forced restart collects the stash then installs without confirm` (vérifier l'ordre : `collectStash` émis, `receiveStash`, fichier écrit, `finish`, `quitAndInstall`) ;
  - `stash timeout` (aucun `receiveStash`, avancer de 5000 ms → `quitAndInstall` appelé, pas de fichier) ;
  - `user restart with running sessions asks, cancel changes nothing` ;
  - `second restart while one runs is ignored`.
- [ ] **Step 2: Run `npx vitest run tests/main/update/updater.test.ts`** — FAIL.
- [ ] **Step 3: Implement `updater.ts`.**
- [ ] **Step 4: Brancher dans `index.ts`** :
  - Si `app.isPackaged && !hidden`, créer l'updater avec `autoUpdater` de `electron-updater`.
  - `confirm` : boîte de dialogue `type: 'warning'`, boutons `['Redémarrer', 'Annuler']`, message `Redémarrer pour mettre à jour ?`.
  - `finish` : `quit.finish`.
  - `stashFile` : `join(app.getPath('userData'), 'update-stash.json')`.
  - `powerMonitor.on('resume', tick)`.
  - Sinon, `state()` renvoie `{ phase: 'none' }`. `takeStash` reste branché dans tous les cas, avec le même fichier.
- [ ] **Step 5: Ajouter les handlers IPC** (validation des arguments via `parseStash`), le preload et les types `CanopyApi`.
- [ ] **Step 6: Run `npm test && npm run typecheck`** — PASS.
- [ ] **Step 7: Commit** — `feat(update): download updates and restart into them`

### Task 8: Collecte et restauration côté renderer

**Files:**
- Create: `src/renderer/update/stash.ts`
- Modify: `src/renderer/code/drafts.ts`, `src/renderer/sessions/sessionStore.ts`, `src/renderer/App.tsx`
- Test: `tests/renderer/updateStash.test.ts`, `tests/renderer/drafts.test.ts`

**Interfaces:**
- Consumes : `Stash`, `StashedBuffer`, `StashedTab` (Task 6), `window.canopy.submitStash` / `takeStash` / `on('update:collectStash')` (Task 7).
- Produces :
  - `allDrafts(): StashedBuffer[]` (dans `drafts.ts`).
  - `stashTabs(): StashedTab[]` (dans `sessionStore.ts`) : tous les onglets qui ont un `sessionId` ou un brouillon non vide. `interrupted` est vrai quand `state` vaut `working` ou `waiting`.
  - `restoreTabs(tabs: StashedTab[]): void` (dans `sessionStore.ts`) :
    - Onglet avec `sessionId` : il s'ouvre comme `openSession`, en `resumable` et sans processus. Si `interrupted`, ajouter la notice `Session interrompue par la mise à jour. Envoie un message pour la reprendre.`
    - Dans tous les cas, le brouillon est remis dans le composer.
  - `collectStash(): Stash`, `restoreStash(s: Stash): void`, `connectUpdateStash(): () => void` (écoute `update:collectStash` et répond par `submitStash(collectStash())`).
  - `restoredFiles` : un store zustand `{ files: StashedBuffer[] }`, que Task 10 affiche.

- [ ] **Step 1: Write the failing tests**
  - `allDrafts lists every unsaved buffer with its version` (dans `drafts.test.ts`).
  - `collect then restore gives back drafts and tabs` :
    - `setDraft('/wt', 'a.ts', { text: 'x', version: 'v1' })` et un onglet avec `sessionId: 's1'` à l'état `working` et un brouillon `'suite'` ;
    - réinitialiser les stores, puis `restoreStash(collectStash())` ;
    - `getDraft('/wt', 'a.ts')` vaut `{ text: 'x', version: 'v1' }` ;
    - l'onglet `s1` existe, en `resumable` et sans `localId`, avec son brouillon `'suite'`, et le dernier élément du transcript est la notice d'interruption.
  - `restored draft over changed file` : le draft garde sa `version` d'origine. C'est `CodeView`, déjà en place, qui compare avec la version disque et affiche « modifié sur le disque ». Le test vérifie seulement que la version n'est pas réécrite.
- [ ] **Step 2: Run `npx vitest run tests/renderer`** — FAIL.
- [ ] **Step 3: Implement.** Pour l'historique dans `restoreTabs`, réutiliser `loadHistory`.
- [ ] **Step 4: Dans `App.tsx`** :
  - `useEffect(() => connectUpdateStash(), [])` ;
  - au lancement, avant la réouverture du dossier récent, `const s = await window.canopy.takeStash().catch(() => null)`, puis `restoreStash(s)` si `s` n'est pas null.
- [ ] **Step 5: Vérifier le cas `deleted file`** : ouvrir un draft restauré dont le fichier n'existe plus. `CodeView` doit afficher le draft avec un message, pas une erreur qui le jette. Si ce n'est pas le cas, faire en sorte que `readFile` en échec garde le draft et affiche `Ce fichier n'existe plus sur le disque. Enregistrer le recréera.` Ajouter un test sur la fonction concernée.
- [ ] **Step 6: Run `npm test && npm run typecheck`** — PASS.
- [ ] **Step 7: Commit** — `feat(update): restore unsaved files, drafts and sessions after updating`

### Task 9: Bandeau et avertissement

**Files:**
- Create: `src/renderer/update/UpdateBanner.tsx`, `src/renderer/update/updateText.ts`
- Modify: `src/renderer/App.tsx`, `src/renderer/theme.css`
- Test: `tests/renderer/updateText.test.ts`, `tests/e2e/update.spec.ts`

**Interfaces:**
- Consumes : `UpdateState`, `updateState()`, `restartToUpdate()`, l'événement `update:state` (Task 7).
- Produces : `bannerText(s: UpdateState, now: number): string | null` (pur).

Textes :
- Phase `ready` : `Nouvelle version {version} prête. Redémarrage obligatoire {quand}.`
  - `{quand}` vaut `à HH:MM` le même jour, `demain à HH:MM` le jour suivant.
  - Bouton `Redémarrer`.
- Phase `warning` : `Canopy redémarre dans {m:ss} pour installer la version {version}. Tes fichiers non enregistrés et brouillons seront conservés.`
  - Bouton `Redémarrer maintenant`.
- Le bandeau est placé tout en haut, au-dessus de `Header`, et ne peut pas être fermé.
  - Fond accent en phase `ready`, fond attention `#E3B341` en phase `warning`.
  - Compte à rebours rafraîchi chaque seconde.

- [ ] **Step 1: Write the failing tests** — `bannerText` : phase `none` → null ; `ready` le même jour et le lendemain ; `warning` à `restartAt - 65_000` → contient `1:05`.
- [ ] **Step 2: Run `npx vitest run tests/renderer/updateText.test.ts`** — FAIL.
- [ ] **Step 3: Implement `updateText.ts`, `UpdateBanner.tsx`, l'insertion dans `App.tsx` et les styles.**
- [ ] **Step 4: Test e2e** `tests/e2e/update.spec.ts` : depuis le process principal (`electronApp.evaluate`), émettre l'événement `update:state` `ready` sur la fenêtre, puis vérifier que le bandeau et le bouton sont visibles. Si l'API de test ne le permet pas, ajouter un hook réservé aux tests derrière `hiddenWindow`, comme `fakeQuery`.
- [ ] **Step 5: Run `npm test && npm run test:e2e -- update`** — PASS.
- [ ] **Step 6: Commit** — `feat(update): announce the update and the forced restart`

### Task 10: « Quoi de neuf » et fichiers récupérés

**Files:**
- Create: `src/main/update/whatsNew.ts`, `src/renderer/update/WhatsNew.tsx`
- Modify: `src/main/ipc.ts`, `src/renderer/App.tsx`, `src/renderer/theme.css`
- Test: `tests/main/update/whatsNew.test.ts`

**Interfaces:**
- Consumes : `src/shared/releases.json` (Task 1), `AppStore.prefs` / `setPrefs`, `restoredFiles` (Task 8).
- Produces :
  - `notesToShow(history: ReleaseNotes[], current: string, lastSeen: string | undefined): ReleaseNotes[]`
    - `lastSeen` indéfini (installation fraîche) → `[]` ;
    - sinon, les versions `> lastSeen` et `<= current`, de la plus récente à la plus ancienne (comparaison semver numérique).
  - IPC `whatsNew` : `notesToShow(releases, app.getVersion(), prefs.lastSeenVersion)`. Si `lastSeenVersion` est indéfini, l'écrire à `app.getVersion()` tout de suite.
  - IPC `markWhatsNewSeen` : écrit `prefs.lastSeenVersion = app.getVersion()`.

- [ ] **Step 1: Write the failing tests** — `fresh install shows nothing` ; `shows skipped versions newest first` (historique 1.2.0, 1.1.0, 1.0.0 ; lastSeen 1.0.0 ; current 1.2.0 → [1.2.0, 1.1.0]) ; `1.10.0 > 1.9.0` ; `same version shows nothing`.
- [ ] **Step 2: Run `npx vitest run tests/main/update/whatsNew.test.ts`** — FAIL.
- [ ] **Step 3: Implement `whatsNew.ts` et l'IPC.**
- [ ] **Step 4: Implement `WhatsNew.tsx`** : panneau modal, rendu avec le composant `Markdown` existant.
  - Titre `Quoi de neuf dans {version}`. Si plusieurs versions, une section par version, avec les sous-titres `Nouveautés` et `Corrections`.
  - Si `restoredFiles` n'est pas vide, ajouter la section `Récupéré après la mise à jour` : une ligne par fichier (chemin relatif au worktree). Un clic sélectionne le worktree et ouvre le fichier dans la vue Code, via `setShown(cwd, { selected: path, mode: 'code', scope: 'all' })` puis la navigation existante.
  - Si `whatsNew()` ne renvoie rien mais qu'il y a des fichiers récupérés, le panneau montre uniquement cette section.
  - Bouton `Fermer`, qui appelle `markWhatsNewSeen()`.
- [ ] **Step 5: Run `npm test && npm run typecheck`** — PASS.
- [ ] **Step 6: Commit** — `feat(update): show what changed after an update`

### Task 11: Clé API illisible et première release

**Files:**
- Modify: `src/main/appStore.ts`, `src/main/ipc.ts`, `src/shared/api.ts`, `src/renderer/shell/Settings.tsx`
- Test: `tests/main/appStore.test.ts`

**Interfaces:**
- Produces : `AppStore.apiKeyReadable(): boolean`. `apiKeyStatus` renvoie en plus `{ readable: boolean }`.

- [ ] **Step 1: Write the failing test** — `stored key that no longer decrypts is reported unreadable` (le faux cipher lève une erreur dans `decryptString` → `hasApiKey()` vrai, `apiKeyReadable()` faux).
- [ ] **Step 2: Run `npx vitest run tests/main/appStore.test.ts`** — FAIL.
- [ ] **Step 3: Implement**, puis afficher dans `Settings.tsx` : `La clé API enregistrée n'est plus lisible (l'application a changé de signature). Saisis-la à nouveau.`
- [ ] **Step 4: Run `npm test && npm run typecheck`** — PASS.
- [ ] **Step 5: Commit** — `fix(settings): ask again for an API key that can no longer be read`
- [ ] **Step 6: Procédure manuelle (Bastien)**, à suivre avec `docs/release.md`. Elle remplace le test de bout en bout :
  1. Remplir l'Environment `release`.
  2. Merger dans `master`. Le workflow publie `v1.0.0`.
  3. Installer le `.dmg` de la release. Il s'ouvre sans avertissement Gatekeeper.
  4. Vérifier : session Claude, terminal, recherche, langage TS, `canopy .`.
  5. Pousser un `fix:` trivial sur `master`. `v1.0.1` est publiée.
  6. Dans la `v1.0.0` installée, ouvrir un fichier modifié non enregistré et un brouillon. Le bandeau apparaît en moins de 4 h, ou tout de suite en relançant l'app.
  7. Cliquer `Redémarrer`. L'app redémarre en `1.0.1`, le panneau « Quoi de neuf » liste le correctif et le fichier récupéré, et le brouillon est revenu.
