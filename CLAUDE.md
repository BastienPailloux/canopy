# CLAUDE.md

Guide pour Claude Code (et tout contributeur) dans ce dépôt.

## Le projet

Canopy est une application Mac (Electron, Apple Silicon) qui remplace l'IDE pour un « product builder » : on passe de l'idée à la PR en pilotant Claude Code plutôt qu'en écrivant le code à la main. Une seule fenêtre réunit worktrees git, sessions Claude (via `@anthropic-ai/claude-agent-sdk`), code avec diff vs la branche de base, terminal et tickets.

Conception de référence : `docs/superpowers/specs/2026-11-07-canopy-design.md`. Plans d'implémentation : `docs/superpowers/plans/`. Publication : `docs/release.md`.

## Commandes

```sh
npm install          # postinstall : electron-rebuild de node-pty
npm run dev          # app en dev (electron-vite, hot reload du renderer)
npm run typecheck    # tsc --noEmit sur src, tests, scripts
npm test             # tests unitaires Vitest (tests/main, tests/renderer, tests/scripts)
npm run test:e2e     # build puis Playwright sur l'app Electron (tests/e2e)
npm run build        # build electron-vite vers out/
```

Un seul test : `npx vitest run tests/main/quit.test.ts` ou `npx playwright test tests/e2e/sessions.spec.ts`.

Les E2E tournent avec `CANOPY_HIDE_WINDOW=1` par défaut (fenêtre hors écran, sans focus). `CANOPY_HIDE_WINDOW=0` pour la voir. `CANOPY_FAKE_QUERY` remplace le SDK par `src/main/sessions/fakeQuery.ts` : aucun test ne lance de vraie session Claude. `CANOPY_FAKE_ACCOUNT` fait de même pour le compte. `CANOPY_FAKE_LINEAR=tests/fixtures/linear` remplace le serveur MCP Linear par la relecture des réponses capturées (`src/main/linear/replay.ts`, ignoré en build packagé) ; `CANOPY_FAKE_LINEAR_FAIL`, `_LOG` et `_COLLEAGUE` pilotent les pannes, le journal des appels et les modifications d'un collègue dans les E2E.

`.npmrc` impose `legacy-peer-deps=true` : ne pas le retirer.

## Architecture

```
src/
  main/       process principal Electron (Node) : git, sessions Claude, terminaux (node-pty),
              LSP TypeScript, recherche (ripgrep), tickets, mises à jour, menu, CLI
  preload/    pont contextBridge : expose `window.canopy` (type CanopyApi)
  renderer/   UI React 19 + Zustand, organisée par écran (sessions, code, terminal, tickets, shell, update)
  shared/     types et contrats partagés main/renderer (aucune dépendance Electron ni DOM)
tests/        miroir de src : main/, renderer/, scripts/, e2e/, helpers/
scripts/release/  calcul de version et notes de release (exécuté en CI)
build/        icônes, entitlements, CLI `canopy` (shell script copié dans le bundle)
```

