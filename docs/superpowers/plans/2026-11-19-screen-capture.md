# Capture d'écran et enregistrement en pièce jointe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the composer, capture a screen region as an image or a ≤ 2 min recording (key frames + clicks + timeline) and send it to Claude.

**Architecture:** Main owns the capture flow (`src/main/capture/`): hide Canopy, open a selection overlay per display, then for a recording open a floating panel, start a mouse-only Swift click helper and a 2 min timer. A hidden "worker" window samples the desktop stream on a canvas, keeps candidate frames, picks ≤ 20 key frames and returns a `Recording`. Main sends the result to the main renderer, which attaches it to the draft of the tab that launched it. `SessionManager.toUserMessage` turns a recording into one timeline text block followed by its image blocks. No video file is ever encoded.

**Tech Stack:** Electron 45 (`desktopCapturer`, `getUserMedia` with `chromeMediaSource: 'desktop'`, `globalShortcut`, `systemPreferences`, `setContentProtection`), React 19 + Zustand, Swift (`NSEvent.addGlobalMonitorForEvents`) for clicks, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-screen-capture-design.md`

## Global Constraints

- User-visible text in French with « » quotes; code, identifiers and comments in English. Style: 2 spaces, single quotes, no semicolons.
- TDD for every task except Task 1 (spike): failing test first.
- Keystrokes must never reach Canopy: the click helper listens to mouse-button events only (no `uiohook-napi`).
- `MAX_RECORDING_MS = 120_000`; `MAX_RECORDING_FRAMES = 20`; frame long side ≤ `MAX_FRAME_SIDE = 1568` px; recording frames are JPEG (quality 0.8); screenshots are PNG at the same size cap.
- After-click frame taken ~`AFTER_CLICK_MS = 500` ms after the click.
- `MAX_IMAGES_PER_MESSAGE = 100` (API limit), counting images and every recording frame together; over it, sending is blocked in the composer and rejected in main.
- A region never spans two displays: it is clamped to the display where the drag started.
- The panel shows `● m:ss / 2:00   ■ Arrêter`; the time turns red in the last 10 s.
- Shortcuts: `capture-screenshot` = `CmdOrCtrl+Alt+Shift+4` (« Capture d'écran… »), `capture-recording` = `CmdOrCtrl+Alt+Shift+5` (« Enregistrer l'écran… »), both `menu: 'file'`, `needs: 'worktree'`. During a recording the same `CmdOrCtrl+Alt+Shift+5` is registered as a `globalShortcut` that stops it, and is unregistered right after.
- Spawn the helper with `execFile`/`spawn` and an argument array, never a shell string. Any new native binary goes into the packaged app outside the asar (`extraResources`) and is signed.
- Fakes (`CANOPY_FAKE_CAPTURE`) are ignored when `app.isPackaged`.
- Every new IPC goes through `src/shared/api.ts` → `src/preload/index.ts` → `src/main/capture/captureIpc.ts`, and is validated in main.

## Review Focus

- **The launching tab is closed while Canopy is hidden:** the capture is dropped with « La session qui a lancé la capture a été fermée. » and nothing goes into another tab. Test in Task 9 (`attachCapture` with an unknown tab).
- **A second capture is started while one runs** (shortcut pressed twice, or the screenshot shortcut during a recording): the second is refused and the first carries on. Test in Task 7.
- **The recording is stopped before any frame was sampled** (immediate stop, or stream failure): it gives an error result, never an empty recording attached. Tests in Task 5 (`selectKeyFrames([])`) and Task 7 (worker error → `error` result, Canopy shown again).
- **The main window must always come back** after cancel, error, stop or timer: `showMain` is called exactly once per capture whatever the path. Test in Task 7 (all four paths).
- **History reload of a sent recording** (app restart, session reopened): the timeline block is hidden and its N frames are grouped back into a recording, not shown as N loose images. Test in Task 3 (`reduceTranscript` on a stored user message).

---

### Task 1: Spike — click permission and content protection (throwaway)

Not TDD: a throwaway check that decides two facts the later tasks rely on. Nothing from it is kept except the notes.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-screen-capture-design.md` (§3.6 and §7: findings)

