import type { CaptureBridge, CaptureClick, CaptureFinish, CaptureWorkerJob, CaptureWorkerResult } from '../../shared/capture'
import { fitSize, regionInStream, toImagePoint, type Rect } from '../../shared/captureGeometry'
import { MAX_RECORDING_MS, type Recording, type RecordingFrame } from '../../shared/recording'
import { CHANGE_THRESHOLD, createFrameCollector, fingerprintDiff, selectKeyFrames } from './keyframes'

const SAMPLE_MS = 250
const FINGERPRINT_WIDTH = 64
const JPEG_QUALITY = 0.8
/** A recording main never finishes stops sampling here, so the memory stays bounded. */
const MAX_SAMPLES = Math.ceil((MAX_RECORDING_MS + 10_000) / SAMPLE_MS)
const CLICK_RADIUS = 18
const CLICK_LINE = 3
const CLICK_COLOR = '#f85149'
const INTERRUPTED = 'La capture s\'est interrompue.'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function context(c: HTMLCanvasElement, readBack = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readBack ? { willReadFrequently: true } : undefined)
  if (!ctx) throw new Error('Canvas indisponible')
  return ctx
}

function canvas(size: { width: number; height: number }): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size.width
  c.height = size.height
  return c
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => { if (b) resolve(b); else reject(new Error('Image non encodée')) }, type, quality)
  })
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const url = String(r.result); resolve(url.slice(url.indexOf(',') + 1)) }
    r.onerror = () => { reject(r.error ?? new Error('Lecture impossible')) }
    r.readAsDataURL(blob)
  })
}

async function openStream(job: CaptureWorkerJob): Promise<{ video: HTMLVideoElement; stop: () => void; ended: Promise<void> }> {
  const { bounds, scaleFactor } = job.display
  // Without a max size Chromium scales a Retina display down; the real stream size still wins in regionInStream.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: job.sourceId,
        maxWidth: Math.round(bounds.width * scaleFactor),
        maxHeight: Math.round(bounds.height * scaleFactor)
      }
    }
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints)
  } catch (e) {
    throw new Error(`Impossible de lire l'écran : ${message(e)}`)
  }
  const stop = (): void => { for (const t of stream.getTracks()) t.stop() }
  // A display unplugged or a permission withdrawn ends the track: the recording must say so at once.
  const ended = new Promise<void>((resolve) => { for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => { resolve() }, { once: true }) })
  try {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    if (!video.videoWidth) await new Promise((r) => { video.addEventListener('loadedmetadata', r, { once: true }) })
    return { video, stop, ended }
  } catch (e) {
    stop()
    throw e
  }
}

/** The region in stream pixels, kept inside the stream whatever the rounding. */
function cropOf(job: CaptureWorkerJob, video: HTMLVideoElement): Rect {
  const w = video.videoWidth
  const h = video.videoHeight
  const r = regionInStream(job.region, job.display, { width: w, height: h })
  const x = Math.min(Math.max(0, r.x), w - 1)
  const y = Math.min(Math.max(0, r.y), h - 1)
  return { x, y, width: Math.max(1, Math.min(r.width, w - x)), height: Math.max(1, Math.min(r.height, h - y)) }
}

/** A grayscale thumbnail `FINGERPRINT_WIDTH` wide, compared between samples to spot a change. */
function fingerprinter(size: { width: number; height: number }): (frame: HTMLCanvasElement) => Uint8ClampedArray {
  const c = canvas({ width: FINGERPRINT_WIDTH, height: Math.max(1, Math.round(FINGERPRINT_WIDTH * size.height / size.width)) })
  const ctx = context(c, true)
  return (frame) => {
    ctx.drawImage(frame, 0, 0, c.width, c.height)
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data
    const gray = new Uint8ClampedArray(c.width * c.height)
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
    return gray
  }
}

async function withClick(blob: Blob, at: { x: number; y: number }): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const c = canvas(bitmap)
  const ctx = context(c)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  ctx.lineWidth = CLICK_LINE
  ctx.strokeStyle = CLICK_COLOR
  ctx.beginPath()
  ctx.arc(at.x, at.y, CLICK_RADIUS, 0, 2 * Math.PI)
  ctx.stroke()
  return toBlob(c, 'image/jpeg', JPEG_QUALITY)
}

