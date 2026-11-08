# Canopy — Connecteur Linear (étape 3)

Date : 2026-11-08
Spec parente : `2026-11-07-canopy-design.md`, sections 3, 5, 7 et 8.
Étape précédente : `2026-11-08-tickets-design.md` (tickets locaux), dont ce document reprend les écrans et le lancement.
Maquettes de travail : `.superpowers/brainstorm/` (non versionné), écrans `sources`, `filters` et `editor`.

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement. **[Essai]** = constaté pendant l'essai du 2026-11-08 contre le vrai serveur MCP Linear, sur un espace perso.

## 1. Intention

Au travail, Bastien code à partir de tickets Linear qui lui sont assignés. Ces tickets sont de plus en plus détaillés et portent le vrai besoin ; il les enrichit souvent lui-même en ajoutant des précisions **[Bastien]**. Aujourd'hui il passe de Linear à Claude Code à la main.

Le connecteur amène ces tickets dans l'écran Tickets de Canopy, à côté des tickets locaux : on les lit, on les modifie, et on les lance en un clic comme un ticket local (worktree, branche, session Claude qui connaît le ticket).

Succès : sur un repo pro, Bastien voit tous ses tickets Linear assignés dans Canopy, précise l'un d'eux sans ouvrir Linear, le lance, et la PR qui en sort est reliée au ticket par l'intégration GitHub de Linear, sans rien faire de plus.

## 2. Contexte et contraintes

- L'espace Linear pro bloque les clés API personnelles **[Bastien]**. Le serveur MCP officiel de Linear (`https://mcp.linear.app/mcp`) y est autorisé et utilisé par l'équipe **[Bastien]**. Canopy passe donc par ce serveur MCP, et par rien d'autre.
- Bastien ne branche pas son compte Linear pro sur ses projets perso, développement de Canopy compris **[Bastien]**. Développement et tests manuels se font sur un espace Linear gratuit perso, créé pour ça (`canopy`, équipe `CAN`). Les réglages d'admin de l'espace pro (approbation des applications tierces) ne seront vérifiés qu'au premier branchement au travail.
- L'avancement des statuts est déjà fait par l'intégration GitHub de Linear, à l'ouverture et au merge de la PR **[Bastien]**. Canopy ne la remplace pas.
- Un espace Linear correspond en pratique à un repo ; Bastien travaille rarement sur plusieurs repos à la fois **[Bastien]**.

## 3. Périmètre

Dans le périmètre :

- Connexion d'un espace Linear à Canopy, déconnexion.
- Tickets Linear assignés à Bastien dans l'écran Tickets, mélangés aux tickets locaux.
- Modification d'un ticket Linear depuis Canopy, commentaires compris.
- Lancement d'un ticket Linear.

Hors périmètre :

- Créer un ticket Linear depuis Canopy. « + Nouveau ticket » crée toujours un ticket local **[Choix conception]**.
- Plusieurs espaces Linear connectés en même temps **[Choix conception]**.
- Les tickets non assignés à Bastien, sauf ceux déjà lancés (section 5).
- L'estimation : ni affichée, ni modifiable **[Bastien]**.
- Une case « Passer En cours » au lancement d'un ticket Linear : GitHub s'en charge **[Bastien]**.
- Jira, GitHub Issues : plus tard (spec parente).
- « Préciser avec Claude » et les maquettes : étape 4.

Anti-objectifs **[Bastien]** :

