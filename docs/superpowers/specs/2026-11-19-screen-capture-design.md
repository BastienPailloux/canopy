# Canopy — Capture d'écran et enregistrement en pièce jointe

Date : 2026-11-19
Spec parente : `2026-11-07-canopy-design.md` (sessions, composeur).

Convention : **[Bastien]** = décidé par Bastien. **[Choix conception]** = décidé pendant la rédaction, à contester librement.

## 1. Intention

Montrer à Claude un comportement de l'app qu'on teste : ce que l'on fait et comment l'app réagit, dans le temps **[Bastien]**. Aujourd'hui, le composeur accepte seulement des images et des PDF (`src/renderer/sessions/attachments.ts`). L'API Claude ne lit pas la vidéo : il faut donc lui donner une séquence d'images, avec la chronologie des actions.

Succès : depuis le composeur, on capture une zone de l'écran (une image ou un enregistrement) en quelques secondes. Claude reçoit assez de contexte pour décrire ce qui s'est passé, clic par clic, sans qu'on ait à le raconter.

## 2. Périmètre

Dans le périmètre :

- Un **outil de capture intégré à Canopy** plutôt qu'un import de fichier vidéo **[Bastien]**.
- Deux modes : **capture d'écran** (une image) et **enregistrement** (une séquence) **[Bastien]**.
- **Choix d'une zone de l'écran** ou de l'écran entier, pour les deux modes **[Bastien]**.
- **Clics notés** pendant l'enregistrement, sans les frappes clavier (niveau « a ») **[Bastien]**.

Hors périmètre :

- **Frappes clavier** : jamais enregistrées, pour qu'un mot de passe ne parte pas chez Claude **[Bastien]**.
- **Son et micro** **[Choix conception]**.
- **Import d'un fichier vidéo existant** (`.mov`, `.mp4`) : c'était l'option 1, écartée au profit de l'enregistreur **[Bastien]**. Elle pourra réutiliser la sélection d'images clés plus tard.
- **Montage** : pas de recadrage ni de suppression d'images après coup. La pièce jointe se garde ou se retire entière **[Choix conception]**.

Anti-objectifs :

- Une capture qui montre à Claude la fenêtre de Canopy ou le panneau d'enregistrement à la place de l'app testée.
- Un enregistrement qui part en dizaines d'images identiques et consomme le contexte pour rien.

## 3. Parcours (validé par Bastien)

### 3.1 Lancer

- Un **bouton caméra** dans le composeur, à côté du trombone, ouvre un menu : « Capture d'écran » et « Enregistrer ».
- Deux **raccourcis** sont ajoutés à `SHORTCUTS` (`src/shared/shortcuts.ts`), menu `file`, `needs: 'worktree'`, comme `dictation`. Les touches sont au choix du builder, sans conflit avec la table existante.
- La capture s'attache au **composeur de l'onglet de session actif du worktree au moment du lancement**, retenu par l'identifiant de l'onglet. Changer d'onglet ou de worktree pendant que Canopy est masqué ne la déplace pas. Si cet onglet a été fermé entre-temps, la capture est abandonnée avec un message. Le raccourci affiche l'écran Sessions et vise le composeur comme le fait `dictation` (`renderer/shell/shortcuts.ts`) **[Choix conception]**.

### 3.2 Choisir la zone

- La fenêtre Canopy **se masque** (`hide`, pas `minimize`) **[Bastien]**.
- Un **voile semi-transparent** couvre chaque écran (une fenêtre transparente plein écran par écran, au-dessus de tout).
- Glisser trace un rectangle. Un simple clic prend l'écran entier sous le curseur. Échap annule et réaffiche Canopy sans rien joindre.
- En capture d'écran, l'image est prise dès que la zone est validée.
- En enregistrement, l'enregistrement démarre dès que la zone est validée.

### 3.3 Pendant l'enregistrement

