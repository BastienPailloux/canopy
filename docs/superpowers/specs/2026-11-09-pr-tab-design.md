# Canopy — Onglet PR (ticket CAN-5)

Date : 2026-11-09
Spec parente : `2026-11-07-canopy-design.md`.
Maquette de référence : écran **« 2b · Gestion de la PR (GitHub) »** (`PullRequest.dc.html`) de la toile claude.ai « Canopy — maquettes » (`https://claude.ai/artifact/WcXTxNhxSWaDL28ttqjZye`). C'est elle qui fait foi pour la disposition et les libellés. Le présent document fixe le comportement.
Code existant concerné :
- `src/main/git/pr.ts` (`gh pr list`, `GhRunner`) ;
- `src/main/status.ts` (`PrCache`) ;
- `src/renderer/terminal/TerminalControls.tsx` (« Tester la PR ») ;
- `src/renderer/sessions/panelPrompts.ts` ;
- `src/renderer/shell/RemoveWorktreeDialog.tsx` ;
- `src/main/git/switchBranch.ts` ;
- `src/main/linear/` (file `linear-pending.json`) et `src/main/tickets/` ;
- `switchBranch`, `removeWorktree` et `startSession` dans `src/shared/api.ts`.

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Ne plus quitter Canopy pour GitHub quand une branche a une PR. Aujourd'hui, Bastien va sur GitHub pour :
- lire la PR : description, conversation, commentaires de ligne des humains, de Copilot et de Greptile, état de la CI ;
- commenter ;
- demander une relecture à Copilot ;
- assigner ;
- poser des labels ;
- approuver la PR d'un collègue ;
- merger.

Après un merge, il supprime la branche, et le worktree s'il n'a plus rien en cours **[Bastien]**. La maquette 2b ajoute le reste de ce que GitHub permet sur une PR. Tout ce qu'elle montre est dans le périmètre de CAN-5 **[Bastien]**.

Succès :
1. Sur une branche avec PR, Bastien lit la PR et envoie un commentaire de Copilot à Claude.
2. Claude corrige et répond dans le fil.
3. Bastien fait corriger un check rouge par Claude, puis merge.
4. Canopy supprime la branche, bascule le worktree sur sa branche suivante (ou propose de le supprimer) et passe le ticket lié en « Done ».

Il n'ouvre GitHub à aucun moment.

## 2. Objectifs, non-objectifs, anti-objectifs

Objectifs : tout ce que montre la maquette 2b, détaillé sections 3 à 9.

Non-objectifs :
- Créer la PR depuis l'onglet. Le panneau latéral des sessions sait déjà demander à Claude de la créer (`prPrompt`).
- Afficher les commentaires de ligne dans le diff de l'écran Code. C'était l'option C, et Bastien a choisi A **[Bastien]**. L'onglet « Fichiers » renvoie vers le diff de Code.
- PR d'une branche de fork, comme aujourd'hui (`isCrossRepository` est ignoré).
- Nettoyer la branche ou le worktree après un merge fait hors de Canopy **[Bastien]**.
- Démarrer une revue multi-commentaires (« Start a review » de GitHub) : chaque commentaire part seul **[Choix conception]**.

Anti-objectifs :
- Un merge qui laisse le worktree sur une branche supprimée, ou qui supprime un worktree ou des fichiers contenant du travail en cours.
- Une action qui échoue en silence : chaque échec de `gh` s'affiche en français, avec le message de GitHub.
- Demander une nouvelle connexion GitHub : tout passe par `gh`, déjà utilisé et déjà connecté.

## 3. Placement et visibilité

- Onglet « PR » dans l'en-tête, entre « Code » et « Tickets » **[Bastien, option A]**. Son badge compte les conversations non résolues, comme dans la maquette.
- L'onglet montre la **dernière PR de la branche actuelle** du worktree sélectionné, quel que soit son état : ouverte, brouillon, mergée, fermée **[Choix conception, imposé par les états « Mergée » et « Fermée » de la maquette]**.
- Il disparaît si la branche n'a jamais eu de PR. Si l'utilisateur était dessus, il revient sur « Code ».
- La PR est trouvée par la branche (`headRefName`, hors fork). `PrCache` ne lit que les PR ouvertes pour le badge de la liste des worktrees. L'onglet a besoin d'une lecture qui inclut les PR fermées et mergées de la branche.
- La PR d'un collègue s'affiche de la même façon : Bastien ouvre sa branche dans un worktree pour la relire et la tester **[Bastien]**.
- `gh` absent ou non connecté : l'onglet n'apparaît pas, comme le badge actuel.

## 4. En-tête de la PR

