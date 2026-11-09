# Fixtures gh

Réponses brutes de `gh` capturées sur `BastienPailloux/canopy` le 2026-11-09, avec gh 2.61.0 (2024-11-06). Lues par `tests/main/github/query.test.ts` et `gatewayRead.test.ts`. Seuls des appels en lecture ont servi : rien n'a été créé ni modifié sur GitHub.

Partout, l'adresse `noreply@anthropic.com` des lignes `Co-Authored-By` des messages de commit est remplacée par `user@example.com`. Aucun jeton ni autre adresse n'apparaît dans les réponses.

## `view-merged.json`

PR #9 (mergée), réponse non modifiée hormis les adresses (et réindentée) :

```sh
# query.graphql = PR_QUERY de src/main/github/query.ts, écrit tel quel dans un fichier
gh api graphql -F owner=BastienPailloux -F name=canopy -F number=9 -F query=@query.graphql > view-merged.json
```

Ce qu'elle contient : 2 fils de revue non résolus (Copilot puis une réponse de Bastien), dont un sans ligne (`line: null`) ; une revue `COMMENTED` de Copilot ; 49 commits du même auteur ; 119 fichiers dont 100 envoyés (`truncated.files === 19`) ; aucun check (le repo n'a pas de CI : `statusCheckRollup` vaut `null` sur chaque commit).

## `view-open.json`

Copie **modifiée à la main** de la réponse pour la PR #8 (mergée, plus petite : 2 commits, 5 fichiers, 1 fil résolu et périmé), capturée par la même commande avec `number=8`. Aucune PR de brouillon n'a été ouverte pour l'occasion. Modifications :

- `pullRequest.state` : `MERGED` → `OPEN` ; `reviewDecision` : `null` → `REVIEW_REQUIRED` ; `mergeStateStatus` : `UNKNOWN` → `BLOCKED` ;
- `repository.autoMergeAllowed` : `true`, `rebaseMergeAllowed` : `false` ;
- `labels` : `enhancement` ; `assignees` : `BastienPailloux` ;
- `reviewRequests` : un utilisateur `octocat` et une équipe `acme/core` (inventés) ;
- ajout d'un `IssueComment` (id `IC_kwDOVmYqg87fake01`, databaseId `3500000001`) qui finit par la signature `— Claude via Canopy`, `filteredCount` passé à 4 ;
- `statusCheckRollup` du premier commit : `SUCCESS` sans contexte ; du dernier : `FAILURE` avec 4 contextes inventés (ids, URLs et durées fictifs) : `unit` (Actions, succès), `e2e` (Actions, échec), `Greptile Review` (autre app, sans `workflowRun`, `NEUTRAL`) et un `StatusContext` `deploy/preview` en attente.

L'état brouillon se teste en passant `isDraft` à `true` sur la réponse lue.

## `find.json`

```sh
gh pr list --head feat/linear-tickets --state all --limit 1 --json number,state,title,url,isCrossRepository,isDraft
```

## Comportement constaté de l'API

- `timelineItems(itemTypes: …)` : `totalCount` compte **tous** les éléments de la chronologie, filtre ignoré (57 pour la PR #9) ; seul `filteredCount` (50) compte les types demandés. La troncature se calcule donc sur `filteredCount`.
- Une revue faite seulement de commentaires de ligne (ou une réponse dans un fil) est une `PullRequestReview` `COMMENTED` au corps vide ; certaines n'apparaissent même pas dans `timelineItems` (PR #9 : 3 revues, 1 seule dans la chronologie). Le parseur les laisse à leurs fils.
- Le `diffHunk` est porté par chaque commentaire, pas par le fil.
- Les bots ont un `login` sans suffixe `[bot]` en GraphQL (`copilot-pull-request-reviewer`), `__typename: "Bot"`.
- `gh api graphql -f query=@fichier` n'ouvre pas le fichier : seul `-F` lit `@fichier`.