- Un **panneau flottant** affiche `● 0:12 / 2:00   ■ Arrêter`. Le temps passe en rouge pendant les 10 dernières secondes **[Choix conception]**, toujours au-dessus. Il est placé hors de la zone quand c'est possible : sous la zone, sinon au-dessus, sinon dans un coin de l'écran.
- Le panneau est **exclu de la capture** (`setContentProtection(true)`). C'est aussi un risque, cf. 7.
- Pour arrêter : le bouton du panneau, ou le même raccourci. Ce raccourci est un `globalShortcut`, enregistré **seulement pendant l'enregistrement** : les accélérateurs de menu ne marchent pas quand Canopy est masqué **[Choix conception]**.
- **Arrêt automatique à 2 minutes** **[Bastien]**.
- À l'arrêt, Canopy réapparaît et la pièce jointe est dans le composeur.

### 3.4 Pièce jointe

- **Capture d'écran** : une image jointe ordinaire (`draft.images`), avec le même aperçu et le même ×.
- **Enregistrement** : **une seule pièce jointe** dans le composeur (vignette de la première image clé, durée, nombre de clics), retirable par ×.
- Un enregistrement en brouillon **survit au redémarrage** comme les images. Il passe par `Draft` dans `src/shared/update.ts`, champ facultatif pour rester compatible avec les brouillons déjà mis de côté **[Choix conception]**.

### 3.5 Ce que Claude reçoit (enregistrement)

- **Au plus 20 images clés** **[Bastien]**, en JPEG, côté long ≤ 1568 px. C'est la taille au-delà de laquelle l'API réduit l'image sans gagner de détail **[Choix conception]**.
- Une image est retenue quand **l'écran change** de façon visible (différence entre échantillons au-dessus d'un seuil) et **à chaque clic** :
  - l'état juste avant le clic ;
  - l'état ~500 ms après, pour voir la réaction.
- Au-delà de 20 images, on garde en priorité :
  1. la première et la dernière ;
  2. les paires autour des clics ;
  3. les changements les plus marqués.
- Sur chaque image qui suit un clic, un **cercle** marque l'endroit cliqué **[Bastien]**.
- Un **bloc texte de chronologie** précède les images, par exemple :

  ```
  Enregistrement d'écran de 14,2 s (zone 1280×800), 9 images dans l'ordre.
  Image 1 — t = 0,0 s : début
  Image 2 — t = 3,9 s : avant clic en (812, 340)
  Image 3 — t = 4,4 s : après clic en (812, 340)
  Image 4 — t = 6,1 s : l'écran change
  …
  ```

  Les coordonnées sont en pixels de l'image envoyée.
- Le transcript affiche l'enregistrement **comme une pièce jointe unique**, sans la chronologie, de la même façon que `isAttachmentNote` masque les notes de copie. Le format exact est laissé au builder, tant que la chronologie ne s'affiche pas en texte brut dans le message de l'utilisateur.

### 3.6 Permissions

