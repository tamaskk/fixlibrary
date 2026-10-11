// Finds the audio files under the library root and keeps the `tracks` table in step
// with them. Read only: a scan never changes, moves or deletes a library file.
import { lstat, opendir, realpath, stat } from 'fs/promises'
import { extname, join, sep } from 'path'
import type { AppDatabase } from '../db/connection'
import type { AUDIO_FORMATS } from '../db/schema'
import { normalizeTrackPath, volumeNameOfPath } from '../db/track-paths'
import {
  getTrackById,
  insertTracks,
  listTrackFileStates,
  setTracksMissing,
  updateTracks,
  type NewTrack,
  type TrackChanges,
  type TrackFileState
} from '../db/tracks'
import { logger } from '../services/logger'
import { AppError, type ErrorCode, type Result } from '@shared/errors'
import type { ScanProgress, ScanSummary } from '@shared/library'
import { TAG_BATCH_SIZE, type FileTags } from '@shared/rpc'
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

export interface ScanDependencies {
  db: AppDatabase
  environment: SettingsEnvironment
  /** Reads one batch through the sidecar: one entry per path, in input order. */
  readTags: (paths: string[]) => Promise<FileTags[]>
  listMountedVolumes: () => ReadonlySet<string>
  onProgress?: (progress: ScanProgress) => void
}

export interface LibraryScanner {
  /** Starts a scan, or joins the one that is running. Never rejects. */
  scan: () => Promise<Result<ScanSummary>>
  isRunning: () => boolean
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
  /** False when a folder could not be read, so files may exist that were not seen. */
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

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    try {
      for await (const entry of await opendir(folder)) {
        if (isHidden(entry.name)) continue
        const diskPath = join(folder, entry.name)
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
          logger.warn('Scan: two files differ only in how their name is composed; one is skipped')
          continue
        }
        const { size, mtimeMs } = await stat(diskPath)
        seen.add(trackPath)
        files.push({ diskPath, trackPath, format, sizeBytes: size, mtimeMs: Math.trunc(mtimeMs) })
        if (files.length % WALK_PROGRESS_STEP === 0) onFound(files.length)
      }
    } catch (error) {
      // The root itself failing is the caller's to explain (the drive is gone);
      // a folder below it is skipped, and nothing is marked missing in this scan.
      if (folder === root) throw error
      complete = false
      logger.warn('Scan: a folder could not be read and was skipped', error)
    }
  }
  return { files, complete }
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
  const { db, environment, readTags, listMountedVolumes, onProgress } = dependencies
  const fail = (code: ErrorCode): Result<ScanSummary> => ({ ok: false, code })

  const settings = readSettings(db)
  const chosenRoot = settings.library.rootFolder
  if (chosenRoot === null) return fail('LIBRARY_NOT_SET')

  // An unclean eject can leave an empty folder under /Volumes. Scanning that would
  // find nothing and mark the whole library missing, so the mount itself is checked.
  const rootIsReachable = async (): Promise<string | null> => {
    try {
      const resolved = await realpath(chosenRoot)
      const volume = volumeNameOfPath(resolved)
      if (volume !== null && !listMountedVolumes().has(volume)) return null
      return (await stat(resolved)).isDirectory() ? resolved : null
    } catch {
      return null
    }
  }

  const root = await rootIsReachable()
  if (root === null) return fail('LIBRARY_UNAVAILABLE')
  // The rules were checked when the folders were chosen; what the paths point to
  // may have changed since.
  if (isUnsuitableLibraryRoot(root, environment) || libraryFoldersOverlap(settings, environment)) {
    return fail('LIBRARY_ROOT_UNSUITABLE')
  }

  const { backupFolder } = resolveEffectiveSettings(settings, environment)
  const excluded = new Set(
    [backupFolder, settings.library.cleanLibraryFolder]
      .filter((folder): folder is string => folder !== null)
      .map(normalizeTrackPath)
  )

  try {
    onProgress?.({ phase: 'walking', found: 0 })
    const walk = await walkLibrary(root, excluded, (found) =>
      onProgress?.({ phase: 'walking', found })
    )

    const stored = new Map<string, TrackFileState>(
      listTrackFileStates(db).map((state) => [state.path, state])
    )
    const toRead: FoundFile[] = []
    const foundAgain: number[] = []
    let unchanged = 0
    for (const file of walk.files) {
      const known = stored.get(file.trackPath)
      const same =
        known !== undefined &&
        known.fileSizeBytes === file.sizeBytes &&
        known.fileMtimeMs === file.mtimeMs
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
      unreadable: 0
    }

    for (let start = 0; start < toRead.length; start += TAG_BATCH_SIZE) {
      onProgress?.({ phase: 'reading', done: start, total: toRead.length })
      const batch = toRead.slice(start, start + TAG_BATCH_SIZE)
      const tags = await readTags(batch.map((file) => file.diskPath))
      if (tags.length !== batch.length) {
        throw new AppError('PYTHON_ERROR', 'tags.read answered for a different number of files')
      }

      const inserts: NewTrack[] = []
      const updates: { id: number; changes: TrackChanges }[] = []
      batch.forEach((file, index) => {
        const fileTags = tags[index]
        if (fileTags === undefined || fileTags.path !== file.diskPath) {
          throw new AppError('PYTHON_ERROR', 'tags.read answered for a different file')
        }
        if (!fileTags.readable) summary.unreadable += 1
        const scanStatus = fileTags.readable ? ('done' as const) : ('failed' as const)
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
        // Only the scan's own entry changes; what other stages recorded stays.
        const current = getTrackById(db, known.id, new Set())?.stageStatus ?? {}
        updates.push({
          id: known.id,
          changes: {
            ...fileFields(file),
            ...tagFields(fileTags),
            fileMissing: false,
            stageStatus: { ...current, scan: scanStatus }
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
    if ((await rootIsReachable()) === null) return fail('LIBRARY_UNAVAILABLE')
    if (walk.complete) {
      const foundPaths = new Set(walk.files.map((file) => file.trackPath))
      const rootPrefix = normalizeTrackPath(root) + sep
      const gone = [...stored.values()].filter(
        (state) => state.path.startsWith(rootPrefix) && !foundPaths.has(state.path)
      )
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
    logger.error('The library scan stopped', error)
    if ((await rootIsReachable()) === null) return fail('LIBRARY_UNAVAILABLE')
    return fail(error instanceof AppError ? error.code : 'UNEXPECTED')
  }
}

/** One scan at a time: a second request while one runs gets the result of that run. */
export function createLibraryScanner(dependencies: ScanDependencies): LibraryScanner {
  let running: Promise<Result<ScanSummary>> | null = null
  return {
    scan() {
      running ??= runScan(dependencies)
        .catch((error: unknown): Result<ScanSummary> => {
          logger.error('The library scan failed', error)
          return { ok: false, code: 'UNEXPECTED' }
        })
        .finally(() => {
          running = null
        })
      return running
    },
    isRunning: () => running !== null
  }
}
