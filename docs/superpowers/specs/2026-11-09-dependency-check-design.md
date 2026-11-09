# Vérification des dépendances — conception

Date : 2026-11-09. Statut : validé, implémenté.

## Intention

Bastien ne sait jamais quand une dépendance d'un de ses projets doit être mise à jour. Canopy doit le lui dire sans qu'il y pense, lui montrer clairement ce qui est **à faire absolument**, et lui permettre de confier la mise à jour à Claude en un clic, dans le même flux que le lancement d'un ticket (worktree, branche, session, PR).

## Objectifs

- Détecter automatiquement, pour chaque projet du sélecteur de dépôt, les dépendances directes non à jour.
- Classer chaque dépendance par criticité. Deux signaux rendent une mise à jour **critique** : une faille de sécurité grave connue sur la version installée, ou une version plus maintenue.
- Attirer l'attention quand il y a du critique : bandeau rouge, badge rouge, icône dans le sélecteur de dépôt.
- Permettre de cocher des dépendances et de lancer **une** session Claude qui les met à jour ensemble, dans un worktree.
- Couvrir JavaScript, Ruby et Python.

## Non-objectifs

- **Pas d'« ignorer cette alerte »** : décision explicite de Bastien. Une alerte critique reste rouge tant que le problème existe.
- Pas de mise à jour faite par Canopy lui-même (`npm update` direct) : c'est toujours Claude qui fait la montée, corrige et teste.
- Pas de vérification des dépendances de Canopy (l'app elle-même) : seulement des projets ouverts dedans.
- Pas d'autres écosystèmes (Go, Rust, PHP…) dans cette version.
- Pas de notification système macOS.

## Anti-objectifs (échecs même si « ça marche »)

- Du rouge pour rien : une alerte critique doit être justifiée et son « pourquoi » lisible. Le simple retard de version n'est jamais rouge.
- Une vérification qui ralentit l'app, bloque l'UI ou sature le réseau au démarrage.
- Un résultat inventé quand le réseau ou un registre est indisponible : on affiche le dernier résultat connu et l'erreur, pas un état faux.
- Une dépendance à des outils locaux (`npm`, `bundle`, `pip`) installés et fonctionnels pour *vérifier*. Seul Claude les utilise, au moment de la mise à jour.

## Ce qui a été décidé avec Bastien

1. **Criticité** : faille de sécurité critique, et version plus maintenue.
2. **Sélection** : on coche les dépendances à mettre à jour, et le lancement porte sur la sélection.
3. **Alerte voyante** : maquette « A » retenue. Elle combine un nouvel onglet « Dépendances » avec un badge rouge et un bandeau rouge sous l'en-tête, visible sur tous les écrans.
4. **Langages** : JavaScript, Ruby, Python.
5. **Autres projets** : une petite icône dans le sélecteur de dépôt signale qu'un projet n'est pas à jour.
6. **Pas d'option « ignorer »**.

## Comportement

### Niveaux de criticité

| Niveau | Couleur | Règle |
|---|---|---|
| **Critique** | rouge (`--del`) | faille connue de gravité *critique* ou *haute* sur la version installée ; **ou** paquet/version marqué déprécié par le registre (npm `deprecated`), version retirée (PyPI/RubyGems *yanked*), ou projet PyPI au statut `Development Status :: 7 - Inactive` |
| **À prévoir** | orange (`--warn`) | faille *modérée* ou *faible* ; **ou** au moins 2 versions majeures de retard ; **ou** aucune publication du paquet depuis plus de 2 ans (inactivité seule, jamais rouge) |
| **Peut attendre** | gris | une version plus récente existe, sans autre signal |

Les dépendances à jour ne sont pas listées. La colonne « Pourquoi » donne la raison la plus grave en clair, en français (« Faille critique : exécution de code à distance », « Déprécié : remplacé par X », « 3 versions majeures de retard », « Aucune publication depuis 2023 »). La version cible proposée est la dernière version stable. Pour une faille, on indique aussi la première version corrigée si elle est plus proche.

**Gravité des failles (décidé avec Bastien) :** rouge dès la gravité *haute*. Quand OSV ne donne pas d'étiquette, la gravité se déduit du score CVSS de base : 9 et plus = critique, 7 et plus = haute, sous 7 = modérée/faible. Une faille sans étiquette ni score passe en orange, « Faille de gravité inconnue ».

*Mes choix (à vérifier) :* les seuils « 2 majeures » et « 2 ans » sont des constantes nommées faciles à changer. En Ruby, faute de marqueur officiel, l'abandon repose surtout sur l'inactivité, donc en orange : c'est assumé.

### Périmètre analysé

- Dépendances **directes** seulement (déclarées dans le manifeste), versions lues dans le lockfile pour savoir ce qui est réellement installé. Une faille sur une dépendance transitive est remontée sur la dépendance directe qui l'amène, quand le lockfile permet de le savoir (npm, Bundler). Sinon elle est ignorée dans cette version.
- Fichiers reconnus :
  - JS : `package.json` + `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` ;
  - Ruby : `Gemfile` + `Gemfile.lock` ;
  - Python : `uv.lock`, `poetry.lock`, `Pipfile.lock`, sinon `requirements*.txt` (versions épinglées `==` seulement ; une ligne non épinglée est listée sans criticité de faille).
- Les manifestes sont cherchés dans tout le dépôt (monorepo), hors `node_modules`, `vendor`, `.venv`, `.worktrees`. Chaque ligne indique le fichier d'origine si le dépôt en a plusieurs.
- *Mon choix :* on lit les fichiers **sur la branche de base** du dépôt (`git ls-files` / `git show <base>:<chemin>`, base via `cachedBaseRef`), pas dans le checkout courant. C'est de là que partira la branche de mise à jour, et le résultat ne dépend pas d'un worktree en cours de modification.
- *Mon choix :* `cachedBaseRef` renvoie en général la branche distante (`origin/develop`), que rien dans Canopy ne rafraîchit aujourd'hui. Avant chaque vérification, on lance donc un `git fetch <remote> <branche de base>` **non interactif** (`GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`), avec un délai d'expiration. Si ce fetch échoue (identifiants, hors ligne), on vérifie la ref telle qu'elle est et l'onglet le signale (« Branche de base non rafraîchie : <raison> »). Sans ce fetch, une faille corrigée et mergée resterait rouge.
- *Mon choix :* « projet » = **dépôt git**. Une entrée du sélecteur qui est un dossier contenant plusieurs dépôts (`scanWorkspace`) fait vérifier chacun d'eux. Son icône dans le sélecteur s'allume si l'un d'eux a du critique. L'icône du bouton fermé compte tout dépôt autre que celui affiché, frères du même dossier compris. Cache et événement `deps:changed` sont indexés par racine du checkout principal.
- *Mon choix, pour la sécurité :* on n'envoie **jamais** à OSV ni aux registres publics le nom d'une dépendance qui ne vient pas du registre public. Sont concernés les spécificateurs `workspace:`, `file:`, `link:`, `git:`/URL, `path:`, un paquet résolu depuis un autre registre que `registry.npmjs.org` (champ `resolved` du lockfile), une gem dont la `remote` n'est pas `rubygems.org` ou qui vient d'un bloc `GIT`/`PATH`, et un paquet Python dont l'index n'est pas PyPI. Ces dépendances sont listées en gris, « Source privée ou locale : non vérifiée », non cochables. Ça évite de divulguer des noms privés et d'afficher du faux rouge à cause d'un homonyme public.

### Sources de données (process principal, réseau)

- **Failles** : API OSV (`https://api.osv.dev/v1/querybatch`, écosystèmes `npm`, `RubyGems`, `PyPI`) puis détail des vulnérabilités pour la gravité. Une seule logique pour les trois langages.
- **Versions, dépréciation, dates** : registre npm (`registry.npmjs.org`), `rubygems.org/api/v1/versions/<gem>.json`, `pypi.org/pypi/<pkg>/json`.
- Requêtes avec `fetch` du process principal, concurrence bornée, délai d'expiration. Les réponses des registres sont mises en cache (en mémoire et sur disque dans `userData`) pour ne pas tout redemander à chaque passage.

### Quand ça vérifie

- À l'ouverture de l'app et à l'ajout d'un projet, pour **tous** les projets du sélecteur (`recentRepos`), en arrière-plan, l'un après l'autre.
- Ensuite toutes les 6 heures tant que l'app est ouverte, et quand un lockfile change sur la branche de base (au prochain passage, détecté par le hash de l'objet git).
- Bouton « Revérifier » dans l'onglet.
- Le dernier résultat de chaque projet est conservé sur disque : au démarrage, badges et icônes s'affichent tout de suite, avant la nouvelle vérification.
- En cas d'échec réseau ou registre : on garde le dernier résultat, l'onglet affiche « Dernière vérification : il y a 3 h · échec : <raison> ». Une source en échec ne fait ni apparaître ni disparaître une alerte.

