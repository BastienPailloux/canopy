# Canopy : document de conception

Date : 2026-11-07
Maquette de référence : https://claude.ai/artifact/WcXTxNhxSWaDL28ttqjZye (titrée « Worktree Studio », ancien nom de Canopy)

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Canopy est une application Mac qui remplace l'IDE pour un product builder : quelqu'un qui passe de l'idée à la PR en pilotant Claude Code, plus qu'en écrivant du code à la main.

Trois douleurs vécues avec l'IDE actuel en sont l'origine **[Bastien]** :

1. Voir le code de chaque worktree oblige à ouvrir l'application plusieurs fois.
2. Les modifications de Claude deviennent invisibles dès qu'il commit, car l'IDE montre le working copy et non l'écart avec la branche par défaut.
3. Rien n'est prévu pour la partie réflexion / product management.

Canopy réunit donc dans une seule fenêtre le cycle penser, affiner, lancer, suivre, vérifier.

## 2. Utilisateurs

Bastien d'abord. D'autres personnes l'utiliseront probablement à terme **[Bastien]**. La V1 ne vise pas la distribution, mais rien ne doit la rendre impossible (voir risque R1).

## 3. Objectifs

Critère de succès de la V1 : Bastien ferme son IDE pour une journée de travail réelle, avec au moins trois worktrees et des sessions Claude en parallèle, sans rouvrir l'IDE.

Le produit complet couvre les 7 écrans de la maquette :

| # | Écran | Rôle |
|---|-------|------|
| 1 | Sessions | Worktrees à gauche, conversations Claude Code au centre, terminal en bas, changements à droite |
| 2 | Code | Tout le code de la branche, filtre « modifiés », diff vs branche par défaut |
| 3 | Tickets | Liste, source au choix, lancement en un clic |
| 3b | Modifier un ticket | Détail, propriétés, sous-tâches, maquettes liées |
| 4 | Maquettes | Galerie des maquettes du repo |
| 4b | Modifier une maquette | Vue intégrée + conversation qui connaît le code |
| 5 | Créer avec Claude | Besoin décrit, Claude propose tickets et maquette en brouillon, validation humaine |

## 4. Non-objectifs et anti-objectifs

Non-objectifs de la V1 **[Choix conception]** :

- Pas d'autocomplétion, de debugger ni d'extensions. L'édition de fichier reste simple.
- Pas de plusieurs repos affichés en même temps : une fenêtre, un sélecteur pour changer. Changer de repo n'arrête rien (section 6).
- Pas de Windows ni de Linux, même si Electron le permet plus tard.
- Pas de compte Canopy, de serveur ni de télémétrie.

Anti-objectifs, ce qui serait un échec même si ça marche **[Choix conception]** :

- Une session se perd ou s'arrête quand on change de worktree ou d'onglet.
- Un diff faux ou incomplet : c'est la raison d'être de l'écran Code.
- Un brouillon de Claude part vers Linear sans validation humaine **[Bastien, via la maquette]**. Une action explicite de l'utilisateur (modifier un champ, commenter, cocher « Passer En cours » au lancement) vaut validation et s'écrit directement. Les écritures via un MCP Linear dans une session suivent les autorisations normales de Claude Code **[Choix conception]**.
- Devoir retourner dans un terminal externe pour une action courante de Claude Code.

## 5. Ordre de construction

**[Bastien]** pour la priorité sessions/worktrees/code avant le reste. **[Choix conception]** pour l'ordre des étapes 2 à 4, Bastien n'ayant pas tranché la place des tickets locaux.

1. **V1 : sessions, worktrees, code, terminal.** Écrans 1 et 2.
2. **Tickets dans l'app.** Écrans 3 et 3b, source locale, lancement en un clic.
3. **Connecteur Linear.** Récupération et modification des tickets.
4. **Maquettes et création avec Claude.** Écrans 4, 4b et 5.

Le premier travail est un spike de quelques heures qui valide les hypothèses de la section 9 avant de construire l'interface.

## 6. Comportement de la V1

### Repo et worktrees

