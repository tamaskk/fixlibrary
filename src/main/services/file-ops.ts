// The only code that copies, renames, overwrites or deletes a file of the library.
// It knows nothing about batches or tracks: what may be done to which file, and
// when, is decided by `pipeline/batch-files.ts`. This module makes sure that a
// change either happens completely or not at all, and never outside its folders.
import { constants } from 'fs'
import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs
} from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, sep } from 'path'
import { AppError } from '@shared/errors'
import { logger } from './logger'

/** A file that is still being written carries this name: `.<name>.fixlib-tmp`. */
const TEMP_SUFFIX = '.fixlib-tmp'
// After this many taken names something else is wrong than a name that is in use.
const MAX_NAME_ATTEMPTS = 1000

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
   * and as large as the source.
   */
  copy: (from: string, to: string, signal?: AbortSignal) => Promise<void>
  /**
   * Replaces the content of `target` with what `write` puts into the temp file it
   * is given. `target` changes in one step, after `write` has succeeded; if `write`
   * fails or the signal is aborted, `target` is untouched and the temp file is gone.
   */
  replace: (
    target: string,
    write: (tempPath: string, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal
  ) => Promise<void>
  /**
   * Makes `to` a byte-identical copy of `from`, replacing what is there, in one step.
   * This is how a backup is put back.
   */
  restore: (from: string, to: string, signal?: AbortSignal) => Promise<void>
  /** Renames a file. The new name must be free; see `freeName`. */
  move: (from: string, to: string) => Promise<void>
  /**
   * `path` if nothing is there, else the first of `name (2).ext`, `name (3).ext`, …
   * that is free. `ownPath` is a file that may be in the way without counting: the
   * file that is about to be renamed, which matters where letter case is ignored.
   */
  freeName: (path: string, ownPath?: string) => Promise<{ path: string; collided: boolean }>
  /** Deletes one file. Says whether there was one. Never a folder. */
  remove: (path: string) => Promise<boolean>
  /** Deletes a folder if it is empty; does nothing otherwise. */
  removeEmptyFolder: (path: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** True when both paths name one file on disk, however they are spelled. */
  sameFile: (first: string, second: string) => Promise<boolean>
  /** True when `path` is `folder` or lies inside it, by what they are on disk. */
  isInside: (path: string, folder: string) => Promise<boolean>
  /** A value that is equal for two paths exactly when they are on the same volume. */
  volumeOf: (path: string) => Promise<string>
  sizeOf: (path: string) => Promise<number>
  /** The free space, in bytes, of the volume that holds `path` or its nearest existing folder. */
  freeBytes: (path: string) => Promise<number>
  /**
   * Deletes the temp files that an interrupted write left under `root`. Returns how
   * many. Links are not followed.
   */
  removeTempFiles: (root: string) => Promise<number>
}

function tempPathOf(target: string): string {
  return join(dirname(target), `.${basename(target)}${TEMP_SUFFIX}`)
}

function isTempName(name: string): boolean {
  return name.startsWith('.') && name.endsWith(TEMP_SUFFIX) && name.length > TEMP_SUFFIX.length + 1
}

/** The folder as the disk names it, from its nearest ancestor that exists. */
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

export function createFileOps(options: FileOpsOptions): FileOps {
  /**
   * Throws unless `path` lies inside one of the allowed folders. Decided by what the
   * folders are on disk, not by how the path is spelled: a link in the path, `..`,
   * or another letter case cannot lead out.
   */
  async function assertAllowed(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new AppError('INVALID_INPUT', 'a file path must be absolute')
    const parent = await resolveExisting(dirname(path))
    for (const root of options.allowedRoots()) {
      const rootIdentity = await identityOf(root)
      if (rootIdentity === null) continue
      for (let current = parent; ; current = dirname(current)) {
        if ((await identityOf(current)) === rootIdentity) return
        if (current === dirname(current)) break
      }
    }
    throw new AppError('INVALID_INPUT', 'the path is outside the folders of the library')
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }

  async function removeQuietly(path: string): Promise<void> {
    await rm(path, { force: true }).catch((error: unknown) => {
      logger.warn('A temp file could not be removed', error)
    })
  }

  /** Writes through a temp file next to `target` and puts it in place in one step. */
  async function writeThroughTemp(
    target: string,
    write: (tempPath: string, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    mayOverwrite: boolean
  ): Promise<void> {
    await assertAllowed(target)
    if (signal.aborted) throw stoppedError()
    const temp = tempPathOf(target)
    await mkdir(dirname(target), { recursive: true })
    // Left by a write that was interrupted earlier.
    await rm(temp, { force: true })
    try {
      await write(temp, signal)
      // Checked after the write and before the rename: once a write was told to stop,
      // nothing of it may appear under the final name.
      if (signal.aborted) throw stoppedError()
      if (!mayOverwrite && (await exists(target))) {
        throw new AppError('WRITE_FAILED', 'the target of a copy exists already')
      }
      await rename(temp, target)
    } catch (error) {
      await removeQuietly(temp)
      throw error
    }
  }

  return {
    async copy(from, to, signal = new AbortController().signal) {
      await assertAllowed(from)
      await assertAllowed(to)
      if (await exists(to))
        throw new AppError('WRITE_FAILED', 'the target of a copy exists already')
      const expected = (await stat(from)).size
      await writeThroughTemp(
        to,
        async (temp) => {
          // A clone on APFS, which takes no time and no room; a plain copy elsewhere.
          await copyFile(from, temp, constants.COPYFILE_FICLONE)
          const copied = (await stat(temp)).size
          if (copied !== expected) {
            throw new AppError('WRITE_FAILED', `a copy has ${copied} bytes instead of ${expected}`)
          }
        },
        signal,
        false
      )
    },

    replace: (target, write, signal = new AbortController().signal) =>
      writeThroughTemp(target, write, signal, true),

    async restore(from, to, signal = new AbortController().signal) {
      await assertAllowed(from)
      const expected = (await stat(from)).size
      await writeThroughTemp(
        to,
        async (temp) => {
          await copyFile(from, temp, constants.COPYFILE_FICLONE)
          const copied = (await stat(temp)).size
          if (copied !== expected) {
            throw new AppError('WRITE_FAILED', `a copy has ${copied} bytes instead of ${expected}`)
          }
        },
        signal,
        true
      )
    },

    async move(from, to) {
      await assertAllowed(from)
      await assertAllowed(to)
      // The same file under another spelling (letter case) may be renamed onto itself.
      if ((await exists(to)) && (await identityOf(to)) !== (await identityOf(from))) {
        throw new AppError('WRITE_FAILED', 'the new name of a file is taken')
      }
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
    },

    async freeName(path, ownPath) {
      const own = ownPath === undefined ? null : await identityOf(ownPath)
      const isFree = async (candidate: string): Promise<boolean> =>
        !(await exists(candidate)) || (own !== null && (await identityOf(candidate)) === own)
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
      // Fails for a folder that holds anything, which is the point.
      await rmdir(path).catch(() => {})
    },

    exists,

    async sameFile(first, second) {
      const identity = await identityOf(first)
      return identity !== null && identity === (await identityOf(second))
    },

    async isInside(path, folder) {
      const folderIdentity = await identityOf(folder)
      if (folderIdentity === null) return false
      for (let current = await resolveExisting(path); ; current = dirname(current)) {
        if ((await identityOf(current)) === folderIdentity) return true
        if (current === dirname(current)) return false
      }
    },

    async volumeOf(path) {
      const folder = await resolveExisting(path)
      for (let current = folder; ; current = dirname(current)) {
        try {
          return String((await stat(current, { bigint: true })).dev)
        } catch (error) {
          if (current === dirname(current)) throw error
        }
      }
    },

    sizeOf: async (path) => (await stat(path)).size,

    async freeBytes(path) {
      const folder = await resolveExisting(path)
      for (let current = folder; ; current = dirname(current)) {
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
      let removed = 0
      const pending = [root]
      for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
        let entries
        try {
          entries = await opendir(folder)
        } catch {
          // Not there (a drive that is away) or not readable: nothing to clean here.
          continue
        }
        try {
          for await (const entry of entries) {
            const path = `${folder}${sep}${entry.name}`
            if (entry.isDirectory()) pending.push(path)
            else if (entry.isFile() && isTempName(entry.name)) {
              await removeQuietly(path)
              removed += 1
            }
          }
        } catch (error) {
          logger.warn('A folder could not be searched for temp files', error)
        }
      }
      return removed
    }
  }
}