- **IPC** : le contrat est dans `src/shared/api.ts` (`CanopyApi`). Ajouter une méthode = la déclarer dans `api.ts`, l'exposer dans `src/preload/index.ts` (`ipcRenderer.invoke('domaine:action', …)`), la gérer dans `src/main/ipc.ts` (ou dans le module `*Ipc.ts` du domaine, comme `tickets/ticketIpc.ts` et `linear/linearIpc.ts`). Les événements main → renderer passent par le canal unique `canopy:event` (`broadcast`).
- **Renderer** : jamais d'accès Node direct, tout passe par `window.canopy`. L'état vit dans des stores Zustand par domaine (`sessionStore`, `terminalStore`, `ticketStore`…).
- **Binaires natifs** (SDK Claude, node-pty, ripgrep, serveur LSP) sont en `asarUnpack` dans `electron-builder.yml`. Toute nouvelle dépendance qui spawn un binaire doit y être ajoutée, sinon elle casse uniquement en build packagé.
- **Worktrees** : créés par défaut sous `<repo>/.worktrees/` (ignoré par git). `.canopy/config.json` décrit le setup et les services lancés par « Tester la PR » ; le port est fourni via `PORT`.
- **Tickets** : fichiers Markdown dans `.tickets/` du checkout principal, hors git. Les modèles de tickets sont dans `.tickets/templates/` (un fichier par modèle, défaut dans `.tickets/config.json`) et se modifient dans l'écran « Modèles de tickets » (Réglages ou lien « Gérer les modèles… » du brouillon).
- **Linear** : connecteur dans `src/main/linear/`, uniquement via le serveur MCP officiel (`https://mcp.linear.app/mcp`, OAuth avec enregistrement dynamique, jeton chiffré par `safeStorage`). Les modifications passent par une file sur disque (`linear-pending.json`) et la description part en `patch` : ne jamais envoyer une description complète. Comportement réel du serveur : `tests/fixtures/linear/README.md`.

## Conventions de code

- TypeScript strict, modules ESM, imports relatifs. Pas de linter configuré : suivre le style existant (2 espaces, quotes simples, pas de point-virgule, lignes longues tolérées).
- **Langue** : code, identifiants et commentaires en anglais ; tout texte visible par l'utilisateur (UI, dialogues, CLI, notes de release) en français, avec les guillemets « » comme le texte existant.
- Commentaires courts qui expliquent le **pourquoi** (contrainte, piège, décision), pas le quoi. JSDoc `/** */` sur les fonctions et champs exportés non évidents.
- Préférer des fonctions pures et testables (ex. `createQuitFlow`, `createOpenFolders`) injectées dans `index.ts`, plutôt que de la logique directement liée à Electron.
- Pas d'abstraction spéculative : le minimum qui résout le besoin.
- Sécurité : ne jamais exposer de secret au renderer ; valider chemins, ids et noms de branches reçus par IPC (cf. `tickets`, `repoTrust`) ; spawn avec `execFile` et tableau d'arguments, jamais de chaîne shell.

## Tests

- **TDD obligatoire** : pour toute fonctionnalité ou correction, écrire d'abord le test, le voir échouer pour la bonne raison, puis écrire le code minimal qui le fait passer, puis refactorer. Pas de code de production sans test qui l'a exigé. Pour un bug : un test qui reproduit le bug avant le correctif.
- Toute logique dans `main/`, `shared/` ou `scripts/` a son test Vitest dans le dossier miroir de `tests/`. Les tests git créent de vrais repos temporaires (`tests/helpers/repo.ts`).
- Un parcours utilisateur visible ajoute ou adapte un spec Playwright dans `tests/e2e/` (un worker, timeout 60 s).
- Avant de déclarer un travail terminé : `npm run typecheck && npm test` doivent passer, et `npm run test:e2e` si l'UI ou le main ont changé.

## Git et branches

- `develop` : branche d'intégration, cible de toutes les PR. Protégée : pas de push direct ni de force-push, merge par PR en squash uniquement.
- `master` : branche de release. Chaque push sur `master` peut publier une version, après approbation dans l'environment `release`. Force-push et suppression interdits, comme pour les tags `v*` (rulesets, cf. `docs/release.md`).
- Ne jamais lancer ni valider un `git push` vers `master` depuis une session Claude : la livraison reste un geste du mainteneur.
- Branches de travail : `<type>/<sujet-court>` (`feat/add-tickets`, `fix/answer`, `docs/claude-md`, `chore/…`), créées depuis `develop`, idéalement dans un worktree sous `.worktrees/`.
- Ne jamais committer : `out/`, `dist/`, `dist-notes/`, `test-results/`, `.worktrees/`, `.superpowers/`, `.canopy/dev-user-data`, ni `src/shared/releases.json` régénéré par la CI.

## Conventional Commits