- Ouvrir un repo local. Mémoriser les repos récents.
- Changer de repo n'arrête ni sessions, ni terminaux, ni serveurs : ils sont gérés globalement dans le process principal, et le sélecteur de repo signale tout repo où Claude attend une réponse **[Choix conception]**.
- Lister les worktrees avec `git worktree list`, y compris ceux créés hors de Canopy.
- Chaque entrée affiche : branche, statut, ticket, +/− vs branche par défaut, commits d'avance, port.
- Créer un worktree depuis l'app, depuis une base au choix. Emplacement par défaut : `<repo>/.worktrees/<nom>`, comme dans les repos actuels de Bastien, et modifiable **[Choix conception]**.
- Supprimer un worktree avec confirmation, en signalant tout travail non commité ou non poussé **[Choix conception]**.

Statuts d'un worktree, du plus prioritaire au moins prioritaire **[Choix conception]** :

| Statut | Source |
|--------|--------|
| Attend ta réponse | Une session Canopy attend une autorisation ou une réponse |
| Claude travaille | Une session Canopy tourne |
| PR ouverte | `gh pr view` sur la branche, si `gh` est disponible |
| Inactif | Le reste |

Une session lancée hors de Canopy dans un autre terminal ne donne pas de statut en direct : seule sa date de dernière activité est connue.

### Sessions

- Conversation rendue en interface graphique comme sur la maquette : messages, cartes d'outils, diff inline, commandes en cours, bouton Interrompre. Pas de terminal `claude` embarqué **[Choix conception, non contesté par Bastien]**.
- Plusieurs sessions par worktree en onglets, et plusieurs worktrees actifs en parallèle.
- Les sessions tournent dans le process principal d'Electron. L'interface ne fait que les afficher : changer de vue ne les interrompt jamais **[Choix conception]**.
- Les demandes d'autorisation et les questions de Claude apparaissent dans la conversation.
- Compositeur : texte, collage d'image, mention `@fichier`, slash commands avec complétion, sélecteur de mode, sélecteur de modèle, envoi par ⌘↵.
- Slash commands, skills, MCP et CLAUDE.md se comportent comme dans la CLI **[Choix conception, non contesté]**.
- Les sessions déjà lancées dans ce worktree hors de Canopy apparaissent et se reprennent **[Choix conception, non contesté]**.
- « Créer la PR » et « Rebaser sur main » envoient une demande à Claude dans la session active **[Choix conception, non contesté]**.
- À la fermeture de l'app, les sessions en cours s'arrêtent après confirmation et restent reprenables **[Choix conception]**.

### Code

- Arbre de tout le repo sur la branche du worktree, avec filtre « Modifiés » et recherche ⌘P.
- Vue Code avec marquage des lignes ajoutées, et vue Diff.
- Le diff compare le working tree, modifications non commitées incluses, au merge-base avec `origin/<défaut>` si le remote existe, sinon avec la branche locale par défaut **[Choix conception]**. Les commits de Claude restent donc visibles. La douleur 2 impose ce comportement **[Bastien]**.
- Branche par défaut lue depuis `origin/HEAD`, avec repli sur `main` puis `master`. Branche de comparaison modifiable via le sélecteur de la maquette.
- Rafraîchissement automatique quand les fichiers changent.
- Recherche de texte dans tout le worktree, avec résultats cliquables **[Bastien : usage quotidien]**.
- Aller à la définition d'une fonction et lister tous ses appels, au clic dans le code **[Bastien : usage quotidien]**. Passe par un serveur de langage, TypeScript/JavaScript d'abord. Pour les autres langages, repli sur la recherche de texte **[Choix conception]**.
- ⌘K recherche fichiers, symboles et texte du worktree actif **[Choix conception]**.
- Édition simple avec sauvegarde. « Demander à Claude » envoie le fichier et la sélection à la session active.

### Terminal

- Plusieurs terminaux par worktree, lancés dans son dossier.
- Scripts de démarrage déclarés dans `.canopy/config.json`, versionné. La maquette écrit `.worktree.json` ; regrouper sous `.canopy/` est un **[Choix conception]**.
- Ports réservés par worktree, enregistrés localement, pour faire tourner plusieurs worktrees sans conflit. La configuration déclare un ou plusieurs services nommés, chacun avec sa variable d'environnement, `PORT` par défaut **[Choix conception]**.
- Un lien `localhost:<port>` par service, boutons Redémarrer et Arrêter, « Envoyer les logs à Claude ».
- « Tester la PR » lance les scripts de démarrage et ouvre le terminal.