### Interface

**En-tête.** Nouvel onglet « Dépendances » après « Maquettes ». Il porte un badge rouge avec le nombre de dépendances critiques du projet affiché (rien s'il n'y en a pas).

**Bandeau rouge.** Il s'affiche sous l'en-tête, sur tous les écrans, quand le projet affiché a au moins une dépendance critique. Texte : « **2 dépendances critiques** dans canopy : faille critique dans **tar**, **request** n'est plus maintenu », puis bouton « Voir » qui ouvre l'onglet. Au-delà de 2 ou 3 paquets, le texte résume (« … et 3 autres »). Le bandeau a une croix. Une fois fermé, il ne revient que si une **nouvelle** dépendance critique apparaît pour ce projet. Le badge, lui, reste. Ce n'est pas un « ignorer » : rien n'est masqué dans l'onglet ni dans le badge.

**Sélecteur de dépôt.** Chaque projet de la liste qui a au moins une dépendance critique porte une petite icône d'alerte rouge à côté de son nom. Elle est distincte du badge « une session attend ta réponse » déjà présent : les deux peuvent coexister. Le bouton fermé du sélecteur porte aussi l'icône si un **autre** projet que celui affiché est concerné. Cela reprend le modèle `useAttention` / `elsewhere` de `RepoPicker.tsx`.

