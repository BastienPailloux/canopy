# Publier une version de Canopy

Une release part d'un push sur `master` (workflow `.github/workflows/release.yml`). La version est calculée depuis les commits (`fix`/`perf` : patch, `feat` : minor, `!` ou `BREAKING CHANGE:` : major). Sans commit de ce type, le workflow se termine en vert sans rien publier. Le tag `vX.Y.Z` est créé seulement si typecheck, tests, build, signature et notarisation ont réussi.

## 1. Certificat Developer ID Application

1. Ouvrir Trousseau d'accès > Assistant de certification > Demander un certificat à une autorité de certification. Saisir ton e-mail, choisir « Enregistrée sur le disque » et générer le fichier `.certSigningRequest` (CSR).
2. Sur developer.apple.com > Certificates, Identifiers & Profiles > Certificates, cliquer `+`, choisir **Developer ID Application**, envoyer le CSR, puis télécharger le `.cer`.
3. Double-cliquer le `.cer` pour l'installer dans le trousseau « session ».

## 2. Export en `.p12` et encodage

1. Dans Trousseau d'accès > Mes certificats, clic droit sur « Developer ID Application: … » (avec sa clé privée) > Exporter, format `.p12`. Choisir un mot de passe : ce sera `CSC_KEY_PASSWORD`.
2. Encoder le fichier et copier le résultat dans le presse-papiers :

   ```sh
   base64 -i cert.p12 | pbcopy
   ```

   Cette valeur est `CSC_LINK`. Supprimer ensuite le `.p12` du disque.

## 3. Clé API App Store Connect

1. Sur appstoreconnect.apple.com > Users and Access > Integrations > Team Keys, créer une clé d'équipe avec le rôle **Developer**.
2. Noter le **Key ID** (`APPLE_API_KEY_ID`) et l'**Issuer ID** affiché en haut de la page (`APPLE_API_ISSUER`).
3. Télécharger le fichier `.p8` (une seule fois possible). Son contenu texte complet, lignes `BEGIN`/`END` comprises, est `APPLE_API_KEY` : `pbcopy < AuthKey_XXXX.p8`.

## 4. Environment GitHub `release`

1. Dépôt > Settings > Environments > New environment, nommé `release`.
2. Deployment branches and tags > Selected branches and tags > ajouter la règle `master`.
3. Ajouter les 5 secrets dans l'Environment (pas au niveau du dépôt) :

   | Secret | Contenu |
   |---|---|
   | `CSC_LINK` | `.p12` encodé en base64 |
   | `CSC_KEY_PASSWORD` | mot de passe du `.p12` |
   | `APPLE_API_KEY` | contenu du fichier `.p8` |
   | `APPLE_API_KEY_ID` | Key ID |
   | `APPLE_API_ISSUER` | Issuer ID |

4. Required reviewers : le mainteneur, « Allow administrators to bypass » décoché. Chaque release attend son approbation dans l'onglet Actions : un push sur `master` (jeton volé, agent, poste compromis) ne publie rien seul.

Les secrets ne sont exposés qu'à l'étape de signature et de notarisation, jamais pendant `npm ci`. Le workflow n'utilise que des actions officielles `actions/*`, référencées par leur tag majeur (`@v4`). N'y ajouter aucune action tierce : elle tournerait dans le job qui détient les secrets.

## 4 bis. Rulesets du dépôt

Settings > Rules > Rulesets :

| Ruleset | Cible | Règles |
|---|---|---|
| `master` | `refs/heads/master` | pas de suppression, pas de force-push |
| `develop` | `refs/heads/develop` | pas de suppression, pas de force-push, PR obligatoire (squash seulement), checks obligatoires (cf. section 4 ter) |
| `release tags` | `refs/tags/v*` | pas de modification ni de suppression |

La création des tags `v*` reste ouverte : sur un dépôt personnel, GitHub Actions ne peut pas être ajouté en contournement, et la CI doit créer le tag.

## 4 ter. CI des pull requests

`ci.yml` et `codeql.yml` tournent sur chaque PR vers `develop` ou `master` et sur chaque push sur ces branches ; `pr-title.yml` seulement sur les PR vers `develop` (le titre devient le commit de squash) :

| Workflow | Job (nom du check) | Rôle |
|---|---|---|
| `ci.yml` | `typecheck, tests, build` | `npm ci`, typecheck, tests Vitest, build (macOS) |
| `ci.yml` | `e2e` | Playwright sur l'app Electron, réparti sur 3 runners macOS (`e2e 1/3`…), traces jointes en cas d'échec |
| `ci.yml` | `npm audit` | échoue sur une vulnérabilité `high` ou `critical` dans les dépendances livrées (`--omit=dev`) |
| `pr-title.yml` | `conventional title` | le titre de PR (futur commit de squash) doit être un Conventional Commit valide (`scripts/ci/prTitle.ts`) |
| `codeql.yml` | `analyze` | analyse de sécurité CodeQL (`security-extended`), aussi chaque lundi |

Aucun de ces workflows n'a de secret, et leur jeton est en lecture seule (sauf l'envoi des résultats CodeQL). Ils peuvent donc utiliser `github/codeql-action`, contrairement au workflow de release.

Dependabot (`.github/dependabot.yml`) ouvre chaque semaine des PR vers `develop` pour npm et les actions, titrées `chore(deps): …` / `ci: …`.

Pour rendre ces checks bloquants : ruleset `develop` > Require status checks to pass > ajouter les cinq noms de checks ci-dessus, et cocher « Require branches to be up to date before merging ».

## 5. Règle de merge

Le calcul de version lit les commits atteignables depuis `master` depuis le dernier tag. **Ne jamais faire de squash de `develop` vers `master`** : les types de commit (`feat`, `fix`, …) seraient perdus. Utiliser un vrai merge ou un fast-forward.

## 6. Procédure de test de mise à jour

Elle remplace un test de bout en bout automatisé.

1. Remplir l'Environment `release` (sections 1 à 4).
2. Merger dans `master`. Le workflow publie `v1.0.0`.
3. Installer le `.dmg` de la release. Il s'ouvre sans avertissement Gatekeeper.
4. Vérifier : session Claude, terminal, recherche, langage TS, `canopy .`.
5. Pousser un `fix:` trivial sur `master`. `v1.0.1` est publiée.
6. Dans la `v1.0.0` installée, ouvrir un fichier modifié non enregistré et un brouillon. Le bandeau apparaît en moins de 4 h, ou tout de suite en relançant l'app.
7. Cliquer `Redémarrer`. L'app redémarre en `1.0.1`, le panneau « Quoi de neuf » liste le correctif et le fichier récupéré, et le brouillon est revenu.
