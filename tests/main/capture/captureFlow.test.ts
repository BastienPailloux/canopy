import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptureFlow, type CaptureBackend, type RecordingSession } from '../../../src/main/capture/captureFlow'
import type { ClickEvent, ClickListener } from '../../../src/main/capture/clicks'
import type { CaptureResult } from '../../../src/shared/capture'
import { MAX_RECORDING_MS, type Recording } from '../../../src/shared/recording'

const sel = { region: { x: 0, y: 0, width: 10, height: 10 }, display: { id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 2 } }
const image = { mediaType: 'image/png', base64: 'AAA' }
const recording = (clicksMissing: boolean): Recording => ({ durationMs: 1000, width: 10, height: 10, frames: [], clicksMissing })
const clicks: ClickEvent[] = [{ t: 5, x: 1, y: 2 }]

interface SetupOptions {
  granted?: boolean
  select?: typeof sel | null
  trusted?: boolean | 'never'
  explained?: boolean
  /** Whether the stop shortcut registers. */
  shortcut?: boolean
  /** Whether the backend shows a stop panel. */
  panel?: boolean
  /** Whether the session says `started` at once. */
  startsAtOnce?: boolean
  permission?: 'accessibility' | 'input-monitoring' | 'none'
}

function setup(o: SetupOptions = {}) {
  let panelStop: () => void = () => {}
  let markStarted: () => void = () => {}
  const session: RecordingSession & { finish: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn> } = {
    stopped: new Promise<void>((r) => { panelStop = r }),
    started: o.startsAtOnce === false ? new Promise<void>((r) => { markStarted = r }) : Promise.resolve(),
    hasPanel: o.panel ?? true,
    click: vi.fn((_c: ClickEvent) => {}),
    finish: vi.fn(async (_c: ClickEvent[], missing: boolean) => recording(missing)),
    cancel: vi.fn(() => {})
  }
  let selectSignal: AbortSignal | null = null
  const backend = {
    screenGranted: vi.fn(() => o.granted ?? true),
    requestScreen: vi.fn(),
    hideMain: vi.fn(),
    showMain: vi.fn(),
    selectRegion: vi.fn(async (signal: AbortSignal) => { selectSignal = signal; return o.select === undefined ? sel : o.select }),
    screenshot: vi.fn(async (_sel: typeof sel, _signal: AbortSignal) => image),
    startRecording: vi.fn(() => session),
    showStopNotice: vi.fn()
  } satisfies CaptureBackend
  let onClick: (c: ClickEvent) => void = () => {}
  const listener: ClickListener & { stop: ReturnType<typeof vi.fn> } = {
    ready: o.trusted === 'never' ? new Promise(() => {}) : Promise.resolve({ trusted: o.trusted ?? true }),
    onClick: (fn) => { onClick = fn },
    stop: vi.fn(() => clicks)
  }
  const unregister = vi.fn()
  let onStop: () => void = () => {}
  const registerStop = vi.fn((fn: () => void) => { onStop = fn; return { registered: o.shortcut ?? true, unregister } })
  let explained = o.explained ?? false
  const markClicksExplained = vi.fn(() => { explained = true })
  const emitted: CaptureResult[] = []
  const flow = createCaptureFlow({
    backend,
    clicks: () => listener,
    registerStop,
    setTimer: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
    clickPermission: o.permission ?? 'accessibility',
    clicksExplained: () => explained,
    markClicksExplained,
    emit: (r) => { emitted.push(r) }
  })
  const done = (): Promise<void> => vi.waitFor(() => { if (emitted.length === 0) throw new Error('not yet') })
  return {
    flow, backend, session, listener, unregister, registerStop, markClicksExplained, emitted, done,
    panelStop: () => panelStop(), shortcut: () => onStop(), markStarted: () => markStarted(),
    click: (c: ClickEvent) => onClick(c), selectSignal: () => selectSignal
  }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

/** Lets the flow reach `startRecording` (it awaits the selection and the listener's `ready`). */
async function untilRecording(s: ReturnType<typeof setup>, calls = 1): Promise<void> {
  // Microtasks only: vi.waitFor would advance the fake clock and eat into the recording's timer.
  for (let i = 0; i < 20 && s.backend.startRecording.mock.calls.length < calls; i++) await Promise.resolve()
  expect(s.backend.startRecording).toHaveBeenCalledTimes(calls)
}

describe('createCaptureFlow: screenshot', () => {
  it('emits the screenshot for the tab and shows Canopy again', async () => {
    const s = setup()
    expect(s.flow.start('screenshot', 'tab-1')).toBe(true)
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 'tab-1', kind: 'screenshot', image }])
    expect(s.backend.screenshot).toHaveBeenCalledWith(sel, expect.any(AbortSignal))
    expect(s.backend.hideMain).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('is cancelled when no region is selected', async () => {
    const s = setup({ select: null })
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
    expect(s.backend.screenshot).not.toHaveBeenCalled()
    expect(s.backend.hideMain).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('asks for the permission without hiding Canopy', async () => {
    const s = setup({ granted: false })
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'needs-permission' }])
    expect(s.backend.hideMain).not.toHaveBeenCalled()
    expect(s.backend.showMain).not.toHaveBeenCalled()
    expect(s.backend.selectRegion).not.toHaveBeenCalled()
  })

  it('asks macOS for the screen when not granted, so Canopy shows up in Screen Recording', async () => {
    const s = setup({ granted: false })
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.backend.requestScreen).toHaveBeenCalledTimes(1)
  })

  it('does not ask macOS again once granted', async () => {
    const s = setup()
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.backend.requestScreen).not.toHaveBeenCalled()
  })

  it('reports a failed screenshot with its message', async () => {
    const s = setup()
    s.backend.screenshot.mockRejectedValueOnce(new Error('boom'))
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: 'boom' }])
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('reports a backend that cannot start, without showing a window it never hid', async () => {
    const s = setup()
    s.backend.screenGranted.mockImplementationOnce(() => { throw new Error('Capture indisponible') })
    s.flow.start('screenshot', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: 'Capture indisponible' }])
    expect(s.backend.showMain).not.toHaveBeenCalled()
  })
})

