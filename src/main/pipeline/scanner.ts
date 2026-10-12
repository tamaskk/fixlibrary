// Finds the audio files under the library root and keeps the `tracks` table in step
// with them. Read only: a scan never changes, moves or deletes a library file.
import type { Dir } from 'fs'
import { lstat, opendir, realpath, stat } from 'fs/promises'
import { extname, join, sep } from 'path'
import type { AppDatabase } from '../db/connection'
import type { AUDIO_FORMATS } from '../db/schema'
import { normalizeTrackPath, volumeNameOfPath } from '../db/track-paths'
import {
  insertTracks,
  listTrackFileStates,
  setTracksMissing,
  updateTracks,
  type NewTrack,
  type TrackChanges,
  type TrackFileState
} from '../db/tracks'
import { describeError } from '../services/error-text'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { AppError, type ErrorCode, type Result } from '@shared/errors'
import type { ScanProgress, ScanSummary } from '@shared/library'
import { fileTagsSchema, TAG_BATCH_SIZE, type FileTags } from '@shared/rpc'
import {
  isUnsuitableLibraryRoot,
  libraryFoldersOverlap,
  readSettings,
  resolveEffectiveSettings,
  type SettingsEnvironment
} from './settings'

type AudioFormat = (typeof AUDIO_FORMATS)[number]

const FORMAT_BY_EXTENSION: Readonly<Record<string, AudioFormat>> = {
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.aif': 'aiff',
  '.aiff': 'aiff'
}

// The walk reports how far it is after this many files, so a slow drive shows progress.
const WALK_PROGRESS_STEP = 200

// Failures of the sidecar that one bad file in a batch can cause.
const BATCH_FAILURE_CODES: readonly ErrorCode[] = ['PYTHON_ERROR', 'PYTHON_CRASHED', 'TIMEOUT']

// A tree of folders that cannot be read must not push the rest out of the log.
const logSkipped = createLogLimiter((line) => logger.warn(line), { limit: 20, windowMs: 10_000 })

export interface ScanDependencies {
  db: AppDatabase
  environment: SettingsEnvironment
  /**
   * Reads one batch through the sidecar: one entry per path, in input order. The
   * entries are untrusted; the scanner checks each of them.
   */
  readTags: (paths: string[]) => Promise<unknown[]>
  /** Whether the sidecar answers at all, asked after a read has failed. Never rejects. */
  isEngineAlive: () => Promise<boolean>
  listMountedVolumes: () => ReadonlySet<string>
  onProgress?: (progress: ScanProgress) => void
  /**
   * True while a batch changes files of the library. No scan starts then: it would
   * see files half renamed, and take them for missing tracks and new ones.
   */
  isChangingFiles?: () => boolean
  /**
   * Runs at the start of every scan, before anything is read. For putting right
   * what the scan would otherwise misread: a file that an interrupted batch renamed
   * without telling its track looks like a new track next to a missing one. If it
   * fails, the scan does not run.
   */
  beforeScan?: () => Promise<void>
  /** The path with its links resolved. Replaced in tests that need a path on a volume. */
  resolvePath?: (path: string) => Promise<string>
}

export interface LibraryScanner {
  /** Starts a scan, or joins the one that is running. Never rejects. */
  scan: () => Promise<Result<ScanSummary>>
  isRunning: () => boolean
  /** The running scan, or null. Unlike `scan`, this never starts one. */
  current: () => Promise<Result<ScanSummary>> | null
}

interface FoundFile {
  /** As the disk spells it; this is what the file is opened by. */
  diskPath: string
  /** As it is stored and compared. */
  trackPath: string
  format: AudioFormat
  sizeBytes: number
  mtimeMs: number
}

interface WalkResult {
  files: FoundFile[]
  /** False when something could not be looked at, so files may exist that were not seen. */
  complete: boolean
}

/** Hidden entries: `._*` AppleDouble files, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, … */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

