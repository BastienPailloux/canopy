import { IMAGE_TYPES, MAX_DOCUMENT_BYTES } from '../../shared/sessionOptions'
import type { UserDocument } from '../../shared/types'
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