describe('createCaptureFlow: recording', () => {
  it('ends with the panel button, after cleaning up once', async () => {
    const s = setup()
    s.flow.start('recording', 'tab-2')
    await untilRecording(s)
    expect(s.registerStop).toHaveBeenCalledTimes(1)
    expect(s.unregister).not.toHaveBeenCalled()
    s.panelStop()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 'tab-2', kind: 'recording', recording: recording(false), explainClicks: false }])
    expect(s.session.finish).toHaveBeenCalledWith(clicks, false)
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.backend.hideMain).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
    expect(s.session.cancel).not.toHaveBeenCalled()
  })

  it('ends with flow.stop(), and a later stop does nothing', async () => {
    const s = setup()
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.flow.stop()
    await s.done()
    s.flow.stop()
    s.panelStop()
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS)
    expect(s.emitted).toHaveLength(1)
    expect(s.emitted[0].kind).toBe('recording')
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.session.finish).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('ends with the stop shortcut', async () => {
    const s = setup()
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.shortcut()
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
    expect(s.unregister).toHaveBeenCalledTimes(1)
  })

  it('ends by itself at MAX_RECORDING_MS', async () => {
    const s = setup()
    s.flow.start('recording', 't')
    await untilRecording(s)
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS - 1)
    expect(s.emitted).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('reports a failed finish', async () => {
    const s = setup()
    s.session.finish.mockRejectedValueOnce(new Error('encodage'))
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: 'encodage' }])
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('cancels the session when finish is never reached', async () => {
    const s = setup()
    s.listener.stop.mockImplementationOnce(() => { throw new Error('clics') })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: 'clics' }])
    expect(s.session.finish).not.toHaveBeenCalled()
    expect(s.session.cancel).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a session whose finish failed: finish cleans up itself', async () => {
    const s = setup()
    s.session.finish.mockRejectedValueOnce(new Error('encodage'))
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.session.cancel).not.toHaveBeenCalled()
  })

  it('registers the stop shortcut before the recording starts', async () => {
    const s = setup()
    s.backend.startRecording.mockImplementationOnce(() => {
      expect(s.registerStop).toHaveBeenCalledTimes(1)
      return s.session
    })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.flow.stop()
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
  })

  it('stops the click listener when the recording cannot start', async () => {
    const s = setup()
    s.backend.startRecording.mockImplementationOnce(() => { throw new Error('flux') })
    s.flow.start('recording', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: 'flux' }])
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('records without clicks when the helper is not trusted, and explains it the first time only', async () => {
    const s = setup({ trusted: false })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.session.finish).toHaveBeenCalledWith(clicks, true)
    expect(s.emitted[0]).toEqual({ tabId: 't', kind: 'recording', recording: recording(true), explainClicks: true })
    expect(s.markClicksExplained).toHaveBeenCalledTimes(1)

    s.emitted.length = 0
    s.flow.start('recording', 't')
    await untilRecording(s, 2)
    s.flow.stop()
    await s.done()
    expect(s.emitted[0]).toMatchObject({ kind: 'recording', explainClicks: false })
    expect(s.markClicksExplained).toHaveBeenCalledTimes(1)
  })

  it('treats a helper silent for 2 s as untrusted', async () => {
    const s = setup({ trusted: 'never' })
    s.flow.start('recording', 't')
    await vi.advanceTimersByTimeAsync(1999)
    expect(s.backend.startRecording).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.session.finish).toHaveBeenCalledWith(clicks, true)
  })
})