async function walkLibrary(
  root: string,
  excludedFolders: ReadonlySet<string>,
  onFound: (count: number) => void
): Promise<WalkResult> {
  const files: FoundFile[] = []
  const seen = new Set<string>()
  let complete = true
  const pending = [root]
  const skip = (what: string, error: unknown): void => {
    complete = false
    logSkipped(`Scan: ${what} could not be read and was skipped: ${describeError(error)}`)
  }

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    let entries: Dir
    try {
      // A folder that was swapped for a link since it was listed is not entered.
      if (folder !== root && (await realpath(folder)) !== folder) {
        skip('a folder that is now a link', new Error('not the folder that was listed'))
        continue
      }
      entries = await opendir(folder)
    } catch (error) {
      // The root itself failing is the caller's to explain (the drive is gone).
      if (folder === root) throw error
      skip('a folder', error)
      continue
    }

    try {
      for await (const entry of entries) {
        if (isHidden(entry.name)) continue
        const diskPath = join(folder, entry.name)
        try {
          // Some file systems do not say what an entry is; then the entry itself is asked.
          // Links are never followed: a link could lead out of the library or into a loop.
          const kind = entry.isFile() || entry.isDirectory() ? entry : await lstat(diskPath)
          if (kind.isDirectory()) {
            if (!excludedFolders.has(normalizeTrackPath(diskPath))) pending.push(diskPath)
            continue
          }
          const format = FORMAT_BY_EXTENSION[extname(entry.name).toLowerCase()]
          if (!kind.isFile() || format === undefined) continue

          const trackPath = normalizeTrackPath(diskPath)
          if (seen.has(trackPath)) {
            logSkipped('Scan: two files differ only in how their name is composed; one is skipped')
            continue
          }
          // lstat, so a file swapped for a link since it was listed is not measured.
          const state = await lstat(diskPath)
          if (!state.isFile()) continue
          seen.add(trackPath)
          files.push({
            diskPath,
            trackPath,
            format,
            sizeBytes: state.size,
            mtimeMs: Math.trunc(state.mtimeMs)
          })
          if (files.length % WALK_PROGRESS_STEP === 0) onFound(files.length)
        } catch (error) {
          // One entry that went away between listing and reading does not end the folder.
          skip('an entry', error)
        }
      }
    } catch (error) {
      if (folder === root) throw error
      skip('the rest of a folder', error)
    }
  }
  return { files, complete }
}

function unreadableTags(path: string): FileTags {
  return {
    path,
    readable: false,
    durationMs: null,
    bitrateKbps: null,
    sampleRateHz: null,
    artist: null,
    title: null,
    album: null,
    label: null,
    year: null,
    hasCover: false
  }
}

/** The sidecar answered about other files than it was asked about. Never retried. */
class AnswerMismatch extends AppError {
  constructor() {
    super('PYTHON_ERROR', 'tags.read answered for different files')
  }
}

function isBatchFailure(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    !(error instanceof AnswerMismatch) &&
    BATCH_FAILURE_CODES.includes(error.code)
  )
}

/** What became of one file: its tags, and whether reading it ran out of time. */
interface ReadFile {
  tags: FileTags
  timedOut: boolean
}

/** Asks for the tags of the files and checks that the answer is about exactly them. */
async function readChecked(
  files: readonly FoundFile[],
  readTags: ScanDependencies['readTags']
): Promise<FileTags[]> {
  const entries = await readTags(files.map((file) => file.diskPath))
  if (entries.length !== files.length) throw new AnswerMismatch()
  return files.map((file, index) => {
    // An entry that does not fit the contract (a value out of range, tag text that is
    // not one clean line) makes that one file unreadable, not the whole batch.
    const parsed = fileTagsSchema.safeParse(entries[index])
    if (!parsed.success) return unreadableTags(file.diskPath)
    if (parsed.data.path !== file.diskPath) throw new AnswerMismatch()
    return parsed.data
  })
}

/**
 * The tags of one batch. When the batch as a whole fails, its files are read one by
 * one, so that a single file the sidecar cannot cope with is recorded as unreadable
 * instead of stopping this scan and every later one at the same place.
 *
 * After a single file fails, the sidecar is asked whether it is alive. If it is, the
 * file was the cause. If it is not, the scan ends with the sidecar's error.
 */
async function readBatch(
  batch: readonly FoundFile[],
  dependencies: Pick<ScanDependencies, 'readTags' | 'isEngineAlive'>,
  stillReachable: () => Promise<boolean>
): Promise<ReadFile[]> {
  const { readTags, isEngineAlive } = dependencies
  try {
    return (await readChecked(batch, readTags)).map((tags) => ({ tags, timedOut: false }))
  } catch (error) {
    if (!isBatchFailure(error) || !(await stillReachable())) throw error
    logger.warn(`Scan: a batch failed (${error.code}); reading its files one by one`)
  }

  const read: ReadFile[] = []
  for (const file of batch) {
    try {
      const [tags] = await readChecked([file], readTags)
      read.push({ tags: tags ?? unreadableTags(file.diskPath), timedOut: false })
    } catch (error) {
      if (!isBatchFailure(error) || !(await isEngineAlive())) throw error
      read.push({ tags: unreadableTags(file.diskPath), timedOut: error.code === 'TIMEOUT' })
    }
  }
  return read
}