async function run(job: CaptureWorkerJob, bridge: CaptureBridge, finished: Promise<CaptureFinish>, clicks: (fn: (c: CaptureClick) => void) => void): Promise<CaptureWorkerResult> {
  const { video, stop, ended } = await openStream(job)
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const crop = cropOf(job, video)
    const size = fitSize(crop.width, crop.height)
    const frame = canvas(size)
    const ctx = context(frame)
    const grab = (): void => { ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height) }

    if (job.mode === 'screenshot') {
      grab()
      return { kind: 'image', base64: await base64Of(await toBlob(frame, 'image/png')) }
    }

    const fingerprint = fingerprinter(size)
    // Only the samples a key frame may need stay in memory: a click's frames are taken as it comes.
    const collector = createFrameCollector<Blob>((c) => toImagePoint(c, job.region, size))
    let stopping = false
    // A late click must not count: finish brings every click main kept.
    clicks((c) => { if (!stopping) collector.click(c) })
    let count = 0
    let lastKept: Uint8ClampedArray | null = null
    const sample = async (): Promise<void> => {
      const t = Date.now()
      grab()
      const fp = fingerprint(frame)
      let change: number | undefined
      if (!lastKept) lastKept = fp
      else {
        const diff = fingerprintDiff(fp, lastKept)
        if (diff >= CHANGE_THRESHOLD) { change = diff; lastKept = fp }
      }
      const blob = await toBlob(frame, 'image/jpeg', JPEG_QUALITY)
      count++
      collector.sample({ t, image: blob, ...(change !== undefined ? { change } : {}) })
    }

    await sample()
    bridge.result({ kind: 'started' })
    let inFlight: Promise<void> | null = null
    let fail: (e: Error) => void = () => {}
    // Main hears a failure as soon as it happens, not when the user stops: the recording ends there.
    const failed = new Promise<never>((_resolve, reject) => { fail = reject })
    // A failure after the stop has nobody waiting for it.
    failed.catch(() => {})
    void ended.then(() => { fail(new Error(INTERRUPTED)) })
    // A slow encode skips a tick rather than queueing them.
    timer = setInterval(() => {
      if (inFlight || count >= MAX_SAMPLES) return
      inFlight = sample().catch(() => { fail(new Error(INTERRUPTED)) }).finally(() => { inFlight = null })
    }, SAMPLE_MS)
    const f = await Promise.race([finished, failed])
    stopping = true
    clearInterval(timer)
    await inFlight
    // A click main heard but never sent live, before the end frame that may be its after frame.
    if (!f.clicksMissing) for (const c of f.clicks) collector.click(c)
    await sample()

    const { candidates, clickCount, t0, t1 } = collector.candidates()
    // Without the helper, frames carry no click (the recording says so).
    const chosen = selectKeyFrames(f.clicksMissing ? candidates.filter((c) => !c.click) : candidates)
    const frames: RecordingFrame[] = await Promise.all(chosen.map(async (c) => {
      const image = c.reason === 'after-click' && c.click ? await withClick(c.image, c.click) : c.image
      return { t: c.t - t0, reason: c.reason, ...(c.click ? { click: c.click } : {}), base64: await base64Of(image) }
    }))
    const recording: Recording = {
      // A Mac asleep mid-recording stretches the clock past the cap, which main would refuse.
      durationMs: Math.min(t1 - t0, MAX_RECORDING_MS),
      width: size.width,
      height: size.height,
      frames,
      clicksMissing: f.clicksMissing,
      ...(f.clicksMissing ? {} : { clickCount })
    }
    return { kind: 'recording', recording }
  } finally {
    clearInterval(timer)
    stop()
  }
}

/** The hidden page that reads the display stream: one job, then main closes it. */
export function startWorker(bridge: CaptureBridge): void {
  const finished = new Promise<CaptureFinish>((resolve) => { bridge.onFinish(resolve) })
  let started = false
  bridge.onJob((job) => {
    if (started) return
    started = true
    void run(job, bridge, finished, bridge.onClick).then(
      (r) => { bridge.result(r) },
      (e: unknown) => { bridge.result({ kind: 'error', message: message(e) }) }
    )
  })
  bridge.ready()
}