- [ ] **Step 1:** In the scratchpad, write a 30-line Swift CLI that calls `NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])`, prints the location of each click, runs `NSApplication.shared.run()`, and prints `AXIsProcessTrusted()` and `CGPreflightListenEventAccess()` at start. Build it with `swiftc`. Run it from Terminal, then from a packaged dev build (or `electron .` spawning it). Note which permission macOS asks for (none / Accessibility / Input Monitoring) and whether clicks arrive without it.
- [ ] **Step 2:** In a throwaway Electron script, open a small `setContentProtection(true)` window, capture the screen with `desktopCapturer` + `getUserMedia` (`chromeMediaSource: 'desktop'`), draw one frame to a canvas, save it as PNG. Check whether the protected window shows up in it.
- [ ] **Step 3:** Write both findings into the spec: §3.6 gets the exact permission name, or « aucune » if none is needed. §7 says whether the content protection holds. Set `CLICK_PERMISSION` for Task 6 (`'accessibility' | 'input-monitoring' | 'none'`) and `PANEL_HIDDEN_FROM_CAPTURE` for Task 8 (`true | false`).
- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-19-screen-capture-design.md
git commit -m "docs(sessions): record screen capture spike findings"
```

### Task 2: Recording model and message content

**Files:**
- Create: `src/shared/recording.ts`
- Modify: `src/shared/types.ts` (`UserContent`), `src/main/sessions/validate.ts`, `src/main/sessions/SessionManager.ts` (`isEmpty`, `toUserMessage`)
- Test: `tests/main/recording.test.ts` (shared logic, alongside other shared tests in `tests/main`), `tests/main/sessions/validate.test.ts`, `tests/main/sessions/SessionManager.test.ts`

**Interfaces:**
- Produces (`src/shared/recording.ts`):
  - `MAX_RECORDING_MS`, `MAX_RECORDING_FRAMES`, `MAX_FRAME_SIDE`, `AFTER_CLICK_MS`, `MAX_IMAGES_PER_MESSAGE`.
  - `type FrameReason = 'start' | 'end' | 'before-click' | 'after-click' | 'change'`.
  - `interface RecordingFrame { t: number /* ms from start */; reason: FrameReason; click?: { x: number; y: number } /* pixels of the image */; base64: string /* image/jpeg */ }`.
  - `interface Recording { durationMs: number; width: number; height: number; frames: RecordingFrame[]; clicksMissing: boolean }`.
  - `recordingNote(r: Recording): string`, `parseRecordingNote(text: string): { frames: number; durationMs: number } | null`, `isRecordingNote(text: string): boolean`, `countImages(c: Pick<UserContent, 'images' | 'recordings'>): number`.
- Produces: `UserContent.recordings?: Recording[]`.

- [ ] **Step 1: Write the failing tests** in `tests/main/recording.test.ts`:
  - `recordingNote` of `{ durationMs: 14200, width: 1280, height: 800, clicksMissing: false, frames: [start t=0, before-click t=3900 click (812,340), after-click t=4400 click (812,340), change t=6100] }` equals exactly:
    ```
    <screen-recording frames="4" duration-ms="14200">Enregistrement d'écran de 14,2 s (zone 1280×800), 4 images dans l'ordre.
    Image 1 — t = 0,0 s : début
    Image 2 — t = 3,9 s : avant clic en (812, 340)
    Image 3 — t = 4,4 s : après clic en (812, 340)
    Image 4 — t = 6,1 s : l'écran change</screen-recording>
    ```
    An `end` frame reads `fin`. With `clicksMissing: true`, a line `Clics non enregistrés (permission manquante).` comes right after the first line.
  - `parseRecordingNote(recordingNote(r))` → `{ frames: 4, durationMs: 14200 }`. `parseRecordingNote('hello')` → `null`. `isRecordingNote` is true for the note with surrounding whitespace, false for text that only contains it.
  - `countImages({ images: [a, b], recordings: [r4, r3] })` → `9`. `countImages({})` → `0`.
- [ ] **Step 2: Run** `npx vitest run tests/main/recording.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/shared/recording.ts`. Decimal comma via `(ms / 1000).toFixed(1).replace('.', ',')`.
- [ ] **Step 4: Write the failing tests** in `validate.test.ts`:
  - `assertContent` accepts a valid `recordings`.
  - It throws « Message invalide » when:
    - `frames` is empty or has > 20 entries;
    - a frame has a non-string `base64` or a non-number `t`;
    - `durationMs` > `MAX_RECORDING_MS + 5000`;
    - `width`/`height` is not a positive integer;
    - `clicksMissing` is not a boolean;
    - `countImages` > 100 (e.g. 90 images + one 11-frame recording).
- [ ] **Step 5: Write the failing tests** in `SessionManager.test.ts`:
  - `'recordings follow the images as a timeline then their frames'`: content `{ text: 'regarde', images: [img], recordings: [r2] }` (r2 has 2 frames) is sent with content blocks typed, in order, `text, image, text (=== recordingNote(r2)), image (media_type 'image/jpeg', data = frame 0), image (frame 1)`.
  - `'a recording alone is not empty'`: `{ text: '', recordings: [r2] }` is sent.
- [ ] **Step 6: Run** both files → FAIL.
- [ ] **Step 7: Implement:**
  - `assertContent` checks recordings and the `countImages` cap.
  - `isEmpty` takes recordings into account.
  - `toUserMessage` content order: `text, images, recordings (note + frames per recording), documents, notes`.
- [ ] **Step 8: Run** `npx vitest run tests/main` → PASS. Run `npm run typecheck` → PASS.
- [ ] **Step 9: Commit** `feat(sessions): send screen recordings as a timeline and key frames`.

### Task 3: Drafts, store and transcript

**Files:**
- Modify: `src/shared/update.ts` (`Draft`, `isDraftEmpty`), `src/renderer/sessions/sessionStore.ts` (`setDraftRecordings`, `send`, sent/restore around lines 262–272, title around line 73), `src/renderer/sessions/transcript.ts`, `src/renderer/sessions/Conversation.tsx`
- Test: `tests/renderer/drafts.test.ts`, `tests/renderer/sessionStore.test.ts`, `tests/renderer/transcript.test.ts`

**Interfaces:**
- Consumes: `Recording`, `parseRecordingNote`, `isRecordingNote` (Task 2).
- Produces:
  - `Draft.recordings?: Recording[]`.
  - `setDraftRecordings(id: string, change: (r: Recording[]) => Recording[]): void`.
  - The transcript user item gets `recordings?: SentRecording[]`, with `interface SentRecording { durationMs: number; frames: UserImage[] }`.

- [ ] **Step 1: Write the failing tests:**
  - `isDraftEmpty({ text: '', images: [], recordings: [r] })` is false.
  - In the store, `submit` sends `content.recordings`. A failed send puts the recordings back in the draft, like images.
  - The tab title of a recording-only first message is `'Enregistrement'`.
  - `addUser` with `recordings: [r2]` gives a user item with `recordings: [{ durationMs, frames: [2 images] }]` and no loose images from it.
  - `reduceTranscript` on a stored user message with blocks `text 'regarde', image A, text recordingNote(r2), image F0, image F1` gives `text: 'regarde'`, `images: [A]`, `recordings: [{ durationMs: r2.durationMs, frames: [F0, F1] }]`. The note text is not in `text`.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/drafts.test.ts tests/renderer/sessionStore.test.ts tests/renderer/transcript.test.ts` → FAIL.
