# Canopy : versions, releases et mises à jour automatiques

Date : 2026-11-07

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Bastien veut qu'un merge sur `master` suffise à livrer une nouvelle version de Canopy à tous ses utilisateurs, sans étape manuelle **[Bastien]**.

Aujourd'hui personne d'autre n'utilise Canopy. Bastien enverra l'installer à quelques personnes, puis Canopy deviendra peut-être une vraie application publique à télécharger **[Bastien]**. Le dispositif doit donc marcher dès maintenant pour quelques personnes et tenir plus tard pour une distribution publique, sans refonte.

## 2. État actuel

- Application Electron (electron-vite + electron-builder), cible `dmg` macOS arm64 uniquement.
- Application non signée (`identity: null` dans `electron-builder.yml`), aucun mécanisme de mise à jour.
- `package.json` est en `0.1.0`. Aucun tag git.
- Repo GitHub public `BastienPailloux/canopy`. `develop` est la branche par défaut et de travail. `master` existe.
- Les commits suivent déjà Conventional Commits (`feat(shell): …`, `fix(cli): …`).
- `src/main/quit.ts` centralise la sortie de l'app. Il demande une confirmation quand des sessions Claude, des terminaux, des fichiers non enregistrés (`buffers`) ou des brouillons de message (`drafts`) seraient perdus.
- Les sessions Claude peuvent être reprises par leur identifiant (`resumeId` dans `SessionManager`).
- Bastien a un compte Apple Developer **individuel**, dont il est donc titulaire (Account Holder) **[Bastien]**. Il peut créer lui-même le certificat Developer ID Application et une clé API App Store Connect d'équipe, sans dépendre de personne. Le guide (§8) part de zéro : création du certificat, puis export.

## 2 bis. Identité de l'application

À figer avant la première release signée (`v1.0.0`). Après, un changement casserait la mise à jour automatique chez tous les utilisateurs.

- **Bundle ID : `io.github.bastienpailloux.canopy`**, en remplacement de `dev.canopy.app`. Bastien ne prendra pas de nom de domaine **[Bastien]**. Un identifiant basé sur un domaine qui ne lui appartient pas pourrait entrer en conflit avec celui de son propriétaire. `bastienpailloux.github.io` lui appartient de fait, c'est la convention habituelle sans domaine **[Choix conception]**.
- **Nom : `Canopy`**, inchangé. Le dossier de données reste `~/Library/Application Support/Canopy` **[Choix conception]**.
- Conséquence pour l'installation actuelle de Bastien : en passant d'une app non signée à une app signée, macOS peut redemander l'accès au trousseau, ou la clé API Anthropic enregistrée via `safeStorage` peut devenir illisible. Dans ce cas, Canopy doit simplement redemander la clé, sans planter **[Choix conception]**.

## 3. Objectifs

1. Un push sur `master` produit automatiquement une version numérotée, signée et notarisée, publiée en GitHub Release.
2. Le numéro de version est calculé à partir des commits **[Bastien]**.
3. Chaque Canopy installé détecte la nouvelle version, la télécharge, l'annonce de façon bien visible **[Bastien]** et l'installe.
4. Personne ne reste indéfiniment sur une ancienne version : le redémarrage devient obligatoire 24 h après le téléchargement **[Bastien]**.
5. Une mise à jour ne fait perdre ni fichier non enregistré ni brouillon de message **[Bastien]**.
6. Après une mise à jour, l'utilisateur voit ce qui a changé **[Bastien]**.

Critère de succès : Bastien merge `develop` dans `master` et, sans autre action, un Canopy installé sur une autre machine affiche le bandeau de la nouvelle version dans les heures qui suivent. Après redémarrage, l'utilisateur retrouve ses fichiers non enregistrés et voit le panneau « Quoi de neuf ».

## 4. Non-objectifs

- Mac Intel, build universel, Windows, Linux.
- Canaux beta/nightly, mises à jour différentielles, retour arrière automatique vers une version précédente.
- Site de téléchargement. La page GitHub Releases en tient lieu.
- Mac App Store.
- Releases depuis `develop` ou depuis une branche de feature.

## 5. Anti-objectifs (échec même si « ça marche »)

- Une mise à jour fait perdre du travail non enregistré.
- Un redémarrage forcé arrive sans avertissement.
- Une release non signée ou non notarisée est publiée et proposée aux utilisateurs.
- Les secrets Apple sont accessibles à du code venant d'une PR externe ou d'une branche autre que `master`.
- Une release est publiée alors que le typecheck ou les tests échouent.

## 6. Versions

