# Résultats du spike SDK (Task 2)

Date : 2026-11-07. SDK `@anthropic-ai/claude-agent-sdk` 0.3.319, qui embarque le CLI 2.1.319. CLI de la machine : 2.1.304. Electron 45.2.3, macOS arm64.

**Décision : GO.** Stream, autorisations et reprise fonctionnent. Interruption, image, slash commands et skills aussi. Le packaging fonctionne à condition de passer `pathToClaudeCodeExecutable`. Plan B non nécessaire à ce stade.

## Méthode

- Le process principal d'Electron exécute des scénarios scriptés et écrit les messages bruts dans un fichier JSONL. Pas de fenêtre : aucune carte d'autorisation n'a été affichée, seul le callback `canUseTool` a été testé.
- Chaque session tourne dans un repo git jetable, avec `model: 'haiku'` sauf un test `opus`. `settingSources` n'est pas défini, donc la vraie configuration de Bastien est chargée : 29 plugins, 125 skills, hooks compris.
- Lancement en développement : `electron` sous `env -i` avec `HOME`, `USER`, `PATH`, `TMPDIR`, `LANG`.
- Coût estimé par le SDK : environ 0,45 $, dont 0,29 $ pour le seul test `opus`.
- Les 24 sessions créées ont été supprimées avec `deleteSession`, et `spike/` a été supprimé.

## Résultats

