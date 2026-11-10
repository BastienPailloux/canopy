import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export type RegularFileRead = { kind: 'file'; bytes: Buffer } | { kind: 'tooLarge'; size: number } | { kind: 'notFile' }

/**
 * Reads a file only if it is a regular file of at most `maxBytes`. The checks run on the opened descriptor, not on
 * the path: a path checked then read could be swapped in between (a symlink, a FIFO, a bigger file).
 * O_NONBLOCK keeps a FIFO from blocking the open. With `noFollow`, a symlink rejects with ELOOP.
 * Open errors (ENOENT…) are thrown as is.
 */
export async function readRegularFile(path: string, opts: { maxBytes: number; noFollow?: boolean }): Promise<RegularFileRead> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (opts.noFollow ? constants.O_NOFOLLOW : 0)
  const fh = await open(path, flags)
  try {
    const st = await fh.stat()
    if (!st.isFile()) return { kind: 'notFile' }
    if (st.size > opts.maxBytes) return { kind: 'tooLarge', size: st.size }
    // Read up to EOF but never past maxBytes + 1: it may have grown since the fstat.
    const chunks: Buffer[] = []
    let n = 0
    while (n <= opts.maxBytes) {
      const want = Math.min(Math.max(st.size - n, 64 * 1024 - 1) + 1, opts.maxBytes + 1 - n)
      const chunk = Buffer.alloc(want)
      const { bytesRead } = await fh.read(chunk, 0, want, n)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      n += bytesRead
    }
    return n > opts.maxBytes ? { kind: 'tooLarge', size: n } : { kind: 'file', bytes: Buffer.concat(chunks, n) }
  } finally {
    await fh.close()
  }
}