- **Un ticket qui disparaît de la liste** : à cause d'une erreur réseau, d'un jeton expiré, d'un changement côté Linear, sans que Bastien sache pourquoi.
- **Du contenu perdu** : une description écrasée (la sienne ou celle d'un collègue), une modification qui n'est jamais partie vers Linear sans qu'il le sache.

Et, de la spec parente : rien ne part vers Linear sans action explicite de Bastien. Une modification de champ ou un commentaire posté par lui vaut validation.

## 4. Connexion

- Dans Réglages, section « Linear » : bouton « Connecter Linear ». Il lance l'OAuth du serveur MCP dans le navigateur par défaut (enregistrement dynamique du client, PKCE, retour sur un port local) **[Essai]** : c'est le même chemin que Claude Code, sans application à déclarer chez Linear.
- Une fois connecté, la section affiche l'espace et le compte (`whoami` : nom de l'espace, e-mail), et un bouton « Déconnecter » qui efface jeton, client enregistré et cache **[Choix conception]**.
- Jeton, jeton de renouvellement et informations du client sont chiffrés avec `safeStorage` d'Electron (trousseau macOS) et stockés dans le dossier application **[Choix conception, conforme à la spec parente]**. Le renouvellement est automatique.
- Droits : le serveur impose `read write` même si l'on demande `read` **[Essai]**. Canopy demande `read write`, et l'écran de connexion le dit.
- Si le renouvellement échoue, Canopy garde la liste en cache (section 8), affiche « Connexion Linear expirée — Reconnecter » et n'efface rien.
- La connexion appartient à l'application, pas au repo : les tickets Linear apparaissent dans l'écran Tickets de tous les repos, et c'est Bastien qui choisit dans quel repo lancer. Pas d'association repo–espace, pas d'avertissement **[Bastien]**.
- Le serveur de retour OAuth écoute sur toutes les interfaces locales (IPv4 et IPv6) : `localhost` peut se résoudre en `::1` **[Essai]**.

## 5. Liste (écran 3)

Une seule liste, groupée par statut comme aujourd'hui, qui mélange les tickets locaux du repo actif et les tickets Linear **[Bastien]**.

Tickets Linear affichés **[Bastien sauf mention]** :

- ceux assignés à Bastien dans l'espace connecté, toutes équipes confondues, quel que soit le repo ouvert ;
- plus, dans le repo actif, ceux déjà lancés dont la branche existe encore, même s'ils ne lui sont plus assignés **[Choix conception, pour l'anti-objectif « disparition »]** ;
- les statuts Linear de type « annulé » sont masqués **[Choix conception]**. Les terminés vont dans le groupe Terminé replié.

Filtres **[Bastien]** : statut (existant), source (Toutes sources / Linear / Local), priorité, recherche texte dans le titre et l'identifiant. Pas de filtre équipe ni étiquette.

Ligne d'un ticket Linear : identifiant Linear (ex. `ENG-482`), titre, priorité, étiquettes, badge « Linear », le vrai statut Linear en petit quand il diffère du nom du groupe (ex. « QA » dans En revue) **[Choix conception]**, puis « ▶ Lancer » ou la branche liée, comme une ligne locale. Les lignes locales gagnent un badge « Local » quand Linear est connecté.

En-tête : « Linear · synchro il y a 1 min » et un bouton ⟳ **[Choix conception]**. Rafraîchissement automatique toutes les 3 minutes tant que l'écran Tickets est visible, au retour de la fenêtre au premier plan, et après chaque modification **[Choix conception]**. Une liste de plus de 250 tickets suit la pagination.

Correspondance des statuts vers les 5 groupes de Canopy, à partir du type fourni par Linear **[Choix conception]** :

| Type Linear | Groupe Canopy |
|---|---|
| `triage`, `backlog` | Backlog |
| `unstarted` | À faire |
| `started` dont le nom contient « review », « revue » ou « QA » (casse ignorée) | En revue |
| autre `started` | En cours |
| `completed` | Terminé |
| `canceled` | masqué |

Identifiants : un ticket local et un ticket Linear peuvent porter le même identifiant (`CAN-7` des deux côtés). La source fait partie de la clé partout (liste, sélection, lien branche–ticket, IPC) **[Choix conception]**.

Sans connexion Linear, l'écran est celui de l'étape 2, sans badge ni filtre source.

## 6. Modification (écran 3b, version Linear)

Même écran que l'éditeur local **[Choix conception]**, avec les différences suivantes **[Bastien pour la liste des champs]** :

