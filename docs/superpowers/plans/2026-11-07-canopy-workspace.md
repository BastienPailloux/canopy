# Canopy Workspace Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir un dossier parent, y trouver tous les repos git imbriqués et leurs worktrees, et travailler dans chacun sans changer d'outil.

**Architecture:** Toute l'app travaille déjà par repo et par `cwd`. L'espace de travail est une couche au-dessus : un scan produit une liste d'entrées, et choisir une entrée rend son repo actif. Aucune API existante ne change de sens.

**Tech Stack:** Existant : Electron, React, zustand, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-canopy-design.md`, section 11.

## Global Constraints

- Limites du scan : profondeur 6, 200 repos au plus, ignorés `node_modules`, `.git`, `dist`, `build`, `vendor`. Liens symboliques jamais suivis. Pas de descente dans un dossier reconnu comme repo, sauf la racine ouverte. Seuls les dossiers cachés autorisés sont `.worktrees`.
- Le scan ne bloque jamais le process principal : `fs/promises` uniquement.
- Sessions, terminaux, confiance et diff restent par repo, inchangés. Changer d'entrée n'arrête rien.
- Aucune écriture dans les repos de l'utilisateur.
- Un dossier sans repo imbriqué : interface et comportement identiques à aujourd'hui.

## Review Focus

1. Dossier énorme ou lent (home, disque réseau) : le scan s'arrête aux limites, l'app reste utilisable (Task 1).
2. Lien symbolique en boucle : pas de boucle infinie (Task 1).
3. Linked worktree et repo principal dans la même arborescence : un seul repo, pas de doublon (Task 1).
4. Dossier ouvert qui n'est pas lui-même un repo git : ouverture acceptée s'il contient des repos, message clair sinon (Task 2).
5. Repo ou worktree supprimé pendant l'utilisation : l'entrée disparaît au scan suivant, sans erreur (Task 3).

---

### Task 1: Scan et groupes

**Files:**
- Create: `src/main/workspace.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/main/workspace.test.ts`

**Interfaces:**
- Consumes: `listWorktrees(repo)`, `git(cwd, args)`.
- Produces dans `src/shared/types.ts` : `interface WorkspaceEntry { repo: string; repoName: string; worktree: Worktree; group: 'space' | 'main' | 'feature' | 'other'; feature?: string }` et `interface Workspace { root: string; entries: WorkspaceEntry[]; truncated: boolean }`.
- Produces : `findRepos(root: string): Promise<{ repos: string[]; truncated: boolean }>` renvoie les racines de worktree principal, dédoublonnées par `realpath` de `git rev-parse --git-common-dir`. `scanWorkspace(root: string): Promise<Workspace>`. `entryGroup(root: string, w: Worktree, repo: string): Pick<WorkspaceEntry, 'group' | 'feature'>`.

- [ ] **Step 1: Write the failing tests.** Vrais repos dans un dossier temporaire :
  - trouve 3 repos à des profondeurs 1, 2 et 5 ; rien à la profondeur 7 ;
  - ignore un repo dans `node_modules/x` et `dist/x` ;
  - ne descend pas dans un repo trouvé ;
  - un linked worktree sous `.worktrees/f/api` d'un repo `api` : un seul repo, une entrée `group:'feature', feature:'f'` ;
  - un worktree `api-wt-x` à côté : `group:'other'` ;
  - racine elle-même repo avec des repos imbriqués : son entrée a `group:'space'`, les imbriqués `group:'main'` ;
  - racine repo sans repo imbriqué : une seule entrée `group:'main'`, ses worktrees sous `.worktrees/x` en `other` ;
  - **`survives a symlink loop`** : lien `a/b -> ..`, le scan se termine ;
  - **`stops at the repo limit`** : 201 repos, `truncated:true`, 200 renvoyés ;
  - un repo dont `listWorktrees` échoue est ignoré, les autres restent.
- [ ] **Step 2:** Run `npx vitest run tests/main/workspace.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implémenter. Parcours en largeur, `readdir` avec `withFileTypes`, concurrence plafonnée à 16.
- [ ] **Step 4:** Run `npx vitest run tests/main/workspace.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(workspace): find nested repos and group their worktrees`.

### Task 2: Ouverture et branche de base mémorisée

**Files:**
- Modify: `src/main/ipc.ts`, `src/main/appStore.ts`, `src/main/git/sharedReads.ts`, `src/shared/api.ts`, `src/preload/index.ts`
- Test: `tests/main/appStore.test.ts`, `tests/main/git/sharedReads.test.ts`, `tests/main/workspace.test.ts`

