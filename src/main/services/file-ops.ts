// The only code that copies, renames, overwrites or deletes a file of the library.
// It knows nothing about batches or tracks: what may be done to which file, and
// when, is decided by `pipeline/batch-files.ts`. This module makes sure that a
// change either happens completely or not at all, never outside its folders, and
// never over a file that is already there unless it was asked to replace exactly that.
import { createHash, randomBytes } from 'crypto'
import { constants, createReadStream } from 'fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink
} from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'path'
import { AppError } from '@shared/errors'

// The rule lives with the preview that shows a name; here it is the last check before
// a file gets one.
export { unusableNameReason } from '@shared/file-names'
import { describeError } from './error-text'
import { logger } from './logger'

/** A file that is still being written carries a name like `.<name>.<random>.fixlib-tmp`. */
const TEMP_SUFFIX = '.fixlib-tmp'
// How much of a file's name its temp file carries; the rest is cut off.
const MAX_TEMP_STEM_LENGTH = 200
/** After this many taken names something else is wrong than a name that is in use. */
export const MAX_NAME_ATTEMPTS = 1000
/** The file systems of a Mac's drives never hold more in one name. */
export const NAME_LIMIT = 255
export interface FileOpsOptions {
  /**
   * The folders this module may change anything in: the library, the clean library
   * and the backup folder, as the settings name them now. Read on every call.
   */
  allowedRoots: () => readonly string[]
}

export interface FileOps {
  /**
   * Copies a file to a path that must not exist yet, as a clone where the file
   * system can make one. The copy appears under its name only when it is complete
   * and as large as the source, and never in the place of another file.
   */
  copy: (from: string, to: string, signal?: AbortSignal) => Promise<void>
  /**
   * Makes `to` a byte-identical copy of `from`, replacing what is there, in one step.
   * This is how a backup is put back.
   */
  restore: (from: string, to: string, signal?: AbortSignal) => Promise<void>
  /**
   * Replaces the content of `target` with what `write` puts into the temp file it
   * is given. `target` changes in one step, after `write` has succeeded; if `write`
   * fails or the signal is aborted, `target` is untouched and the temp file is gone.
   */
  replace: (
    target: string,
    write: (tempPath: string, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
    /**
     * Runs the one step that puts the content in place. For a caller that has a
     * last question to ask of `target` first: if it throws, nothing is replaced.
     */
    naming?: (name: () => Promise<void>) => Promise<void>
  ) => Promise<void>
  /**
   * Makes a new file at `target` of what `write` puts into the temp file it is
   * given. The file appears under its name in one step, after `write` has succeeded,
   * and never in the place of another: if the name is taken by then, it fails.
   */
  create: (
    target: string,
    write: (tempPath: string, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
    /**
     * Runs the one step that gives the file its name. For a caller whose names
     * take turns under a lock: the writing, which is long, stays outside it.
     */
    naming?: (name: () => Promise<void>) => Promise<void>
  ) => Promise<void>
  /**
   * Renames a file. Never replaces another file: if the new name is taken, it fails,
   * also when two renames to one name run at the same time. See `freeName`.
   */
  move: (from: string, to: string) => Promise<void>
  /**
   * `path` if nothing is there, else the first of `name (2).ext`, `name (3).ext`, …
   * that is free. `ownPath` is a file that may be in the way without counting: the
   * file that is about to be renamed, which matters where letter case is ignored.
   */
  freeName: (path: string, ownPath?: string) => Promise<{ path: string; collided: boolean }>
  /** Deletes one file. Says whether there was one. Never a folder. */
  remove: (path: string) => Promise<boolean>
  /** Deletes a folder if it is empty and is not one of the allowed folders themselves. */
  removeEmptyFolder: (path: string) => Promise<void>
  /** Creates one of the allowed folders if it is not there. Refuses a link in its place. */
  createRoot: (path: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** True for a regular file: not a folder, not a link, not anything else. */
  isRegularFile: (path: string) => Promise<boolean>
  /** True for a folder itself: not a link to one, and not a path that is not there. */
  isFolder: (path: string) => Promise<boolean>
  /** True when both paths name one file on disk, however they are spelled. */
  sameFile: (first: string, second: string) => Promise<boolean>
  /** The sha256 of a regular file, or null when there is no such file. */
  sha256Of: (path: string) => Promise<string | null>
  /**
   * True when both are regular files that hold the same bytes. Reads both: for the
   * few files of which it must be known that writing one over the other loses nothing.
   */
  sameContent: (first: string, second: string) => Promise<boolean>
  /** True when `path` is `folder` or lies inside it, by what they are on disk. */
  isInside: (path: string, folder: string) => Promise<boolean>
  /**
   * Where `path` lies under `folder`, by what both are on disk: a root that is
   * spelled in another letter case or Unicode form than the path still matches.
   * Null when `path` is not inside `folder`.
   */
  relativeTo: (folder: string, path: string) => Promise<string | null>
  /** A value that is equal for two paths exactly when they are on the same volume. */
  volumeOf: (path: string) => Promise<string>
  sizeOf: (path: string) => Promise<number>
  /** The free space, in bytes, of the volume that holds `path` or its nearest existing folder. */
  freeBytes: (path: string) => Promise<number>
  /**
   * Deletes the temp files that an interrupted write left under `root`. Returns how
   * many. Links are not followed, and other volumes mounted below are left alone.
   */
  removeTempFiles: (root: string) => Promise<number>
}

function tempPathOf(target: string): string {
  // Unique, so two writes never share a temp file, and short enough for any name.
  const stem = basename(target).slice(0, MAX_TEMP_STEM_LENGTH)
  return join(dirname(target), `.${stem}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`)
}

function isTempName(name: string): boolean {
  return name.startsWith('.') && name.endsWith(TEMP_SUFFIX) && name.length > TEMP_SUFFIX.length + 1
}

/** The path as the disk names it, from its nearest ancestor that exists. */
async function resolveExisting(path: string): Promise<string> {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing)
    } catch {
      if (current === dirname(current)) return path
      missing.unshift(basename(current))
    }
  }
}