- Titre, numéro et badge d'état : « Ouverte », « Brouillon », « Mergée » ou « Fermée ».
- Ligne de contexte : auteur, « veut merger N commits dans `base` depuis `head` », `+ajouts −suppressions`.
- Actions :
  - « Prête pour review » ou « Repasser en brouillon » ;
  - « Fermer la PR » ou « Rouvrir la PR » ;
  - « Ouvrir sur GitHub ↗ ».
- Sous-onglets : « Conversation » (nombre de fils ouverts), « Commits » (nombre), « Checks » (réussis/total), « Fichiers » (nombre). Le badge passe en rouge s'il y a un fil ouvert ou un check en échec.

## 5. Sous-onglet Conversation

- **Description** de la PR en Markdown, avec auteur et date, et le bouton « Modifier » qui l'édite sur place puis l'enregistre sur GitHub. Le rendu réutilise le Markdown existant des sessions.
- **Chronologie**, du plus ancien au plus récent :
  - commentaires généraux ;
  - revues : état, et corps s'il y en a ;
  - événements : commits poussés, approbations, demandes de modifications, résultat de la CI sur un commit ;
  - fils de commentaires de ligne.
- **Fil de commentaire de ligne** :
  - auteur, fichier, lignes, extrait de diff fourni par GitHub, réponses ;
  - état « Résolue » et le fait qu'il soit obsolète (`outdated`) ;
  - fil résolu affiché atténué et replié.
  - Actions :
    - « Répondre » ;
    - « Faire corriger par Claude » (section 8) ;
    - « Résoudre la conversation » / « Rouvrir la conversation ».
- **Auteurs bots** (Copilot, Greptile, `github-actions`…) : affichés comme les humains, avec leur login. Une réponse écrite par Claude depuis Canopy s'affiche « Claude · via Canopy » (section 8).
- **Zone « Ajouter un commentaire »** :
  - mention « Publié sur GitHub sous ton compte » ;
  - bouton « Commenter » ;
  - bouton « Envoyer à Claude », qui envoie ce texte à Claude au lieu de le publier (section 8).
- **Revue** : « Approuver » et « Demander des modifications », avec un commentaire facultatif.
  - Désactivés sur sa propre PR, puisque GitHub l'interdit, avec une infobulle qui l'explique.
  - Emplacement : dans la colonne de droite ou l'en-tête, au choix du constructeur selon la maquette.

## 6. Sous-onglets Commits, Checks, Fichiers

- **Commits** : message, auteur, date, SHA court et résultat de CI (✓ ou ✕) de chaque commit.
- **Checks** :
  - résumé (« Tous les checks passent » ou « 1 check en échec · 4/5 réussis ») et bouton « Relancer les échecs » ;
  - chaque check affiche nom, détail, durée, état, lien « Logs » (dans le navigateur) et « Relancer » ;
  - un check en échec montre un extrait de son log : les dernières lignes d'erreur, limitées à une vingtaine **[Choix conception]**. Il propose aussi « Corriger avec Claude » (section 8).
  - Les checks qui ne viennent pas d'un workflow GitHub Actions, comme l'app Greptile, ne se relancent pas : leur bouton est masqué **[Choix conception]**.
- **Fichiers** :
  - « N fichiers modifiés · M vus » ;
  - pour chaque fichier : type (A/M/D…), chemin, nombre de conversations, `+/−`, et case « Vu ». La case est synchronisée avec l'état « Viewed » de GitHub **[Choix conception]** ;
  - « Ouvrir le diff complet dans Code », qui bascule sur l'écran Code du worktree.

## 7. Colonne de droite

- **Reviewers** :
  - état de chacun : Approuvé, A commenté, Changements demandés, En attente ;
  - relancer la demande auprès de quelqu'un qui a déjà relu ;
  - « Demander une review » ouvre un sélecteur filtrable. Il propose les relecteurs suggérés par GitHub, les équipes (CODEOWNERS), les collaborateurs et les bots relecteurs, dont Copilot. Copilot y figure comme relecteur, pas comme assigné **[Bastien]**.
- **Assignés** : ajout et retrait parmi les collaborateurs du repo.
- **Labels** : ajout et retrait parmi les labels du repo.
- **Ticket lié** :
  - le ticket Linear ou local lancé sur cette branche, par le lien existant (`linearIdOf` et les liens des tickets locaux) ;
  - mention « Passera en « Done » au merge » ;
  - absent s'il n'y a pas de ticket.
- **Session Claude** : état de la session Claude du worktree, avec un lien vers l'écran Sessions.
- **Tester la PR** : même action que le bouton du panneau terminal **[Bastien]**, avec le port affiché (« Lancer les services sur :PORT »).
- **Copier le lien de la PR.**

## 8. Claude depuis l'onglet

