// The rules for changing the files of a batch: what is saved before the first change,
// where the work happens in each mode, and how a batch is undone. The changes
// themselves are made by `services/file-ops.ts`.
import { basename, dirname, extname, join } from 'path'
import {
  deleteBackup,
  deleteCreatedFile,
  deleteCreatedFiles,
  getBackup,
  insertBackup,
  listBackups,
  listBackupsOfOlderBatches,
  listCreatedFiles,
  listCreatedFilesOfTrack,
  listOlderBatchesWithCreatedFiles,
  recordCreatedFile,
  type Backup
} from '../db/backups'
import {
  cancelPreviewBatches,
  findLastWrittenBatch,
  getBatch,
  getBatchItem,
  listBatchItemsBefore,
  listBatchItemStates,
  setBatchStatus,
  type BatchMode
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { listJobs } from '../db/jobs'
import { normalizeTrackPath } from '../db/track-paths'
import {
  findTrackIdByPath,
  findTrackIdsWithName,
  getTrackById,
  parseTrackSnapshot,
  pathOfSnapshot,
  restoreTrack,
  updateTrack,
  type Track,
  type TrackChanges,
  type TrackSnapshot
} from '../db/tracks'
import { describeError } from '../services/error-text'
import {
  isRespelling,
  MAX_NAME_ATTEMPTS,
  NAME_LIMIT,
  unusableNameReason,
  type FileOps
} from '../services/file-ops'
import { isSetAsidePath } from '@shared/duplicates'
import { extensionOf, UNSAFE_TEXT } from '@shared/file-names'
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
   * file is now. The name must be one a library file may have.
   */
  move: (to: string) => Promise<{ path: string; collided: boolean }>
  /**
   * Replaces the content of the file with what `write` puts into the temp file it
   * is given. `write` must stop when its signal is aborted.
   */
  replaceContent: (write: (tempPath: string, signal: AbortSignal) => Promise<void>) => Promise<void>
  /** Where the file that is worked on is now. Makes the backup or the copy first. */
  workingPath: () => Promise<string>
  /**
   * In the clean library: makes the copy the work happens on, if the track has none
   * there yet. The clean library holds every track a batch was approved for, also
   * one the batch has nothing to change about. In place: does nothing. `collided`
   * says that the copy was made just now and had to take ` (2)`, ` (3)`, …
   */
  ensureCleanCopy: () => Promise<{ collided: boolean }>
  /**
   * Whether giving the file this name, in the folder it is in, would change anything
   * on disk. Asked before `workingPath`: it makes no backup and no copy, so a track
   * that needs nothing costs nothing, and its batch does not count as one that wrote.
   * False when the file has the name already, also when it only has it with the
   * ` (2)` a collision gave it and the plain name is still taken. True in the clean
   * library for a track that has no copy there yet: the copy is a change. Throws
   * what `move` would throw for this name, and when the file is not there.
   */
  wouldMove: (fileName: string) => Promise<boolean>
  /**
   * Moves the file, under the name it has, into the named folder at the top of the
   * folder the work happens in: the library in place, the clean library otherwise.
   * A file that is in that folder already stays where it is. If the name is taken
   * there, the file gets ` (2)`, ` (3)`, …; `collided` says so. Nothing is deleted.
   * `keeperTrackId` names the track whose file stays in the library in its place:
   * unless that file is there, on disk and not set aside itself, nothing is moved.
   */
  setAside: (
    folderName: string,
    keeperTrackId: number
  ) => Promise<{ path: string; collided: boolean }>
  /**
   * Makes the file a file of another format, under its name with the new extension,
   * in the folder it is in. `write` reads `source` and puts the new content into the
   * temp file it is given; what it returns is recorded on the track with the new
   * path and format. The new file appears in one step and never in the place of
   * another. Only then is the old one removed: by then it is saved in its backup,
   * or is a copy in the clean library whose original stays in the library. At no
   * point does a file hold content its name does not say. Done already when the
   * file has the extension; then only an old file that a stopped run left is removed.
   */
  convertTo: (
    target: { extension: string; format: Track['format'] },
    write: (source: string, tempPath: string, signal: AbortSignal) => Promise<TrackChanges | void>
  ) => Promise<{ path: string; collided: boolean }>
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
  /**
   * The places where a file of the last batch that wrote stands again as it was
   * before the batch, byte for byte, while its track still points elsewhere: put
   * back by an undo that stopped half way, or by the user. Such a file is the
   * track's original, not a new track; undo finds it there and finishes.
   */
  restoredOriginals: () => Promise<ReadonlySet<string>>
  /** Puts the files and the tracks of the last batch that wrote back to what they were. */
  undoLast: () => Promise<Result<UndoSummary>>
  /**
   * Once a batch that wrote files is applied, the backups of the batches before it
   * are deleted. Does nothing for a batch that wrote no file: the last batch that
   * did must stay undoable.
   */
  pruneOlderBackups: (keepBatchId: number) => Promise<void>
  /** Deletes what interrupted writes left in the folders of the library. */
  removeTempFiles: () => Promise<number>
  /**
   * After a start: tells the tracks of the last batch that wrote where their files
   * are, where the app stopped between giving a file its new name and writing that
   * down. Returns how many tracks were put right. Called before the library is
   * scanned: a scan would take such a file for a new track, and its track for missing.
   */
  reconcileInterrupted: () => Promise<number>
  /**
   * True while work on files is going on: a stage's step, cancelled or not, an undo,
   * or the deletion of older backups.
   */
  busy: () => boolean
  /** True while an undo is under way. Quitting waits for it, however long it takes. */
  undoing: () => boolean
  /** Resolves when no work on a file is going on; at once if there is none. */
  settled: () => Promise<void>
}