- [ ] **Step 3: Implement:**
  - In `onUser`, walk the blocks in order. A text block for which `parseRecordingNote` returns `n` takes the next `n` image blocks as that recording's frames. All the other image blocks stay as `images`.
  - `Conversation.tsx` renders each recording as `.rec-chip`:
    - a « Enregistrement » label and the duration (`14 s`);
    - a horizontal strip of the frame thumbnails, `data-testid="user-recording"`.
- [ ] **Step 4: Run** the same tests → PASS. Run `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(sessions): keep screen recordings in drafts and the transcript`.

### Task 4: Capture geometry

**Files:**
- Create: `src/shared/captureGeometry.ts`
- Test: `tests/main/captureGeometry.test.ts`

**Interfaces:**
- Produces (all coordinates are global screen points unless named `px`):
  - `interface Rect { x: number; y: number; width: number; height: number }`.
  - `interface DisplayInfo { id: number; bounds: Rect; scaleFactor: number }`.
  - `clampRegion(drag: Rect, display: DisplayInfo): Rect`: normalizes negative width/height and clamps to `display.bounds`. Under 4×4 pt, it counts as a click: returns `display.bounds`.
  - `regionInStream(region: Rect, display: DisplayInfo, stream: { width: number; height: number }): Rect` gives px within the display stream.
  - `fitSize(width: number, height: number, maxSide = MAX_FRAME_SIDE): { width: number; height: number }`: never upscales, rounds to integers.
  - `toImagePoint(click: { x: number; y: number }, region: Rect, image: { width: number; height: number }): { x: number; y: number } | null`: `null` when the click is outside the region; result is rounded.
  - `panelPosition(region: Rect, display: DisplayInfo, panel: { width: number; height: number }, margin = 12): { x: number; y: number }`: tries below the region, then above, then the bottom-right corner of the display.

