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
  type TrackSnapshot
} from '../db/tracks'
import { describeError } from '../services/error-text'
import { unusableNameReason, type FileOps } from '../services/file-ops'
import { UNSAFE_TEXT } from '@shared/file-names'
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
      const free = await fileOps.freeName(wanted)
      const path = normalizeTrackPath(free.path)
      if (free.collided) onCollision()
      recordCreatedFile(db, { batchId, trackId: track.id, path })
      try {
        await fileOps.copy(track.path, path, signal)
      } catch (error) {
        // Not created after all: undo must not take a file at this path for ours.
        deleteCreatedFile(db, batchId, path)
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
      const owner = findTrackIdByPath(db, path)
      if (owner === plan.trackId) return false
      if (leaving.has(path)) return false
      // Another track has the path, whether its file is there or not.
      if (owner !== undefined) return true
      if (!(await fileOps.exists(path))) return false
      // The track's own file, changed where it was or renamed only in letter case.
      if (await fileOps.sameFile(path, plan.currentPath)) return false
      // Or put back already by an undo that stopped before it could say so: the
      // track's file is gone from where it was, and this one is as big as the backup.
      const backupPath = backups.get(plan.trackId)?.backupPath
      if (backupPath === undefined || (await fileOps.exists(plan.currentPath))) return true
      const sizes = await Promise.all([fileOps.sizeOf(path), fileOps.sizeOf(backupPath)])
      return sizes[0] !== sizes[1]
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
      const working = (): Promise<string> =>
        (prepared ??= prepare(batch, trackId, signal, () => {
          copyCollided = true
        }))

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
            const free = await fileOps.freeName(to, track.path)
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

        replaceContent: (write) =>
          withTrack(trackId, async () => fileOps.replace(await working(), write, signal))
      }

      function moveTo(from: string, to: string): Promise<{ path: string; collided: boolean }> {
        return withNames(async () => {
          const free = await fileOps.freeName(to, from)
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
            deleteCreatedFile(db, batch.id, free.path)
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