/**
 * A path as two names are compared that a drive may take for one: in one Unicode
 * form and one letter case, the way `findTrackIdsWithName` folds a name.
 */
function foldedName(path: string): string {
  return normalizeTrackPath(path).normalize('NFKC').toUpperCase().toLowerCase()
}

/** Lets pieces of work that must not overlap take turns. */
function createLock(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return (work) => {
    const run = last.then(work, work)
    last = run.catch(() => {})
    return run
  }
}

/** What undo will do for one track, decided before anything is changed. */
interface UndoPlan {
  trackId: number
  snapshot: TrackSnapshot
  /** The backup to put back, or null for a track the batch only made a copy of. */
  backup: Backup | null
  /** Where the track's file is now, as the database says. */
  currentPath: string
  /** Where the track's file will be after the undo. */
  restoredPath: string
}

export function createBatchFiles(dependencies: BatchFilesDependencies): BatchFiles {
  const { db, fileOps, folders, listMountedVolumes } = dependencies

  // Picking a free name and taking it are two steps: two tracks that want the same
  // name must not both see it free. Every name is taken under this lock.
  const withNames = createLock()
  // The names files are being written for right now, by the track each is for: a
  // conversion takes its name first and writes for a minute, and no other track may
  // take the name meanwhile. Kept by the name as a drive that ignores letter case
  // would compare it.
  const reserved = new Map<string, number>()
  // The stages of one track take turns at its file.
  const trackLocks = new Map<number, ReturnType<typeof createLock>>()
  // Work on files that has started and not ended, also for a stage nobody waits for
  // any more: a cancelled stage may still be in the middle of a copy.
  let inFlight = 0
  let settledWaiters: (() => void)[] = []
  // An undo that has started and not ended. It puts many files back and writes all
  // of that down in one step at its end, so it is never to be cut short.
  let undoing = 0
  /** Counts a piece of work on files from its start to its end, however it ends. */
  const counted = <T>(work: () => Promise<T>): Promise<T> => {
    inFlight += 1
    // Started inside the chain, so that work which throws at once is counted out too.
    return Promise.resolve()
      .then(work)
      .finally(() => {
        inFlight -= 1
        if (inFlight > 0) return
        const waiters = settledWaiters
        settledWaiters = []
        for (const done of waiters) done()
      })
  }
  const withTrack = <T>(trackId: number, work: () => Promise<T>): Promise<T> => {
    const lock = trackLocks.get(trackId) ?? createLock()
    trackLocks.set(trackId, lock)
    return counted(() => lock(work))
  }

  function readTrack(trackId: number): Track {
    const track = getTrackById(db, trackId, listMountedVolumes())
    if (!track) throw new AppError('FILE_UNREADABLE', 'the track is not in the library any more')
    return track
  }

  /** The track whose file stays when another is set aside, if it is still in the library. */
  function readKept(trackId: number): Track | undefined {
    const track = getTrackById(db, trackId, listMountedVolumes())
    return track && !isSetAsidePath(track.path) ? track : undefined
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

  /** True when the path is in the library or in its clean copy, where tracks live. */
  async function isTrackPlace(path: string): Promise<boolean> {
    const { libraryRoot, cleanLibraryFolder, backupFolder } = folders()
    if (backupFolder !== null && (await fileOps.isInside(path, backupFolder))) return false
    for (const root of [libraryRoot, cleanLibraryFolder]) {
      if (root !== null && (await fileOps.isInside(path, root))) return true
    }
    return false
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
    for (const file of listCreatedFilesOfTrack(db, batchId, track.id)) {
      // The journal is not taken at its word: only a plain file, where tracks live,
      // that no other track has under any spelling, can be this track's file.
      if (!(await fileOps.isRegularFile(file.path))) continue
      if (!(await isTrackPlace(file.path))) continue
      if (ownedByAnother(file.path, track.id)) continue
      // A rename keeps the size of a file. One of another size under the noted name
      // is another file, put there since.
      if (
        track.fileSizeBytes !== null &&
        (await fileOps.sizeOf(file.path)) !== track.fileSizeBytes
      ) {
        continue
      }
      candidates.push(file.path)
    }
    const [found] = candidates
    if (candidates.length !== 1 || found === undefined) {
      throw new AppError('FILE_UNREADABLE', 'the file of the track is not where it was')
    }
    updateTrack(db, track.id, { path: found })
    logger.warn(`Track ${track.id}: its file was found under the name an interrupted run gave it`)
    return readTrack(track.id)
  }

  /**
   * Saves the file as it is, before this batch changes it for the first time. A
   * backup that was made stays until the batch is undone or a later batch is applied,
   * also when the change it was made for fails: nothing here decides that a file is
   * "still as it was" and takes its backup away. A backup too many costs an undo of
   * the batch before; a backup too few cannot be made good.
   */
  async function backUp(batchId: number, track: Track, signal: AbortSignal): Promise<void> {
    const recorded = getBackup(db, batchId, track.id)
    if (recorded) {
      // The file may have been changed since: without its backup it must not be
      // changed any further.
      if (!(await fileOps.exists(recorded.backupPath))) {
        throw new AppError('WRITE_FAILED', 'the backup of the track is gone')
      }
      return
    }
    const folder = needFolder(folders().backupFolder, 'backup')
    await fileOps.createRoot(folder)
    // A file that is there without a record is from a run that stopped between the
    // two, or from another database: it is left alone, and the copy is made again
    // beside it. The record comes before any change, so the track is still untouched.
    const { path: backupPath } = await fileOps.freeName(
      join(folder, String(batchId), `${track.id}${extname(track.path)}`)
    )
    await fileOps.copy(track.path, backupPath, signal)
    insertBackup(db, { batchId, trackId: track.id, originalPath: track.path, backupPath })
  }

  /** Makes the copy in the clean library that all the work happens on. */
  async function copyToCleanLibrary(
    batchId: number,
    track: Track,
    signal: AbortSignal,
    onCollision: () => void
  ): Promise<string> {
    const { libraryRoot } = folders()
    const cleanFolder = needFolder(folders().cleanLibraryFolder, 'clean library')
    await fileOps.createRoot(cleanFolder)
    // The same place under the clean library as under the library. Found by what
    // the folders are on disk: the root and the track may be spelled differently.
    const inLibrary =
      libraryRoot === null ? null : await fileOps.relativeTo(libraryRoot, track.path)
    const wanted = join(cleanFolder, inLibrary ?? basename(track.path))
    if (!(await fileOps.isInside(wanted, cleanFolder))) {
      throw new AppError('WRITE_FAILED', 'the copy of a track would land outside the clean library')
    }

    // A copy this batch made already, by a run that stopped before the track was
    // told about it: nothing has changed it yet, so it is taken as it is.
    const size = await fileOps.sizeOf(track.path)
    for (const file of listCreatedFilesOfTrack(db, batchId, track.id)) {
      if (!(await fileOps.exists(file.path))) continue
      if ((await fileOps.sizeOf(file.path)) !== size) continue
      updateTrack(db, track.id, { path: file.path })
      return file.path
    }

    return withNames(async () => {
      // Named as a track's path is stored: the folders of the library may be spelled
      // decomposed on disk, and undo finds the copy by comparing the two.
      // Also not a name another track is writing its file for right now.
      const free = await freeNameFor(wanted, track.path, track.id)
      const path = normalizeTrackPath(free.path)
      if (free.collided) onCollision()
      recordCreatedFile(db, { batchId, trackId: track.id, path })
      try {
        await fileOps.copy(track.path, path, signal)
      } catch (error) {
        // Not created after all: undo must not take a file at this path for ours.
        deleteCreatedFile(db, batchId, path, track.id)
        throw error
      }
      updateTrack(db, track.id, { path })
      return path
    })
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
    signal: AbortSignal,
    onCopyCollision: () => void
  ): Promise<string> {
    const track = await reconcile(batch.id, readTrack(trackId))
    if (batch.mode === 'clean_library' && !(await isCleanCopy(track.path))) {
      return copyToCleanLibrary(batch.id, track, signal, onCopyCollision)
    }
    // A file this batch created itself needs no backup: undo deletes it. Unless the
    // batch backed the track up before it renamed it, which is then checked again.
    const createdHere = listCreatedFilesOfTrack(db, batch.id, trackId).length > 0
    if (!createdHere || getBackup(db, batch.id, trackId)) await backUp(batch.id, track, signal)
    return track.path
  }

  /** True when another track has this name, in any letter case or Unicode form. */
  function ownedByAnother(path: string, trackId: number): boolean {
    return findTrackIdsWithName(db, path).some((owner) => owner !== trackId)
  }

  /**
   * The name a file gets at `to`: that name, or the next one with ` (2)`, ` (3)`, …
   * Among what was set aside, a name that another track still has counts as taken
   * too. The user empties that folder by hand, and the rows of the files that were
   * deleted there keep their paths: without this the next copy of the same name
   * could never be moved or named there.
   */
  async function freeNameFor(
    to: string,
    from: string,
    trackId: number
  ): Promise<{ path: string; collided: boolean }> {
    const aside = isSetAsidePath(to)
    const extension = extname(to)
    const stem = to.slice(0, to.length - extension.length)
    for (let number = 1; number <= MAX_NAME_ATTEMPTS; number += 1) {
      const candidate = number === 1 ? to : `${stem} (${number})${extension}`
      if (candidate === from) return { path: from, collided: number > 1 }
      // A name the file system would refuse is not free, whatever the disk says.
      if (basename(candidate).length > NAME_LIMIT) continue
      // The file itself under another letter case is no other file; a second name
      // for it (a hard link) is one, and stays.
      const own = isRespelling(candidate, from) && (await fileOps.sameFile(candidate, from))
      if (!own && (await fileOps.exists(candidate))) continue
      // A name another track is writing its file for right now is taken, though
      // nothing stands there yet.
      const reservedBy = reserved.get(foldedName(candidate))
      if (reservedBy !== undefined && reservedBy !== trackId) continue
      if (aside && ownedByAnother(candidate, trackId)) continue
      return { path: candidate, collided: number > 1 }
    }
    throw new AppError('WRITE_FAILED', 'no name is free for the file')
  }

  /**
   * Throws when something other than a folder stands where what is set aside goes:
   * a link would send the file to another place than the database writes down, and
   * a file there cannot hold one.
   */
  async function assertFolderOrNone(folder: string): Promise<void> {
    if ((await fileOps.exists(folder)) && !(await fileOps.isFolder(folder))) {
      throw new AppError('WRITE_FAILED', 'the place for what is set aside is not a folder')
    }
  }

  async function workingRoot(path: string): Promise<string> {
    const { libraryRoot, cleanLibraryFolder } = folders()
    for (const root of [cleanLibraryFolder, libraryRoot]) {
      if (root !== null && (await fileOps.isInside(path, root))) return root
    }
    throw new AppError('INVALID_INPUT', 'the file is in no folder of the library')
  }

  /**
   * Throws unless moving the file at `from` to `to` stays inside the library and
   * every part of the path the move brings in is a name it may have.
   *
   * - The file name, and a folder that does not exist yet, are new names: the rule
   *   for new names applies to them as they were asked for.
   * - A folder the file is in already keeps the name it has, whatever that rule says
   *   of it (`R.E.M.`, a name stored decomposed). A file in it can be renamed.
   * - Another folder that exists may be named as it is, but not be hidden or hold an
   *   invisible character: a file moved into `.Trashes` would be gone from every scan.
   *
   * A file that already has the wanted name under another spelling is a name that is
   * taken, not a name that is wrong: that is for `freeName` to deal with.
   */
  async function assertUsableTarget(root: string, to: string, from: string): Promise<void> {
    if ((await fileOps.relativeTo(root, to)) === null) {
      throw new AppError('INVALID_INPUT', 'a file may only be moved inside its library')
    }
    const refuse = (reason: string): never => {
      throw new AppError('INVALID_INPUT', `a name is not usable: ${reason}`)
    }
    const fileReason = unusableNameReason(basename(to), 'file')
    if (fileReason !== null) refuse(fileReason)
    for (let folder = dirname(to); ; folder = dirname(folder)) {
      // Up to the root of the library, whose name is not the app's to judge.
      if (dirname(folder) === folder || (await fileOps.relativeTo(root, folder)) === null) break
      const name = basename(folder)
      if (!(await fileOps.exists(folder))) {
        const folderReason = unusableNameReason(name, 'folder')
        if (folderReason !== null) refuse(folderReason)
        continue
      }
      // The file is in this folder, and so in every folder above it.
      if (await fileOps.isInside(from, folder)) break
      if (name.startsWith('.')) refuse('it would put the file into a hidden folder')
      if (UNSAFE_TEXT.test(name)) refuse('a folder on the way holds an invisible character')
    }
  }

  /**
   * Removes the folders a deleted file leaves empty, from its own upward. Stops at
   * the first one that holds anything; the folders of the library themselves stay.
   */
  async function removeEmptyFoldersAbove(path: string): Promise<void> {
    let folder = dirname(path)
    for (let depth = 0; depth < 64; depth += 1) {
      await fileOps.removeEmptyFolder(folder)
      if (await fileOps.exists(folder)) return
      folder = dirname(folder)
    }
  }

  /** The tracks of a batch that the apply phase will write. */
  function writableTracks(batchId: number): Track[] {
    const mounted = listMountedVolumes()
    return listBatchItemStates(db, batchId)
      .filter((item) => item.approved && !item.excluded && !item.failed)
      .map((item) => getTrackById(db, item.trackId, mounted))
      .filter((track): track is Track => track !== undefined)
  }

  /**
   * Works out what undo has to do, and checks all of it, before anything changes.
   * Returns null when the records of the batch cannot be trusted or acted on.
   */
  async function planUndo(batchId: number): Promise<UndoPlan[] | null> {
    const { backupFolder } = folders()
    const mode = getBatch(db, batchId)?.mode
    const backups = new Map<number, Backup>()
    for (const backup of listBackups(db, batchId)) {
      if (backup.trackId !== null) backups.set(backup.trackId, backup)
    }
    const touched = new Set<number>(backups.keys())
    for (const file of listCreatedFiles(db, batchId)) {
      if (file.trackId !== null) touched.add(file.trackId)
    }

    const refuse = (why: string): null => {
      logger.error(`Undo of batch ${batchId} refused: ${why}`)
      return null
    }
    const found: (Omit<UndoPlan, 'restoredPath'> & { wanted: string })[] = []
    for (const item of listBatchItemsBefore(db, batchId)) {
      // Only the tracks whose file the batch touched: another track of the batch
      // may have changed since for reasons of its own, such as a rescan.
      if (!touched.has(item.trackId)) continue
      const snapshot = parseTrackSnapshot(item.before)
      const snapshotPath = pathOfSnapshot(item.before)
      if (snapshot === null || snapshotPath === null) {
        return refuse(`the record of track ${item.trackId} is not readable`)
      }
      const track = getTrackById(db, item.trackId, listMountedVolumes())
      if (!track) return refuse(`track ${item.trackId} is not in the library any more`)
      // A file that was renamed just before the app stopped is found again first.
      const current = await reconcile(batchId, track).catch(() => track)

      const backup = backups.get(item.trackId) ?? null
      if (backup !== null) {
        // The records say what to copy over what: neither may point anywhere but
        // from the backup folder into the library.
        const fromBackups =
          backupFolder !== null && (await fileOps.isInside(backup.backupPath, backupFolder))
        if (!fromBackups) return refuse(`the backup of track ${item.trackId} is not a backup`)
        if (!(await fileOps.exists(backup.backupPath))) {
          return refuse(`the backup of track ${item.trackId} is gone`)
        }
      }
      // Where the file was before the batch: the place it was backed up from, or,
      // for a track the batch only copied, where the record of the batch says.
      const wanted = backup?.originalPath ?? snapshotPath
      if (!(await isTrackPlace(wanted))) {
        return refuse(`the old place of track ${item.trackId} is outside the library`)
      }
      if (backup === null) {
        // Without a backup the file the batch left is deleted and nothing is put
        // back: right only for the copy a clean library batch made of an original.
        // In place it means the backup record is gone, and the file is the only one.
        if (mode !== 'clean_library') {
          return refuse(`track ${item.trackId} was changed in place and has no backup`)
        }
        // The original must still be there: if the user has removed it since, the
        // copy is the last one, and it stays, with its track.
        const originalThere =
          (await fileOps.exists(wanted)) && !(await fileOps.sameFile(wanted, current.path))
        if (!originalThere) {
          logger.warn(`Undo of batch ${batchId}: track ${item.trackId} keeps its copy`)
          continue
        }
      }
      found.push({ trackId: item.trackId, snapshot, backup, currentPath: current.path, wanted })
    }

    // The files this undo deletes anyway: under a name the batch gave them, with the
    // original safe in its backup and due back somewhere else. Their names are free
    // for another track of the batch, as when two tracks swapped names.
    const leaving = new Map<string, number>()
    for (const each of found) {
      if (each.backup === null || each.currentPath === each.wanted) continue
      if (await fileOps.sameFile(each.currentPath, each.wanted)) continue
      const created = listCreatedFilesOfTrack(db, batchId, each.trackId)
      if (created.some((file) => file.path === each.currentPath)) {
        leaving.set(each.currentPath, each.trackId)
      }
    }

    const given = new Set<string>()
    /** True when restoring a track's file to the path would take something away. */
    const taken = async (
      path: string,
      plan: { trackId: number; currentPath: string }
    ): Promise<boolean> => {
      if (given.has(path)) return true
      const backupPath = backups.get(plan.trackId)?.backupPath
      /** True when the file at the path holds what the backup holds: nothing is lost by writing the backup over it. */
      const holdsTheBackup = async (): Promise<boolean> =>
        backupPath !== undefined && (await fileOps.sameContent(path, backupPath))
      const owner = findTrackIdByPath(db, path)
      if (owner === plan.trackId) {
        // The track's own path, and so its own file, unless the batch moved the file
        // away from here: then whatever told the track it is here again (a scan
        // that found a file at the old place) is not taken at its word. Only a file
        // that holds what the backup holds is the track's; any other is somebody
        // else's, however alike in size, and is not written over.
        const created = listCreatedFilesOfTrack(db, batchId, plan.trackId)
        if (created.length === 0 || created.some((file) => file.path === path)) return false
        if (backupPath === undefined || !(await fileOps.exists(path))) return false
        return !(await holdsTheBackup())
      }
      if (leaving.has(path)) return false
      // Another track has the path, whether its file is there or not, and in
      // whatever letter case or Unicode form its row spells it.
      if (ownedByAnother(path, plan.trackId)) return true
      if (!(await fileOps.exists(path))) return false
      // The track's own file, changed where it was or renamed only in letter case.
      if (await fileOps.sameFile(path, plan.currentPath)) return false
      // Or put back already, by an undo that stopped before it could say so or by
      // the user: the file holds what the backup holds, byte for byte.
      return !(await holdsTheBackup())
    }

    const plans: UndoPlan[] = []
    for (const { wanted, ...plan } of found) {
      let restoredPath = wanted
      // A file is only ever put where nothing is lost by it: at its old path, or
      // under the next free name beside it.
      if (plan.backup !== null && (await taken(wanted, plan))) {
        const extension = extname(wanted)
        const stem = wanted.slice(0, wanted.length - extension.length)
        let number = 2
        restoredPath = `${stem} (${number})${extension}`
        while (await taken(restoredPath, plan)) {
          number += 1
          if (number > 999) return refuse(`no free name for the file of track ${plan.trackId}`)
          restoredPath = `${stem} (${number})${extension}`
        }
      }
      given.add(restoredPath)
      plans.push({ ...plan, restoredPath })
    }
    return plans
  }

  /** Puts the files and the tracks of the last batch that wrote back to what they were. */
  async function undoLastBatch(): Promise<Result<UndoSummary>> {
    const batch = findLastWrittenBatch(db)
    if (!batch) return { ok: false, code: 'NOTHING_TO_UNDO' }

    try {
      // Everything is decided and checked before the first file changes: half an
      // undo would be worse than none.
      const plans = await planUndo(batch.id)
      if (plans === null) return { ok: false, code: 'WRITE_FAILED' }

      let restored = 0
      let removed = 0
      const createdBy = (trackId: number): string[] =>
        listCreatedFilesOfTrack(db, batch.id, trackId).map((file) => file.path)
      // First the files whose name another track of the batch gets back: restoring
      // onto them and deleting them afterwards would delete what was restored.
      const targets = new Set(plans.map((plan) => plan.restoredPath))
      const gone = new Set<number>()
      for (const plan of plans) {
        if (plan.backup === null || plan.currentPath === plan.restoredPath) continue
        if (!targets.has(plan.currentPath)) continue
        if (!createdBy(plan.trackId).includes(plan.currentPath)) continue
        if (await fileOps.remove(plan.currentPath)) removed += 1
        gone.add(plan.trackId)
      }
      for (const plan of plans) {
        if (plan.backup !== null) {
          await fileOps.restore(plan.backup.backupPath, plan.restoredPath)
          restored += 1
        }
        if (plan.currentPath === plan.restoredPath || gone.has(plan.trackId)) continue
        if (await fileOps.sameFile(plan.currentPath, plan.restoredPath)) {
          // Renamed only in letter case: the restored file is that file, and it
          // gets its old spelling back.
          await fileOps.move(plan.currentPath, plan.restoredPath)
          continue
        }
        // The file the batch left behind: a copy in the clean library, or the file
        // under its new name. Only what the batch wrote down as its own is deleted.
        const created = createdBy(plan.trackId)
        if (!created.includes(plan.currentPath)) continue
        if (await fileOps.remove(plan.currentPath)) removed += 1
        // Every folder the file passed through on its way, if it is empty now.
        for (const path of created) await removeEmptyFoldersAbove(path)
      }

      db.transaction((tx) => {
        // First out of each other's way: one track of the batch may get back the
        // path another one has now, and a path belongs to one track at a time.
        for (const plan of plans) {
          updateTrack(tx, plan.trackId, { path: `/.fixlib-undo/${batch.id}/${plan.trackId}` })
        }
        for (const plan of plans) {
          restoreTrack(tx, plan.trackId, plan.snapshot, plan.restoredPath)
        }
        deleteCreatedFiles(tx, batch.id)
        setBatchStatus(tx, batch.id, 'undone')
        for (const plan of plans) if (plan.backup !== null) deleteBackup(tx, plan.backup.id)
        // What a batch proposed for the files as they were is of no use for the
        // files as they are again.
        cancelPreviewBatches(tx)
      })
      // The originals are back in place: their backups have done their job. One
      // that cannot be deleted is only a file that stays in the backup folder.
      for (const plan of plans) {
        if (plan.backup === null) continue
        try {
          await fileOps.remove(plan.backup.backupPath)
          await fileOps.removeEmptyFolder(dirname(plan.backup.backupPath))
        } catch (error) {
          logger.warn(`A used backup could not be deleted: ${describeError(error)}`)
        }
      }
      logger.info(`Batch ${batch.id} undone: ${restored} files restored, ${removed} files removed`)
      return { ok: true, value: { batchId: batch.id, restored, removed } }
    } catch (error) {
      // Whatever was put back stays put back, and undo can be asked for again: it
      // restores from the same backups.
      logger.error(`Undo of batch ${batch.id} stopped: ${describeError(error)}`)
      return { ok: false, code: error instanceof AppError ? error.code : 'WRITE_FAILED' }
    }
  }

  /** Deletes the backups and the notes of the batches before this one, once it has written. */
  async function pruneBackupsOlderThan(keepBatchId: number): Promise<void> {
    // A batch that wrote nothing leaves nothing to go back to: the last batch
    // that did write keeps its backups, and stays the one that undo undoes.
    if (findLastWrittenBatch(db)?.id !== keepBatchId) return

    let deleted = 0
    const failed = new Set<number>()
    const { backupFolder } = folders()
    for (const backup of listBackupsOfOlderBatches(db, keepBatchId)) {
      try {
        // A record is no licence to delete anywhere: only a file in the backup
        // folder is a backup.
        const isBackup =
          backupFolder !== null && (await fileOps.isInside(backup.backupPath, backupFolder))
        if (!isBackup) throw new AppError('INVALID_INPUT', 'the record names no backup')
        await fileOps.remove(backup.backupPath)
        await fileOps.removeEmptyFolder(dirname(backup.backupPath))
        deleteBackup(db, backup.id)
        deleted += 1
      } catch (error) {
        // The record stays with its file, to be tried again after the next batch.
        failed.add(backup.batchId)
        logger.error(
          `The backup ${backup.id} of an older batch could not be deleted: ${describeError(error)}`
        )
      }
    }
    // A batch keeps the notes about its files for as long as it keeps a backup.
    for (const batchId of listOlderBatchesWithCreatedFiles(db, keepBatchId)) {
      if (!failed.has(batchId)) deleteCreatedFiles(db, batchId)
    }
    if (deleted > 0) logger.info(`Deleted ${deleted} backups of batches older than ${keepBatchId}`)
  }

  return {
    forTrack(batch, trackId, signal) {
      let prepared: Promise<string> | null = null
      // True when the copy in the clean library could not get the name of its original.
      let copyCollided = false
      const prepareNow = (): Promise<string> =>
        prepare(batch, trackId, signal, () => {
          copyCollided = true
        })
      const working = async (): Promise<string> => {
        const path = await (prepared ??= prepareNow())
        // Two stages of a batch may work on one track, each with its own view of it:
        // the other may have moved the file since this one asked. Asked again then,
        // which finds the backup or the copy that is there and makes no second one.
        if (readTrack(trackId).path === path) return path
        prepared = prepareNow()
        return prepared
      }

      return {
        workingPath: () => withTrack(trackId, working),

        ensureCleanCopy: () =>
          withTrack(trackId, async () => {
            if (batch.mode !== 'clean_library') return { collided: false }
            const track = await reconcile(batch.id, readTrack(trackId))
            if (!(await isCleanCopy(track.path))) await working()
            return { collided: copyCollided }
          }),

        wouldMove: (fileName) =>
          withTrack(trackId, async () => {
            // A name, never a path: the file stays in the folder it is in. Checked
            // first of all, so that no answer is ever given about another place.
            if (unusableNameReason(fileName, 'file') !== null) {
              throw new AppError('INVALID_INPUT', 'the name cannot be given to a file')
            }
            // The file as it is now, without the backup or the copy `working` makes.
            const track = await reconcile(batch.id, readTrack(trackId))
            if (!(await fileOps.exists(track.path))) {
              throw new AppError('FILE_UNREADABLE', 'the file of the track is not where it was')
            }
            // The clean library holds every track a batch was approved for: one
            // that has no copy there yet gets it, whatever its name.
            if (batch.mode === 'clean_library' && !(await isCleanCopy(track.path))) return true
            const to = join(dirname(track.path), fileName)
            await assertUsableTarget(await workingRoot(track.path), to, track.path)
            const free = await freeNameFor(to, track.path, trackId)
            if (free.path === track.path) return false
            if (ownedByAnother(free.path, trackId)) {
              throw new AppError('WRITE_FAILED', 'the new name belongs to another track')
            }
            return true
          }),

        move: (to) =>
          withTrack(trackId, async () => {
            const from = await working()
            await assertUsableTarget(await workingRoot(from), to, from)
            return moveTo(from, to)
          }),

        setAside: (folderName, keeperTrackId) =>
          withTrack(trackId, async () => {
            // A name, never a path: the folder is always right under the root.
            if (unusableNameReason(folderName, 'folder') !== null) {
              throw new AppError('INVALID_INPUT', 'the name cannot be given to a folder')
            }
            // Looked at on the disk, and now: what is set aside leaves the library,
            // so the copy it gives way to must be a file that is in it.
            const keeperThere = async (): Promise<boolean> => {
              const keeper = keeperTrackId === trackId ? undefined : readKept(keeperTrackId)
              return keeper !== undefined && (await fileOps.isRegularFile(keeper.path))
            }
            // Asked a second time while no file is being renamed: the copy that is
            // kept may be getting its new name this very moment, which is no absence.
            if (!(await keeperThere()) && !(await withNames(keeperThere))) {
              throw new AppError('FILE_UNREADABLE', 'the copy that was to be kept is not there')
            }
            // Before the file is asked for, which makes its backup or its copy: a
            // track that is not moved after all must not cost one, nor make its batch
            // the one that undo undoes.
            const track = await reconcile(batch.id, readTrack(trackId))
            const aside = join(
              batch.mode === 'clean_library'
                ? needFolder(folders().cleanLibraryFolder, 'clean library')
                : await workingRoot(track.path),
              folderName
            )
            await assertFolderOrNone(aside)
            // And whether the file can be named there at all: a name the rule for
            // new names refuses, or no name left to take.
            if (unusableNameReason(basename(track.path), 'file') !== null) {
              throw new AppError('INVALID_INPUT', 'the file has a name that cannot be given anew')
            }
            await freeNameFor(join(aside, basename(track.path)), track.path, trackId)
            const from = await working()
            const root = await workingRoot(from)
            const folder = join(root, folderName)
            await assertFolderOrNone(folder)
            // Set aside already, by a run that was stopped after it: once is enough.
            if (await fileOps.isInside(from, folder)) return { path: from, collided: false }
            const to = join(folder, basename(from))
            await assertUsableTarget(root, to, from)
            return moveTo(from, to)
          }),

        convertTo: (target, write) =>
          withTrack(trackId, async () => {
            if (unusableNameReason(`name${target.extension}`, 'file') !== null) {
              throw new AppError('INVALID_INPUT', 'not an extension of a library file')
            }
            // Before the file is asked for, which makes its backup or its copy: a
            // track that is what it is to become already costs neither.
            const track = await reconcile(batch.id, readTrack(trackId))
            if (extensionOf(track.path) === target.extension) {
              await removeConverted(track.path)
              return { path: track.path, collided: false }
            }
            const from = await working()
            // The old file goes once the new one is there, so every byte of it must
            // be somewhere else, now and when it goes: the same bytes in its backup,
            // or, for a copy in the clean library, in the original it was made of.
            const heldElsewhere = await elsewhereOf(from)
            if (!(await heldElsewhere())) {
              throw new AppError('WRITE_FAILED', 'the file is not saved anywhere else as it is')
            }
            const stem = from.slice(0, from.length - extname(from).length)
            const to = `${stem}${target.extension}`
            await assertUsableTarget(await workingRoot(from), to, from)
            // The name is taken under the lock, written down, and kept from every
            // other track until the file is there; the writing itself, which may
            // take a minute, holds up no other file.
            const free = await withNames(async () => {
              const name = await freeNameFor(to, from, trackId)
              if (ownedByAnother(name.path, trackId)) {
                throw new AppError('WRITE_FAILED', 'the new name belongs to another track')
              }
              if (signal.aborted) throw new AppError('WRITE_FAILED', 'the change was stopped')
              recordCreatedFile(db, { batchId: batch.id, trackId, path: name.path })
              reserved.set(foldedName(name.path), trackId)
              return name
            })
            let changes: TrackChanges = {}
            try {
              await fileOps.create(
                free.path,
                async (temp, stop) => {
                  changes = (await write(from, temp, stop)) ?? {}
                  // What was converted is what will be removed: a file that was
                  // changed meanwhile would lose that change, so nothing is put in
                  // place and the file stays.
                  if (!(await heldElsewhere())) {
                    throw new AppError('WRITE_FAILED', 'the file changed while it was converted')
                  }
                },
                signal,
                // On a drive without hard links giving a name is two steps, and
                // two files that are given one name must take turns at them.
                withNames
              )
            } catch (error) {
              // Not created after all: undo must not take a file at this path for
              // ours. Only this track's own note: the name may be another's by now.
              deleteCreatedFile(db, batch.id, free.path, trackId)
              throw error
            } finally {
              reserved.delete(foldedName(free.path))
            }
            updateTrack(db, trackId, {
              ...changes,
              path: free.path,
              format: target.format,
              // The size a later step knows the file by, should the app stop in it.
              fileSizeBytes: await fileOps.sizeOf(free.path)
            })
            prepared = Promise.resolve(free.path)
            // Both files are there now, each what its name says. The old one goes
            // last, and only if it is still what was converted: asked at this very
            // moment, because syncing a large file to a slow drive took a while. One
            // that was changed meanwhile stays beside the new file, with its change.
            if (await heldElsewhere()) await fileOps.remove(from)
            else logger.warn(`Track ${trackId}: its old file changed and stays beside the new one`)
            return free
          }),

        replaceContent: (write) =>
          withTrack(trackId, async () => fileOps.replace(await working(), write, signal))
      }

      /**
       * Removes the file a conversion of this track left behind when it was stopped
       * between putting the new file in place and removing the old one: the file at
       * the place the batch backed the track up from, or a copy this batch made
       * and converted. Under the very condition a conversion removes it under:
       * every byte of it is in another file.
       */
      async function removeConverted(current: string): Promise<void> {
        const now = normalizeTrackPath(current)
        const backup = getBackup(db, batch.id, trackId)
        const old =
          backup !== undefined
            ? [backup.originalPath]
            : listCreatedFilesOfTrack(db, batch.id, trackId).map((file) => file.path)
        for (const path of old) {
          // Another file of this very track, of the format it had before.
          if (path === now || extensionOf(path) === extensionOf(now)) continue
          if (ownedByAnother(path, trackId) || !(await fileOps.isRegularFile(path))) continue
          const heldElsewhere = await elsewhereOf(path)
          if (await heldElsewhere()) await fileOps.remove(path)
        }
      }

      /**
       * A question that can be asked again and again: whether every byte of the
       * file at `path` is in another file as well. That other file is the backup
       * this batch made of it, which must be a file in the backup folder, or, for
       * a copy this batch made in the clean library, the original the batch found
       * the track at.
       */
      async function elsewhereOf(path: string): Promise<() => Promise<boolean>> {
        const backup = getBackup(db, batch.id, trackId)
        if (backup !== undefined) {
          const { backupFolder } = folders()
          const inBackups =
            backupFolder !== null && (await fileOps.isInside(backup.backupPath, backupFolder))
          return async () => inBackups && (await fileOps.sameContent(path, backup.backupPath))
        }
        const copied = listCreatedFilesOfTrack(db, batch.id, trackId).some(
          (file) => file.path === normalizeTrackPath(path)
        )
        const original = pathOfSnapshot(getBatchItem(db, batch.id, trackId)?.before)
        return async () =>
          copied &&
          original !== null &&
          !(await fileOps.sameFile(original, path)) &&
          (await fileOps.sameContent(path, original))
      }

      function moveTo(from: string, to: string): Promise<{ path: string; collided: boolean }> {
        return withNames(async () => {
          const free = await freeNameFor(to, from, trackId)
          // The file keeps the name it has. With ` (2)` if that is what it has
          // because the plain name is taken, which the caller is told.
          if (free.path === from) return { path: from, collided: free.collided }
          // A track whose file is missing still has its path: taking the name
          // would leave this file under a name the database cannot give it.
          if (ownedByAnother(free.path, trackId)) {
            throw new AppError('WRITE_FAILED', 'the new name belongs to another track')
          }
          // A stage that was told to stop renames nothing any more.
          if (signal.aborted) throw new AppError('WRITE_FAILED', 'the move was stopped')
          // Written down first: if the app stops right after the rename, undo and
          // the next run still know about the new name.
          recordCreatedFile(db, { batchId: batch.id, trackId, path: free.path })
          try {
            await fileOps.move(from, free.path)
          } catch (error) {
            deleteCreatedFile(db, batch.id, free.path, trackId)
            throw error
          }
          updateTrack(db, trackId, { path: free.path })
          prepared = Promise.resolve(free.path)
          return free
        })
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
        // Read from the disk: the stored size may be old, or not a size at all.
        const size = Math.max(0, await fileOps.sizeOf(track.path).catch(() => 0))
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

    async restoredOriginals() {
      const batch = findLastWrittenBatch(db)
      const restored = new Set<string>()
      if (!batch) return restored
      for (const backup of listBackups(db, batch.id)) {
        // A path a track has is that track's, and no question of this kind.
        if (findTrackIdByPath(db, backup.originalPath) !== undefined) continue
        if (await fileOps.sameContent(backup.originalPath, backup.backupPath)) {
          restored.add(normalizeTrackPath(backup.originalPath))
        }
      }
      return restored
    },

    undoLast() {
      undoing += 1
      return counted(undoLastBatch).finally(() => {
        undoing -= 1
      })
    },

    pruneOlderBackups: (keepBatchId) => counted(() => pruneBackupsOlderThan(keepBatchId)),

    busy: () => inFlight > 0,

    undoing: () => undoing > 0,

    settled: () =>
      inFlight === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            settledWaiters.push(resolve)
          }),

    async reconcileInterrupted() {
      const batch = findLastWrittenBatch(db)
      if (!batch) return 0
      // Only tracks the batch did not finish: a step that ended has written down
      // every name it gave. For those the journal is history, and a file that sits
      // under an old name of theirs today is somebody else's.
      const unfinished = new Set(
        listJobs(db, batch.id)
          .filter((job) => job.phase === 'apply' && job.status !== 'done')
          .map((job) => job.trackId)
      )
      const trackIds = new Set(
        listCreatedFiles(db, batch.id).flatMap((file) =>
          file.trackId !== null && unfinished.has(file.trackId) ? [file.trackId] : []
        )
      )
      let found = 0
      let notFound = 0
      // Read once: the same drives for every track of the pass.
      const mounted = listMountedVolumes()
      for (const trackId of trackIds) {
        try {
          found += await withTrack(trackId, async () => {
            const track = getTrackById(db, trackId, mounted)
            // A drive that is away says nothing about where a file is.
            if (!track || track.offline) return 0
            const now = await reconcile(batch.id, track)
            return now.path === track.path ? 0 : 1
          })
        } catch (error) {
          // Only "not found under any name the batch gave it", which the scan will
          // report as missing. Anything else, a database that is closed above all,
          // is no answer about a file: the pass fails, and with it the scan.
          if (!(error instanceof AppError) || error.code !== 'FILE_UNREADABLE') throw error
          notFound += 1
        }
      }
      // One line, however many: a library whose folder was renamed must not fill the log.
      if (notFound > 0) {
        logger.warn(`${notFound} tracks of batch ${batch.id} were not found where it left them`)
      }
      return found
    },

    async removeTempFiles() {
      const { libraryRoot, cleanLibraryFolder, backupFolder } = folders()
      let removed = 0
      for (const folder of [libraryRoot, cleanLibraryFolder, backupFolder]) {
        if (folder === null) continue
        try {
          removed += await fileOps.removeTempFiles(folder)
        } catch (error) {
          logger.warn(`A folder of the library could not be cleaned: ${describeError(error)}`)
        }
      }
      if (removed > 0) logger.info(`Removed ${removed} temp files that an interrupted write left`)
      return removed
    }
  }
}