**Onglet « Dépendances ».** Il montre un tableau pour le projet affiché, avec les colonnes case à cocher, paquet, langage/fichier, installée, cible, criticité, pourquoi. Tri : Critique, puis À prévoir, puis Peut attendre, puis par nom. Les critiques sont **pré-cochées**. Une case en tête permet de tout cocher. Des liens mènent à l'avis de faille et à la page du registre (via `externalLinks`). Un état vide indique « Tout est à jour » avec la date de vérification, et un état « Aucun fichier de dépendances reconnu » couvre les autres cas. En bas, on voit le compteur de sélection et le bouton « Lancer Claude sur la mise à jour ».

Référence visuelle : `.superpowers/brainstorm/60211-1794211798/content/alerte-et-liste.html`, option A.

### Lancement de Claude

- Le bouton ouvre le même panneau de lancement que les tickets (`LaunchPanel` / `launchCandidates`) : nouveau worktree ou worktree libre existant, nom de branche modifiable. Branche par défaut : `chore/deps-<AAAA-MM-JJ>`, ou `fix/deps-<AAAA-MM-JJ>` si la sélection contient une faille (au sens Conventional Commits, une correction de sécurité est un `fix`).
- La session reçoit un prompt qui liste, pour chaque dépendance cochée : langage, fichier manifeste, version installée, version cible, raison (avec identifiant d'avis de faille et version corrigée le cas échéant). Il donne aussi la consigne : mettre à jour avec l'outil du projet (`npm`/`pnpm`/`yarn`, `bundle update`, `uv`/`poetry`/`pip`), corriger ce qui casse, lancer les tests, signaler plutôt que forcer une montée majeure trop risquée, puis préparer la PR.
- Aucun fichier n'est écrit dans le dépôt par le lancement (pas de ticket créé). Après le lancement, Canopy bascule sur Sessions dans le worktree, comme `runLaunch`.
- La vérification suivante, après merge sur la base, fait disparaître les alertes résolues.

## Contraintes (projet)

- Contrat IPC dans `src/shared/api.ts`, exposé dans `src/preload/index.ts`, géré dans un module `src/main/deps/depsIpc.ts`. Événement `deps:changed` `{ repo }` sur le canal `canopy:event`.
- Logique pure et testable dans `src/main/deps/` (parseurs de lockfiles, calcul de criticité, construction du prompt dans `src/shared/`), injectée dans `index.ts`. Le réseau est derrière une interface injectable.
- Pour les E2E, un `CANOPY_FAKE_DEPS=tests/fixtures/deps` rejoue des réponses OSV/registres capturées, ignoré en build packagé, sur le modèle de `src/main/linear/replay.ts`.
- TDD. Tests Vitest dans `tests/main/deps/`, avec de vrais repos temporaires (`tests/helpers/repo.ts`). Spec Playwright `tests/e2e/deps.spec.ts` (bandeau, badge, icône du sélecteur, sélection, lancement).
- Textes visibles en français avec « », code en anglais.
- Aucun nouveau binaire spawné, donc rien à ajouter en `asarUnpack`. Les seuls spawns sont des appels `git` via `execFile`.
- Valider le `repo` reçu par IPC comme le font `tickets` et `repoTrust`.

## Laissé au builder

- Structure exacte des modules, format du cache disque, stratégie de concurrence et de délais.
- Détails des parseurs (notamment `yarn.lock` v1 et berry, `pnpm-lock.yaml`), dans la limite du périmètre ci-dessus.
- Le texte exact du prompt de lancement et des libellés « pourquoi », dans l'esprit décrit.
- Le style précis de l'icône du sélecteur et du bandeau, cohérent avec `theme.css` et la maquette A.
- Le découpage en commits et en PR. Une livraison par étapes est acceptable : moteur et JS d'abord, puis Ruby et Python, puis l'UI complète, tant que la PR finale couvre tout.
