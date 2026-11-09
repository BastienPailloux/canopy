# Canopy — Modèles de tickets (CAN-3)

Date : 2026-11-09
Spec parente : `2026-11-08-tickets-design.md` (tickets locaux, écrans 3 et 3b).

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Standardiser le format des tickets pour que Claude démarre avec un maximum de contexte **[Bastien]**. Aujourd'hui, le premier message d'une session lancée depuis un ticket (`launchPrompt`, `src/shared/tickets.ts`) contient le titre, la description libre et les sous-tâches restantes. Ce que Claude sait dépend donc de ce qu'on a pensé à écrire.

Un modèle pré-remplit un nouveau ticket avec des rubriques à compléter. Le ticket garde ainsi la même structure d'un lancement à l'autre.

Succès : chaque ticket créé dans Canopy part d'un modèle, et la description envoyée à Claude au lancement suit des rubriques connues (contexte, objectif, critères…) au lieu d'un texte libre.

## 2. Périmètre

Dans le périmètre :

- Un **modèle principal**, proposé par défaut, centré sur le contexte **[Bastien]**.
- Des **modèles par type** de ticket (bug, fonctionnalité, refacto…), choisis à la création **[Bastien]**.
- Modèles **modifiables** par l'utilisateur **[Bastien]**, depuis un **écran dédié** dans Canopy **[Bastien]** : créer, renommer, modifier, supprimer, choisir le modèle par défaut.
- Un choix de modèle à la création d'un ticket local (« + Nouveau ticket »).

Hors périmètre :

- Tickets Linear : Canopy ne crée pas de ticket Linear aujourd'hui, il n'y a donc rien à pré-remplir **[Choix conception]**.
- Validation de structure : rien n'est imposé ni vérifié à l'enregistrement, on peut effacer des rubriques **[Choix conception]**.
- Modification de `launchPrompt` : la structure arrive par la description, le prompt reste le même **[Choix conception]**.
- Appliquer un modèle à un ticket existant.

Anti-objectifs :

- Perdre du texte déjà tapé en changeant de modèle.
- Un modèle qui salit le working tree du checkout principal ou finit dans un commit sans qu'on l'ait demandé (même règle que les tickets locaux).
- Un ticket vide créé sur disque juste parce qu'on a choisi un modèle : la règle actuelle tient toujours, rien n'est écrit tant qu'il n'y a pas de titre.

## 3. Ce qu'est un modèle

Un modèle pré-remplit les champs d'un nouveau ticket, sauf le titre :