- [ ] **Step 1: Write the failing tests:**
  - A drag from (500,400) to (100,100) on display `{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }` → `{ x: 100, y: 100, width: 400, height: 300 }`.
  - A drag overflowing to x = 2000 is clamped to width 1340.
  - A 2×2 drag gives the full display.
  - `regionInStream({ x: 100, y: 100, width: 400, height: 300 }, display, { width: 2880, height: 1800 })` → `{ x: 200, y: 200, width: 800, height: 600 }`.
  - A second display at `x: 1440`: a region at x = 1540 maps to stream x = 200 (scale 2).
  - `fitSize(3024, 1964)` → `{ width: 1568, height: 1018 }`. `fitSize(800, 600)` is unchanged.
  - `toImagePoint({ x: 300, y: 250 }, region, { width: 800, height: 600 })` → `{ x: 400, y: 300 }`. Outside the region → `null`.
  - `panelPosition`: a region ending 40 pt above the bottom edge → the panel goes above. A full-display region → the corner.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sessions): add screen capture geometry`.

### Task 5: Key frame selection

**Files:**
- Create: `src/renderer/capture/keyframes.ts`
- Test: `tests/renderer/capture/keyframes.test.ts`

**Interfaces:**
- Produces:
  - `fingerprintDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number`: mean absolute difference of two equal-length grayscale fingerprints, in 0..1.
  - `CHANGE_THRESHOLD = 0.02`, tuned on real captures in Task 8.
  - `interface Candidate { t: number; reason: FrameReason; score: number; click?: { x: number; y: number } }`: `score` is the diff for `change`, 0 otherwise.
  - `selectKeyFrames(candidates: Candidate[], max = MAX_RECORDING_FRAMES): Candidate[]`.

  Algorithm (the tests pin it):
  1. Always keep the first `start` and the last `end`.
  2. Keep `before-click`/`after-click` pairs together. If not all pairs fit in the remaining budget, keep `k = floor(remaining / 2)` pairs evenly spaced: pair index `round(i * (n - 1) / (k - 1))`, or the last pair when `k = 1`.
  3. Fill what is left with `change` frames, highest `score` first.
  4. Return the result sorted by `t`.

  `[]` → `[]`.

- [ ] **Step 1: Write the failing tests:**
  - `fingerprintDiff` of `[0,0]` vs `[255,255]` is 1; identical arrays give 0.
  - 3 clicks (6 frames) + start + end + 30 changes, max 20 → 8 click/edge frames plus the 12 best-scoring changes, sorted by `t`.
  - 15 clicks + start/end, max 20 → start, end and 9 pairs: pairs 0, 2, 4, 5, 7, 9, 10, 12, 14 (from `round(i*14/8)`), 20 frames, never a lone half pair.
  - Empty candidates → `[]`.
  - Start only → `[start]`.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/capture/keyframes.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sessions): pick key frames of a screen recording`.

### Task 6: Mouse-only click helper

**Files:**
- Create: `build/capture/clicks.swift`, `scripts/capture/buildClicks.ts` (+ a `scripts/capture/cli.ts` entry run by `postinstall`), `src/main/capture/clicks.ts`
- Modify: `package.json` (`postinstall`: `electron-rebuild -f -w node-pty && node scripts/capture/cli.ts`, run like `scripts/release/cli.ts` in `release.yml`), `.gitignore` (`build/capture/canopy-clicks`), `electron-builder.yml` (`extraResources`: `build/capture/canopy-clicks` → `canopy-clicks`; `mac.binaries: [Contents/Resources/canopy-clicks]` so it is signed)
- Test: `tests/scripts/buildClicks.test.ts`, `tests/main/capture/clicks.test.ts`