| Point vérifié | Résultat | Observation |
|---|---|---|
| Stream du texte | OK | `includePartialMessages: true` : `stream_event` / `content_block_delta` / `text_delta` arrive par fragments (`'Created'`, `' \`spike-stream\`.'`, `'\n\nT'`, …), toutes les 15 à 20 ms. |
| Stream des outils | OK | `input_json_delta` pour l'entrée, puis `assistant` avec `tool_use`, puis `user` avec `tool_result` et `tool_use_result`. |
| Second tour dans la même file | OK | Un seul `query()`, le `session_id` ne change pas, nouveau `result` à chaque tour. |
| `interrupt()` pendant une commande | OK | Le `perl -e 'sleep 47'` de premier plan tourne (vu dans `ps`), `interrupt()` répond en 3 ms avec `{still_queued: []}`, le process disparaît. `result` : `subtype: 'error_during_execution'`, `is_error: true`, `terminal_reason: 'aborted_tools'`. Le tour suivant répond normalement. |
| `interrupt()` pendant une attente d'autorisation | OK | `options.signal` passe à `aborted`, l'événement `abort` est reçu, même `result`. |
| `q.close()` pendant une commande | OK | La commande est tuée, le générateur se termine sans erreur en 2 s, aucun `result`. |
| `canUseTool` allow | OK | `{behavior:'allow', updatedInput: input}` : fichier créé. `{behavior:'allow'}` sans `updatedInput` marche aussi. |
| `canUseTool` allow avec `updatedInput` modifié | OK | La commande réécrite est celle qui s'exécute (`rewritten-by-host` créé, `rewrite-me` absent). Le `tool_use` du stream garde l'entrée d'origine. |
| `canUseTool` deny | OK | `{behavior:'deny', message}` : fichier non créé, `tool_result` avec `is_error: true` et le message, le tour continue, `result.permission_denials` rempli. |
| deny avec `interrupt: true` | OK | Le tour s'arrête comme une interruption (`error_during_execution`, `aborted_tools`). La session reste utilisable. |
| « Toujours » avec toutes les `suggestions` | KO pour l'usage prévu | Passe aussi `setMode: acceptEdits` et `addDirectories` : le mode de la session bascule sans prévenir, et `Write` puis `touch` ne demandent plus rien. |
| « Toujours » avec les seules `addRules` | OK | Même commande : plus de demande. Autre commande et `Write` : demande maintenue. Mode inchangé. Règle écrite dans `<cwd>/.claude/settings.local.json` (`"Bash(touch always-two *)"`), fichier absent de `git status` dans le repo de test. |
| Commandes en lecture seule | Note | `echo spike-stream` n'appelle pas `canUseTool` en mode `default`. |
| `permissionMode` omis | partiel | Mode `default` observé avec `haiku` et `opus`, `canUseTool` appelé. Le `sdk.d.ts` annonce `'auto'` là où c'est le défaut : sur ce compte ce n'est pas le cas, rien ne le garantit ailleurs. |
| `AskUserQuestion` | OK | Voir la section dédiée. |
| Reprise CLI → SDK | OK | Session créée par `claude -p "reply with OK"`. `options.resume` : même `session_id`, la session cite `reply with OK` à la lettre. `getSessionInfo`, `listSessions`, `getSessionMessages` la voient. |
| Reprise SDK → CLI | OK | Mot de code donné dans une session SDK, `claude -p --resume <id>` répond `ZEBRA42`, même `session_id`, malgré le CLI plus ancien (2.1.304 contre 2.1.319). |
| Même session ouverte dans les deux | partiel | Aucun verrou, aucune erreur, le fichier n'est pas corrompu, mais la conversation se scinde en silence. Voir plus bas. Testé avec `claude -p --resume`. **Non vérifié** avec le CLI interactif : non tenté, car accepter la confiance d'un dossier risquait de modifier la configuration utilisateur. |
| Image en bloc de contenu | OK | Bloc `{type:'image', source:{type:'base64', media_type:'image/png', data}}` après un bloc texte : un PNG vert généré répond `Green`, la question ne citant pas la couleur. Bloc conservé dans `getSessionMessages`. Le collage dans l'interface reste à faire (Task 8). |
| `supportedCommands()` | OK | 172 commandes dont 56 `builtin`, disponibles avant le premier message. Contient les plugins (`superpowers:brainstorming`, `caveman:caveman-help`, `code-review:code-review`, 18 préfixes) et les skills (`loop`, `pdf`, `docx`, …). Absentes : `help`, `plugin`, `resume`, `review`. |
| Commande de plugin exécutée | OK | `/caveman:caveman-help` envoyé comme texte : la carte d'aide revient en stream. |
| Skill par l'outil `Skill` | OK | `tool_use` `Skill`, puis le tour se termine normalement. `canUseTool` n'est pas appelé. |
| Commandes locales | OK | `/context` renvoie un `assistant` sans `stream_event`, et `/compact` renvoie `compact_boundary` puis un `result` à texte vide. |
| `setModel`, `setPermissionMode`, `supportedModels` | OK | Appliqués à chaud. `setModel` émet un `user` `isReplay: true` contenant `<local-command-stdout>`. 13 modèles listés. |
| `listSessions({dir, includeWorktrees:false})` | OK | Session lancée dans un worktree lié : absente de la liste du repo principal avec `false`, présente avec `true` ou par défaut, présente depuis le worktree. |
| `options.sessionId` | OK | Un UUID choisi à l'avance est repris par la session. Incompatible avec `resume` sans `forkSession` selon `sdk.d.ts`. |
| App packagée sans `pathToClaudeCodeExecutable` | KO | `query()` lance **de façon synchrone** `spawn ENOTDIR` : le SDK résout le binaire dans `app.asar/...`. Malgré l'`asarUnpack`. Identique lancé par `open` et directement. |
| App packagée avec `pathToClaudeCodeExecutable` | OK | Lancée par `open -n -W`, chemin dans `app.asar.unpacked/...` : stream, `canUseTool`, 172 commandes, 125 skills, 29 plugins, connexion Claude trouvée sans clé API (`apiKeySource: 'none'`). |
| `node-pty` packagé | OK | `spawn('/bin/echo', ['pty-ok'])` renvoie `pty-ok`, avec le même `asarUnpack`. |
| Taille | Note | `.app` de 702 Mo, dont 314 Mo dans `app.asar.unpacked` et 120 Mo dans `app.asar`. |
| Environnement minimal | Note | `PATH=/usr/bin:/bin` : `git` trouvé, `gh` et `node` absents, un hook `SessionStart` de Bastien échoue (`node: command not found`, code 127). La session continue. Confirme le besoin de `loginShellEnv`. |
| `env` sans `USER` | KO | `Not logged in · Please run /login`, avec `subtype: 'success'` et `is_error: true`, puis le générateur lance `Claude Code process exited with code 1`. Avec seulement `PATH`, `HOME`, `USER` : OK. |

