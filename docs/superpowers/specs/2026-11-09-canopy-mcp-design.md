# Canopy — Outils Canopy pour Claude (serveur MCP interne)

Date : 2026-11-09
Ticket : CAN-4 « Transformer Canopy en serveur MCP ».
Specs liées : `2026-11-08-tickets-design.md`, `2026-11-08-linear-connector-design.md`, `2026-11-08-mockups-design.md`.

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Aujourd'hui, Bastien tient son backlog à la main dans l'écran Tickets : il crée, découpe et met à jour les tickets, cherche s'il en existe déjà un pour le sujet, et vérifie à l'œil que la maquette liée correspond encore à ce qu'il veut. Le but est que Claude fasse ce travail lui-même depuis une session Canopy : « découpe CAN-4 en sous-tickets », « est-ce qu'on a déjà un ticket pour l'export ? », « passe CAN-7 en revue », « la maquette de CAN-3 est-elle encore réalisable avec ce qu'on vient de faire ? ».

Succès : dans une session Canopy, Bastien demande à Claude de découper un ticket (local ou Linear) en sous-tickets. Claude vérifie qu'ils n'existent pas déjà, les crée, et ils apparaissent dans l'écran Tickets sans que Bastien ait rien validé ni configuré.

## 2. Décisions de Bastien

- **Pour qui** : uniquement les sessions Claude lancées dans Canopy **[Bastien]**. Aucun serveur exposé hors de l'app (pas de port, pas de stdio, rien à configurer dans Claude Code).
- **Autonomie** : Claude agit directement, sans demande de permission ni brouillon à valider **[Bastien]**.
- **Sources** : tickets locaux (`.tickets/`) **et** tickets Linear **[Bastien]**.
- **Sous-tickets** : de vrais sous-tickets locaux, chacun un ticket complet rattaché à un parent, pas les sous-tâches cochables **[Bastien]**. Pour Linear, un sous-ticket est un ticket enfant Linear (`parentId`).
- **Recherche Linear** : seulement parmi les tickets assignés à Bastien **[Bastien]**, comme la liste actuelle.
- **Maquettes et contradictions** : ce n'est pas une détection automatique. Une maquette peut être dépassée ou irréalisable, c'est normal **[Bastien]**. Claude lit la maquette liée et signale l'écart.

## 3. Objectifs, non-objectifs, anti-objectifs

Objectifs :
- Claude peut lister et chercher les tickets (locaux et Linear assignés), en lire un en détail avec son parent, ses enfants et ses maquettes liées.
- Claude peut créer un ticket ou un sous-ticket (local ou Linear) et en modifier les champs.
- Claude peut lister les maquettes du repo, les lier à un ticket local ou les en délier, et changer leur statut.
- Les sous-tickets locaux existent dans le modèle, le fichier et l'interface.

Non-objectifs :
- Serveur MCP accessible depuis l'extérieur de Canopy.
- Pilotage du reste de l'app par Claude : worktrees, sessions, terminaux, lancement de ticket, « Tester la PR ».
- Recherche dans toute l'équipe Linear, commentaires Linear, archivage ou suppression de tickets par Claude.
- Outil de « détection de contradiction » : Claude raisonne lui-même à partir du ticket, du code et de la maquette lue avec son outil `Artifact`.
- Modification du contenu d'une maquette sur claude.ai par ces outils. Claude le fait déjà avec `Artifact` quand Bastien le demande.

Anti-objectifs, ce qui serait un échec même si ça marche :
- Une modification Linear de Claude qui contourne les règles de l'app : description envoyée en entier, écriture hors de la file `linear-pending.json`, modification d'un collègue écrasée.
- Une demande de permission à chaque action de Claude sur un ticket.
- Un fichier `.tickets/` ou `.mockups/mockups.json` corrompu ou réécrit en perdant des champs inconnus.
- Un secret (jeton Linear) qui se retrouve dans la session ou dans le renderer.

## 4. Mécanisme

