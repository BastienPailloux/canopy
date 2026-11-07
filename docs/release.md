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

   Une approbation manuelle (Required reviewers) est possible mais désactivée par défaut : merge = livraison.

Les secrets ne sont exposés qu'à l'étape de signature et de notarisation, jamais pendant `npm ci`.

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