**Interfaces:**
- Helper protocol, one JSON object per stdout line:
  - `{"type":"ready","trusted":true|false}`;
  - then `{"type":"click","t":<epoch ms>,"x":<pt>,"y":<pt>}`, in **top-left-origin global points**: `y = NSScreen.screens[0].frame.height - location.y`.

  It listens to `.leftMouseDown, .rightMouseDown, .otherMouseDown` only and exits when stdin closes. `trusted` comes from the check that matches `CLICK_PERMISSION` (Task 1): `AXIsProcessTrusted()` for `accessibility`, `CGPreflightListenEventAccess()` for `input-monitoring`, `true` for `none`.
- Produces:
  - `buildClicksCommand(o: { platform: NodeJS.Platform; hasSwiftc: boolean }): { file: string; args: string[] } | null`.
  - `parseClickLine(line: string): { type: 'ready'; trusted: boolean } | { type: 'click'; t: number; x: number; y: number } | null`.
  - `startClickListener(o: { path: string; spawn: typeof import('node:child_process').spawn }): ClickListener`, with `interface ClickListener { ready: Promise<{ trusted: boolean }>; stop(): ClickEvent[] }` and `type ClickEvent = { t: number; x: number; y: number }`.
  - `clicksHelperPath(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string`.

- [ ] **Step 1: Write the failing tests:**
  - `buildClicksCommand({ platform: 'darwin', hasSwiftc: true })` → `{ file: 'swiftc', args: ['-O', '-target', 'arm64-apple-macos13', 'build/capture/clicks.swift', '-o', 'build/capture/canopy-clicks'] }`. `linux` or no `swiftc` → `null` (the CLI prints a warning and exits 0).
  - `parseClickLine('{"type":"click","t":1,"x":2,"y":3}')` → the click. Garbage, missing fields, non-numbers or an unknown `type` → `null`.
  - `startClickListener` with a fake `spawn` (an `EventEmitter` with a `PassThrough` stdout and a stdin stub):
    - `ready` resolves on the ready line;
    - lines split across chunks are joined;
    - `stop()` returns the clicks in order and closes stdin.
    - If the process exits before `ready`, `ready` resolves `{ trusted: false }` and `stop()` returns `[]`.
  - `clicksHelperPath` → `<resourcesPath>/canopy-clicks` when packaged, `<appPath>/build/capture/canopy-clicks` otherwise.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/buildClicks.test.ts tests/main/capture/clicks.test.ts` → FAIL.
- [ ] **Step 3: Implement** the TS modules, the Swift helper (from the Task 1 spike) and the config changes.
- [ ] **Step 4: Run** the tests → PASS. Run `npm install`, then check that `build/capture/canopy-clicks` exists. Run it, click once, and see a click line.
- [ ] **Step 5: Commit** `feat(sessions): add a mouse-only click listener for screen recordings`.

### Task 7: Capture flow in main

**Files:**
- Create: `src/shared/capture.ts`, `src/main/capture/captureFlow.ts`, `src/main/capture/fakeBackend.ts`, `src/main/capture/captureIpc.ts`
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/ipc.ts` (register `captureIpc`), `src/main/index.ts` (select backend)
- Test: `tests/main/capture/captureFlow.test.ts`, `tests/main/capture/fakeBackend.test.ts`

**Interfaces:**
- Produces (`src/shared/capture.ts`):
  - `type CaptureKind = 'screenshot' | 'recording'`.
  - `type CaptureResult`, one of:
    - `{ tabId: string; kind: 'screenshot'; image: UserImage }`
    - `{ tabId: string; kind: 'recording'; recording: Recording; explainClicks: boolean }`
    - `{ tabId: string; kind: 'cancelled' }`
    - `{ tabId: string; kind: 'needs-permission' }`
    - `{ tabId: string; kind: 'error'; message: string }`
- Produces (`CanopyApi`):
  - `startCapture(kind: CaptureKind, tabId: string): Promise<boolean>`: `false` when a capture is already running.
  - `stopCapture(): Promise<void>`.
  - `openCaptureSettings(which: 'screen' | 'clicks'): Promise<void>`.
  - Event `capture:done` with a `CaptureResult`.
- Produces (`captureFlow.ts`):
  - `interface CaptureBackend { screenGranted(): boolean; hideMain(): void; showMain(): void; selectRegion(): Promise<{ region: Rect; display: DisplayInfo } | null>; screenshot(sel): Promise<UserImage>; startRecording(sel): RecordingSession }`.
  - `interface RecordingSession { stopped: Promise<void> /* panel button */; finish(clicks: ClickEvent[], clicksMissing: boolean): Promise<Recording> }`.
  - `createCaptureFlow(deps: { backend: CaptureBackend; clicks: () => ClickListener; registerStop: (onStop: () => void) => () => void; setTimer: (fn: () => void, ms: number) => () => void; clicksExplained: () => boolean; markClicksExplained: () => void; emit: (r: CaptureResult) => void })`, returning `{ start(kind, tabId): boolean; stop(): void }`.