- **« Enregistrement de l'écran »** est indispensable. Au premier usage, si elle manque, un dialogue en français explique pourquoi Canopy la demande, avec un bouton qui ouvre la bonne page des Réglages Système. macOS impose souvent de relancer l'app après l'avoir accordée : le dialogue le dit.
- **La permission des clics** : son nom exact (« Accessibilité » ou « Surveillance de l'entrée ») dépend de l'API retenue en 5.2, et l'essai le dira. Elle sert seulement aux clics. Sans elle, l'enregistrement fonctionne quand même, sans clics, et la pièce jointe indique « clics non enregistrés (permission Accessibilité manquante) ». Le dialogue d'explication s'affiche une fois **[Bastien]**.

## 4. Approches envisagées

1. **Importer une vidéo existante et en extraire des images clés dans le renderer.**
   - Pour : rien à installer, ça marche avec n'importe quelle capture.
   - Contre : aucune trace des actions, le son est perdu.
2. **Enregistreur intégré avec clics notés.** Retenue **[Bastien]** :
   - c'est la seule option qui relie chaque réaction de l'app à l'action qui l'a provoquée ;
   - elle couvre en plus la capture d'écran simple avec zone.
3. **Option 1, plus une copie de la vidéo pour `ffmpeg`.**
   - Contre : dépend d'un outil absent de beaucoup de Mac.

Pour noter les actions, trois niveaux ont été comparés :
- **a. Clics seulement** : retenu **[Bastien]**.
- **b. Clics et frappes** : écarté, à cause du risque des mots de passe.
- **c. Aucune action** : écarté, trop pauvre.

## 5. Conception technique

Tout ce qui suit est **[Choix conception]**, sauf mention contraire.

### 5.1 Capture du flux

- Main : `desktopCapturer` donne la source de l'écran choisi. Le renderer la lit par `getUserMedia` (`chromeMediaSource: 'desktop'`) ou `getDisplayMedia` avec `session.setDisplayMediaRequestHandler`, au choix du builder.
- **Aucun fichier vidéo n'est encodé.** Le flux est échantillonné (~4 images/s) sur un canvas, recadré à la zone, et seuls les candidats aux images clés sont gardés en mémoire. Ça évite un encodeur, un fichier temporaire et un décodage après coup.
- Le traitement vit dans un module **pur et testable** :
  - entrée : échantillons (horodatage, empreinte réduite) et clics (horodatage, position) ;
  - sortie : images retenues, chronologie.
  
  Le code navigateur (canvas, flux) reste un adaptateur mince autour de ce module.
- Écrans Retina et multi-écrans : la zone est choisie en points, en coordonnées globales. Le module convertit vers les pixels du flux de l'écran concerné. **Une zone ne chevauche qu'un seul écran** : le rectangle est borné à l'écran où le tracé a commencé.

### 5.2 Clics

- **Écoute de la souris seule, au niveau du système** : le clavier ne doit jamais atteindre Canopy, même pour être jeté. Une bibliothèque qui pose un hook clavier et souris ensemble (`uiohook-napi`) est donc **écartée** **[Choix conception, dans l'esprit de « pas de frappes » de Bastien]**.
- Implémentation : un petit helper natif dédié, au choix du builder. Ce peut être un addon N-API ou un binaire Swift lancé par `execFile` qui écrit les clics sur stdout. Il utilise `NSEvent.addGlobalMonitorForEvents` ou un `CGEventTap` en écoute seule, avec un masque limité aux boutons de la souris.
- **Premier essai** : mesurer quelle permission macOS ce helper demande. Une écoute limitée à la souris pourrait n'en demander aucune, ce qui simplifierait 3.6.
- Le helper est signé avec l'app et ajouté à `asarUnpack` dans `electron-builder.yml` (règle du dépôt).
- Il ne tourne **que pendant un enregistrement**.
- Les clics hors zone sont ignorés. Les clics sur le panneau d'arrêt aussi.

### 5.3 Fenêtres

- Voile de sélection : une `BrowserWindow` transparente, sans cadre, `alwaysOnTop: 'screen-saver'`, par écran, avec son propre preload minimal. Elle n'a pas accès à `window.canopy` complet : seulement la zone choisie ou l'annulation.
- Panneau d'enregistrement : petite `BrowserWindow` sans cadre, `setContentProtection(true)`, `alwaysOnTop`, `focusable: false` pour ne pas voler le focus de l'app testée.
- IPC selon la règle du dépôt :
  - le contrat va dans `src/shared/api.ts` ;
  - l'exposition dans le preload ;
  - le code dans un module `src/main/capture/` avec son `captureIpc.ts`.

### 5.4 Envoi

- `UserContent` (`src/shared/types.ts`) gagne un champ facultatif `recordings`. Chaque enregistrement contient :
  - ses images (JPEG base64), avec leur horodatage et leur clic éventuel ;
  - la taille de la zone et la durée ;
  - un drapeau `clicksMissing`.
- `toUserMessage` (`SessionManager`) le traduit en un bloc texte (la chronologie, marquée pour que le transcript la reconnaisse), puis en blocs `image`.
- Le cercle de clic est **dessiné dans l'image** dès la capture : Claude le voit tel quel et le transcript n'a rien à recalculer.
- **Plusieurs enregistrements** peuvent être joints au même message. Les plafonds de l'API (nombre d'images et taille de la requête) sont vérifiés avant l'envoi, en comptant ensemble les images et les enregistrements. En cas de dépassement, l'envoi est **bloqué** avec un message en français qui invite à retirer une pièce jointe. Rien n'est réduit ni supprimé sans le dire **[Choix conception]**. Avec 20 images au plus par enregistrement, ce cas reste rare.

### 5.5 Tests

- TDD selon `CLAUDE.md`. Le module de sélection des images clés, la chronologie, la conversion des coordonnées et `toUserMessage` ont leurs tests Vitest.
- E2E : une variable `CANOPY_FAKE_CAPTURE` (sur le modèle de `CANOPY_FAKE_QUERY`, ignorée en build packagé) remplace le flux d'écran, le hook et les permissions par des données fixes. Les specs Playwright couvrent :
  - capture d'écran → image jointe ;
  - enregistrement → pièce jointe → envoi → message reçu par la fausse session ;
  - annulation par Échap ;
  - permission Accessibilité absente.
- Ce qui ne peut pas être testé automatiquement (permissions réelles, `setContentProtection`, multi-écrans) est vérifié à la main sur un build packagé avant la PR, et noté dans la PR.

## 6. Laissé au builder

- Les touches des deux raccourcis.
- Le seuil de changement d'écran et la fréquence d'échantillonnage, à régler sur de vraies captures d'interface.
- L'aspect exact du voile, du panneau et de la pièce jointe dans le composeur, dans le style existant.
- `getUserMedia` ou `getDisplayMedia` pour le flux.
- Le rendu de l'enregistrement dans le transcript.

## 7. Risques

- **`setContentProtection` sur les macOS récents** : la capture par ScreenCaptureKit peut ignorer cette protection. À vérifier en premier, par un essai rapide. Si le panneau apparaît quand même, il est toujours placé hors de la zone. En écran entier, il se place sur un autre écran s'il y en a un. Sinon, il est caché et l'arrêt se fait par le raccourci seul, rappelé par une notification au démarrage. Ce repli est accepté d'avance **[Choix conception]**.
- **Module natif de hook** : compilation pour Electron, signature et notarisation (bibliothèque dans `asarUnpack`). C'est à vérifier dès le début sur un build packagé, pas seulement en dev.
- **Permission d'écran et relance** : macOS ne prend souvent en compte la permission accordée qu'après relance de l'app. Le parcours doit le dire clairement plutôt que d'échouer sans explication.

## 8. Résultats de l'essai (tâche 1)

- **Clics** : un helper Swift qui n'écoute que les boutons de la souris (`NSEvent.addGlobalMonitorForEvents`) se compile et démarre sans aucune demande de permission. Il voit `AXIsProcessTrusted() = false` et `CGPreflightListenEventAccess() = false`. La documentation d'Apple réserve l'exigence « Accessibilité » aux événements clavier. On part donc sur **`CLICK_PERMISSION = 'none'`**, provisoirement : il n'a pas été possible de cliquer pendant l'essai, faute d'utilisateur devant l'écran. La réception réelle des clics est vérifiée à la main (tâche 8). Si les clics n'arrivent pas, on passe la constante à `'accessibility'` : le parcours « clics non enregistrés » existe déjà.
- **Panneau exclu de la capture** : l'essai n'a pas pu être fait, faute de permission d'enregistrement d'écran pour Electron en dev. On prend l'hypothèse prudente **`PANEL_HIDDEN_FROM_CAPTURE = false`** : le panneau reste toujours hors de la zone, et pour un écran entier, il va sur un autre écran ou laisse place à une notification. La vérification manuelle (tâche 8) peut passer la constante à `true`.