describe('createCaptureFlow: one at a time', () => {
  it('refuses a second capture while one runs, and the first still completes', async () => {
    const s = setup()
    expect(s.flow.start('recording', 'a')).toBe(true)
    await untilRecording(s)
    expect(s.flow.start('screenshot', 'b')).toBe(false)
    expect(s.backend.hideMain).toHaveBeenCalledTimes(1)
    s.panelStop()
    await s.done()
    expect(s.emitted).toEqual([expect.objectContaining({ tabId: 'a', kind: 'recording' })])
    expect(s.backend.screenshot).not.toHaveBeenCalled()
  })

  it('reports a failing showMain and accepts the next capture', async () => {
    const s = setup()
    s.backend.showMain.mockImplementationOnce(() => { throw new Error('fenêtre') })
    s.flow.start('screenshot', 'a')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 'a', kind: 'error', message: 'fenêtre' }])
    expect(s.flow.start('screenshot', 'b')).toBe(true)
    await vi.waitFor(() => { if (s.emitted.length < 2) throw new Error('not yet') })
    expect(s.emitted[1]).toMatchObject({ tabId: 'b', kind: 'screenshot' })
  })

  it('accepts a new capture once the previous one is done', async () => {
    const s = setup({ select: null })
    s.flow.start('screenshot', 'a')
    await s.done()
    expect(s.flow.start('screenshot', 'b')).toBe(true)
    await vi.waitFor(() => { if (s.emitted.length < 2) throw new Error('not yet') })
    expect(s.emitted[1]).toEqual({ tabId: 'b', kind: 'cancelled' })
  })
})

describe('createCaptureFlow: stop controls', () => {
  it('refuses to record when neither the stop shortcut nor a panel is available', async () => {
    const s = setup({ shortcut: false, panel: false })
    s.flow.start('recording', 't')
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'error', message: "Impossible d'afficher le bouton d'arrêt ni d'enregistrer le raccourci ⌥⇧⌘5 : enregistrement annulé." }])
    expect(s.session.cancel).toHaveBeenCalledTimes(1)
    expect(s.session.finish).not.toHaveBeenCalled()
    expect(s.backend.showStopNotice).not.toHaveBeenCalled()
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('records with the panel alone when the shortcut is taken, without any notice', async () => {
    const s = setup({ shortcut: false, panel: true })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
    expect(s.backend.showStopNotice).not.toHaveBeenCalled()
  })

  it('tells about the shortcut when there is no panel', async () => {
    const s = setup({ panel: false })
    s.flow.start('recording', 't')
    await untilRecording(s)
    expect(s.backend.showStopNotice).toHaveBeenCalledTimes(1)
    s.shortcut()
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
  })

  it('arms the 2-minute stop once the recording has really started', async () => {
    const s = setup({ startsAtOnce: false })
    s.flow.start('recording', 't')
    await untilRecording(s)
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS)
    expect(s.emitted).toHaveLength(0)
    s.markStarted()
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS - 1)
    expect(s.emitted).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await s.done()
    expect(s.emitted[0].kind).toBe('recording')
  })
})

