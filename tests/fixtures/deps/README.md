# Fixtures du contrôle des dépendances

Réponses capturées rejouées par `src/main/deps/replay.ts` quand l'app tourne hors build packagé avec `CANOPY_FAKE_DEPS=tests/fixtures/deps` (chemin résolu depuis le répertoire courant). Aucune requête réseau.

## Disposition

Une URL `https://<hôte>/<chemin>` est lue dans `<hôte>/<chemin>.json` (`.json` ajouté sauf s'il y est déjà).

- npm : `registry.npmjs.org/<nom>.json`. Un nom scopé garde son `/` encodé, le fichier s'appelle donc littéralement `@scope%2fname.json` (aucun sous-dossier).
- RubyGems : `rubygems.org/api/v1/versions/<gem>.json`.
- PyPI : `pypi.org/pypi/<nom normalisé PEP 503>/json.json`.
- OSV, détail : `api.osv.dev/v1/vulns/<id>.json` (réponse OSV telle quelle).
- OSV, lots : `api.osv.dev/v1/querybatch.json` est une table `{ "<écosystème>:<nom>@<version>": [ { "id", "modified" } ] }` ; le rejeu en fait la réponse `results` alignée sur les requêtes. Une clé absente = aucune faille.

Un fichier absent répond 404. Les segments contenant `..`, `\` ou un octet nul sont refusés.

## Ajouter un paquet

Créer son fichier de registre ; pour une faille, ajouter une entrée dans `querybatch.json` et le fichier `vulns/<id>.json` correspondant.

## Contenu actuel

`tar@6.1.11` (faille critique, corrigée en 6.2.1), `request@2.88.2` (déprécié), `electron@33.2.0` (dernière 39.1.0), `zustand@5.0.1` (dernière 5.0.8).