Limites du test de lancement : il s'agit de `open`, pas d'un double-clic dans le Finder. Il a fallu lancer `open` sous `env -i`, car il transmet `ELECTRON_RUN_AS_NODE` du shell, ce qui faisait démarrer le binaire en mode Node (`bad option: --scenario=packaged`). Le `PATH=/usr/bin:/bin` observé est donc celui que j'ai imposé, pas forcément celui du Finder. Le reste de l'environnement est bien réduit : 15 variables, `cwd` = `/`.

## Forme exacte de `AskUserQuestion`

`canUseTool` reçoit `toolName: 'AskUserQuestion'` et :

```json
{
  "questions": [
    { "question": "Which color?", "header": "Color", "multiSelect": false,
      "options": [{ "label": "Red", "description": "..." }, { "label": "Blue", "description": "..." }] },
    { "question": "Which sizes?", "header": "Sizes", "multiSelect": true,
      "options": [{ "label": "Small", "description": "..." }, { "label": "Medium", "description": "..." }, { "label": "Large", "description": "..." }] }
  ]
}
```

`options.suggestions` est absent. La réponse se passe dans `updatedInput`, les questions d'origine plus `answers`, avec le texte de la question comme clé :

```ts
{
  behavior: 'allow',
  updatedInput: {
    questions: input.questions,
    answers: { 'Which color?': 'Blue', 'Which sizes?': 'Small, Medium' }
  }
}
```

- Choix multiple : libellés joints par `, `.
- Texte libre : n'importe quelle chaîne dans `answers`. Le `tool_result` change alors de formulation (`The user answered: ...`) et le modèle reçoit la valeur.
- `tool_result` observé : `Your questions have been answered: "Which color?"="Blue", "Which sizes?"="Small, Medium". You can now continue with these answers in mind.`
- `allow` sans `answers` : `The user did not answer the questions.`, sans erreur.
- `deny` avec message : le modèle reçoit le message en `is_error: true`. Utilisable pour « ne pas répondre ».
- `annotations` et `response` existent dans `sdk-tools.d.ts`. **Non vérifiés.**

## Même session dans la CLI et le SDK

Session gardée ouverte dans le SDK, `claude -p --resume` lancé en parallèle, puis deux tours simultanés :

- Le CLI voit ce que le disque contient à son démarrage : il répond `SDKALPHA, CLIBETA`.
- Le SDK garde son état en mémoire et ne voit jamais le message du CLI : il répond `SDKALPHA`.
- Les deux écrivent dans le même JSONL. Deux entrées ont le même `parentUuid` : la conversation a deux branches.
- `getSessionMessages` ne suit qu'une branche. Les messages `CLIBETA` et `cli-race` sont absents de l'historique rendu, bien que présents dans le fichier.
- Pendant les deux tours simultanés, aucun des deux n'échoue.

Conséquence : pas de corruption, mais une perte silencieuse côté affichage. Canopy doit éviter cette situation ou la signaler.

## Contradictions avec le plan

### Task 7