describe('createCaptureFlow: clicks', () => {
  it('passes each click to the recording as it comes', async () => {
    const s = setup()
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.click({ t: 10, x: 3, y: 4 })
    expect(s.session.click).toHaveBeenCalledWith({ t: 10, x: 3, y: 4 })
    s.flow.stop()
    await s.done()
  })

  it('passes no click from an untrusted helper', async () => {
    const s = setup({ trusted: false })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.click({ t: 10, x: 3, y: 4 })
    expect(s.session.click).not.toHaveBeenCalled()
    s.flow.stop()
    await s.done()
  })

  it('never explains missing clicks when they need no permission: the helper failed', async () => {
    const s = setup({ trusted: false, permission: 'none' })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await s.done()
    expect(s.emitted[0]).toEqual({ tabId: 't', kind: 'recording', recording: recording(true), explainClicks: false })
    expect(s.markClicksExplained).not.toHaveBeenCalled()
  })
})

describe('createCaptureFlow: cancelAll', () => {
  it('frees a running recording without finishing it', async () => {
    const s = setup()
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.flow.cancelAll()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
    expect(s.session.finish).not.toHaveBeenCalled()
    expect(s.session.cancel).toHaveBeenCalled()
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    expect(s.unregister).toHaveBeenCalledTimes(1)
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('closes the selection under way', async () => {
    const s = setup()
    s.backend.selectRegion.mockImplementationOnce((signal: AbortSignal) =>
      new Promise((resolve) => { signal.addEventListener('abort', () => { resolve(null) }) }))
    s.flow.start('recording', 't')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(s.backend.selectRegion).toHaveBeenCalledTimes(1)
    s.flow.cancelAll()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
    expect(s.backend.startRecording).not.toHaveBeenCalled()
  })

  it('stops a screenshot under way and shows Canopy at once', async () => {
    const s = setup()
    let screenshotSignal: AbortSignal | null = null
    s.backend.screenshot.mockImplementationOnce((_sel, signal) => new Promise((_resolve, reject) => {
      screenshotSignal = signal
      signal.addEventListener('abort', () => { reject(new Error("La capture s'est interrompue.")) })
    }))
    s.flow.start('screenshot', 't')
    await vi.waitFor(() => { expect(s.backend.screenshot).toHaveBeenCalled() })
    expect(s.backend.showMain).not.toHaveBeenCalled()
    s.flow.cancelAll()
    expect(screenshotSignal!.aborted).toBe(true)
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
    expect(s.backend.showMain).toHaveBeenCalledTimes(1)
  })

  it('drops a screenshot that comes back after the cancel', async () => {
    const s = setup()
    let deliver: () => void = () => {}
    s.backend.screenshot.mockImplementationOnce(() => new Promise((resolve) => { deliver = () => { resolve(image) } }))
    s.flow.start('screenshot', 't')
    await vi.waitFor(() => { expect(s.backend.screenshot).toHaveBeenCalled() })
    s.flow.cancelAll()
    deliver()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
  })

  it('stops the click helper while waiting for it, and never starts the recording', async () => {
    const s = setup({ trusted: 'never' })
    s.flow.start('recording', 't')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    s.flow.cancelAll()
    await s.done()
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
    expect(s.listener.stop).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.backend.startRecording).not.toHaveBeenCalled()
  })

  it('reports a quit during finish as cancelled, the windows closed at once', async () => {
    const s = setup()
    let fail: (e: Error) => void = () => {}
    s.session.finish.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    s.session.cancel.mockImplementation(() => { fail(new Error("La capture s'est interrompue.")) })
    s.flow.start('recording', 't')
    await untilRecording(s)
    s.panelStop()
    await vi.waitFor(() => { expect(s.session.finish).toHaveBeenCalled() })
    s.flow.cancelAll()
    await s.done()
    expect(s.session.cancel).toHaveBeenCalledTimes(1)
    expect(s.emitted).toEqual([{ tabId: 't', kind: 'cancelled' }])
  })

  it('does nothing when no capture runs', () => {
    const s = setup()
    s.flow.cancelAll()
    expect(s.emitted).toEqual([])
  })
})