Les trois actions vers Claude démarrent chacune une **nouvelle** session sur le worktree **[Bastien]** et basculent sur l'écran Sessions. Le mode de permission est le dernier choisi, comme le fait déjà `startSession`. Les prompts sont en français et construits par des fonctions pures à côté de `panelPrompts.ts`.

- **« Faire corriger par Claude »** (fil de ligne). Le prompt contient :
  - le numéro de PR, l'auteur, le fichier et les lignes ;
  - l'extrait de diff et le fil complet ;
  - une consigne : traiter le commentaire, ou expliquer pourquoi ne pas le faire, puis commiter et pousser ;
  - la consigne de répondre dans le fil quand c'est fini, avec une commande `gh` fournie toute prête (id du commentaire et du repo déjà remplis). La réponse est publiée sous le compte de Bastien. Elle se termine par une signature fixe, par exemple `— Claude via Canopy`, qui permet à Canopy de l'afficher comme « Claude · via Canopy » **[Choix conception]**. Le fil n'est pas résolu automatiquement : Bastien garde la main.
  - Pendant que la session tourne, le bouton devient « Claude traite le retour » ; à la fin, « Claude a traité le retour ».
- **« Envoyer à Claude »** (zone de commentaire général) : le texte saisi, avec le contexte de la PR (numéro, titre). Rien n'est publié sur GitHub.
- **« Corriger avec Claude »** (check en échec) : le nom du check, l'extrait de log, le SHA. La consigne : corriger, commiter, pousser. La CI se relance d'elle-même au push. La condition « Checks » du merge affiche alors « Checks en cours ».

## 9. Merger

Panneau de merge, au bas de la conversation comme dans la maquette.

- **Conditions**, chacune avec son état et, si besoin, son action :
  - Brouillon → « Prête pour review » ;
  - Review (approbations obtenues et requises, revues en attente) ;
  - Conversations non résolues → « Voir » ;
  - Checks → « Corriger avec Claude » ;
  - Branche (conflits, retard sur la base) → « Mettre à jour la branche ».

  Les états viennent de GitHub (`mergeStateStatus`, `reviewDecision`, protections de branche). Une condition que le repo n'impose pas s'affiche à titre d'information, sans bloquer **[Choix conception]**.
- **Méthode** : seulement celles autorisées par le repo, parmi Squash, Commit de merge et Rebase, chacune avec son explication. Squash est le choix par défaut quand il est autorisé **[Bastien a validé le squash]**.
- **Message du commit** : modifiable. Il est prérempli avec le titre de la PR (et le numéro, comme le fait GitHub) et le corps par défaut. Sous le champ, le rappel « Conventional Commit, utilisé pour la release ». Si le sujet ne suit pas le format, un avertissement s'affiche sans bloquer **[Choix conception]**. Pas de champ de message en Rebase.
- **Case « Supprimer la branche distante et le worktree après le merge »** : cochée par défaut, elle déclenche le nettoyage de la section 10. Le libellé de la maquette simplifie : le worktree n'est supprimé que si la règle de la section 10 le permet. Sinon le worktree bascule **[Choix conception, conciliant la maquette et la règle de Bastien]**.
- **Bouton de merge** (« Squash et merger », « Merger », « Rebase et merger ») : désactivé tant qu'une condition bloque, avec le texte « Merge bloqué tant que les points ci-dessus ne sont pas réglés ».
- **Auto-merge** : « Activer l'auto-merge » ou « Désactiver l'auto-merge ». Une fois activé : « Auto-merge activé : mergera dès que tout est vert ». Il n'est proposé que si le repo l'autorise. Si Canopy, ouvert, voit se terminer un auto-merge qu'il a lui-même activé, il fait le nettoyage selon l'état de la case au moment de l'activation. C'est un merge lancé depuis l'onglet **[Choix conception]**.
- **Après le merge**, le panneau devient « PR mergée dans base ». Il donne le détail (méthode, ce qui a été nettoyé, ticket passé en Done) et propose « Annuler (revert) », qui crée la PR de revert sur GitHub. Le revert ouvre une nouvelle PR, sans toucher au worktree, et Canopy affiche son lien **[Choix conception]**.
- **PR fermée** : « PR fermée sans merge. Le worktree et la branche sont conservés. »
- **Ticket lié** : passe en « Done » au merge. Pour Linear, par la file existante (`linear-pending.json`), sans jamais envoyer la description. Pour un ticket local, par le fichier dans `.tickets/` **[Choix conception pour le mécanisme]**.

## 10. Nettoyage après le merge

Il ne se fait que pour un merge lancé depuis l'onglet, auto-merge compris, case cochée. Une PR mergée ailleurs ne touche à rien en local, et l'onglet l'affiche simplement « Mergée » **[Bastien]**.

Dans le worktree de la branche :

