// The rules for changing the files of a batch: what is saved before the first change,
// where the work happens in each mode, and how a batch is undone. The changes
// themselves are made by `services/file-ops.ts`.
import { basename, dirname, extname, join, relative } from 'path'
import {
  deleteBackup,
  deleteCreatedFiles,
  deleteCreatedFilesOfOtherBatches,
  getBackup,
  insertBackup,
  listBackups,
  listBackupsOfOtherBatches,
  listCreatedFiles,
  recordCreatedFile
} from '../db/backups'
import {
  findLastWrittenBatch,
  getBatch,
  listBatchItemsBefore,
  listBatchItemStates,
  setBatchStatus,
  type BatchMode
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { getTrackById, restoreTrack, updateTrack, type Track } from '../db/tracks'
import type { FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import { AppError, type Result } from '@shared/errors'
import type { SpaceCheck } from '@shared/file-ops'

// Kept free beyond what the copies need: a volume that is full to the last byte
// fails in other places.
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024

export interface LibraryFolders {
  libraryRoot: string | null
  cleanLibraryFolder: string | null
  /** The folder in use: the chosen one, or the default next to the library. */
  backupFolder: string | null
}

export interface BatchFilesDependencies {
  db: AppDatabase
  fileOps: FileOps
  /** As the settings say now. */
  folders: () => LibraryFolders
  listMountedVolumes: () => ReadonlySet<string>
}

/** What an apply stage may do to the file of the one track it works on. */
export interface TrackFiles {
  /**
   * Renames or moves the file, inside the folder the work happens in. If the name
   * is taken, the file gets ` (2)`, ` (3)`, …; `collided` says so. Returns where the
   * file is now.
   */
  move: (to: string) => Promise<{ path: string; collided: boolean }>
  /**
   * Replaces the content of the file with what `write` puts into the temp file it
   * is given. `write` must stop when its signal is aborted.
   */
  replaceContent: (write: (tempPath: string, signal: AbortSignal) => Promise<void>) => Promise<void>
  /** Where the file that is worked on is now. Makes the backup or the copy first. */
  workingPath: () => Promise<string>
}

export interface UndoSummary {
  batchId: number
  /** Files put back from their backup. */
  restored: number
  /** Files the batch had created, now deleted. */
  removed: number
}

export interface BatchFiles {
  forTrack: (
    batch: { id: number; mode: BatchMode },
    trackId: number,
    signal: AbortSignal
  ) => TrackFiles
  /** Whether what the batch still has to copy fits on its volume. */
  checkSpace: (batchId: number) => Promise<SpaceCheck>
  /** The batch that undo would undo now, or null. */
  lastUndoable: () => number | null
  /** Puts the files and the tracks of the last batch that wrote back to what they were. */
  undoLast: () => Promise<Result<UndoSummary>>
  /** Once a batch is applied, the backups of every earlier batch are deleted. */
  pruneOlderBackups: (keepBatchId: number) => Promise<void>
  /** Deletes what interrupted writes left in the folders of the library. */
  removeTempFiles: () => Promise<number>
}

export function createBatchFiles(dependencies: BatchFilesDependencies): BatchFiles {
  const { db, fileOps, folders, listMountedVolumes } = dependencies

  function readTrack(trackId: number): Track {
    const track = getTrackById(db, trackId, listMountedVolumes())
    if (!track) throw new AppError('FILE_UNREADABLE', 'the track is not in the library any more')
    return track
  }

  function needFolder(folder: string | null, what: string): string {
    if (folder === null) throw new AppError('WRITE_FAILED', `no ${what} folder is set`)
    return folder
  }

  /** True when the file is a copy in the clean library, not an original. */
  async function isCleanCopy(path: string): Promise<boolean> {
    const { cleanLibraryFolder } = folders()
    return cleanLibraryFolder !== null && (await fileOps.isInside(path, cleanLibraryFolder))
  }

  /**
   * After a crash the database may still name a file that was already renamed: the
   * new name is written down before the rename, the track after it. If the file is
   * not where the track says and exactly one file this batch created for the track
   * exists, that is the file.
   */
  async function reconcile(batchId: number, track: Track): Promise<Track> {
    if (await fileOps.exists(track.path)) return track
    const candidates: string[] = []
    for (const file of listCreatedFiles(db, batchId)) {
      if (file.trackId === track.id && (await fileOps.exists(file.path))) candidates.push(file.path)
    }
    const [found] = candidates
    if (candidates.length !== 1 || found === undefined) {
      throw new AppError('FILE_UNREADABLE', 'the file of the track is not where it was')
    }
    logger.warn(`Track ${track.id}: its file was found under the name an interrupted run gave it`)
    updateTrack(db, track.id, { path: found })
    return readTrack(track.id)
  }

  /** Saves the file as it is, before this batch changes it for the first time. */
  async function backUp(batchId: number, track: Track, signal: AbortSignal): Promise<void> {
    if (getBackup(db, batchId, track.id)) return
    const folder = needFolder(folders().backupFolder, 'backup')
    const backupPath = join(folder, String(batchId), `${track.id}${extname(track.path)}`)
    // A file without its record is from a run that stopped between the two. The
    // record comes before any change, so the file of the track is still untouched:
    // the copy is simply made again.
    await fileOps.remove(backupPath)
    await fileOps.copy(track.path, backupPath, signal)
    insertBackup(db, { batchId, trackId: track.id, originalPath: track.path, backupPath })
  }

  /** Makes the copy in the clean library that all the work happens on. */
  async function copyToCleanLibrary(
    batchId: number,
    track: Track,
    signal: AbortSignal
  ): Promise<string> {
    const { libraryRoot } = folders()
    const cleanFolder = needFolder(folders().cleanLibraryFolder, 'clean library')
    // The same place under the clean library as under the library.
    const inLibrary = libraryRoot !== null && (await fileOps.isInside(track.path, libraryRoot))
    const wanted = join(
      cleanFolder,
      inLibrary && libraryRoot !== null ? relative(libraryRoot, track.path) : basename(track.path)
    )

    // A copy this batch made already, by a run that stopped before the track was
    // told about it: nothing has changed it yet, so it is taken as it is.
    const size = await fileOps.sizeOf(track.path)
    for (const file of listCreatedFiles(db, batchId)) {
      if (file.trackId !== track.id || !(await fileOps.exists(file.path))) continue
      if ((await fileOps.sizeOf(file.path)) !== size) continue
      updateTrack(db, track.id, { path: file.path })
      return file.path
    }

    const { path } = await fileOps.freeName(wanted)
    recordCreatedFile(db, { batchId, trackId: track.id, path })
    await fileOps.copy(track.path, path, signal)
    updateTrack(db, track.id, { path })
    return path
  }

  /**
   * Makes sure the file may be changed, and returns where it is. In place: the
   * original is backed up first. Clean library: the work happens on a copy and the
   * original is never touched; a copy that an earlier batch made is backed up like
   * an original, so that this batch can be undone too.
   */
  async function prepare(
    batch: { id: number; mode: BatchMode },
    trackId: number,
    signal: AbortSignal
  ): Promise<string> {
    const track = await reconcile(batch.id, readTrack(trackId))
    if (batch.mode === 'clean_library' && !(await isCleanCopy(track.path))) {
      return copyToCleanLibrary(batch.id, track, signal)
    }
    const createdHere = listCreatedFiles(db, batch.id).some((file) => file.trackId === trackId)
    // A file this batch created itself needs no backup: undo deletes it.
    if (!createdHere) await backUp(batch.id, track, signal)
    return track.path
  }

  async function workingRoot(path: string): Promise<string> {
    const { libraryRoot, cleanLibraryFolder } = folders()
    for (const root of [cleanLibraryFolder, libraryRoot]) {
      if (root !== null && (await fileOps.isInside(path, root))) return root
    }
    throw new AppError('INVALID_INPUT', 'the file is in no folder of the library')
  }

  /** The tracks of a batch that the apply phase will write. */
  function writableTracks(batchId: number): Track[] {
    const mounted = listMountedVolumes()
    return listBatchItemStates(db, batchId)
      .filter((item) => item.approved && !item.excluded && !item.failed)
      .map((item) => getTrackById(db, item.trackId, mounted))
      .filter((track): track is Track => track !== undefined)
  }

  return {
    forTrack(batch, trackId, signal) {
      // One at a time: the stage of a track is the only one that works on its file.
      let prepared: Promise<string> | null = null
      const workingPath = (): Promise<string> => (prepared ??= prepare(batch, trackId, signal))

      return {
        workingPath,

        async move(to) {
          const from = await workingPath()
          const root = await workingRoot(from)
          if (!(await fileOps.isInside(to, root))) {
            throw new AppError('INVALID_INPUT', 'a file may only be moved inside its library')
          }
          const free = await fileOps.freeName(to, from)
          if (free.path === from) return { path: from, collided: false }
          // Written down first: if the app stops right after the rename, undo and the
          // next run still know about the new name.
          recordCreatedFile(db, { batchId: batch.id, trackId, path: free.path })
          await fileOps.move(from, free.path)
          updateTrack(db, trackId, { path: free.path })
          prepared = Promise.resolve(free.path)
          return free
        },

        async replaceContent(write) {
          await fileOps.replace(await workingPath(), write, signal)
        }
      }
    },

    async checkSpace(batchId) {
      const batch = getBatch(db, batchId)
      if (!batch) return { enough: true, neededBytes: 0, freeBytes: 0 }
      const { backupFolder, cleanLibraryFolder } = folders()

      // What still has to be copied, per folder it goes to.
      const needed = new Map<string, number>()
      const created = new Set(listCreatedFiles(db, batchId).map((file) => file.trackId))
      for (const track of writableTracks(batchId)) {
        // Mirrors `prepare`: a copy into the clean library, or a backup of the file
        // that is changed where it is.
        const copiesToClean = batch.mode === 'clean_library' && !(await isCleanCopy(track.path))
        // Done already by this batch, before it was interrupted.
        if (created.has(track.id) || getBackup(db, batchId, track.id)) continue
        const target = copiesToClean ? cleanLibraryFolder : backupFolder
        // Without the folder the apply phase fails for the track; nothing is copied.
        if (target === null) continue
        const size = track.fileSizeBytes ?? (await fileOps.sizeOf(track.path).catch(() => 0))
        needed.set(target, (needed.get(target) ?? 0) + size)
      }

      // Two folders on one volume share its room.
      const volumes = new Map<string, { neededBytes: number; freeBytes: number }>()
      for (const [folder, bytes] of needed) {
        const volume = await fileOps.volumeOf(folder)
        const known = volumes.get(volume)
        if (known) known.neededBytes += bytes
        else volumes.set(volume, { neededBytes: bytes, freeBytes: await fileOps.freeBytes(folder) })
      }

      // Reported for the volume with the least room to spare.
      let tightest = { neededBytes: 0, freeBytes: 0 }
      let leastSpare = Infinity
      for (const volume of volumes.values()) {
        const spare = volume.freeBytes - volume.neededBytes
        if (spare < leastSpare) {
          leastSpare = spare
          tightest = volume
        }
      }
      return {
        enough: volumes.size === 0 || leastSpare >= SPACE_MARGIN_BYTES,
        neededBytes: tightest.neededBytes,
        freeBytes: tightest.freeBytes
      }
    },

    lastUndoable: () => findLastWrittenBatch(db)?.id ?? null,

    async undoLast() {
      const batch = findLastWrittenBatch(db)
      if (!batch) return { ok: false, code: 'NOTHING_TO_UNDO' }
      const backups = listBackups(db, batch.id)
      const created = listCreatedFiles(db, batch.id)

      try {
        // Checked before anything changes: a backup that is gone cannot be put back,
        // and half an undo would be worse than none.
        for (const backup of backups) {
          if (!(await fileOps.exists(backup.backupPath))) {
            logger.error(`Undo of batch ${batch.id}: the backup of track ${backup.trackId} is gone`)
            return { ok: false, code: 'WRITE_FAILED' }
          }
        }

        for (const backup of backups) {
          await fileOps.restore(backup.backupPath, backup.originalPath)
        }

        let removed = 0
        for (const file of created) {
          // A file that only got another letter case is the original itself, now
          // restored: it must stay.
          let isRestored = false
          for (const backup of backups) {
            if (await fileOps.sameFile(file.path, backup.originalPath)) isRestored = true
          }
          if (isRestored) continue
          if (await fileOps.remove(file.path)) removed += 1
          await fileOps.removeEmptyFolder(dirname(file.path))
        }

        // Only the tracks whose file the batch touched: another track of the batch
        // may have changed since for reasons of its own, such as a rescan.
        const touched = new Set(
          [
            ...backups.map((backup) => backup.trackId),
            ...created.map((file) => file.trackId)
          ].filter((id): id is number => id !== null)
        )
        db.transaction((tx) => {
          for (const item of listBatchItemsBefore(tx, batch.id)) {
            if (touched.has(item.trackId)) restoreTrack(tx, item.trackId, item.before)
          }
          deleteCreatedFiles(tx, batch.id)
          setBatchStatus(tx, batch.id, 'undone')
        })
        logger.info(
          `Batch ${batch.id} undone: ${backups.length} files restored, ${removed} files removed`
        )
        return { ok: true, value: { batchId: batch.id, restored: backups.length, removed } }
      } catch (error) {
        // Whatever was put back stays put back, and undo can be asked for again: it
        // restores from the same backups.
        logger.error(`Undo of batch ${batch.id} stopped`, error)
        return { ok: false, code: error instanceof AppError ? error.code : 'WRITE_FAILED' }
      }
    },

    async pruneOlderBackups(keepBatchId) {
      let deleted = 0
      for (const backup of listBackupsOfOtherBatches(db, keepBatchId)) {
        try {
          await fileOps.remove(backup.backupPath)
          await fileOps.removeEmptyFolder(dirname(backup.backupPath))
          deleteBackup(db, backup.id)
          deleted += 1
        } catch (error) {
          // The record stays with its file, to be tried again after the next batch.
          logger.error(`The backup ${backup.id} of an older batch could not be deleted`, error)
        }
      }
      deleteCreatedFilesOfOtherBatches(db, keepBatchId)
      if (deleted > 0)
        logger.info(`Deleted ${deleted} backups of batches older than ${keepBatchId}`)
    },

    async removeTempFiles() {
      const { libraryRoot, cleanLibraryFolder, backupFolder } = folders()
      let removed = 0
      for (const folder of [libraryRoot, cleanLibraryFolder, backupFolder]) {
        if (folder === null) continue
        try {
          removed += await fileOps.removeTempFiles(folder)
        } catch (error) {
          logger.warn('A folder of the library could not be cleaned of temp files', error)
        }
      }
      if (removed > 0) logger.info(`Removed ${removed} temp files that an interrupted write left`)
      return removed
    }
  }
}
