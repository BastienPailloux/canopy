import { IMAGE_TYPES, MAX_DOCUMENT_BYTES } from '../../shared/sessionOptions'
import { countImages, MAX_IMAGES_PER_MESSAGE, type Recording } from '../../shared/recording'
import type { UserDocument } from '../../shared/types'
import type { Draft } from '../../shared/update'
import type { UserImage } from './transcript'

interface FileLike { name: string; type: string; size: number }

const PDF = 'application/pdf'

/** What the composer can attach, in the order given, and why the rest is left out. */
export function sortFiles<F extends FileLike>(files: F[]): { images: F[]; documents: F[]; error: string | null } {
  const images = files.filter((f) => IMAGE_TYPES.includes(f.type))
  const pdfs = files.filter((f) => f.type === PDF)
  const documents = pdfs.filter((f) => f.size <= MAX_DOCUMENT_BYTES)
  const tooBig = pdfs.find((f) => f.size > MAX_DOCUMENT_BYTES)
  const unknown = images.length + pdfs.length < files.length
  const error = tooBig
    ? `« ${tooBig.name} » dépasse ${MAX_DOCUMENT_BYTES / 1024 / 1024} Mo, la limite de Claude.`
    : unknown ? 'Seuls les PDF et les images PNG, JPEG, GIF et WebP sont acceptés.' : null
  return { images, documents, error }
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error(`« ${file.name} » est illisible`))
    reader.readAsDataURL(file)
  })
}

export const readImage = async (file: File): Promise<UserImage> => ({ mediaType: file.type, base64: await readBase64(file) })
export const readDocument = async (file: File): Promise<UserDocument> => ({ name: file.name, base64: await readBase64(file) })

/** The accept list of the file chooser. */
export const ACCEPTED_TYPES = [...IMAGE_TYPES, PDF].join(',')

/** Why the draft cannot be sent as it is: the API refuses a message with too many images. */
export function imageLimitError(d: Draft): string | null {
  const n = countImages(d)
  return n > MAX_IMAGES_PER_MESSAGE ? `Trop d'images pour un seul message (${n} / ${MAX_IMAGES_PER_MESSAGE}) : retirez une pièce jointe.` : null
}

/** `14 s · 3 clics` on the recording chip. A click gives a before and an after frame: only one of them is counted. */
export function recordingLabel(r: Recording): string {
  const seconds = `${Math.round(r.durationMs / 1000)} s`
  if (r.clicksMissing) return `${seconds} · clics non enregistrés`
  const after = r.frames.filter((f) => f.reason === 'after-click').length
  const clicks = after > 0 ? after : r.frames.filter((f) => f.reason === 'before-click').length
  return `${seconds} · ${clicks} ${clicks > 1 ? 'clics' : 'clic'}`
}