0. **Fichiers non commités** : si le worktree en a, Canopy fait le merge, puis s'arrête avant toute bascule ou suppression. Il le signale (« N fichiers non commités : nettoyage local non fait »), pour qu'ils ne finissent pas mis de côté sur une branche supprimée **[Choix conception]**.
1. **Branche distante** : la supprimer si elle appartient au repo et qu'aucune règle ne l'interdit. Elle reste sinon, sans bloquer la suite.
2. **Branche suivante** : chercher dans l'historique du worktree (section 11) une branche qui remplit toutes ces conditions **[Choix conception]** :
   - elle existe encore localement ;
   - ce n'est pas la branche de base du repo ;
   - elle n'est ouverte dans aucun autre worktree ;
   - sa PR n'est ni mergée ni fermée. Une branche sans PR compte comme en cours.

   Selon le résultat :
   - Si une ou plusieurs existent : basculer sur la dernière utilisée **[Bastien pour la bascule, Choix conception pour « la dernière »]**, avec `switchBranch`.
   - Sinon : ouvrir le dialogue existant de suppression du worktree (`RemoveWorktreeDialog`, avec ses risques). Bastien confirme ou annule.
3. **Branche locale** : la supprimer une fois que le worktree n'est plus dessus. Après un squash ou un rebase, `git branch -d` refuse toujours. Canopy utilise donc `-D`, mais seulement si le dernier commit de la branche locale est celui de la PR mergée (`headRefOid`) : rien de local n'est alors perdu. Sinon la branche reste et Canopy le signale **[Choix conception]**. Si Bastien annule la suppression du worktree, la branche locale reste aussi.
4. **Échecs** : afficher chaque étape qui échoue. Aucune suppression forcée en dehors du cas de l'étape 3.

Le worktree principal (checkout du repo) n'est jamais supprimé. Après un merge sur le checkout principal, Canopy bascule sur la branche suivante si elle existe, sinon sur la branche de base, mise à jour par `git fetch` puis `git merge --ff-only`. Un échec de cette mise à jour est signalé sans bloquer **[Choix conception]**.

## 11. Historique des branches d'un worktree

Canopy ne connaît aujourd'hui que la branche actuelle d'un worktree. Il doit maintenant retenir, par worktree, la liste ordonnée des branches qui y ont été ouvertes **[Bastien]**.

- **Où** : stockage local de l'app (userData), indexé par chemin absolu de worktree, hors du repo **[Choix conception]**.
- **Quand on enregistre** : création du worktree, `switchBranch`, et toute branche actuelle observée par Canopy. Cette dernière règle couvre les changements de branche faits dans le terminal.
- **Nettoyage** : l'entrée disparaît avec le worktree. Une branche qui n'existe plus est ignorée à la lecture.
- **Démarrage** : pour un worktree existant avant cette fonctionnalité, l'historique commence avec sa branche actuelle.

## 12. Données, rafraîchissement, sécurité

- Tout passe par `gh`, avec `execFile` et un tableau d'arguments. On utilise surtout `gh pr view/comment/review/edit/merge/close/reopen/ready/update-branch`, `gh run rerun`, `gh run view --log-failed`, `gh api` et `gh api graphql`. Le GraphQL couvre la résolution des fils, l'état « Viewed », les relecteurs suggérés et `revertPullRequest`. Le choix exact des commandes revient au constructeur.
- Le module main reçoit un runner injectable, comme `GhRunner` dans `pr.ts`, pour être testé sans réseau. Les E2E utilisent un faux `gh` piloté par une variable d'environnement, comme `CANOPY_FAKE_LINEAR`, avec des réponses capturées sur un vrai repo. Ce faux est ignoré en build packagé.
- **Rafraîchissement** :
  - toutes les 60 s tant que l'onglet est affiché ;
  - toutes les 15 s tant qu'un check est en cours ou qu'un auto-merge est activé **[Choix conception]** ;
  - à l'arrivée sur l'onglet ;
  - immédiatement après chaque action.
  - `PrCache` est invalidé (`soon`) après un merge, une fermeture ou une réouverture.
- **Sécurité** :
  - le main valide le chemin du worktree, le numéro de PR, les ids de commentaires et de runs, les logins et les noms de labels reçus par IPC ;
  - le jeton GitHub reste dans `gh` et n'est jamais exposé au renderer ;
  - les textes saisis passent par `--body-file` ou par stdin, jamais interpolés dans une commande.

## 13. Laissé au constructeur

- Les commandes `gh` exactes et la forme des types partagés (`src/shared/`).
- La découpe en composants et le store Zustand (`prStore` probable).
- Le format du faux `gh` pour les E2E.
- La transposition visuelle de la maquette dans le style existant de l'app.
- L'ordre de livraison en tâches dans le plan.