- **description** : Markdown avec les rubriques (titres `###` + texte d'aide court) ;
- **labels** de départ (ex. `bug` pour le modèle Bug), optionnels ;
- **priorité** de départ, optionnelle (défaut `none`) ;
- **sous-tâches** de départ, optionnelles (ex. « Écrire un test qui reproduit le bug »).

Statut toujours `backlog`, comme aujourd'hui. Titre vide. **[Choix conception]**

### Stockage

Un fichier Markdown par modèle dans `.tickets/templates/<slug>.md` du checkout principal, hors git, à côté des tickets **[Choix conception]**. Raisons : les tickets locaux sont personnels (spec parente), modifier un modèle depuis Canopy ne doit pas laisser de fichier modifié dans le checkout principal, et `.tickets/` est déjà vérifié comme non suivi par git (`store.ts`).

Format, calqué sur celui des tickets (`format.ts`) :

```md
---
name: Bug
labels: [bug]
priority: high
order: 2
---
### Contexte
Où ça se passe (écran, fichier, commande) et depuis quand.

### Étapes pour reproduire
1. …

### Comportement attendu

### Comportement observé

## Sous-tâches
- [ ] Écrire un test qui reproduit le bug
```

- `name` : nom affiché, obligatoire, 50 caractères max.
- `order` : ordre dans les menus. À défaut : ordre alphabétique de `name`.
- Le modèle par défaut est indiqué dans `.tickets/config.json` (`defaultTemplate: "<slug>"`), à côté de `prefix` et `next`. Absent ou introuvable : le premier modèle dans l'ordre. « Aucun » ne peut pas être le défaut : chaque ticket part d'un modèle (section 1). **[Choix conception]**
- `TicketStore` réécrit aujourd'hui `config.json` en `{ prefix, next }` seulement (`setPrefix`, création de ticket) : ces écritures doivent garder les autres clés, sinon `defaultTemplate` est effacé.
- Le slug (nom de fichier) est calculé depuis `name` à la création du modèle, comme `branchSlug`, et ne change pas quand on renomme : `^[a-z0-9-]{1,50}$`, validé en main sur chaque appel IPC. **[Choix conception]**
- Un fichier illisible apparaît dans l'écran des modèles avec son erreur, sans être écrasé, comme les tickets illisibles **[Choix conception]**.

### Modèles fournis

Si `.tickets/templates/` n'existe pas, Canopy y écrit les modèles fournis la première fois qu'il en a besoin (ouverture de l'écran des modèles ou création d'un ticket). Ensuite ils appartiennent à l'utilisateur : en supprimer un ne le fait pas revenir. Supprimer tous les modèles est possible, et « + Nouveau ticket » crée alors un ticket vide comme aujourd'hui. **[Choix conception]**

Contenu proposé (texte d'aide court, à affiner pendant l'implémentation) **[Choix conception]** :

1. **Contexte** (défaut) : `### Contexte` (pourquoi ce ticket, quel problème ou quel besoin), `### Où ça se passe` (écrans, fichiers, modules concernés), `### Ce qui existe déjà` (code, tickets, décisions liées), `### Objectif` (ce qu'on veut obtenir), `### Critères d'acceptation` (liste vérifiable), `### Hors périmètre`.
2. **Fonctionnalité** : `### Contexte`, `### Besoin utilisateur`, `### Comportement attendu`, `### Critères d'acceptation`, `### Hors périmètre`. Label `feat`.
3. **Bug** : comme l'exemple plus haut. Label `bug`, sous-tâche « Écrire un test qui reproduit le bug ».
4. **Refacto** : `### Contexte`, `### Problème actuel`, `### Cible`, `### Contraintes` (comportement inchangé, tests existants…). Label `refactor`.

## 4. Écrans

### Création d'un ticket

« + Nouveau ticket » ouvre le brouillon (écran 3b) avec le modèle par défaut déjà appliqué. En haut de l'éditeur du brouillon, un sélecteur « Modèle » liste les modèles et « Aucun ». **[Choix conception]**

Changer de modèle dans le brouillon :

- si la description, les labels et les sous-tâches sont encore ceux du modèle appliqué (rien de modifié) : le nouveau modèle remplace sans rien demander ;
- sinon : confirmation « Remplacer le contenu par le modèle « X » ? Ce que tu as écrit sera perdu. » ; Annuler garde tout ;
- le titre n'est jamais touché.

Le sélecteur n'est visible que tant que le brouillon n'a pas d'id, c'est-à-dire avant que le premier titre saisi l'enregistre sur disque **[Bastien]**. Appliquer un modèle à un ticket existant est hors périmètre.

Un lien « Gérer les modèles… » à côté du sélecteur ouvre l'écran des modèles.

### Écran « Modèles de tickets »

Ouvert depuis la section Tickets des Réglages (bouton « Modèles de tickets… ») et depuis le lien du brouillon. Fenêtre modale, comme les Réglages (`useModal`). Visible seulement avec un repo actif, et porte sur ses modèles. **[Choix conception]**

Disposition : liste des modèles à gauche (nom, badge « Par défaut »), éditeur du modèle sélectionné à droite.

- Liste : « + Nouveau modèle » (part d'un modèle vide nommé « Nouveau modèle »), « Dupliquer », « Supprimer » (avec confirmation), « Définir par défaut », réordonner (boutons monter/descendre, qui écrivent `order`).
- Éditeur : nom, description (même zone de texte et mêmes outils de mise en forme que l'éditeur de ticket, `descriptionTools.ts`), labels, priorité, sous-tâches. Mêmes limites que les tickets (`MAX_*`).
- Enregistrement automatique à la frappe (debounce), comme l'éditeur de ticket. Pas de bouton Enregistrer.
- Les modifications sur disque faites hors de Canopy sont relues (watch de `.tickets/templates/`, comme `watch.ts`).

## 5. IPC et main

Nouveau module `src/main/tickets/templates.ts` (lecture, écriture, modèles fournis), fonctions pures testées, et handlers dans `ticketIpc.ts`. Méthodes à ajouter à `CanopyApi` (noms indicatifs) :

- `ticketTemplates(repo)` → liste (modèles + fichiers illisibles + slug par défaut) ; écrit les modèles fournis si le dossier manque ;
- `saveTicketTemplate(repo, slug | null, fields)` → crée (slug calculé, suffixe `-2`… si pris) ou met à jour ;
- `deleteTicketTemplate(repo, slug)` ;
- `setDefaultTicketTemplate(repo, slug)` ;
- événement `canopy:event` quand le dossier change.

Validation en main sur chaque appel : chemin du repo absolu, slug conforme, champs dans les limites (réutiliser `parseFields` / les `MAX_*`).

## 6. Tests

TDD (CLAUDE.md). Au minimum :

- Vitest `tests/main/tickets/templates.test.ts` : parse/serialize aller-retour, fichier illisible, slugs (calcul, collision, refus des slugs invalides), modèles fournis écrits une seule fois et pas recréés après suppression, défaut absent ou introuvable.
- Vitest renderer : logique « le brouillon est-il encore intact » pour décider de la confirmation.
- Playwright `tests/e2e/tickets.spec.ts` (ou `ticket-templates.spec.ts`) : nouveau ticket pré-rempli avec le modèle par défaut ; changement de modèle avec et sans confirmation ; création et modification d'un modèle dans l'écran dédié puis utilisation dans un nouveau ticket ; changement du modèle par défaut.

## 7. Laissé au builder

- Le texte exact des modèles fournis et des aides.
- La mise en page fine de l'écran des modèles, dans le style existant (`tickets.css`).
- Le découpage en commits.