**Interfaces:**
- Consumes: `scanWorkspace`, `mainWorktreeRoot`.
- Produces dans `CanopyApi` : `scanWorkspace(root: string): Promise<Workspace>`, `setRepoBase(repo: string, branch: string | null): Promise<void>`, `repoBase(repo: string): Promise<string | null>`. `openRepo` et `selectRepo` renvoient le dossier ouvert, repo ou non, et rejettent avec « Aucun repo git dans ce dossier » si le scan ne trouve rien.
- Produces : `AppStore.repoBases: Record<string, string>`, `resolveOpenedFolder(path: string): Promise<string>` : si le scan trouve un repo imbriqué, le dossier lui-même ; sinon la racine du repo comme aujourd'hui.
- `cachedBaseRef(cwd)` consulte d'abord la base mémorisée du repo principal de `cwd`, si la ref existe, puis `resolveBaseRef`.

- [ ] **Step 1: Write the failing tests.** `AppStore` relit `repoBases`, valeur corrompue ignorée. `cachedBaseRef` : base mémorisée `origin/develop` gagne sur `origin/HEAD` vers `master` ; une base mémorisée disparue retombe sur `resolveBaseRef` ; le cache est vidé après `setRepoBase`. `resolveOpenedFolder` : parent non git avec repos → le parent ; sous-dossier d'un repo sans repo imbriqué → racine du repo ; dossier vide → rejet.
- [ ] **Step 2:** Run `npx vitest run tests/main`. Expected: FAIL.
- [ ] **Step 3:** Implémenter. Valider `branch` comme `resolveCompareRef` à la frontière IPC.
- [ ] **Step 4:** Run `npx vitest run tests/main`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(workspace): open parent folders and remember a repo's base`.

### Task 3: Interface

**Files:**
- Modify: `src/renderer/store.ts`, `src/renderer/App.tsx`, `src/renderer/shell/WorktreeList.tsx`, `src/renderer/shell/RepoPicker.tsx`, `src/renderer/code/CodeScreen.tsx`
- Test: `tests/renderer/store.test.ts`, `tests/e2e/workspace.spec.ts`

**Interfaces:**
- Consumes: `scanWorkspace`, `setRepoBase`, `repoBase`.
- Produces dans `useApp` : `workspace: Workspace | null`, `setWorkspace(w)`, `selectEntry(e: WorkspaceEntry)` qui fixe `repo` et `worktree` sans vider l'état des autres repos. `repo` reste le repo actif : les consommateurs existants ne changent pas.

- [ ] **Step 1: Write the failing tests.** Store : `selectEntry` change `repo` et `worktree` ; un nouveau scan garde la sélection si l'entrée existe, sinon prend la première ; un dossier à un seul repo garde le comportement actuel. E2E sur un dossier fixture, deux repos et une feature sous `.worktrees` : les sections « Principal », feature et « Autres » s'affichent ; un clic sur un repo montre son code, pas celui du parent ; le diff compare à la base mémorisée après choix dans le sélecteur ; une session dans un repo continue après sélection d'un autre (**session survives**) ; le sélecteur de repo signale un repo de l'espace qui attend une réponse.
- [ ] **Step 2:** Run `npm run test:e2e -- workspace`. Expected: FAIL.
- [ ] **Step 3:** Implémenter. Section sans titre si l'espace n'a qu'un repo. Entrée libellée `<repo> · <branche>` dans une feature, `<repo>` dans Principal. « Espace » pour `group:'space'`. Rescan toutes les 60 s, au focus et après création ou suppression de worktree, avec la pause de `polling.ts`. Case « Mémoriser pour ce repo » à côté du sélecteur de comparaison. Message si `truncated`. Bouton « + » : crée un worktree dans le repo actif.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run test:e2e`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(workspace): grouped worktree list across repos`.

### Task 4: Validation

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-spike-results.md`

- [ ] **Step 1:** Reconstruire avec `npm run build && npx electron-builder --mac`.
- [ ] **Step 2:** Dans un dossier jetable, reproduire la forme de `foxy-app` : parent git avec `.gitignore` excluant trois repos imbriqués, `origin/HEAD` sur `master`, branche `develop`, feature à trois worktrees, un `backend-wt-x`. Ouvrir l'app packagée par `open` : vérifier sections, code, diff après mémorisation de `develop`.
- [ ] **Step 3:** Mesurer `scanWorkspace` sur `/Users/basti/code/foxy-app` en lecture seule, hors app, et noter durée et résultat.
- [ ] **Step 4:** Noter les résultats, commit `docs: record workspace validation`.
