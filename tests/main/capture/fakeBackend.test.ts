import { describe, expect, it, vi } from 'vitest'
import { selectCaptureBackend } from '../../../src/main/capture/fakeBackend'
import type { CaptureBackend } from '../../../src/main/capture/captureFlow'

const fakeSel = { region: { x: 0, y: 0, width: 1, height: 1 }, display: { id: 1, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 } }
const realBackend = { screenGranted: () => true } as unknown as CaptureBackend

describe('selectCaptureBackend', () => {
  it('uses the real backend without the variable, built only when first used', () => {
    for (const env of [{}, { CANOPY_FAKE_CAPTURE: '' }]) {
      const real = vi.fn(() => realBackend)
      const s = selectCaptureBackend(real, { isPackaged: false, env })
      expect(s.clicks).toBeNull()
      expect(real).not.toHaveBeenCalled()
      expect(s.backend.screenGranted()).toBe(true)
      expect(s.backend.screenGranted()).toBe(true)
      expect(real).toHaveBeenCalledTimes(1)
    }
  })

  it('lets the real factory fail on use, not on selection', () => {
    const s = selectCaptureBackend(() => { throw new Error('Capture indisponible') }, { isPackaged: false, env: {} })
    expect(() => s.backend.screenGranted()).toThrow('Capture indisponible')
  })

  it('never selects the fake in a packaged app', () => {
    const s = selectCaptureBackend(() => realBackend, { isPackaged: true, env: { CANOPY_FAKE_CAPTURE: '1' } })
    expect(s.clicks).toBeNull()
    expect(s.backend.screenGranted()).toBe(true)
  })
})

describe('fake capture', () => {
  const fake = (value: string) => selectCaptureBackend(() => { throw new Error('not called') }, { isPackaged: false, env: { CANOPY_FAKE_CAPTURE: value } })

  it('gives a 1×1 PNG screenshot of a selected region', async () => {
    const { backend } = fake('1')
    expect(backend.screenGranted()).toBe(true)
    const sel = await backend.selectRegion(new AbortController().signal)
    expect(sel).not.toBeNull()
    const image = await backend.screenshot(sel!, new AbortController().signal)
    expect(image.mediaType).toBe('image/png')
    expect(Buffer.from(image.base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
  })

  it('gives no screenshot once cancelled', async () => {
    const { backend } = fake('1')
    const sel = await backend.selectRegion(new AbortController().signal)
    const controller = new AbortController()
    controller.abort()
    await expect(backend.screenshot(sel!, controller.signal)).rejects.toThrow()
  })

  it('passes the cancel on to the real screenshot', async () => {
    const screenshot = vi.fn(async () => ({ mediaType: 'image/png', base64: 'AAAA' }))
    const s = selectCaptureBackend(() => ({ screenshot }) as unknown as CaptureBackend, { isPackaged: false, env: {} })
    const signal = new AbortController().signal
    await s.backend.screenshot(fakeSel, signal)
    expect(screenshot).toHaveBeenCalledWith(fakeSel, signal)
  })

  it('gives a 2-frame recording with 1 click, the panel stopping right away', async () => {
    const { backend, clicks } = fake('1')
    const listener = clicks!()
    expect(await listener.ready).toEqual({ trusted: true })
    const session = backend.startRecording((await backend.selectRegion(new AbortController().signal))!)
    expect(session.hasPanel).toBe(true)
    await session.started
    await session.stopped
    session.click({ t: 1, x: 2, y: 3 })
    const r = await session.finish(listener.stop(), false)
    expect(r.frames).toHaveLength(2)
    expect(r.frames.map((f) => f.reason)).toEqual(['before-click', 'after-click'])
    expect(new Set(r.frames.map((f) => JSON.stringify(f.click))).size).toBe(1)
    expect(r.frames[0].click).toBeDefined()
    expect(Buffer.from(r.frames[0].base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(r.clicksMissing).toBe(false)
    expect(r.durationMs).toBe(1500)
  })

  it('delivers no click live: the fake recording is fixed', () => {
    const listener = fake('1').clicks!()
    expect(() => { listener.onClick(() => { throw new Error('no click expected') }) }).not.toThrow()
  })

  it('cancels the selection with "cancel"', async () => {
    expect(await fake('cancel').backend.selectRegion(new AbortController().signal)).toBeNull()
  })

  it('denies the screen permission with "denied"', () => {
    expect(fake('denied').backend.screenGranted()).toBe(false)
  })

  it('reports an untrusted click helper with "noclicks", and frames without click', async () => {
    const { backend, clicks } = fake('noclicks')
    const listener = clicks!()
    expect(await listener.ready).toEqual({ trusted: false })
    const session = backend.startRecording((await backend.selectRegion(new AbortController().signal))!)
    const r = await session.finish(listener.stop(), true)
    expect(r.clicksMissing).toBe(true)
    expect(r.frames.every((f) => f.click === undefined)).toBe(true)
  })
})