- La source de vérité est le tag git `vX.Y.Z` sur `master`. La CI injecte la version dans `package.json` au moment du build, sans commit de retour sur `master`. On évite ainsi que `master` et `develop` divergent à chaque release. Le `version` de `package.json` dans le repo n'a donc pas de sens et peut rester à `0.1.0` **[Choix conception]**.
- Le calcul porte sur tous les commits atteignables depuis `master` depuis le dernier tag `v*`, y compris ceux arrivés par un merge de `develop`. Les merges `develop` → `master` doivent donc être de vrais merges ou des fast-forwards, pas des squash, sinon les types de commit sont perdus **[Choix conception]**.
- Règles **[Bastien]** pour le principe, **[Choix conception]** pour le détail :
  - `fix:` / `perf:` → patch.
  - `feat:` → minor.
  - `feat!:`, `fix!:` ou un pied de commit `BREAKING CHANGE:` → major.
  - Aucun commit `feat`/`fix`/`perf`/cassant (seulement `chore`, `docs`, `test`, `refactor`, `ci`, …) → pas de release. Le workflow se termine sans erreur.
- S'il n'existe encore aucun tag, la première release est `v1.0.0` **[Bastien]**. Ses notes couvrent tout l'historique : on les remplace par un texte court « Première version » plutôt que des dizaines de lignes **[Choix conception]**.
- Note : `master` et `develop` sont aujourd'hui au même commit, et tout le travail est sur `feat/v1`. Le premier push sur `master` après la mise en place de ce dispositif produira la première release.
- Le choix de l'outil (semantic-release configuré sans commit de retour, release-please, script maison…) est laissé au builder, tant que les règles ci-dessus sont respectées.

## 7. Pipeline de release (GitHub Actions)

Déclencheur : `push` sur `master` uniquement. Le workflow ne s'exécute jamais sur `pull_request` **[Choix conception]**.

Étapes, dans l'ordre :

1. Calculer la prochaine version. S'il n'y en a pas, arrêter avec succès.
2. Sur un runner macOS arm64 hébergé par GitHub : `npm ci`, typecheck, tests unitaires (`npm test`). Inclure les tests e2e dans la barrière est laissé au builder, selon leur fiabilité en CI.
3. Build electron-vite, puis electron-builder avec :
   - cibles `dmg` **et** `zip` arm64 (le `zip` est requis par la mise à jour automatique sur macOS) ;
   - signature Developer ID Application, hardened runtime, entitlements nécessaires à Electron et aux binaires natifs ;
   - notarisation et staple ;
   - fichier `latest-mac.yml` produit pour `electron-updater`.
4. Seulement si tout a réussi : créer le tag `vX.Y.Z`, puis la GitHub Release (non draft, non prerelease) avec le `dmg`, le `zip`, les `.blockmap`, `latest-mac.yml` et les notes de release. Un échec avant ce point ne laisse ni tag ni release **[Choix conception]**.
5. Les secrets Apple ne sont exposés qu'aux étapes de signature et de notarisation. Les scripts d'installation des dépendances (`npm ci`, `postinstall`) ne s'exécutent jamais avec ces secrets dans leur environnement **[Choix conception]**.
6. Deux pushs rapprochés sur `master` ne doivent pas produire deux releases en parallèle (`concurrency` sur le workflow, sans annulation de celui en cours) **[Choix conception]**.

### Risque technique connu

Les binaires sortis de l'asar (`asarUnpack` : agent SDK Claude, `node-pty` et son `spawn-helper`, ripgrep, typescript-language-server, tsserver) et le script `build/cli/canopy` doivent être signés et doivent fonctionner sous hardened runtime. C'est la partie la plus susceptible de casser. Il faut le vérifier sur une vraie build notarisée : sessions Claude, terminal, recherche, langage TS et commande `canopy .`.

## 8. Secrets Apple

Stockage **[Choix conception, approuvé par Bastien sur recommandation]** : secrets d'un **Environment GitHub `release`** dont la règle de déploiement n'autorise que la branche `master`. Ajouter une approbation manuelle est une option laissée à Bastien, désactivée par défaut puisque l'objectif est « merge = livraison ».

| Secret | Contenu |
|---|---|
| `CSC_LINK` | Certificat Developer ID Application exporté en `.p12`, encodé en base64 |
| `CSC_KEY_PASSWORD` | Mot de passe du `.p12` |
| `APPLE_API_KEY` | Clé API App Store Connect (`.p8`), contenu ou base64 selon ce qu'attend l'outil |
| `APPLE_API_KEY_ID` | Key ID de la clé |
| `APPLE_API_ISSUER` | Issuer ID |

La publication de la release utilise le `GITHUB_TOKEN` du workflow (permission `contents: write`). Le plan doit inclure un guide pas à pas pour que Bastien crée le certificat, l'exporte, crée la clé API et remplisse l'Environment.

## 9. Mise à jour côté application

Bibliothèque : `electron-updater`, provider GitHub, repo public, donc pas de token embarqué **[Choix conception]**. Il est désactivé en développement (`app.isPackaged` faux).

### Détection et téléchargement

- Vérification au lancement puis toutes les 4 heures **[Choix conception]**.
- Téléchargement automatique en arrière-plan, sans rien afficher pendant le téléchargement **[Choix conception]**.
- Une erreur réseau ou de vérification est silencieuse pour l'utilisateur (journalisée) et sera retentée à la vérification suivante **[Choix conception]**.

### Annonce **[Bastien]**