1. **`always:true` ne doit pas transmettre `options.suggestions` tel quel.** Filtrer sur `type === 'addRules'`. Sinon `setMode: acceptEdits` et `addDirectories` s'appliquent en même temps. Le test « `always:true` transmet `options.suggestions` en `updatedPermissions` » est à réécrire.
2. **`suggestions` peut ne rien contenir d'utilisable.** Observé : absent pour `AskUserQuestion`, `[]` pour une commande contenant une variable, uniquement `setMode` pour `Write`. Ajouter `canAlways: boolean` à `PermissionRequest`. Pour `Write`, `setMode: acceptEdits` est la seule suggestion : si on la propose, c'est un choix distinct et explicite.
3. **`PermissionRequest` est trop pauvre.** Ajouter au moins `toolUseID`, `description`, `decisionReason`, `blockedPath`, fournis par `canUseTool`. `requestId` existe dans `options` et peut être réutilisé. `title` est resté vide sur tous les appels observés : ne pas en dépendre.
4. **`pathToClaudeCodeExecutable` obligatoire en packagé**, à ajouter à `options`. Valeur : le chemin résolu du binaire avec `app.asar` remplacé par `app.asar.unpacked`, quand `app.isPackaged`. Non défini en développement.
5. **`query()` peut lancer de façon synchrone.** `start()` doit l'entourer d'un `try/catch` et passer à l'état `error`. Le plan ne couvre que l'erreur du générateur.
6. **`result` n'indique pas à lui seul l'état.** Après une interruption ou un deny avec `interrupt: true`, `is_error: true` mais la session reste utilisable : l'état doit être `idle`. À l'inverse, une erreur de connexion arrive avec `subtype: 'success'` et `is_error: true`. Se fonder sur `is_error` et `terminal_reason`, pas sur `subtype`.
7. **Le générateur lance aussi à la fermeture normale.** Si le dernier `result` est une erreur (cas de l'interruption), fermer la file fait lancer `Claude Code returned an error result`. Après `stop`, l'état doit rester `stopped`, pas `error`.
8. **`stop` :** appeler `input.close()` et `q.close()`. Seul `q.close()` a été testé sur une commande en cours.
9. **`mode` :** toujours passer `permissionMode` explicitement, `'default'` par défaut, pour ne pas dépendre de `auto`.
10. **`env` remplace `process.env`.** Fusionner avec `{ ...process.env, ...loginEnv }` : sans `USER`, plus de connexion. `loginShellEnv` a un test avec `PATH=/x` seul, qui reflète ce risque. Retirer `ELECTRON_RUN_AS_NODE` si présent.
11. **Identifiant de session :** sans message envoyé, `system/init` n'arrive pas, donc aucun `sessionId` connu. Passer `sessionId: randomUUID()` pour une nouvelle session. Le `sessionId` est alors connu dès `start()`, ce qui simplifie la fusion dans `list`.
12. **`commands(localId)` :** retirer de la complétion les noms de `terminal_slash_commands` (message `system/init`, ici `doctor`, `send-to-project`, `color`, `focus`, `reload-plugins`) et les noms internes en `__` (`__remote-workflow`).
13. **Session déjà ouverte :** `start` avec un `resumeId` déjà vivant dans Canopy doit basculer sur l'onglet existant plutôt que de lancer un second process. Pour une session ouverte dans une CLI externe, il n'y a aucun verrou : afficher un avertissement à la reprise. Le moyen de le détecter reste à trouver.
14. **`SessionSummary.title`** vient de `customTitle ?? summary`. Pas de contradiction, seulement le nom des champs.

Sans changement : `settingSources` non défini charge bien les trois sources, `send` après `result` réutilise la file, `resume` transmis tel quel, `signal` annulé pendant une attente, `listSessions({dir, includeWorktrees:false})`, forme de `PermissionDecision`, qui suffit pour `AskUserQuestion` grâce à `updatedInput`.

### Task 8

1. **« Le message final remplace sans doublon » doit se faire par bloc, pas par message.** Le SDK émet un `assistant` **par bloc de contenu**, avec le même `message.id` : un pour `thinking`, puis un pour `text` ou `tool_use`. Chacun ne contient que son bloc. Clé : `message.id` + position du bloc, sinon un bloc écrase le précédent.
2. **Le stream n'envoie pas le message de l'utilisateur.** Aucun écho, et aucune option `replayUserMessages` dans le `sdk.d.ts`. L'historique le contient. Le compositeur doit ajouter l'élément `user` lui-même à l'envoi.
3. **« Historique et stream donnent le même résultat » est faux tel quel**, à cause du point 2 et de ce qui suit. `SessionMessage` n'a ni `tool_use_result`, ni `isSynthetic`, ni `isReplay`, et `tool_result` y garde seulement son `content`. Le test doit comparer les éléments une fois l'élément `user` ajouté, sans dépendre de `tool_use_result`.
4. **Messages `user` à ne pas afficher comme tels.** `<local-command-stdout>...`, `<command-name>...`, `[Request interrupted by user for tool use]`, `Skill /... is already loaded above`, `This session is being continued from a previous conversation...`. Dans le stream, `isReplay` et `isSynthetic` permettent de les repérer. Dans l'historique, seul le texte le permet. En faire des `notice` ou les ignorer.
5. **Blocs `thinking` :** `thinking` y est vide, seule `signature` est remplie. Les ignorer. `TranscriptItem` n'a pas besoin de type dédié.
6. **`is_error` est absent quand tout va bien** pour `Write` et `AskUserQuestion`, `false` pour `Bash` : traiter l'absence comme `false`.
7. **`/compact` tronque l'historique.** Ensuite `getSessionMessages` ne rend que le résumé et les messages suivants (4 messages dans le test). Le transcript en mémoire reste plus long que celui rechargé. `system/compact_boundary` doit produire une `notice`.
8. **`system/init` revient à chaque tour** (31 outils au premier, 118 au second dans le test). Ne pas le traiter comme un début de session.
9. **`QuestionCard` :** envoyer `resolvePermission(requestId, {allow: true, updatedInput: {questions, answers}})` avec la forme ci-dessus. Le bouton « Refuser » de `PermissionCard` utilise un deny simple, sans `interrupt: true`, pour que le modèle puisse continuer.
10. **`PermissionCard` :** le bouton « Toujours » n'apparaît que si `canAlways` est vrai (voir Task 7, point 2).

### Autres tasks

- **Task 14 :** garder `asarUnpack` sur `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**` et `node_modules/node-pty/**`, validé avec `identity: null`. L'`asarUnpack` seul ne suffit pas, il faut aussi le point 4 de la Task 7.
- **Task 12 :** `@vscode/ripgrep` était déjà sorti de l'archive par electron-builder sans règle `asarUnpack`. La ligne prévue reste sans danger.

## Non vérifié

- Reprise et double ouverture avec le CLI interactif (voir plus haut).
- Vrai double-clic dans le Finder (`open` utilisé, sans personne à l'écran).
- Bundle du SDK par `electron-vite` : le spike le gardait en dépendance externe. Si la Task 7 le bundle, `import.meta.url` change.
- `cwd` supprimé pendant une session (`cwd removed while running`, Task 7).
- Sessions et sous-agents : `parent_tool_use_id`, `agentID`.
- Outils en parallèle : `canUseTool` et `tool_result` dans le désordre.
- Clé API : seul le login Claude Code a été utilisé.
- Chemin `/tmp` contre `/private/tmp` dans `listSessions({dir})` : seuls des chemins réels ont été utilisés.

## Effets de bord

- `~/.claude/projects` : sessions supprimées par `deleteSession`. Cette fonction laisse le dossier du projet et un éventuel `memory/` vide : ces dossiers vides ont été retirés avec `rmdir`.
- Pendant les tests, des fichiers récents sont apparus dans `~/.claude/` : `backups/.claude.json.backup.*`, `file-history/`, `security/`, `sessions/`. Ils sont écrits par le CLI et les plugins, sans que je puisse distinguer ceux du spike de ceux de la session qui l'a exécuté. Non modifiés ni nettoyés. Aucun réglage n'a été changé par le spike. `~/.claude.json` ne contient aucune référence aux repos jetables.