## 7. Étapes suivantes

### Tickets

- Une abstraction de source unique. Les écrans et le bouton Lancer sont identiques quelle que soit la source **[Bastien, via la maquette]**.
- Source par défaut : dans l'app, en Markdown dans `.tickets/`, versionné avec le repo **[Bastien]**.
- Canopy lit et écrit les tickets uniquement dans le checkout principal, jamais dans les worktrees, pour que tous voient le même état immédiatement **[Bastien]**.
- Les fichiers de `.tickets/` ne sont pas commités automatiquement. Canopy signale les tickets non commités et propose de les commiter sur la branche du checkout principal. Si cette branche refuse les push directs, l'échec est affiché et le flux sera revu à l'étape 2 **[Choix conception]**.
- Modèle commun minimal à toutes les sources : titre, description, statut, priorité, labels, sous-tâches, maquettes liées. Assigné, estimation, cycle, commentaires et activité s'affichent seulement si la source les fournit. Statuts locaux : Backlog, À faire, En cours, En revue, Terminé. Les connecteurs font correspondre leurs statuts à ces cinq-là **[Choix conception]**.
- Claude reçoit le ticket dans son prompt de lancement, pour ne pas lire une copie périmée dans son worktree **[Choix conception]**.
- Connecteurs optionnels : Linear d'abord **[Bastien]**, Jira et GitHub Issues à terme (maquette).

Lancement en un clic, deux options **[Bastien]** :

- Nouveau worktree, depuis la branche par défaut ou une autre base.
- Worktree existant, avec une nouvelle branche démarrée depuis la branche la plus avancée.

« La plus avancée » = parmi les branches checkoutées dans un worktree, celle qui a le plus de commits d'avance sur la branche par défaut, départagée par le commit le plus récent, modifiable avant lancement **[Choix conception]**.

Un worktree est « libre » s'il n'a ni session en cours ni modification non commitée. Son ancienne branche reste intacte, seul le checkout change **[Choix conception]**.

Une branche démarrée ainsi est empilée sur sa base. Canopy mémorise cette base. Le diff reste comparé à la branche par défaut comme demandé, avec un raccourci vers la base dans le sélecteur de comparaison. « Créer la PR » propose la base comme cible **[Choix conception]**.

Options au lancement : démarrer Claude avec la description, joindre la maquette liée, passer le ticket « En cours ».

### Maquettes

- Les maquettes vivent sur claude.ai. Le rendu est une vue intégrée de la page claude.ai **[Bastien]**.
- La conversation est dans Canopy : c'est une session Claude Code lancée dans le repo, qui connaît le code **[Bastien]**. Elle modifie la maquette, puis la vue se recharge.
- Le lien repo ↔ maquette est enregistré dans un fichier versionné sous `.canopy/`, écrit dans le checkout principal comme les tickets, donc partagé avec l'équipe **[Choix conception, non contesté]**. Une maquette privée sur claude.ai peut ne pas s'ouvrir chez un coéquipier, à vérifier avec R6.
- Périmètre de l'écran 4b à préciser avant l'étape 4, une fois R2 et R6 testés. Tant que ce n'est pas fait, Canopy construit seulement la vue intégrée et la conversation. Liste d'écrans, versions, comparaison, commentaires épinglés et export dessinés sur la maquette ne sont repris que si claude.ai les expose **[Choix conception]**.

Voir le risque R2 : ce fonctionnement n'est pas encore garanti.

## 8. Technique

**[Bastien]** a validé Electron + TypeScript sur recommandation.

