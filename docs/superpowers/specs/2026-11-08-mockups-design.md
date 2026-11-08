# Canopy — Maquettes (étape 4, sans « Créer avec Claude »)

Date : 2026-11-08
Spec parente : `2026-11-07-canopy-design.md`, sections 3, 7 (Maquettes) et 9 (R2, R6). Spec tickets : `2026-11-08-tickets-design.md`.
Maquette : écrans 4, 4b et la section « Maquettes liées » de 3b dans `docs/mockups/canopy-maquettes.html` (copie locale, non versionnée).

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Donner à Canopy un onglet Maquettes : la galerie des maquettes claude.ai du repo, leur vue intégrée, une conversation Claude Code qui les modifie en connaissant le code, et le lien avec les tickets, pour qu'un ticket lancé emporte sa maquette.

Succès : Bastien lie une maquette à un ticket, la modifie depuis Canopy en parlant à Claude, voit la vue se recharger, puis lance le ticket et Claude reçoit la maquette dans son prompt.

## 2. Résultat des risques R2 et R6

- **R2 levé** (testé le 2026-11-08, SDK 0.3.319, login claude.ai) : l'outil `Artifact` est absent d'une session SDK par défaut, même avec `settings.enableArtifact`. Il apparaît avec la variable d'environnement `CLAUDE_CODE_ARTIFACT=1` (avec `ArtifactComments` et `ArtifactData`). Il sait `publish` (avec `url` pour mettre à jour une maquette existante), `read` (HTML brut pour ses propres maquettes) et `list`. Il exige toujours le login claude.ai (R1 inchangé).
- **R6** : la page `claude.ai/artifact/<id>` refuse d'être affichée dans un iframe (`frame-ancestors`). La vue intégrée est donc une `WebContentsView` du process principal, comme prévu par la spec parente, avec une partition persistante `persist:claude-ai` pour garder le login. Le login dans cette vue reste à vérifier à la main par Bastien.

## 3. Périmètre

Dans le périmètre :

- Onglet Maquettes (écran 4) : galerie, filtres, panneau de détail.
- Écran 4b réduit : vue intégrée, conversation Claude, propriétés.
- Ajout d'une maquette par lien claude.ai, et « ✦ Nouvelle maquette » qui la fait créer par Claude.
- Lien maquette ↔ ticket : section « Maquettes liées » de 3b, case « Joindre la maquette liée » au lancement, filtre « Sans ticket ».

Hors périmètre **[Choix conception]**, parce que claude.ai ne les expose pas à Canopy (règle de la spec parente, section 7) :

- Liste d'écrans et « + Nouvel écran », versions, « Comparer avec v3 », commentaires épinglés, zoom, « Exporter en PNG / Figma ».
- Vignettes réelles : les cartes montrent le gabarit téléphone ou web de la maquette, coloré.
- « Synchroniser » : remplacé par « + Ajouter un lien ». Le titre se met à jour depuis la page chargée (section 6).
- Écran 5 « Créer avec Claude » (tickets et maquette en brouillon).
- Supprimer la maquette sur claude.ai : Canopy la retire seulement de sa liste.

## 4. Stockage

- Registre local, hors git, comme les tickets **[Bastien]** : `<checkout principal>/.mockups/mockups.json`. Canopy ajoute `/.mockups/` à `.git/info/exclude` à la première écriture **[Choix conception]**.
- Lu et écrit uniquement dans le checkout principal, surveillé comme `.tickets/`.
- Format **[Choix conception]** :

```json
{
  "version": 1,
  "mockups": [
    {
      "id": "WcXTxNhxSWaDL28ttqjZye",
      "url": "https://claude.ai/artifact/WcXTxNhxSWaDL28ttqjZye",
      "title": "Scanner GTIN — résultat",
      "kind": "phone",
      "status": "todo",
      "ticket": "DPP-12",
      "added": "2026-11-08T10:12:00Z",
      "updated": "2026-11-08T10:40:00Z"
    }
  ]
}
```

- `id` : l'identifiant de l'URL (`claude.ai/artifact/<id>` ou `claude.ai/code/artifact/<uuid>`). Une même maquette n'est enregistrée qu'une fois.
- `kind` : `phone` ou `web`, choisi à l'ajout, `web` par défaut. Sert au gabarit de la carte.
- `status` : `todo` Pas commencée, `wip` En cours de dev, `done` Implémentée.
- `ticket` : identifiant d'un ticket local, absent si aucun.
- Un fichier illisible n'est pas écrasé : l'écran l'affiche en erreur, comme un ticket illisible.

## 5. Lien avec les tickets

- Une maquette a au plus un ticket ; un ticket a plusieurs maquettes (maquette, 3b) **[Bastien, via la maquette]**. Le lien est porté par la maquette.
- Statut affiché : s'il y a un ticket, il est déduit du ticket (Backlog et À faire → Pas commencée, En cours et En revue → En cours de dev, Terminé → Implémentée) et le menu Statut est grisé ; sinon c'est `status` **[Choix conception]**.
- Branche affichée : celle du ticket lié, sinon « — ».
- Un ticket archivé ou absent : la maquette affiche son identifiant barré, et se comporte comme sans ticket.
- Écran 3b, section « Maquettes liées » sous les sous-tâches : une puce par maquette liée (gabarit, titre) qui ouvre 4b, et « + Lier ou générer une maquette » : menu avec les maquettes sans ticket, « Coller un lien claude.ai… » et « Générer avec Claude », qui ouvre 4b en création avec le ticket lié.
- Panneau de lancement : case « Joindre les maquettes liées (n) », cochée par défaut, visible si le ticket en a. Le prompt de lancement ajoute la liste « Maquettes : <titre> — <url> » et demande de les lire avec l'outil Artifact.

