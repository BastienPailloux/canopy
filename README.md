# Canopy

Application Mac qui remplace l'IDE pour un « product builder » : on passe de l'idée à la PR en pilotant Claude Code plutôt qu'en écrivant le code à la main.

Une seule fenêtre réunit :

- **Sessions** : worktrees git à gauche, conversations Claude Code au centre, terminal en bas, changements à droite. Changer de worktree ou d'onglet n'arrête aucune session.
- **Code** : tout le code de la branche, avec le diff par rapport à sa branche de base (les changements restent visibles après un commit de Claude).
- **PR** : la pull request de la branche, gérée via `gh`.
- **Tickets** : tickets locaux (Markdown dans `.tickets/`, avec sous-tickets et modèles) ou Linear, lancés en un clic dans un nouveau worktree.
- **Maquettes** : galerie des maquettes du dépôt, liées aux tickets.
- **Dépendances** : vérification en arrière-plan des vulnérabilités (OSV) et des versions obsolètes des lockfiles.
- **Tester la PR** : setup et services d'un worktree lancés depuis l'app (`.canopy/config.json`).

## Prérequis

- macOS sur Apple Silicon.
- Un compte Claude utilisable par Claude Code.
- Facultatif : [`gh`](https://cli.github.com/) authentifié pour l'onglet « PR », un compte Linear pour les tickets Linear.

## Installation

Télécharger le `.dmg` de la dernière [release](https://github.com/BastienPailloux/canopy/releases), puis glisser Canopy dans Applications. L'app est signée et notarisée, et se met à jour toute seule (bandeau « Redémarrer »).

Pour ouvrir un dossier depuis un terminal, menu Canopy → « Installer la commande canopy » (lien dans `~/.local/bin`), puis :

```sh
canopy .           # ouvre le dossier courant
canopy ~/code/app  # ouvre un autre dossier
```

## Configurer « Tester la PR »

`.canopy/config.json` à la racine du dépôt décrit les commandes de préparation et les services à lancer dans un worktree. Le port attribué est fourni dans `PORT`.

```json
{
  "setup": ["npm install"],
  "services": [
    { "name": "web", "command": "npm run dev -- --port $PORT" }
  ]
}
```

Ce réglage peut aussi se faire par dépôt dans Réglages → « Tester la PR », qui remplace alors le fichier.

## Développement

Node 24 (comme la CI).

```sh
npm install          # postinstall : electron-rebuild de node-pty
npm run dev          # app en dev, hot reload du renderer
npm run typecheck    # tsc --noEmit
npm test             # tests unitaires Vitest
npm run test:e2e     # build puis Playwright sur l'app Electron
npm run build        # build electron-vite vers out/
```

Aucun test ne lance de vraie session Claude ni ne touche au réseau : les E2E remplacent le SDK, Linear, `gh` et les registres par des doublures (variables `CANOPY_FAKE_*`).

Architecture, conventions, TDD, branches et Conventional Commits : voir [`CLAUDE.md`](CLAUDE.md). En bref :

- Electron + React 19 + Zustand, TypeScript strict. `src/main` (process principal), `src/preload` (pont `window.canopy`), `src/renderer` (UI), `src/shared` (contrats IPC).
- Branches `<type>/<sujet>` depuis `develop`, PR vers `develop` avec un titre Conventional Commit (mergées en squash).
- La version et les notes « Quoi de neuf » sont calculées depuis les commits : ne jamais modifier `version` ni créer de tag à la main.

## Documentation

- Conception : [`docs/superpowers/specs/`](docs/superpowers/specs/) (document de référence : `2026-11-07-canopy-design.md`).
- Plans d'implémentation : [`docs/superpowers/plans/`](docs/superpowers/plans/).
- Publication d'une version (signature, notarisation, CI) : [`docs/release.md`](docs/release.md).
