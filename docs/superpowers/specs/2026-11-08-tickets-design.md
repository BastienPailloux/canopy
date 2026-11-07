# Canopy — Tickets dans l'app (étape 2)

Date : 2026-11-08
Spec parente : `2026-11-07-canopy-design.md`, sections 3, 5 et 7.
Maquette : écrans 3 et 3b de `docs/mockups/canopy-maquettes.html` (copie locale, non versionnée, de l'artefact claude.ai).

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Donner à Canopy une liste de tickets d'où l'on lance le travail en un clic : un ticket devient un worktree, une branche et une session Claude Code qui connaît déjà le besoin. C'est l'étape 2 de la spec parente, sans connecteur Linear.

Les tickets locaux sont personnels **[Bastien]** : sur un repo sans Linear ils ne servent qu'à Bastien ; sur un repo avec Linear, le partage passe par Linear (étape 3). D'où l'écart avec la spec parente, qui prévoyait `.tickets/` versionné : ce document la remplace sur ce point (section 4).

Succès : sur un repo sans Linear, Bastien note ses tickets dans Canopy et lance chaque tâche depuis l'écran Tickets, sans créer de worktree ni rédiger de prompt à la main.

## 2. Périmètre

Dans le périmètre :

- Onglet Tickets (écran 3) : liste, filtres, panneau de lancement.
- Écran de modification d'un ticket (écran 3b), réduit au modèle local.
- Création, duplication, archivage d'un ticket.
- Lancement : nouveau worktree, ou worktree existant avec nouvelle branche.
- Stockage local hors git.

Hors périmètre de cette étape :

- Connecteur Linear, et tout ce qui n'existe que par lui : sélecteur de source, bandeau « Synchronisé avec Linear », Assigné, Estimation, Cycle, Activité, commentaires, « Ouvrir dans Linear », « Copier le lien » **[Bastien : pas d'interconnexion Linear pour l'instant]**.
- « Préciser avec Claude », « Lier ou générer une maquette », la section Maquettes liées et la case « Joindre la maquette liée » : ils attendent l'étape Maquettes **[Bastien]**.

Anti-objectifs :

- Un ticket local qui finit dans un commit ou une PR sans que Bastien l'ait demandé.
- Deux worktrees qui voient deux états différents du même ticket.
- Un lancement qui écrase ou perd du travail non commité dans un worktree existant.

## 3. Écrans

Les écrans suivent la maquette : thème, typographie, disposition. Seuls les écarts sont décrits.

### Navigation

- Onglet « Tickets » ajouté au header, après Code, avec le nombre de tickets ouverts (ni Terminés, ni archivés) du repo actif.
- Les tickets sont ceux du repo actif. En mode espace de travail (spec parente, section 11), changer de repo dans le sélecteur change la liste.
- L'écran Tickets occupe toute la largeur, sans la liste des worktrees, comme la maquette **[Choix conception]**.

### Écran 3 — liste et lancement

En-tête : titre « Mes tickets », bouton « + Nouveau ticket », filtres « Tous · n », « À faire · n », « En cours · n », « Backlog · n ». Pas de sélecteur de source tant qu'il n'y en a qu'une **[Choix conception]**.

Liste groupée par statut, dans l'ordre : En cours, En revue, À faire, Backlog. Un groupe vide est masqué. Les tickets Terminés sont dans un groupe replié en bas **[Choix conception]**.

Chaque ligne : identifiant (mono), titre, priorité, labels, puis à droite :

- si le ticket a une branche lancée et que cette branche existe encore : le nom de la branche en lien, qui ouvre la vue Sessions sur son worktree ;
- sinon : bouton « ▶ Lancer ».

Cliquer sur une ligne la sélectionne et remplit le panneau de droite. « Lancer » sur une ligne fait pareil et met le focus sur le bouton de lancement. Aucune sélection : le panneau invite à choisir un ticket.

Panneau de droite :

- Identifiant, titre, priorité et labels, lien « Voir et modifier le ticket » vers l'écran 3b.
- **Où lancer**, deux choix **[Bastien]** :
  - *Nouveau worktree* : crée un dossier dans `<repo>/.worktrees/`. Base : branche par défaut, ou une autre branche choisie dans une liste.
  - *Worktree existant, nouvelle branche* : choix du worktree, base auto = branche la plus avancée (définition dans la spec parente), modifiable. Ne sont proposés que les worktrees « libres » : pas le checkout principal, et aucune session qui travaille ou attend une réponse. Les autres apparaissent grisés avec la raison **[Choix conception]**.
- **Nom de la branche**, prérempli et modifiable (section 6).
- Cases : « Démarrer Claude Code avec la description du ticket » (cochée par défaut) et « Passer le ticket « En cours » » (cochée par défaut sauf si le ticket est déjà En cours ou En revue).
- Bouton « Lancer DPP-12 ⌘↵ ».

### Écran 3b — modifier un ticket

- Fil d'Ariane « Mes tickets / DPP-12 », bouton « Dupliquer ».
- Titre éditable.
- Description en Markdown, avec la barre de la maquette (gras, liste, code) qui insère la syntaxe dans le texte. Zone de texte simple, pas d'éditeur riche **[Choix conception]**.
- Sous-tâches : compteur « 1 / 3 », cocher, renommer au clic, supprimer, « + Ajouter ».
- Colonne de droite : Statut, Priorité, Labels (pastilles, « + » pour en ajouter, choix parmi les labels déjà utilisés dans le repo ou saisie libre).
- Bloc « Développement » : la branche et le worktree liés, avec lien vers Sessions ; sinon « Aucun worktree pour l'instant. » et le bouton « ▶ Lancer DPP-12 », qui ramène à l'écran 3 avec ce ticket sélectionné.
- En bas de la colonne : « Archiver le ticket ».

Sauvegarde automatique, sans bouton : chaque modification s'écrit après une courte pause de frappe, et au changement d'écran **[Choix conception]**.

## 4. Stockage

Tout est dans le checkout principal du repo, jamais dans un worktree : tous les worktrees voient le même état **[Bastien]**.

- Un fichier par ticket : `<checkout principal>/.tickets/<ID>.md` **[Bastien]** pour le Markdown dans `.tickets/`.
- `.tickets/` reste hors git **[Bastien]**. Canopy ajoute `/.tickets/` à `.git/info/exclude` du repo à la première écriture, sans toucher au `.gitignore` versionné **[Choix conception]**. Le fichier `info/exclude` est commun à tous les worktrees du repo.
- Plus de signal « tickets non commités » ni de commit proposé : la spec parente est remplacée sur ce point.
- Config des tickets : `.tickets/config.json`, avec le préfixe et le prochain numéro. Elle reste locale comme les tickets, et non dans `.canopy/config.json` versionné **[Choix conception]**.

Format d'un ticket **[Choix conception]** : front matter YAML pour les propriétés, puis la description en Markdown, puis les sous-tâches en liste à cocher sous un titre réservé.

```markdown
---
id: DPP-12
title: Export JSON-LD du passeport textile
status: todo          # backlog | todo | in_progress | in_review | done
priority: high        # urgent | high | medium | low | none
labels: [DPP, Textile]
created: 2026-11-08T10:12:00Z
updated: 2026-11-08T10:40:00Z
branch: feat/export-jsonld-textile   # absent tant que non lancé
worktree: /Users/basti/code/dpp-api/.worktrees/feat-export-jsonld-textile
base: main
---
Exposer le passeport d'un produit textile au format JSON-LD…

## Sous-tâches
- [x] Définir le contexte JSON-LD
- [ ] Sérialiseur passeport → JSON-LD
```

- Statuts affichés : Backlog, À faire, En cours, En revue, Terminé (spec parente). Priorités affichées : Urgente, Haute, Moyenne, Basse, Aucune, alignées sur Linear pour l'étape 3 **[Choix conception]**.
- Un fichier édité à la main ou par Claude est relu : Canopy surveille `.tickets/` et rafraîchit les écrans. Un fichier illisible n'est pas écrasé : il est signalé dans la liste, avec son nom **[Choix conception]**.
- Écriture protégée comme `writeFile` : si le fichier a changé depuis la lecture, Canopy ne l'écrase pas en bloc. Il fusionne champ par champ : les champs que l'utilisateur a modifiés depuis la dernière sauvegarde gardent sa saisie, les autres prennent la version du disque. Rien de ce qui vient d'être tapé n'est perdu **[Choix conception]**.

## 5. Identifiants

- Format `<PRÉFIXE>-<n>`, numéro incrémenté **[Bastien]**.
- Préfixe par défaut : les trois premières lettres du nom du dossier du repo, en majuscules (`canopy` → `CAN`) **[Choix conception]**.
- Préfixe modifiable depuis l'app **[Bastien]**, dans Réglages, pour le repo actif. Le changement ne s'applique qu'aux nouveaux tickets : un ticket garde son identifiant et son nom de fichier **[Choix conception]**.
- Un seul compteur, quel que soit le préfixe : après `CAN-42`, un passage à `DPP` donne `DPP-43` **[Choix conception]**.
- Le numéro suivant ne réutilise jamais un numéro existant, archivé compris. Il est recalculé depuis les fichiers si la config manque.

## 6. Lancement

Nom de branche : `<type>/<titre-court>`, la convention du repo, par exemple `feat/add-tickets` **[Bastien]**. Pas de prénom, pas d'identifiant.

- Type : `feat` par défaut, menu `feat`, `fix`, `chore`, `docs`, `refactor`, `test` **[Choix conception]**.
- Titre court : titre du ticket en minuscules, accents retirés, mots joints par `-`, quatre ou cinq mots au plus **[Choix conception]**.
- Le nom complet reste modifiable. Un nom déjà pris est signalé avant le lancement.

Ce que fait « Lancer » :

1. **Nouveau worktree** : `createWorktree` avec la branche et la base choisies, dossier `<repo>/.worktrees/<branche aplatie>` comme le dialogue existant.
   **Worktree existant** : nouvelle opération qui crée la branche depuis la base dans ce worktree. Les changements non commités y sont mis de côté pour la branche quittée, comme le changement de branche existant. Le panneau affiche avant lancement le nombre de fichiers mis de côté et de sessions en cours dans ce worktree.
2. Écrit dans le ticket `branch`, `worktree` et `base`, et mémorise la base de la branche (section 6 bis).
3. Si coché, passe le ticket En cours.
4. Bascule sur la vue Sessions, sur ce worktree.
5. Si coché, ouvre un onglet de session et envoie le prompt de lancement, avec la demande d'approbation du repo habituelle.

Prompt de lancement **[Choix conception]** : l'identifiant et le titre, la description, puis les sous-tâches non faites. Claude reçoit le ticket dans son prompt et ne lit pas `.tickets/`, qui n'existe pas dans son worktree (spec parente).

Un lancement qui échoue (branche existante, git qui refuse) n'écrit rien dans le ticket et affiche l'erreur dans le panneau.

Un ticket peut être relancé : le lancement suivant remplace la branche liée.

## 6 bis. Branches empilées

Gestion complète dans cette étape **[Bastien]**.

- Canopy retient la base de chaque branche qu'il crée depuis une autre branche que la branche par défaut : lancement d'un ticket, et aussi dialogue « Nouveau worktree » **[Choix conception]**.
- Stockage dans le dossier application de l'utilisateur, par repo et par branche, à côté des bases de repo déjà retenues (`repoBases`). Pas dans le ticket seul : une branche archivée, relancée ou créée hors ticket garde sa base **[Choix conception]**.
- Une entrée est oubliée quand sa branche n'existe plus en local. Si la base disparaît (fusionnée, supprimée), Canopy retombe sur la branche par défaut et le signale, comme `lostBase` aujourd'hui **[Choix conception]**.
- Écran Code : le diff reste comparé à la branche par défaut (spec parente). Le sélecteur de comparaison affiche la base en premier raccourci, libellé « base de la branche ».
- « Créer la PR » : le prompt envoyé à Claude demande la base comme cible au lieu de la branche par défaut. Le panneau affiche la cible avant l'envoi **[Choix conception]**.

## 7. Autres actions

- **Nouveau ticket** : ouvre l'écran 3b sur un ticket vide en Backlog. Le fichier et l'identifiant ne sont créés qu'à la saisie d'un titre ; quitter sans titre ne crée rien **[Choix conception]**.
- **Dupliquer** : nouvel identifiant, même contenu, titre suffixé « (copie) », sans branche liée, statut Backlog.
- **Archiver** : `archived: true`, et le fichier passe dans `.tickets/archive/`. Le ticket disparaît de la liste et du compteur, et ce dossier n'est pas relu pour afficher la liste : des milliers de tickets archivés ne ralentissent rien. Seul le calcul du prochain numéro le parcourt, si la config manque. Pas d'écran des archivés dans cette étape ; un ticket se désarchive en déplaçant son fichier **[Choix conception]**.
- Pas de suppression dans l'app **[Bastien]**.
- **Lien inverse** : dans la liste des worktrees, une entrée dont la branche est liée à un ticket affiche son identifiant, comme le prévoit la spec parente. Cliquer dessus ouvre le ticket **[Choix conception]**.

## 8. Technique

- Un module du process principal lit, écrit et surveille `.tickets/`, exposé par IPC comme le reste (`contextIsolation`, pas d'accès disque depuis le renderer).
- Le parsing et l'écriture du format sont des fonctions pures, testées unitairement : aller-retour sans perte, front matter invalide, section sous-tâches absente, champs inconnus conservés.
- Tests e2e : créer un ticket, le modifier, le lancer en nouveau worktree avec session, le lancer dans un worktree existant avec des changements non commités.

## 9. Laissé au constructeur

- Le découpage exact des composants et des stores, en suivant `src/renderer/shell` et `sessions`.
- Le délai de sauvegarde automatique et de rafraîchissement.
- La bibliothèque YAML, ou un parseur limité au sous-ensemble utilisé.
- Les textes d'erreur.