## 6. Écrans

### Navigation

Onglet « Maquettes » après Tickets. Il occupe toute la largeur, comme Tickets. Les maquettes sont celles du repo actif.

### Écran 4 — galerie

- En-tête : « Maquettes », « n maquettes liées à <repo> », filtres « Toutes », « Ce worktree » (ticket lié dont la branche est celle du worktree actif), « Sans ticket », bouton « + Ajouter un lien », bouton « ✦ Nouvelle maquette ».
- Grille de cartes : gabarit téléphone ou web, titre, identifiant du ticket, date relative de mise à jour, pastille de statut. Clic : sélection (bordure violette). Double-clic : 4b.
- Panneau de droite, maquette sélectionnée : grand gabarit, titre, « Claude Design · il y a 2 h », Ticket (lien vers 3b), Branche, Statut, puis :
  - « Joindre à la session en cours » : ajoute « Maquette : <titre> — <url> » au brouillon de la session active du worktree de la branche liée, ou du worktree actif, et ouvre Sessions.
  - « Lancer un worktree depuis la maquette » : avec ticket, ouvre Tickets sur le panneau de lancement de ce ticket ; sans ticket, crée un ticket « <titre> » en Backlog, le lie, puis fait de même.
  - « Modifier la maquette » : 4b.
- Liste vide : texte d'explication et les deux boutons.
- « + Ajouter un lien » : petite fenêtre avec le lien, le titre (facultatif), le gabarit et le ticket. Un lien qui n'est pas une maquette claude.ai est refusé.

### Écran 4b — modifier

- Barre gauche réduite : « ← Toutes les maquettes ».
- En-tête : titre, pastille de statut, « Recharger », « Ouvrir dans claude.ai ».
- Centre : la vue intégrée de l'URL. Si claude.ai demande de se connecter, c'est dans cette vue, une fois.
- Colonne droite, onglets :
  - **Claude** : la conversation et le compositeur des Sessions, sur un onglet de session lancé dans le checkout principal du repo **[Bastien]** pour la session qui connaît le code. Le premier message est précédé d'un contexte : l'URL, l'instruction de lire la maquette avec `Artifact` (`read`), de la modifier et de la republier avec `url` pour la mettre à jour sur place. Case « Créer une variante » : demande de publier une nouvelle maquette sans `url`.
  - **Propriétés** : Nom, Ticket lié (tickets du repo + Aucun), Statut, Branche, gabarit, « Retirer de Canopy ».
- Pied de colonne : « Envoyer à la session <branche> », si le ticket lié a un worktree : comme « Joindre à la session en cours » sur ce worktree.
- Rechargement : quand un appel `Artifact` `publish` de cette conversation se termine sans erreur, la vue se recharge. Si le résultat contient une autre URL de maquette (variante, création), elle est ajoutée au registre avec le même ticket et le même gabarit **[Choix conception]**.
- « ✦ Nouvelle maquette » ouvre 4b sans URL : la vue montre une invite, le premier message demande à Claude de créer une maquette avec `Artifact` `publish`. La première URL publiée devient la maquette, la vue s'y place.
- Titre : à l'ajout sans titre, et tant que l'utilisateur ne l'a pas changé, il suit le titre de la page chargée, sans le suffixe « | Claude » s'il existe **[Choix conception]**.
- La conversation d'une maquette reste attachée à elle tant que l'application tourne ; au redémarrage, une nouvelle commence (l'ancienne reste dans l'historique des Sessions du checkout principal) **[Choix conception]**.

## 7. Technique

- Sessions : toutes les sessions Canopy reçoivent `CLAUDE_CODE_ARTIFACT=1`, pour que celle du worktree d'un ticket lancé puisse lire la maquette **[Choix conception]**.
- Registre : un module du process principal (`MockupStore`), écritures sérialisées, écriture atomique, garde comme `.tickets/` (vrai dossier, dans le repo, non suivi par git), IPC `mockups:*` validées.
- Vue intégrée : un gestionnaire dans le process principal, une `WebContentsView` par fenêtre, partition `persist:claude-ai`, sans preload, `sandbox`. Le renderer donne l'URL et le rectangle de la zone, à chaque redimensionnement, et la cache quand il quitte 4b ou qu'une fenêtre modale s'ouvre (la vue native passerait au-dessus). Navigation libre dans la vue (connexion) ; `window.open` ouvre le navigateur par défaut. Le titre de la page remonte par événement.
- Le parsing et la validation du registre, la déduction du statut, la détection des URL de maquette et la construction des prompts sont des fonctions pures, testées.
- Tests e2e : ajouter une maquette par lien, la lier à un ticket depuis 3b, la voir dans la galerie et le filtre « Sans ticket ». La vue claude.ai n'est pas chargée en e2e (URL remplacée par une page locale).

## 8. Laissé au constructeur

- Découpage des composants et des stores, en suivant `src/renderer/tickets`.
- Couleurs des gabarits, dans la palette de la maquette.
- Textes d'erreur.
