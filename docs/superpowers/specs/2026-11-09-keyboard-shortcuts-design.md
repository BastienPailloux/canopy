# Canopy — Raccourcis clavier (CAN-2)

Date : 2026-11-09
Ticket : CAN-2 « Ajouter des raccourcis clavier ».

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Bastien passe son temps à basculer d'un écran à l'autre à la souris **[Bastien]**. Le but : déclencher les gestes fréquents au clavier, depuis n'importe quel écran, sans quitter ce qu'il fait quand ce n'est pas nécessaire.

Succès : depuis l'écran Code, Bastien crée un ticket, change de worktree, ouvre une nouvelle session et dicte son message sans toucher la souris.

## 2. État actuel

Raccourcis existants : ⌘K (barre de recherche, `shell/CommandBar.tsx`), ⌘P et ⌘⇧F (écran Code), Ctrl+` (terminal), ⌘W (menu Fichier → `broadcast('menu:closeTab')` → `App.tsx`). Aucun pour changer d'écran ni de worktree.

## 3. Raccourcis

| Raccourci | Action | Origine |
|---|---|---|
| ⌘1 / ⌘2 / ⌘3 / ⌘4 | Écran Sessions / Code / Tickets / Maquettes | proposition, idée ajoutée **[Choix conception]** |
| ⌘⇧N | Nouveau worktree : ouvre `NewWorktreeDialog` du repo actif, par-dessus l'écran courant | ticket |
| ⌘T | Nouvelle session dans le worktree actif : `newTab(cwd)`, puis écran Sessions | ticket |
| ⌃⇥ / ⌃⇧⇥ | Worktree suivant / précédent **du repo actif uniquement** **[Bastien]**, dans l'ordre de la liste de gauche, en boucle ; ignore l'entrée « espace » et les orphelins ; marche depuis tous les écrans | ticket |
| ⌘⇧T | Nouveau ticket : modale rapide (section 5) | ticket |
| ⌘⇧D | Dictée (section 6) | ticket |
| ⌘⇧H | Aide : modale listant tous les raccourcis (pas ⌘/, qui commente une ligne dans l'éditeur de code) | idée ajoutée **[Choix conception]** |

Les touches précises sont **[Choix conception]**. Contraintes de choix : ne pas prendre ⌘⇧3/4/5 (captures d'écran macOS), ni ⌘N/⌘O/⌘Q réservés à des usages futurs ou système, ni une touche que l'éditeur de code (Monaco) utilise déjà, puisque l'accélérateur du menu passerait devant.

Sans repo ou sans worktree actif, les raccourcis qui en ont besoin ne font rien (entrée de menu grisée).

## 4. Mécanisme

**[Choix conception]** Comme ⌘W : chaque raccourci est une entrée du menu de l'app (`src/main/menu.ts`) avec son `accelerator`. Le main la transmet au renderer par `broadcast('menu:<action>')` et le renderer l'écoute via `window.canopy.on`.

Pourquoi le menu plutôt qu'un `keydown` dans le renderer :
- les accélérateurs du menu passent avant Monaco et xterm, qui avalent sinon les touches ;
- ils sont visibles dans la barre de menu macOS, ce qui aide à les découvrir.

Un nouveau menu « Aller » regroupe les écrans et les worktrees. « Fichier » accueille nouveau worktree, nouvelle session, nouveau ticket et dictée. « Aide » accueille ⌘⇧H.

Le traitement côté renderer vit dans une fonction pure testable (ex. `nextWorktree(list, current, step)` pour ⌃⇥), conformément aux conventions. Le câblage dans `App.tsx` ou un hook `useShortcuts` est laissé au builder.

Règle unique : tant qu'une modale est ouverte (`[aria-modal="true"]`), **tous** les raccourcis de cette spec sont ignorés, sauf Échap géré par la modale elle-même **[Choix conception]**. Ainsi rien ne change derrière une modale. La règle est portée par la table partagée et testée.

« Repo actif » = `useApp.repo`, « worktree actif » = `useApp.worktree`. Une entrée est grisée quand la valeur dont elle a besoin est nulle **[Choix conception]**.

Une saisie non enregistrée n'est jamais perdue : changer d'écran ou de worktree conserve déjà les brouillons, il faut seulement le vérifier.

## 5. Nouveau ticket depuis n'importe où

- Modale par-dessus l'écran courant **[Bastien]**, avec un titre (obligatoire) et une description (facultative) **[Bastien, validé]**.
- ⌘↵ crée, Échap ferme (`useModal`). Après création, l'écran ne change pas. Une confirmation brève s'affiche avec un lien « Ouvrir » vers le ticket dans l'écran Tickets **[Choix conception]**. Si l'éditeur de tickets contient des modifications non enregistrées, « Ouvrir » passe par le même garde-fou que la sélection d'un autre ticket dans la liste, sans en créer un nouveau.
- Ticket **local** du repo actif, via `createTicket(repo, fields)` avec les valeurs par défaut du bouton « + Nouveau ticket » (statut, priorité…) **[Choix conception]**. La création de tickets Linear n'existe pas encore dans Canopy (`api.ts` n'a pas de création d'issue). Elle est hors périmètre ici.

## 6. Dictée

- Intégrée à l'app, et s'appuyant sur la dictée native de macOS **[Bastien]**.
- Le texte dicté arrive dans la zone de saisie de la session active et n'est jamais envoyé automatiquement. Bastien relit puis fait ⌘↵ **[Bastien]**.
- Point d'entrée : un bouton micro dans le `Composer`, plus ⌘⇧D. Le raccourci ouvre l'écran Sessions si besoin, met le focus dans le composer de l'onglet actif (curseur en fin de texte), puis lance la dictée **[Choix conception]**. Sans onglet ouvert, une session est créée d'abord comme ⌘T.
- Déclenchement prévu : `Menu.sendActionToFirstResponder('startDictation:')` dans le main, appelé par IPC (`dictation:start`) après que le renderer a posé le focus. Pas de service externe, pas de clé. La langue et le micro se règlent dans Réglages Système.
- **Risque à lever en premier** : vérifier dans l'app réelle que ce sélecteur ouvre bien la dictée sur le champ focalisé d'Electron. Si ce n'est pas le cas, seule la dictée s'arrête : on revient vers Bastien avant de choisir une autre voie, et les autres raccourcis continuent et sont livrés sans elle **[Choix conception]**. La dictée est donc une étape séparée du plan.
- Les E2E ne peuvent pas tester la dictée réelle. Ils vérifient le focus et l'appel IPC (via un faux, comme `CANOPY_FAKE_*`).

## 7. Aide ⌘⇧H

Modale listant les raccourcis de la section 3, générée depuis la même table de données que le menu, pour que les deux restent toujours en accord **[Choix conception]**. Cette table vit dans `src/shared/` (aucune dépendance Electron ni DOM).

## 8. Hors périmètre, idées pour plus tard

- Créer un ticket directement dans Linear (demande une création d'issue côté connecteur).
- Ajouter les worktrees et les tickets à la barre ⌘K, pour y aller par leur nom.
- ⌘. pour interrompre la session en cours.
- Raccourcis personnalisables.

## 9. Tests

- Vitest : table des raccourcis (unicité des accélérateurs, cohérence avec le menu), `menuTemplate` (entrées et accélérateurs), `nextWorktree`, actions grisées sans repo ou worktree.
- Playwright : ⌘1–4, ⌃⇥, ⌘T, ⌘⇧N ouvre la modale, ⌘⇧T crée un ticket sans changer d'écran, ⌘⇧D focalise le composer et appelle la dictée (faux), ⌘⇧H affiche l'aide. Les accélérateurs du menu ne se déclenchent pas toujours au clavier en E2E avec la fenêtre masquée : le builder peut piloter l'entrée de menu via `app.evaluate` si besoin.
