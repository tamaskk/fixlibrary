// The covers folder of the app (`userData/covers`): the pictures downloaded for
// covers, the covers the sidecar made of them, and their thumbnails. Kept between
// runs, so a cover is downloaded once; nothing in it is a library file.
import { constants } from 'fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'fs/promises'
import { createHash, randomBytes } from 'crypto'
import { isAbsolute, join } from 'path'
import { isCoverName, type CoverNameKind } from '@shared/covers'

// A thumbnail is a JPEG of 128 px: a few kilobytes.
const MAX_THUMB_BYTES = 256 * 1024
// As large as a picture from a service may be; the same limit is in fixlib_py/cover.py.
const MAX_PICTURE_BYTES = 16 * 1024 * 1024

export interface CoverStore {
  /** The folder, as the sidecar is told it. */
  folder: string
  /** Makes the folder, or checks the one that is there is a folder. */
  ensure: () => Promise<void>
  /** True when a file of this name is in the folder. */
  has: (name: string, kind: CoverNameKind) => Promise<boolean>
  /** Puts the bytes in the folder under the name, whole or not at all. */
  save: (name: string, kind: CoverNameKind, bytes: Uint8Array) => Promise<void>
  /** Removes a file of the folder; a file that is not there is no error. */
  remove: (name: string, kind: CoverNameKind) => Promise<void>
  /** The SHA-1 of a file of the folder, or null when it is not there. */
  digest: (name: string, kind: CoverNameKind) => Promise<string | null>
  /** A thumbnail as the page shows it: a `data:` address, or null. */
  thumbnail: (name: string) => Promise<string | null>
  /**
   * Copies a picture the user chose into the folder as a download, named by the
   * SHA-1 of its content, and returns that name. Reads the file only: it must be a
   * regular file reached without a link, of at most 16 MiB.
   */
  importPicture: (path: string) => Promise<string>
}

export function createCoverStore(folder: string): CoverStore {
  function pathOf(name: string, kind: CoverNameKind): string {
    // Only a name the app builds: no part of a path can come in through it.
    if (!isCoverName(name, kind)) throw new Error(`not the name of a ${kind}`)
    return join(folder, name)
  }

  const store: CoverStore = {
    folder,

    async ensure() {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      // A link in its place would let the sidecar write wherever it points, and a
      // folder of another user is no folder of the app's.
      const stats = await lstat(folder)
      if (!stats.isDirectory()) throw new Error('the covers folder is not a folder')
      if (process.getuid && stats.uid !== process.getuid()) {
        throw new Error('the covers folder belongs to another user')
      }
      if ((stats.mode & 0o077) !== 0) await chmod(folder, 0o700)
    },

    async has(name, kind) {
      try {
        return (await lstat(pathOf(name, kind))).isFile()
      } catch {
        return false
      }
    },

    async save(name, kind, bytes) {
      const final = pathOf(name, kind)
      const temp = join(folder, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
      const file = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        await file.writeFile(bytes)
        await file.close()
        await rename(temp, final)
      } catch (error) {
        await file.close().catch(() => {})
        await unlink(temp).catch(() => {})
        throw error
      }
    },

    async digest(name, kind) {
      try {
        const file = await open(pathOf(name, kind), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          return createHash('sha1')
            .update(await file.readFile())
            .digest('hex')
        } finally {
          await file.close()
        }
      } catch {
        return null
      }
    },

    async remove(name, kind) {
      try {
        await unlink(pathOf(name, kind))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },

    async thumbnail(name) {
      if (!isCoverName(name, 'thumb')) return null
      let bytes: Buffer
      try {
        const file = await open(pathOf(name, 'thumb'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stats = await file.stat()
          if (!stats.isFile() || stats.size > MAX_THUMB_BYTES) return null
          bytes = await file.readFile()
        } finally {
          await file.close()
        }
      } catch {
        return null
      }
      // Made by the sidecar, and still checked: the page shows only a JPEG.
      if (bytes.length > MAX_THUMB_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
      return `data:image/jpeg;base64,${bytes.toString('base64')}`
    },

    async importPicture(path) {
      if (!isAbsolute(path)) throw new Error('the picture must be named by an absolute path')
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      let bytes: Buffer
      try {
        const stats = await file.stat()
        if (!stats.isFile() || stats.size > MAX_PICTURE_BYTES) {
          throw new Error('the picture is no file of a size a picture may have')
        }
        // Read into a buffer of the limit, whatever size the file says it has: a file
        // that grows, or one of a file system that tells no size, is not read on.
        const buffer = Buffer.alloc(MAX_PICTURE_BYTES + 1)
        let filled = 0
        for (;;) {
          const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, null)
          if (bytesRead === 0) break
          filled += bytesRead
          if (filled > MAX_PICTURE_BYTES) throw new Error('the picture grew while it was read')
        }
        bytes = buffer.subarray(0, filled)
      } finally {
        await file.close()
      }
      const name = `${createHash('sha1').update(bytes).digest('hex')}.download`
      await store.save(name, 'download', bytes)
      return name
    }
  }
  return store
}