Obligatoire : le numéro de version et les notes de release « Quoi de neuf » en sont calculés automatiquement (`scripts/release/versioning.ts`).

Format : `<type>(<scope optionnel>)<! optionnel>: <description>`

| Type | Usage | Effet sur la version |
|---|---|---|
| `feat` | nouvelle fonctionnalité visible | **minor** (section « Nouveautés ») |
| `fix` | correction de bug | **patch** (section « Corrections ») |
| `perf` | amélioration de performance | **patch** (section « Corrections ») |
| `refactor`, `test`, `docs`, `chore`, `build`, `ci`, `style` | le reste | aucune release |
| `!` après le type, ou `BREAKING CHANGE:` dans le corps | rupture de compatibilité | **major** |

Règles :

- Scope = domaine touché, en minuscules : `tickets`, `git`, `sessions`, `code`, `terminal`, `update`, `release`…
- Description à l'impératif, en minuscule, sans point final, en anglais (comme l'historique). Elle apparaît telle quelle (capitalisée) dans les notes de release : la rédiger pour un utilisateur, sans faute de frappe.
- Un commit = un changement cohérent. Corps facultatif pour expliquer le pourquoi.
- Exemples : `feat(tickets): launch a ticket into a new worktree`, `fix(git): start branch without upstream`, `refactor(sessions)!: drop legacy transcript format`.

**Titre de PR** : les PR vers `develop` sont mergées en squash, le titre de la PR devient donc le sujet du commit. Il doit lui aussi être un Conventional Commit, sinon la PR ne compte pas dans le calcul de version (le parseur lit seulement le sujet, le corps ne sert qu'à détecter `BREAKING CHANGE:`). Choisir le type le plus fort de la PR (`feat` si elle contient au moins une fonctionnalité).

## Système de release

Détails et configuration Apple/GitHub : `docs/release.md`. Résumé :

1. Les PR sont mergées dans `develop` (squash, titre conventionnel).
2. Pour livrer, `develop` est mergé dans `master` par **vrai merge ou fast-forward, jamais en squash** (les types des commits seraient perdus).
3. Le push sur `master` déclenche `.github/workflows/release.yml` (macOS, environment `release` avec approbation manuelle du mainteneur, pas de release parallèle) :
   - `scripts/release/cli.ts` lit les commits depuis le dernier tag `v*`, calcule la version suivante (première release : `1.0.0`), génère `dist-notes/notes.md` et `src/shared/releases.json` (historique affiché dans « Quoi de neuf »). Aucun `feat`/`fix`/`perf`/breaking : le workflow finit en vert sans rien publier.
   - typecheck, tests unitaires, injection de la version (`npm version`), build ;
   - packaging electron-builder, signature Developer ID et notarisation Apple (secrets exposés uniquement à cette étape) ;
   - vérification Gatekeeper/staple et smoke test du binaire Claude embarqué ;
   - création du tag `vX.Y.Z` et de la release GitHub (dmg, zip, blockmaps, `latest-mac.yml`).
4. Les apps installées se mettent à jour via `electron-updater` (bandeau « Redémarrer », brouillons et fichiers non enregistrés préservés).

Ne jamais créer de tag ni modifier `version` dans `package.json` à la main : c'est la CI qui s'en charge.

## Workflow attendu de Claude

- Lire le code existant et la spec concernée avant de modifier ; réutiliser les helpers en place.
- Travailler sur une branche dédiée depuis `develop`, jamais directement sur `develop` ou `master`.
- Commits et push uniquement quand c'est demandé.
- Vérifier (typecheck, tests) avant d'annoncer qu'une tâche est terminée, et dire honnêtement ce qui n'a pas été vérifié.
- Appliquer le TDD (cf. « Tests ») : test qui échoue d'abord, code ensuite.
- **Après chaque commit**, vérifier que ce `CLAUDE.md` est toujours à jour (commandes, architecture, conventions, release, workflow). S'il ne l'est plus, le corriger dans un commit `docs` dédié.