- Modifiables : titre, description, statut, priorité, étiquettes, assigné.
- Affichés seulement : équipe, cycle, projet.
- Sous-tickets : liste avec identifiant, titre et statut ; un clic ouvre le sous-ticket dans l'éditeur. Pas de cases à cocher locales.
- Commentaires : lecture du fil, et champ « Ajouter un commentaire » (Markdown). Pas de modification ni de suppression d'un commentaire **[Choix conception]**.
- En haut : « Ouvrir dans Linear ↗ » (l'`url` du ticket) et « Copier le lien ».
- Pas de « Dupliquer » ni d'« Archiver ».

Détail des champs :

- **Statut** : menu des vrais statuts de l'équipe du ticket (`list_issue_statuses`), dans l'ordre de Linear **[Bastien]**.
- **Étiquettes** : choix parmi les étiquettes de l'équipe et de l'espace ; pas de création d'étiquette depuis Canopy **[Choix conception]**.
- **Assigné** : menu des membres. Si Bastien se désassigne, un message le prévient que le ticket quittera sa liste ; il reste affiché tant que l'éditeur est ouvert **[Choix conception]**.
- **Description** : Markdown, avec les balises propres à Linear (`<linear-image>`, `<linear-embed>`, etc.) **[Essai]**. Elles s'affichent sous forme lisible (image ou lien, ou pastille « vidéo », « fichier ») et ne sont jamais altérées par une modification ailleurs dans le texte **[Choix conception]**.

Envoi vers Linear **[Choix conception, validé par « Go »]** : statut, priorité, étiquettes et assigné partent dès qu'ils changent. Titre et description partent à la sortie du champ et à la fermeture de l'éditeur, jamais pendant la frappe : les collègues ne voient pas de texte à moitié écrit et l'historique Linear ne se remplit pas de versions intermédiaires. Règles pour l'anti-objectif « contenu perdu » **[Choix conception]** :

- La description est envoyée en modifications partielles (`save_issue` avec `patch` : remplacer ou insérer un passage ancré sur le texte actuel) **[Essai : le paramètre existe]**, calculées entre la version lue et la saisie. Une modification d'un collègue ailleurs dans le texte est préservée.
- Avant d'envoyer, Canopy relit le ticket. Si le passage modifié par Bastien a aussi changé côté Linear, rien n'est envoyé pour ce passage : l'éditeur montre les deux versions et Bastien choisit.
- Les autres champs sont envoyés champ par champ, seulement ceux que Bastien a modifiés.
- Une modification qui échoue (réseau, jeton) reste en attente, sur disque, avec un indicateur « non envoyé » sur le ticket et dans la liste. Elle est renvoyée au retour de la connexion. Elle n'est jamais jetée sans que Bastien le décide.

## 7. Lancement

Le panneau de lancement de l'étape 2, avec ces différences :

- **Nom de branche** : `<type>/<identifiant en minuscules>-<titre-court>`, par exemple `feat/eng-482-export-csv`, modifiable **[Choix conception, validé par « Go »]**. C'est la convention de l'étape 2 plus l'identifiant, qui permet à l'intégration GitHub de Linear de relier la branche et la PR au ticket. Le `gitBranchName` de Linear (`bastien/eng-482-…`) n'est pas utilisé : il contient le prénom.
- Pas de case « Passer En cours » **[Bastien]**.
- **Prompt de lancement** : identifiant, URL, titre et description (balises Linear rendues lisibles), puis une phrase indiquant que le reste du ticket (commentaires, sous-tickets, pièces jointes) est accessible via le MCP Linear **[Bastien : Claude va chercher le reste via le MCP Linear]**.
- **MCP Linear de la session** : la session utilise la configuration MCP de Claude Code de Bastien, pas la connexion de Canopy **[Bastien]**. Canopy n'injecte rien. Détection **[Choix conception]** : au démarrage de la session, le message d'initialisation du SDK liste les serveurs MCP et leur statut ; si aucun ne pointe vers Linear (nom contenant « linear », ou URL `mcp.linear.app`) ou s'il n'est pas connecté, la session affiche une fois « Claude n'a pas accès à Linear dans cette session », sans bloquer. Pas de lecture des fichiers de config de Claude Code : trop de sources (utilisateur, projet, `.mcp.json`, plugins, connecteurs claude.ai).
- **Lien branche–ticket** : un ticket Linear ne peut pas porter `branch`/`worktree`/`base` comme un fichier local. Canopy les garde dans le dossier application, par repo et par identifiant Linear, à côté des bases de branches **[Choix conception]**. Lien inverse dans la liste des worktrees comme pour les tickets locaux.
- **« Créer la PR »** sur une branche liée à un ticket Linear : le prompt demande à Claude de mettre l'identifiant dans le titre de la PR, pour que le lien se fasse même si la branche a été renommée **[Choix conception]**.

## 8. Ne rien perdre, ne rien faire disparaître

Règles transverses **[Bastien pour l'intention, Choix conception pour les règles]** :

- Une erreur ne vide jamais la liste. La dernière liste reçue est gardée en cache sur disque ; en cas d'échec, Canopy l'affiche avec « Liste du <heure> — <raison> » et un bouton pour réessayer.
- Une réponse illisible du serveur (format changé) est traitée comme une erreur, pas comme une liste vide.
- Un ticket qui quitte la liste entre deux synchros est signalé une fois, avec la raison connue : « ENG-482 n'est plus assigné à toi », « … a été annulé », « … est introuvable ».
- Un ticket lancé reste accessible depuis sa branche (section 5).
- Une modification non envoyée reste en attente et visible (section 6).
- Déconnecter Linear demande confirmation s'il reste des modifications non envoyées.

## 9. Technique

- **Client MCP** dans le process principal, avec `@modelcontextprotocol/sdk` (transport Streamable HTTP, `OAuthClientProvider`) **[Essai : fonctionne en 1.32.2]**. Le renderer n'y a pas accès ; tout passe par IPC, comme les tickets locaux.
- **Outils utilisés** **[Essai]** : `list_issues` (`assignee: "me"`, `limit`, `cursor`), `get_issue` (avec `fields`, dont `gitBranchName`, `url`, `parentId`, `cycleId`, `project`, `labels`, `assignee`, `statusType`), `save_issue` (`id` + champs ou `patch`), `list_comments`, `save_comment`, `list_issue_statuses`, `list_issue_labels`, `list_users`, `whoami`.
- **Format des réponses** : du JSON dans un bloc texte, sans schéma de sortie déclaré **[Essai]**. Chaque réponse est validée contre un schéma écrit dans Canopy ; un champ manquant ou d'un type inattendu est une erreur explicite, jamais une valeur vide silencieuse. Le serveur annonce ses outils au démarrage : si un outil utilisé manque ou a perdu un paramètre requis, la section Linear des Réglages le signale.
- **Modèle** : un ticket Linear entre dans le modèle commun de la spec parente (titre, description, statut, priorité, étiquettes) avec les champs propres à Linear à part. Priorité Linear 0–4 → Aucune, Urgente, Haute, Moyenne, Basse.
- **Performance** : environ 120 ms par appel **[Essai]**. Le détail d'un ticket (commentaires, sous-tickets) n'est chargé qu'à l'ouverture de l'éditeur.
- **Réponses de référence** : la première tâche du plan capture, contre l'espace perso `canopy` enrichi (sous-tickets, cycle, étiquettes, commentaires, balises Linear), les réponses des outils utilisés, et les range dans `tests/fixtures/linear/`. Celles de l'essai (`/tmp/canopy-linear-spike/out`) ne couvrent que les tickets d'accueil **[Choix conception]**.
- **Comportement de `patch`** : la même tâche vérifie sur un ticket factice comment `save_issue` applique `patch` (ancre absente, ancre en double, plusieurs opérations). Repli si `patch` ne convient pas : relire, comparer à la version lue, envoyer la description complète seulement si elle n'a pas changé côté Linear, sinon conflit affiché. La fenêtre de course restante (quelques centaines de ms) est acceptée **[Choix conception]**.
- **Tests** : un faux serveur MCP en mémoire qui rejoue ces réponses de référence, pour les tests unitaires et e2e. Cas obligatoires : liste vide légitime vs erreur, jeton expiré, réponse au format changé, conflit sur la description, modification en attente puis renvoyée, ticket réassigné qui sort de la liste, identifiant identique en local et dans Linear.
- **Essai manuel** contre l'espace perso `canopy` avant de livrer, avec des tickets couvrant sous-tickets, commentaires, étiquettes et cycle (non vérifiés pendant l'essai, faute de données).

## 10. Laissé au constructeur

- Le découpage des modules et des stores, en suivant `src/main/tickets` et `src/renderer/tickets`.
- Le calcul des modifications partielles de la description et l'affichage d'un conflit.
- L'affichage exact des balises Linear dans l'éditeur.
- Le port de retour OAuth et la page affichée au retour.
- Les textes d'erreur.