function tagFields(tags: FileTags): TrackChanges {
  return {
    durationMs: tags.durationMs,
    bitrateKbps: tags.bitrateKbps,
    sampleRateHz: tags.sampleRateHz,
    artist: tags.artist,
    title: tags.title,
    album: tags.album,
    label: tags.label,
    year: tags.year,
    coverStatus: !tags.readable ? 'unknown' : tags.hasCover ? 'embedded' : 'missing'
  }
}

function fileFields(file: FoundFile): TrackChanges {
  return { format: file.format, fileSizeBytes: file.sizeBytes, fileMtimeMs: file.mtimeMs }
}

async function runScan(dependencies: ScanDependencies): Promise<Result<ScanSummary>> {
  const { db, environment, listMountedVolumes, onProgress } = dependencies
  const resolvePath = dependencies.resolvePath ?? realpath
  const fail = (code: ErrorCode): Result<ScanSummary> => ({ ok: false, code })

  const settings = readSettings(db)
  const chosenRoot = settings.library.rootFolder
  if (chosenRoot === null) return fail('LIBRARY_NOT_SET')

  // An unclean eject can leave an empty folder under /Volumes. Scanning that would
  // find nothing and mark the whole library missing, so the mount itself is checked.
  const reachableRoot = async (): Promise<string | null> => {
    try {
      const resolved = await resolvePath(chosenRoot)
      const volume = volumeNameOfPath(resolved)
      if (volume !== null && !listMountedVolumes().has(volume)) return null
      return (await stat(resolved)).isDirectory() ? resolved : null
    } catch {
      return null
    }
  }
  const stillReachable = async (): Promise<boolean> => (await reachableRoot()) !== null

  const root = await reachableRoot()
  if (root === null) return fail('LIBRARY_UNAVAILABLE')
  // The rules were checked when the folders were chosen; what the paths point to
  // may have changed since.
  if (isUnsuitableLibraryRoot(root, environment) || libraryFoldersOverlap(settings, environment)) {
    return fail('LIBRARY_ROOT_UNSUITABLE')
  }

  // Compared with the paths of the walk, which are spelled as the disk spells them.
  const { backupFolder } = resolveEffectiveSettings(settings, environment)
  const excluded = new Set<string>()
  for (const folder of [backupFolder, settings.library.cleanLibraryFolder]) {
    if (folder === null) continue
    excluded.add(normalizeTrackPath(await resolvePath(folder).catch(() => folder)))
  }

  try {
    onProgress?.({ phase: 'walking', found: 0 })
    const walk = await walkLibrary(root, excluded, (found) =>
      onProgress?.({ phase: 'walking', found })
    )

    const stored = new Map<string, TrackFileState>(
      listTrackFileStates(db).map((state) => [state.path, state])
    )
    // In clean library mode a track points at its copy, and its original stays in
    // the library untouched. That file is known, not a new track.
    const originals = new Set(
      [...stored.values()]
        .filter((state) => state.originalPath !== state.path)
        .map((state) => state.originalPath)
    )
    const toRead: FoundFile[] = []
    const foundAgain: number[] = []
    let unchanged = 0
    for (const file of walk.files) {
      const known = stored.get(file.trackPath)
      if (known === undefined && originals.has(file.trackPath)) {
        unchanged += 1
        continue
      }
      const same =
        known !== undefined &&
        known.fileSizeBytes === file.sizeBytes &&
        known.fileMtimeMs === file.mtimeMs &&
        // A file that could not be read is tried again: the cause may have been the
        // drive or the reader, not the file. A file that ran out of time (`skipped`)
        // is not, until it changes: trying it costs minutes on every scan.
        known.stageStatus.scan !== 'failed'
      if (!same) {
        toRead.push(file)
        continue
      }
      unchanged += 1
      if (known.fileMissing) foundAgain.push(known.id)
    }
    setTracksMissing(db, foundAgain, false)

    const summary: ScanSummary = {
      found: walk.files.length,
      added: 0,
      updated: 0,
      unchanged,
      missing: 0,
      unreadable: 0,
      complete: walk.complete
    }

    for (let start = 0; start < toRead.length; start += TAG_BATCH_SIZE) {
      onProgress?.({ phase: 'reading', done: start, total: toRead.length })
      const batch = toRead.slice(start, start + TAG_BATCH_SIZE)
      const read = await readBatch(batch, dependencies, stillReachable)

      const inserts: NewTrack[] = []
      const updates: { id: number; changes: TrackChanges }[] = []
      batch.forEach((file, index) => {
        const { tags: fileTags, timedOut } = read[index] ?? {
          tags: unreadableTags(file.diskPath),
          timedOut: false
        }
        if (!fileTags.readable) summary.unreadable += 1
        const scanStatus = fileTags.readable ? 'done' : timedOut ? 'skipped' : 'failed'
        const known = stored.get(file.trackPath)
        if (known === undefined) {
          inserts.push({
            path: file.trackPath,
            originalPath: file.trackPath,
            format: file.format,
            ...fileFields(file),
            ...tagFields(fileTags),
            stageStatus: { scan: scanStatus }
          })
          return
        }
        const sameFile =
          known.fileSizeBytes === file.sizeBytes && known.fileMtimeMs === file.mtimeMs
        if (sameFile && known.stageStatus.scan === scanStatus && !known.fileMissing) {
          // Tried again and still unreadable: nothing about the track has changed.
          summary.unchanged += 1
          return
        }
        const fromTags = tagFields(fileTags)
        // What the user set by hand in a preview stays, whatever the file's tags say:
        // they may not have been written into the file yet.
        if (known.lockedFields.includes('artist')) delete fromTags.artist
        if (known.lockedFields.includes('title')) delete fromTags.title
        updates.push({
          id: known.id,
          changes: {
            ...fileFields(file),
            ...fromTags,
            fileMissing: false,
            // Only the scan's own entry changes; what other stages recorded stays.
            stageStatus: { ...known.stageStatus, scan: scanStatus }
          }
        })
      })
      insertTracks(db, inserts)
      updateTracks(db, updates)
      summary.added += inserts.length
      summary.updated += updates.length
    }
    onProgress?.({ phase: 'reading', done: toRead.length, total: toRead.length })

    // A drive that went away during the scan must not make its tracks look deleted.
    if (!(await stillReachable())) return fail('LIBRARY_UNAVAILABLE')

    const foundPaths = new Set(walk.files.map((file) => file.trackPath))
    const rootPrefix = normalizeTrackPath(root) + sep
    const gone = [...stored.values()].filter(
      (state) => state.path.startsWith(rootPrefix) && !foundPaths.has(state.path)
    )
    // A library that had tracks and now shows no file at all is far more likely to be
    // unreadable (a permission the app lost, an empty mount) than emptied.
    if (walk.files.length === 0 && gone.length > 0) summary.complete = false
    if (summary.complete) {
      setTracksMissing(
        db,
        gone.filter((state) => !state.fileMissing).map((state) => state.id),
        true
      )
      summary.missing = gone.length
    }

    return { ok: true, value: summary }
  } catch (error) {
    // What was written before the failure stays; the next scan picks up from there.
    logger.error(`The library scan stopped: ${describeError(error)}`)
    if (!(await stillReachable())) return fail('LIBRARY_UNAVAILABLE')
    return fail(error instanceof AppError ? error.code : 'UNEXPECTED')
  }
}

/** One scan at a time: a second request while one runs gets the result of that run. */
export function createLibraryScanner(dependencies: ScanDependencies): LibraryScanner {
  let running: Promise<Result<ScanSummary>> | null = null
  return {
    scan() {
      if (running === null && dependencies.isChangingFiles?.()) {
        return Promise.resolve({ ok: false, code: 'RUN_ACTIVE' })
      }
      running ??= (async () => {
        await dependencies.beforeScan?.()
        return runScan(dependencies)
      })()
        .catch((error: unknown): Result<ScanSummary> => {
          logger.error(`The library scan failed: ${describeError(error)}`)
          return { ok: false, code: 'UNEXPECTED' }
        })
        .finally(() => {
          running = null
        })
      return running
    },
    isRunning: () => running !== null,
    current: () => running
  }
}