- Dès que la mise à jour est téléchargée, un bandeau bien visible apparaît : « Nouvelle version X.Y.Z » avec un bouton **Redémarrer**. Il indique aussi l'heure du redémarrage obligatoire.
- Le bandeau ne peut pas être fermé. Il reste jusqu'au redémarrage **[Choix conception]**.
- Si l'utilisateur quitte Canopy normalement entre-temps, la mise à jour s'installe à la fermeture (`autoInstallOnAppQuit`). La fermeture normale garde la confirmation existante de `quit.ts`.

### Redémarrage forcé **[Bastien]**

- Échéance : 24 h après la fin du téléchargement, mesurée en temps réel. Si le Mac était en veille au moment de l'échéance, le compte à rebours de 10 minutes démarre au réveil, il n'y a jamais de redémarrage sans préavis **[Choix conception]**.
- 10 minutes avant : avertissement visible avec compte à rebours et bouton « Redémarrer maintenant ». On ne peut pas le repousser.
- Si une version encore plus récente arrive alors qu'une mise à jour attend, elle remplace celle en attente, mais l'échéance reste celle du premier téléchargement. Sinon, des releases fréquentes repousseraient le redémarrage indéfiniment **[Choix conception]**.

### Redémarrage pour mise à jour (bouton ou forcé)

Les deux chemins passent par la même séquence de mise de côté (§10), puis `quitAndInstall`.

- Clic sur **Redémarrer** avec des sessions Claude en cours ou des terminaux actifs : une confirmation indique ce qui sera arrêté (réutiliser `quitDetail`). Elle annonce que les fichiers non enregistrés et les brouillons sont conservés, au lieu de « Seront perdus » **[Choix conception]**.
- Redémarrage forcé : aucune confirmation, l'avertissement des 10 minutes en tient lieu.

## 10. Mise de côté et restauration **[Bastien]** pour le principe

Avant un redémarrage pour mise à jour, Canopy enregistre dans son dossier de données (`userData`), dans un fichier unique et écrit de façon atomique :

- **Fichiers non enregistrés de l'éditeur** : chemin, worktree, contenu modifié, et une empreinte (hash) du contenu disque sur lequel portaient les modifications. Les fichiers sur le disque **ne sont pas modifiés** **[Bastien]**.
- **Brouillons de message Claude** (composer), par session.
- **Sessions Claude en cours** : identifiants des sessions interrompues.
- **Contexte** : dossier ouvert et worktree sélectionné. Le mécanisme existant `lastEntries` couvre peut-être déjà ce point.

Après le redémarrage :

- Les fichiers mis de côté se rouvrent dans l'éditeur à l'état « non enregistré », avec les modifications.
  - Si le fichier sur le disque a changé entre-temps (empreinte différente), on ne fusionne ni n'écrase rien en silence : on prévient l'utilisateur sur ce fichier.
  - Si le fichier a été supprimé, ses modifications restent récupérables, l'utilisateur ne doit pas les perdre.
  - Le détail de l'interface est laissé au builder **[Choix conception]**.
- Les brouillons réapparaissent dans le composer de leur session.
- Les sessions interrompues sont reprises par leur `resumeId`, sans relancer automatiquement la dernière demande. Un message dans la session indique qu'elle a été interrompue par la mise à jour. La reprise effective se fait au prochain message de l'utilisateur **[Choix conception]**.
- Les terminaux ne sont pas restaurés : les processus sont perdus et l'avertissement l'a annoncé.
- Le fichier de mise de côté est supprimé une fois la restauration faite. S'il est illisible, il est ignoré et le lancement continue.

Cette mise de côté ne concerne que les redémarrages pour mise à jour. La fermeture normale (⌘Q) garde son comportement actuel **[Choix conception]**.

## 11. « Quoi de neuf » **[Bastien]**

- Au premier lancement d'une nouvelle version, un panneau « Quoi de neuf dans X.Y.Z » s'affiche. Si plusieurs versions ont été sautées, il montre les notes de chacune, de la plus récente à la plus ancienne. On le ferme par un bouton.
- Canopy mémorise la dernière version vue (dans `prefs` de `appStore`). Il n'y a pas de panneau au tout premier lancement après une installation fraîche **[Choix conception]**.
- Source des notes : un fichier généré par la CI au moment du build et embarqué dans l'app, contenant l'historique de toutes les releases. Le panneau marche donc hors ligne et sans appel à l'API GitHub **[Choix conception]**.
- Contenu : sections « Nouveautés » (`feat`) et « Corrections » (`fix`, `perf`), une ligne par commit avec le sujet du commit sans son préfixe de type ni son scope. Les mêmes notes sont utilisées pour la GitHub Release **[Choix conception]**.

## 12. Ce qui est laissé au builder

- L'outil de calcul de version et de génération des notes (§6).
- L'inclusion des tests e2e dans la barrière de release.
- La liste exacte des entitlements.
- Le design visuel du bandeau, de l'avertissement et du panneau « Quoi de neuf », dans le style existant (`theme.css`).
- Le format du fichier de mise de côté.
- Comment tester le flux de mise à jour de bout en bout avant la première vraie release (par exemple installer une version N signée, publier N+1, observer).
