import type { RecordingFrame } from '../../shared/recording'
import type { CaptureBackend, CaptureSelection } from './captureFlow'
import type { ClickListener } from './clicks'

/** 1×1 images: enough for the composer and the transcript to show something. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAGxsbGxsbLxsbL0IvLy9CWUJCQkJZcFlZWVlZcIhwcHBwcHCIiIiIiIiIiKOjo6Ojo76+vr6+1dXV1dXV1dXV1f/bAEMBISMjNjI2XTIyXd+XfJff39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f3//dAAQAAf/aAAwDAQACEQMRAD8A1qKKK5TiP//Z'

const SELECTION: CaptureSelection = {
  region: { x: 100, y: 100, width: 320, height: 200 },
  display: { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
}
const CLICK = { t: 700, x: 160, y: 100 }

/** Test-only stand-in for the screen, the windows, the permissions and the click helper (`CANOPY_FAKE_CAPTURE`). */
function fakeCapture(mode: string): { backend: CaptureBackend; clicks: () => ClickListener } {
  const backend: CaptureBackend = {
    screenGranted: () => mode !== 'denied',
    requestScreen: () => {},
    hideMain: () => {},
    showMain: () => {},
    selectRegion: async () => (mode === 'cancel' ? null : SELECTION),
    screenshot: async () => ({ mediaType: 'image/png', base64: PNG }),
    startRecording: () => ({
      // The fake panel is pressed right away.
      stopped: new Promise((resolve) => { setTimeout(resolve, 0) }),
      finish: async (_clicks, clicksMissing) => {
        const click = clicksMissing ? {} : { click: { x: CLICK.x, y: CLICK.y } }
        const frames: RecordingFrame[] = [
          { t: CLICK.t - 50, reason: 'before-click', ...click, base64: JPEG },
          { t: CLICK.t + 500, reason: 'after-click', ...click, base64: JPEG }
        ]
        return { durationMs: 1500, width: 320, height: 200, frames, clicksMissing }
      },
      cancel: () => {}
    })
  }
  const clicks = (): ClickListener => ({
    ready: Promise.resolve({ trusted: mode !== 'noclicks' }),
    stop: () => (mode === 'noclicks' ? [] : [CLICK])
  })
  return { backend, clicks }
}

/** Builds the real backend on first use, so a missing one fails a capture, not the launch. */
function lazy(real: () => CaptureBackend): CaptureBackend {
  let made: CaptureBackend | null = null
  const get = (): CaptureBackend => (made ??= real())
  return {
    screenGranted: () => get().screenGranted(),
    requestScreen: () => get().requestScreen(),
    hideMain: () => get().hideMain(),
    showMain: () => get().showMain(),
    selectRegion: () => get().selectRegion(),
    screenshot: (sel) => get().screenshot(sel),
    startRecording: (sel) => get().startRecording(sel)
  }
}

/**
 * The fake when `CANOPY_FAKE_CAPTURE` is set in development (`1`, `cancel`, `denied`, `noclicks`), ignored packaged.
 * `clicks` is null for the real click helper.
 */
export function selectCaptureBackend(real: () => CaptureBackend, o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): { backend: CaptureBackend; clicks: (() => ClickListener) | null } {
  const mode = o.isPackaged ? undefined : o.env.CANOPY_FAKE_CAPTURE
  return mode ? fakeCapture(mode) : { backend: lazy(real), clicks: null }
}