- `fakeBackend.ts`:
  - `selectCaptureBackend(real: () => CaptureBackend, o: { isPackaged: boolean; env: NodeJS.ProcessEnv })`;
  - `CANOPY_FAKE_CAPTURE` values: `1` (a 2-frame recording, 1 click, or a 1×1 PNG screenshot), `cancel` (selection gives `null`), `denied` (`screenGranted` false), `noclicks` (the fake click listener's `ready` gives `trusted: false`).
  - In fake mode, `clicks` is replaced too. The fake panel "stops" right away, so `stopped` resolves on the next tick.

- [ ] **Step 1: Write the failing tests** (fake backend object, fake timers, a fake `ClickListener`). For each case, assert both `emit` and the `hideMain`/`showMain` calls:
  - screenshot → `screenshot` result for the given `tabId`.
  - `selectRegion` → `null` gives `cancelled`.
  - `screenGranted()` false gives `needs-permission`, without hiding Canopy.
  - `screenshot` throws → `error` with its message.
  - recording stopped by the panel → `recording` result.
  - The click listener's `stop()` is called, and the stop shortcut registered then unregistered.
  - recording stopped by `flow.stop()` → same.
  - recording stopped by the timer at `MAX_RECORDING_MS` → same.
  - `finish` throws → `error`.
  - `ready` gives `trusted: false` → `clicksMissing: true`. `explainClicks` is true the first time only (`markClicksExplained` called once).
  - `start` during a running capture returns `false` and emits nothing. The first capture still completes.
  - `showMain` is called exactly once on each path above that hid Canopy.
- [ ] **Step 2: Run** `npx vitest run tests/main/capture` → FAIL.
- [ ] **Step 3: Implement** the flow, the fake backend, the IPC and the API wiring:
  - `captureIpc` validates `kind` against the two values and `tabId` as a non-empty string ≤ 200 chars.
  - `openCaptureSettings` opens fixed `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, or the URL matching `CLICK_PERMISSION` for `clicks` (`Privacy_Accessibility` / `Privacy_ListenEvent`), via `shell.openExternal` in main only.
  - `clicksExplained` is stored in `AppStore.prefs` under `captureClicksExplained`.
  - `index.ts` uses `selectCaptureBackend(() => electronBackend(...), …)`. Until Task 8 exists, the real factory throws « Capture indisponible ».
- [ ] **Step 4: Run** the tests → PASS. Run `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(sessions): orchestrate screen captures from main`.

### Task 8: Capture windows (real backend)

Glue over Electron, verified by hand. Pure helpers are tested.

**Files:**
- Create:
  - `src/main/capture/electronBackend.ts`;
  - `src/preload/capture.ts`;
  - `src/renderer/capture/index.html`, `main.tsx`, `Selector.tsx`, `Panel.tsx`, `worker.ts`, `panelTime.ts`.
- Modify: `electron.vite.config.ts` (renderer input `capture: resolve('src/renderer/capture/index.html')`, preload input `capture: resolve('src/preload/capture.ts')`)
- Test: `tests/renderer/capture/panelTime.test.ts`

**Interfaces:**
- Consumes: geometry (Task 4), `selectKeyFrames`/`fingerprintDiff` (Task 5), `CaptureBackend` (Task 7).
- Produces:
  - `formatPanelTime(elapsedMs: number): { text: string; warning: boolean }`.
  - `window.captureBridge`, exposed by `src/preload/capture.ts` and **only** to capture pages. It carries the role, the selection result, panel stop and worker messages, and nothing from `CanopyApi`.
  - The page role comes from the `?role=select&display=<id>`, `?role=panel` or `?role=worker` query.

- [ ] **Step 1: Write the failing test:** `formatPanelTime(12_000)` → `{ text: '0:12 / 2:00', warning: false }`; `formatPanelTime(110_000)` → `{ text: '1:50 / 2:00', warning: true }`; `formatPanelTime(130_000)` → `'2:00 / 2:00'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `panelTime.ts`. **Step 4: Run** → PASS.
- [ ] **Step 5: Implement the windows:**
  - **Selector:** one window per `screen.getAllDisplays()`. `transparent`, `frame: false`, `alwaysOnTop: 'screen-saver'`, covering `display.bounds`.
    - A drag draws the rectangle, mouse-up resolves through `clampRegion`, and Échap resolves `null` on every selector.
    - All selectors close as soon as one resolves.
  - **Worker:** a hidden window (`show: false`, `backgroundThrottling: false`).
    - It gets the `desktopCapturer` source whose `display_id` matches and opens `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`.
    - Every 250 ms it draws `regionInStream` to a 64-px-wide grayscale fingerprint.
    - It keeps `start` and `change` candidates (diff ≥ `CHANGE_THRESHOLD` vs the last kept frame) as JPEG blobs at `fitSize`, plus a ring of the last 4 samples for `before-click`.
    - On `finish(clicks)`:
      - it maps the clicks with `toImagePoint`, dropping `null`;
      - it takes `before-click` from the ring/history and `after-click` as the first sample ≥ `AFTER_CLICK_MS` after the click;
      - it draws a 3-px circle, radius 18 px, on after-click frames;
      - it adds the last sample as `end`, runs `selectKeyFrames`, and returns the `Recording`.
    - To keep `before-click` frames available after the fact, keep every sample's JPEG for the session in an array of `{ t, blob }`. At 4 fps × 120 s × ~150 KB that is ~70 MB worst case. Drop all of it on finish.
    - Screenshot: the same stream, one frame, PNG at `fitSize`.
  - **Panel:** `frame: false`, `alwaysOnTop`, `focusable: false`, `setContentProtection(true)`, placed at `panelPosition`.
    - If `PANEL_HIDDEN_FROM_CAPTURE` is false (Task 1) and the region is the full display: put the panel on another display if there is one. Otherwise don't open it, and show a `Notification` « Enregistrement en cours. ⌥⇧⌘5 pour arrêter. ».
    - It shows `formatPanelTime` and goes red when `warning`. Its button resolves `stopped`.
  - **`screenGranted`:** `systemPreferences.getMediaAccessStatus('screen') === 'granted'`.
  - **`hideMain`/`showMain`:** `win.hide()` / `win.show(); win.focus()`.
  - Tune `CHANGE_THRESHOLD` on two real captures: typing in a form, and a page navigation. Update the constant and its test if needed.
- [ ] **Step 6: Manual check** (`npm run dev`), each item checked off in the PR:
  - region screenshot;
  - full-screen screenshot by click;
  - Échap;
  - 20 s recording with 3 clicks in another app;
  - stop by button, by ⌥⇧⌘5, and by the timer (temporarily set `MAX_RECORDING_MS` to 10 s, then revert);
  - the panel absent from frames;
  - a second display, if available.
- [ ] **Step 7: Run** `npm run typecheck && npm test` → PASS.
- [ ] **Step 8: Commit** `feat(sessions): add screen selection, recording panel and frame worker`.

### Task 9: Composer, shortcuts and dialogs

**Files:**
- Modify: `src/shared/shortcuts.ts`, `src/renderer/shell/shortcuts.ts` (`runShortcut`), `src/renderer/shell/ShortcutHelp.tsx`, `src/renderer/sessions/Composer.tsx`, `src/renderer/sessions/sessionStore.ts` (`attachCapture`, `connectSessions` listens to `capture:done`), `src/renderer/sessions/attachments.ts` (`imageLimitError`)
- Create: `src/renderer/sessions/CaptureDialog.tsx` (permission explanations)
- Test: `tests/main/shortcuts.test.ts`, `tests/renderer/shortcuts.test.ts`, `tests/renderer/attachments.test.ts`, `tests/renderer/sessionStore.test.ts`, `tests/e2e/capture.spec.ts`

**Interfaces:**
- Consumes: `startCapture`, `capture:done`, `openCaptureSettings` (Task 7); `setDraftRecordings` (Task 3); `countImages` (Task 2).
- Produces:
  - `attachCapture(r: CaptureResult): { dialog: 'screen' | 'clicks' | null; error: string | null }`.
  - `imageLimitError(d: Draft): string | null`.

- [ ] **Step 1: Write the failing tests:**
  - `SHORTCUTS` has the two new entries with the exact accelerators and labels from Global Constraints. No accelerator is used twice in the table.
  - `runShortcut('capture-recording')` sets the view to `sessions` and calls `startCapture('recording', <active tab of the worktree>)`. With no tab, it creates one first via `ensureTab`.
  - `attachCapture` behaves as follows:
    - `screenshot` → image appended to that tab's draft;
    - `recording` → appended to `recordings`; `explainClicks: true` → `dialog: 'clicks'`;
    - `needs-permission` → `dialog: 'screen'`;
    - `error` → `error: message`;
    - `cancelled` → nothing;
    - unknown `tabId` → `error: 'La session qui a lancé la capture a été fermée.'` and no draft changed.
  - `imageLimitError` → `null` at 100 images. At 101 it returns `Trop d'images pour un seul message (101 / 100) : retirez une pièce jointe.`.
- [ ] **Step 2: Run** the unit tests → FAIL. **Step 3: Implement:**
  - **Composer:**
    - a camera button with `aria-label="Capturer l'écran"` next to the attach button, opening a 2-item menu: « Capture d'écran » / « Enregistrer » (with their shortcut glyphs via `displayKeys`);
    - a recording chip `data-testid="draft-recording"` showing the first frame thumbnail, `14 s · 3 clics` (or `14 s · clics non enregistrés`) and a × with `aria-label="Retirer l'enregistrement 1"`;
    - `canSend` also requires `imageLimitError(draft) === null`, and that message is shown in `.del`.
  - **`CaptureDialog`** copy:
    - `screen`: title « Autoriser l'enregistrement de l'écran ». Body: « Canopy a besoin de cette permission pour capturer une zone de l'écran et la joindre à votre message. Après l'avoir accordée dans les Réglages Système, relancez Canopy. » Buttons: « Ouvrir les Réglages Système » / « Annuler ».
    - `clicks`: title « Clics non enregistrés ». Body: « Pour que Claude voie où vous cliquez, autorisez Canopy dans les Réglages Système (<permission name from Task 1>). L'enregistrement fonctionne sans, sans les clics. » Buttons: « Ouvrir les Réglages Système » / « Plus tard ».
- [ ] **Step 4: Run** the unit tests → PASS.
- [ ] **Step 5: Write** `tests/e2e/capture.spec.ts`, modeled on `sessions.spec.ts`, launching with `CANOPY_FAKE_CAPTURE` and `CANOPY_FAKE_QUERY`:
  - `'a screenshot from the camera menu is attached and sent'`: the image is shown in `user-message`.
  - `'a recording is attached as one chip and sent with its frames'`: `draft-recording` shows `1 clic`; after sending, `user-recording` has 2 thumbnails and `user-message` does not contain `screen-recording`.
  - `'a cancelled selection attaches nothing'` (`cancel`).
  - `'missing screen permission opens the explanation'` (`denied`): the dialog title is visible.
  - `'a recording without clicks explains it once'` (`noclicks`): the dialog shows on the first recording and not on the second.
  - `'the recording shortcut starts a recording'`: click the menu entry via `app.evaluate`, as in `shortcuts.spec.ts`.
- [ ] **Step 6: Run** `npm run test:e2e -- tests/e2e/capture.spec.ts` → PASS, then the full `npm run test:e2e` → PASS.
- [ ] **Step 7: Commit** `feat(sessions): capture the screen from the composer`.

### Task 10: Packaged build check and docs

**Files:**
- Modify: `CLAUDE.md`:
  - **Commandes:** `CANOPY_FAKE_CAPTURE` and its values.
  - **Architecture:** the `src/main/capture/` module, the click helper built at `postinstall` and shipped by `extraResources`, and the capture pages with their own preload.
  - **Binaires natifs:** helpers outside the asar.

- [ ] **Step 1:** `npm run build`, then package locally (`npx electron-builder --mac --arm64 --publish never`). In the packaged app:
  - grant both permissions;
  - redo the Task 8 manual list;
  - check that `codesign -dv --verbose=2 dist/mac-arm64/Canopy.app/Contents/Resources/canopy-clicks` shows the Developer ID, or ad-hoc locally;
  - check that clicks arrive.
- [ ] **Step 2:** Update `CLAUDE.md`, then run `npm run typecheck && npm test` → PASS.
- [ ] **Step 3: Commit** `docs: describe screen capture in CLAUDE.md`.