- Electron, React, TypeScript.
- `@anthropic-ai/claude-agent-sdk` dans le process principal. Version inspectée : 0.3.319. Elle expose `query` avec `resume`, `cwd`, `canUseTool`, `permissionMode`, `includePartialMessages`, ainsi que `listSessions({ dir })`, `getSessionMessages`, `interrupt`, `setModel`, `setPermissionMode`, `supportedCommands`, `supportedModels`.
- Le SDK lit par défaut les réglages user, project et local (CLAUDE.md, `.claude/`). Les sessions sont stockées dans `~/.claude/projects/`, comme celles de la CLI.
- xterm.js et node-pty pour le terminal.
- Monaco pour le code et le diff.
- ripgrep pour la recherche de texte, `typescript-language-server` par worktree pour définitions et références, démarré à la demande.
- Commandes `git` et `gh` de la machine, sans réimplémentation.
- Vue claude.ai : `WebContentsView` avec partition persistante pour conserver le login.
- `contextIsolation` activé, accès disque et process uniquement par IPC depuis le process principal.
- Thème sombre et couleurs repris de la maquette, polices Inter et JetBrains Mono.

**[Choix conception]** pour tout ce qui précède, sauf Electron + TypeScript.

Stockage **[Choix conception]** :

| Donnée | Emplacement |
|--------|-------------|
| Scripts, lien maquettes | `.canopy/` dans le repo, versionné |
| Tickets locaux | `.tickets/` dans le checkout principal |
| Ports, repos récents, préférences | Dossier application de l'utilisateur |
| Secrets (clé API, token Linear) | Trousseau macOS |
| Conversations | `~/.claude/projects/`, géré par Claude Code |

## 9. Risques et hypothèses à valider

**R1. Authentification et distribution.** La documentation du SDK interdit aux éditeurs tiers de proposer le login claude.ai ou ses limites sans accord préalable d'Anthropic, et demande une clé API. Usage personnel : le login Claude Code de Bastien fonctionne. Distribution à d'autres : chaque utilisateur fournit sa clé API et paie à l'usage, ou Bastien obtient un accord écrit. La V1 prévoit un champ clé API pour ne pas fermer cette porte. Décision à prendre avant toute distribution. Source : https://code.claude.com/docs/en/agent-sdk/overview.md

**R2. Modification des maquettes.** Le plan repose sur l'outil `Artifact`. Il figure dans les outils intégrés du SDK, mais la documentation le dit désactivé par défaut dans le SDK, sans option documentée pour l'activer, et il exige un login claude.ai, pas une clé API. Source : https://code.claude.com/docs/en/artifacts.md. À tester avant l'étape 4. Si c'est impossible, il faut revoir comment la conversation écrit la maquette. Ce risque se cumule avec R1 : avec une clé API, les utilisateurs distribués n'y auraient pas accès.

**R3. Reprise des sessions dans les deux sens.** Le stockage est commun, mais la documentation ne confirme pas explicitement la reprise CLI ↔ SDK. Le comportement si une même session est ouverte à la fois dans la CLI et dans Canopy est inconnu.

**R4. Parité avec la CLI.** Plugins, skills et complétion des slash commands dans une session SDK sont à vérifier sur la configuration réelle de Bastien.

**R5. Packaging.** Le SDK embarque un binaire par plateforme et node-pty un module natif. Tous deux doivent survivre au packaging Electron, hors de l'archive asar.

**R6. Vue claude.ai.** Login, cookies et chargement de la page dans une vue Electron sont à vérifier.

**R7. Coût des serveurs de langage.** Un serveur TypeScript par worktree consomme beaucoup de mémoire. Il faut démarrer à la demande et arrêter ceux des worktrees inactifs.

Le spike initial couvre R3, R4 et R5 : une fenêtre Electron packagée qui stream une session, affiche une demande d'autorisation et reprend une session de la CLI. R2 et R6 se testent avant l'étape 4.

Le spike est réussi si une session SDK permet : stream, interruption, autorisations, reprise d'une session CLI, image collée, slash commands et skills de Bastien. Plan B **[Choix conception]** : ce qui manque à l'interface graphique se fait en lançant `claude` dans le terminal intégré de Canopy, ce qui reste conforme à l'anti-objectif sur le terminal externe. Si le stream, les autorisations ou la reprise échouent, on revient à Bastien avant de construire l'écran Sessions.

## 10. Laissé au constructeur

- Découpage du code, gestion d'état, outillage de build et de test.
- Rendu détaillé des cartes d'outils et performance sur les longues conversations.
- Stratégie de surveillance des fichiers et cadence de rafraîchissement git.
- Format exact des fichiers `.canopy/` et `.tickets/`.
- Signature et notarisation, à traiter seulement avant distribution.