async function identityOf(path: string): Promise<string | null> {
  try {
    const { dev, ino } = await stat(path, { bigint: true })
    return `${dev}:${ino}`
  } catch {
    return null
  }
}

function stoppedError(): AppError {
  return new AppError('WRITE_FAILED', 'the write was stopped')
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** The sha256 of a file, read as a stream: a track may be hundreds of megabytes. */
function digestOf(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** True for a name that only differs in letter case or Unicode form from another. */
export function isRespelling(first: string, second: string): boolean {
  const fold = (path: string): string => basename(path).normalize('NFC').toLowerCase()
  return dirname(first) === dirname(second) && fold(first) === fold(second)
}

export function createFileOps(options: FileOpsOptions): FileOps {
  /** The identities of the allowed folders that exist. */
  async function rootIdentities(): Promise<Set<string>> {
    const identities = new Set<string>()
    for (const root of options.allowedRoots()) {
      const identity = await identityOf(root)
      if (identity !== null) identities.add(identity)
    }
    return identities
  }

  /**
   * Throws unless `path` lies inside one of the allowed folders. Decided by what the
   * folders are on disk, not by how the path is spelled: a link in the path, `..`,
   * or another letter case cannot lead out.
   */
  async function assertAllowed(path: string): Promise<void> {
    if (!isAbsolute(path) || normalize(path) !== path) {
      throw new AppError('INVALID_INPUT', 'a file path must be absolute and plain')
    }
    const roots = await rootIdentities()
    for (let current = await resolveExisting(dirname(path)); ; current = dirname(current)) {
      const identity = await identityOf(current)
      if (identity !== null && roots.has(identity)) return
      if (current === dirname(current)) break
    }
    throw new AppError('INVALID_INPUT', 'the path is outside the folders of the library')
  }

  /** A source that is copied must be a plain file: a link would bring in another file. */
  async function assertRegularFile(path: string): Promise<number> {
    const found = await lstat(path)
    if (!found.isFile()) throw new AppError('WRITE_FAILED', 'the source is not a regular file')
    return found.size
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }

  /** Makes sure what was written is on the disk before it gets its final name. */
  async function flush(path: string): Promise<void> {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Gives `from` the name `to` only if nothing has that name. A hard link fails when
   * the name is taken, in one step, so two writers cannot both win. Where the file
   * system has no hard links (exFAT), the name is checked and the file renamed;
   * callers that may collide take turns (see the lock in `pipeline/batch-files.ts`).
   */
  async function nameWithoutReplacing(from: string, to: string): Promise<void> {
    try {
      await link(from, to)
    } catch (error) {
      const code = codeOf(error)
      if (code === 'EEXIST') throw new AppError('WRITE_FAILED', 'the name of a file is taken')
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error
      if (await exists(to)) throw new AppError('WRITE_FAILED', 'the name of a file is taken')
      await rename(from, to)
      return
    }
    await unlink(from)
  }

  /** Throws unless what a write left at its temp name is a regular file. */
  async function assertWrittenFile(temp: string): Promise<void> {
    const written = await lstat(temp).catch(() => null)
    if (!written?.isFile()) throw new AppError('WRITE_FAILED', 'what was written is not a file')
  }

  /** Writes through a temp file next to `target` and puts it in place in one step. */
  async function writeThroughTemp(
    target: string,
    write: (tempPath: string, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    mayOverwrite: boolean,
    naming: (name: () => Promise<void>) => Promise<void> = (name) => name()
  ): Promise<void> {
    await assertAllowed(target)
    if (signal.aborted) throw stoppedError()
    await mkdir(dirname(target), { recursive: true })
    // The folder may have been created just now, or swapped since the check.
    await assertAllowed(target)
    const temp = tempPathOf(target)
    try {
      await write(temp, signal)
      // Checked after the write and before the rename: once a write was told to stop,
      // nothing of it may appear under the final name.
      if (signal.aborted) throw stoppedError()
      // Before it is opened to be synced: a link there would be followed, and a
      // pipe would never let go.
      await assertWrittenFile(temp)
      await flush(temp)
      // Syncing a large file takes a while: whoever stopped the write meanwhile may
      // already be putting the file back to what it was.
      if (signal.aborted) throw stoppedError()
      await naming(async () => {
        // The turn may have been waited for: a write that was stopped meanwhile
        // must not appear under the final name either.
        if (signal.aborted) throw stoppedError()
        // Asked again at the last moment: a link put there meanwhile would bring in
        // the file it points to, under the name of a library file.
        await assertWrittenFile(temp)
        if (mayOverwrite) await rename(temp, target)
        else await nameWithoutReplacing(temp, target)
      })
    } catch (error) {
      await rm(temp, { force: true }).catch((cleanupError: unknown) => {
        logger.warn(`A temp file could not be removed: ${describeError(cleanupError)}`)
      })
      throw error
    }
  }

  async function copyInto(temp: string, from: string, expected: number): Promise<void> {
    // A clone where the file system makes one, a plain copy elsewhere. The temp name
    // is new: anything that is there already, such as a link, was put there by
    // someone else and is not written through.
    await copyFile(from, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    const copied = (await stat(temp)).size
    if (copied !== expected) {
      throw new AppError('WRITE_FAILED', `a copy has ${copied} bytes instead of ${expected}`)
    }
  }

  return {
    async copy(from, to, signal = new AbortController().signal) {
      await assertAllowed(from)
      await assertAllowed(to)
      const expected = await assertRegularFile(from)
      await writeThroughTemp(to, (temp) => copyInto(temp, from, expected), signal, false)
    },

    async restore(from, to, signal = new AbortController().signal) {
      await assertAllowed(from)
      const expected = await assertRegularFile(from)
      await writeThroughTemp(to, (temp) => copyInto(temp, from, expected), signal, true)
    },

    replace: (target, write, signal = new AbortController().signal, naming) =>
      writeThroughTemp(target, write, signal, true, naming),

    create: (target, write, signal = new AbortController().signal, naming) =>
      writeThroughTemp(target, write, signal, false, naming),

    async move(from, to) {
      await assertAllowed(from)
      await assertAllowed(to)
      if (to === from) return
      await mkdir(dirname(to), { recursive: true })
      await assertAllowed(to)
      // A link in the place of the file would bring in the file it points to.
      await assertRegularFile(from)
      // The same file under another letter case or Unicode form: where the disk
      // ignores that, the new name "exists" already and is the file itself.
      if (isRespelling(from, to) && (await identityOf(to)) === (await identityOf(from))) {
        await rename(from, to)
        return
      }
      await nameWithoutReplacing(from, to)
    },

    async freeName(path, ownPath) {
      const own = ownPath === undefined ? null : await identityOf(ownPath)
      const isFree = async (candidate: string): Promise<boolean> => {
        // A name the file system would refuse is not free, whatever `lstat` says.
        if (basename(candidate).length > NAME_LIMIT) return false
        if (!(await exists(candidate))) return true
        return (
          own !== null &&
          ownPath !== undefined &&
          isRespelling(ownPath, candidate) &&
          (await identityOf(candidate)) === own
        )
      }
      if (await isFree(path)) return { path, collided: false }
      const extension = extname(path)
      const stem = path.slice(0, path.length - extension.length)
      for (let number = 2; number < MAX_NAME_ATTEMPTS; number += 1) {
        const candidate = `${stem} (${number})${extension}`
        if (await isFree(candidate)) return { path: candidate, collided: true }
      }
      throw new AppError('WRITE_FAILED', 'no free name was found for a file')
    },

    async remove(path) {
      await assertAllowed(path)
      let found
      try {
        found = await lstat(path)
      } catch {
        return false
      }
      // A folder is never removed with what is in it.
      if (found.isDirectory())
        throw new AppError('WRITE_FAILED', 'a folder is not deleted as a file')
      await rm(path)
      return true
    },

    async removeEmptyFolder(path) {
      await assertAllowed(join(path, 'x'))
      const identity = await identityOf(path)
      // The library, its clean copy and the backup folder stay, empty or not.
      if (identity === null || (await rootIdentities()).has(identity)) return
      // Fails for a folder that holds anything, which is the point.
      await rmdir(path).catch(() => {})
    },

    async createRoot(path) {
      if (!options.allowedRoots().includes(path)) {
        throw new AppError('INVALID_INPUT', 'only a folder of the library may be created')
      }
      await mkdir(path, { recursive: true })
      // A link in its place would send every file written here somewhere else.
      if (!(await lstat(path)).isDirectory()) {
        throw new AppError('WRITE_FAILED', 'a folder of the library is not a folder')
      }
    },

    exists,

    async isRegularFile(path) {
      try {
        return (await lstat(path)).isFile()
      } catch {
        return false
      }
    },

    async isFolder(path) {
      try {
        return (await lstat(path)).isDirectory()
      } catch {
        return false
      }
    },

    async sameFile(first, second) {
      const identity = await identityOf(first)
      return identity !== null && identity === (await identityOf(second))
    },

    async sha256Of(path) {
      try {
        if (!(await lstat(path)).isFile()) return null
        return await digestOf(path)
      } catch {
        return null
      }
    },

    async sameContent(first, second) {
      const sizes: number[] = []
      for (const path of [first, second]) {
        try {
          const found = await lstat(path)
          if (!found.isFile()) return false
          sizes.push(found.size)
        } catch {
          return false
        }
      }
      if (sizes[0] !== sizes[1]) return false
      const [one, other] = await Promise.all([digestOf(first), digestOf(second)])
      return one === other
    },

    async isInside(path, folder) {
      const folderIdentity = await identityOf(folder)
      if (folderIdentity === null) return false
      for (let current = await resolveExisting(path); ; current = dirname(current)) {
        if ((await identityOf(current)) === folderIdentity) return true
        if (current === dirname(current)) return false
      }
    },

    async relativeTo(folder, path) {
      const part = relative(await resolveExisting(folder), await resolveExisting(path))
      const outside =
        part === '' || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)
      return outside ? null : part
    },

    async volumeOf(path) {
      for (let current = await resolveExisting(path); ; current = dirname(current)) {
        try {
          return String((await stat(current, { bigint: true })).dev)
        } catch (error) {
          if (current === dirname(current)) throw error
        }
      }
    },

    sizeOf: async (path) => (await stat(path)).size,

    async freeBytes(path) {
      for (let current = await resolveExisting(path); ; current = dirname(current)) {
        try {
          const { bavail, bsize } = await statfs(current)
          return bavail * bsize
        } catch (error) {
          if (current === dirname(current)) throw error
        }
      }
    },

    async removeTempFiles(root) {
      await assertAllowed(join(root, 'x'))
      let rootState
      try {
        rootState = await lstat(root)
      } catch {
        // Not there: a drive that is away, or a folder that was never created.
        return 0
      }
      // A link in the place of the folder is not walked: it could lead anywhere.
      if (!rootState.isDirectory()) return 0

      let removed = 0
      const pending = [root]
      for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
        try {
          // Not into a folder that was swapped for a link since it was listed, and
          // not onto another volume that is mounted below the library.
          const state = await lstat(folder)
          if (!state.isDirectory() || state.dev !== rootState.dev) continue
          for await (const entry of await opendir(folder)) {
            const path = `${folder}${sep}${entry.name}`
            if (entry.isDirectory()) pending.push(path)
            else if (entry.isFile() && isTempName(entry.name)) {
              // One file that cannot be removed must not keep the rest of the folder,
              // and the folders below it, from being cleaned.
              try {
                await rm(path)
                removed += 1
              } catch (error) {
                // Gone already: on some drives a file takes a companion file with it.
                if (codeOf(error) === 'ENOENT') continue
                logger.warn(`A temp file could not be removed: ${describeError(error)}`)
              }
            }
          }
        } catch (error) {
          logger.warn(`A folder could not be cleaned of temp files: ${describeError(error)}`)
        }
      }
      return removed
    }
  }
}