- Un serveur MCP **dans le process principal**, créé avec `createSdkMcpServer` du SDK (`@anthropic-ai/claude-agent-sdk`) et nommé `canopy` **[Choix conception]**. Il est passé dans `options.mcpServers` de chaque session lancée par `SessionManager.options()`. Les outils s'appellent donc `mcp__canopy__<outil>`.
- Un serveur par session, lié au **checkout principal** du `cwd` de la session (`mainWorktreeRoot`). Une session dans un worktree voit donc les tickets et maquettes du repo, comme l'écran Tickets **[Choix conception]**.
- **Pas de permission** : les outils `mcp__canopy__*` sont ajoutés à `allowedTools`, et `canUseTool` les autorise aussi, au cas où le SDK le consulterait **[Bastien : agir direct]**. Cela vaut dans tous les modes, sauf en mode plan, où les outils d'écriture sont refusés avec un message clair et seuls les outils de lecture restent permis **[Choix conception : le mode plan promet qu'il ne modifie rien]**. `allowedTools` court-circuite `canUseTool` : ce refus vit donc **dans le handler de l'outil**, qui lit le mode courant de la session par un getter fourni par `SessionManager`, puisque `setMode` peut le changer en cours de session.
- Les outils sont déclarés avec `alwaysLoad` (ou l'équivalent du SDK) pour que Claude les voie sans passer par la recherche d'outils **[Choix conception]**.
- Câblage : `SessionManager` reçoit une nouvelle dépendance, une fabrique `canopyServer({ repoRoot, mode: () => PermissionMode })`, et `options()` reçoit `repoRoot`. Le `MockupStore` doit être une instance unique partagée entre l'IPC et le serveur (aujourd'hui créé dans l'appel à `registerIpc`) pour garder la sérialisation des écritures par fichier.
- La connexion Linear est vérifiée **à chaque appel** d'un outil, pas au lancement de la session : si Bastien se connecte à Linear en cours de session, les outils Linear marchent aussitôt ; non connecté, ils renvoient « Canopy n'est pas connecté à Linear » **[Choix conception]**.
- La logique de chaque outil est une fonction pure testable (`src/main/mcp/canopyTools.ts`), qui reçoit ses dépendances : `TicketStore`, `MockupStore`, `LinearClient`, `LinearEdits`, `LinearSync`. Le câblage SDK reste mince (`src/main/mcp/canopyServer.ts`) **[Choix conception]**, dans le style de `createQuitFlow`.
- Le serveur ne passe aucun secret à la session : les appels Linear partent du process principal avec la connexion existante.
- Les écritures passent par les mêmes stores que l'IPC. L'écran Tickets se met donc à jour par les mécanismes existants : surveillance de `.tickets/` et `.mockups/`, `LinearSync.onChange` et `LinearEdits.onChange`.
- Avec `CANOPY_FAKE_QUERY`, le serveur est quand même construit et passé à `fakeQuery`, pour qu'un E2E puisse vérifier sa présence ; `fakeQuery` n'appelle pas les outils (section 9).

## 5. Outils

Noms en anglais, descriptions des outils en anglais (lues par Claude), messages d'erreur renvoyés en français comme le reste de l'app **[Choix conception]**. Une clé de ticket est `local:CAN-4` ou `linear:ENG-482` (`TicketKey`, déjà dans `src/shared/tickets.ts`). Les réponses sont du JSON compact.

Lecture :

| Outil | Entrée | Sortie |
|---|---|---|
| `list_tickets` | `query?` (texte, insensible à la casse et aux accents : titre et description pour un ticket local, titre et labels pour Linear), `source?` (`local` / `linear`), `status?`, `includeDone?` (défaut `false`). Les tickets archivés ne sont jamais listés **[Choix conception : `TicketStore` ne lit pas `archive/`]** | clé, titre, statut, priorité, labels, clé du parent, branche si lancé ; nombre d'enfants pour les tickets locaux seulement. Les tickets locaux illisibles sont listés à part, par nom de fichier. |
| `get_ticket` | `key` | tous les champs, description complète, parent, enfants (clé, titre, statut), maquettes liées (titre, URL, statut, type), sous-tâches cochables pour un ticket local. Pour Linear : statuts et labels disponibles de l'équipe (`teamOptions`). |
| `list_mockups` | `ticket?` (clé locale), `unlinked?` | id, titre, URL, type, statut, ticket lié |

Écriture :

| Outil | Entrée | Effet |
|---|---|---|
| `create_ticket` | `source`, `title`, `description?`, `priority?`, `labels?`, `status?`, `parent?` (clé du parent, même source) | crée le ticket, renvoie sa clé |
| `update_ticket` | `key`, et au moins un champ parmi `title`, `description` (texte complet voulu), `status`, `priority`, `labels` (ensemble complet voulu), `parent` (clé ou `null`, local uniquement) | modifie le ticket |
| `link_mockup` | `mockup` (id ou URL), `ticket` (clé locale, ou `null` pour délier), `status?` | modifie le registre des maquettes |

Recherche Linear **[Choix conception]** : `list_tickets` s'appuie sur la liste déjà chargée (`LinearSync`, issue de `listMine`), qui n'a ni description ni nombre d'enfants. Pas d'appel par ticket. La description de l'outil dit à Claude d'ouvrir les candidats avec `get_ticket` pour vérifier un doublon.

Règles d'écriture :
- **Local** : `create_ticket` et `update_ticket` passent par `TicketStore.create` / `patch`, avec les mêmes limites (`MAX_TITLE`, `MAX_DESCRIPTION`, `MAX_LABELS`…) et la même conservation des champs inconnus.
- **Linear, modification** : `update_ticket` construit un `LinearChange` et appelle `LinearEdits.save`, exactement comme l'éditeur. Pour la description, `base` est la description Linear relue juste avant (`client.issue`), `text` est celle de Claude, et `LinearEdits` en tire le `patch`. Pour les labels, `base` est l'ensemble relu, `next` celui de Claude.
- **Linear, modification en attente de Bastien** **[Choix conception, imposé par l'anti-objectif « modification écrasée »]** : si `LinearEdits.pending()` contient déjà une modification de Bastien pour ce ticket, `get_ticket` montre sa version (titre, description, labels en attente, comme `launchLinear`), et `update_ticket` prend cette version comme `base` (`base` = texte en attente de Bastien pour la description, ensemble `next` en attente pour les labels). `merge()` enchaîne alors les deux modifications au lieu que celle de Claude remplace celle de Bastien. Test dédié. Le statut est donné par son nom, Canopy le traduit en `statusId` via `teamOptions` (nom inconnu : erreur listant les noms valides). Le résultat `sent` / `pending` / `conflict` est rendu à Claude en clair (« enregistré », « en attente : <raison> », « conflit avec une modification d'un collègue : la description n'a pas été envoyée »).
- **Linear, création** : nouveau `LinearClient.createIssue`, `save_issue` sans `id`. Le ticket est assigné à Bastien (paramètre `assignee: "me"` de `save_issue`) pour qu'il apparaisse dans sa liste **[Choix conception : cohérent avec « tickets assignés »]**. Équipe : celle du parent s'il y en a un ; sinon celle des tickets assignés à Bastien si elle est unique ; sinon Claude doit passer `team` (nom), et l'erreur liste les équipes connues **[Choix conception]**. La création ne passe pas par la file : hors ligne ou déconnecté, l'outil échoue avec la raison, et Claude le dira **[Choix conception : la file ne connaît que des modifications d'un ticket existant]**. Après création, `LinearSync.refresh()`.
- **Parent** : même source que l'enfant (pas de ticket local enfant d'un ticket Linear ni l'inverse). Pas de cycle, pas de parent archivé. Le changement de parent d'un ticket Linear existant reste hors périmètre **[Choix conception : pas demandé, et `parentId` n'est pas un champ de `LinearChange`]**.
- **Archivé** : un ticket local archivé ne peut pas être modifié par Claude (erreur). Il n'est pas listé par défaut.

## 6. Sous-tickets locaux

Modèle :
- Nouveau champ optionnel `parent?: string` (id local) dans `TicketFields`, écrit `parent: CAN-3` dans le front matter (ajouté à `KNOWN` dans `format.ts`).
- Les sous-tâches cochables restent inchangées : elles coexistent avec les sous-tickets.
- Validation dans `TicketStore` (et donc aussi pour l'IPC) : le parent existe, n'est pas le ticket lui-même, n'est pas archivé, et la chaîne des parents ne revient pas sur le ticket. Profondeur libre **[Choix conception : comme Linear]**.
- Un parent archivé ou supprimé à la main laisse ses enfants intacts. Leur `parent` pointe alors sur un ticket absent, affiché « CAN-3 (introuvable) ».
- Archiver un parent n'archive pas ses enfants **[Choix conception]**.

Interface (écran 3b, `TicketEditor`) **[Choix conception]** :
- Un ticket avec parent affiche « Sous-ticket de CAN-3 · <titre> », cliquable, qui ouvre le parent.
- Un ticket avec enfants affiche une section « Sous-tickets », même présentation que `SubIssues` dans `LinearEditor` : clé, titre, statut, et un clic ouvre l'enfant.
- Un sélecteur « Parent » dans l'éditeur permet à Bastien de rattacher ou détacher un ticket à la main : il propose les tickets locaux non archivés, sauf le ticket lui-même et ses descendants.
- Liste (écran 3) : à plat comme aujourd'hui, avec la clé du parent en petit sous le titre d'un sous-ticket. Pas d'arborescence.
- `launchPrompt` d'un ticket qui a un parent ajoute une ligne « Ticket parent : CAN-3 : <titre> ». La liste des enfants n'est pas ajoutée.

## 7. Maquettes et contradictions

- `get_ticket` renvoie les maquettes liées avec leur URL. La description de l'outil invite Claude à les lire avec son outil `Artifact` (`read`), déjà disponible dans les sessions Canopy (`CLAUDE_CODE_ARTIFACT=1`), quand il prépare ou découpe un ticket.
- Quand Claude constate un écart (maquette dépassée, irréalisable, ou en contradiction avec un autre ticket), il le dit dans la conversation et peut l'écrire dans la description du ticket. Il ne modifie la maquette sur claude.ai que si Bastien le demande **[Choix conception]**.
- Limite connue : `Artifact read` ne lit que les maquettes du compte claude.ai connecté. Une maquette d'un autre compte est signalée comme illisible, sans plus.
- Les maquettes ne se lient qu'à des tickets locaux, comme aujourd'hui (`Mockup.ticket`).

## 8. Effets de bord sur l'existant

- L'avertissement « serveur MCP Linear manquant » (`LINEAR_NOTICE`, `expectLinear`) n'a plus lieu d'être : toute session Canopy a désormais les outils Linear de Canopy. Il est retiré **[Choix conception]**. Si Canopy n'est pas connecté à Linear, l'outil le dit à l'appel.
- `src/main/linear/replay.ts` doit savoir créer un ticket (`save_issue` sans `id`), pour les tests et les E2E en mode `CANOPY_FAKE_LINEAR`.
- **Capture préalable** : la réponse réelle de `save_issue` en création, et la forme d'un `parentId` non nul, ne sont pas encore capturées (`tests/fixtures/linear/README.md` les dit inconnues). Première étape du plan : Bastien lance une capture sur son compte Linear (création d'un ticket et d'un sous-ticket de test), on l'ajoute aux fixtures, puis on écrit `parse` et `replay` d'après elle.
- `CLAUDE.md`, section Architecture : ajouter `src/main/mcp/`.

## 9. Tests

- Vitest `tests/main/mcp/canopyTools.test.ts` : chaque outil, sur un vrai repo temporaire (`tests/helpers/repo.ts`) pour le local et sur le client de relecture Linear pour Linear. À couvrir : la description Linear part en `patch`, un conflit est rendu en clair, le refus d'écriture en mode plan, le refus d'un parent invalide (lui-même, cycle, archivé, autre source).
- Vitest sur `format.ts` et `TicketStore` pour `parent` : aller-retour du fichier, validation, cycle.
- Vitest sur `SessionManager.options()` : `mcpServers.canopy` présent, outils dans `allowedTools`.
- E2E `tests/e2e/tickets.spec.ts` (ou nouveau spec) : sous-ticket affiché sous son parent, navigation parent ↔ enfant, sélecteur « Parent ».
- E2E : le serveur `canopy` est annoncé dans `mcp_servers` d'une session factice. Faire appeler un outil par `fakeQuery` est laissé au constructeur, s'il est simple à scénariser.
- Le comportement réel avec Claude (choix des outils, lecture des maquettes) n'est pas testable automatiquement : vérification manuelle par Bastien.

## 10. Laissé au constructeur

- La forme exacte des schémas zod et des descriptions d'outils.
- Le format JSON de réponse, tant qu'il reste compact et lisible.
- Le découpage des PR : par exemple sous-tickets locaux d'abord, outils ensuite.
