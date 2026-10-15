// Reads what Rekordbox exported (T-026): its grid becomes the track's `rb_grid`, which
// the cues of T-029 are placed on, and the check of the wizard (T-027) is made.
import { basename } from 'path'
import { z } from 'zod'
import { deleteAnalysis, saveAnalysis } from '../db/analyses'
import type { AppDatabase } from '../db/connection'
import { volumeNameOfPath } from '../db/track-paths'
import { listLibraryTracks } from '../db/tracks'
import { describeError } from '../services/error-text'
import { logger } from '../services/logger'
import {
  fileStatesOf,
  findNewestExport,
  parseRekordboxBytes,
  readExportBytes,
  TEMPO_BOUNDS,
  type RekordboxExport
} from '../services/rekordbox-xml-read'
import { isSetAsidePath } from '@shared/duplicates'
import type { Result } from '@shared/errors'
import { isNetworkPath } from '@shared/network-paths'
import {
  MAX_CHECK_ITEMS,
  type CheckedList,
  type CheckedTrack,
  type RekordboxExportCheck
} from '@shared/rekordbox'
import { toOneLine } from '@shared/text'
import { readSettings, resolveEffectiveSettings, type SettingsEnvironment } from './settings'

/** What `rb_grid` holds: Rekordbox's beat markers, as its export had them. */
export const rbGridSchema = z.object({
  tempos: z
    .array(
      z.object({
        inizio: z.number().nonnegative(),
        bpm: z.number().positive().lt(TEMPO_BOUNDS.maxBpm),
        metro: z.string().regex(TEMPO_BOUNDS.metro),
        battito: z.number().int().min(1).max(TEMPO_BOUNDS.maxBattito)
      })
    )
    .max(TEMPO_BOUNDS.maxTempos),
  /** When Rekordbox wrote the export it came from, in ms since the epoch. */
  exportedAt: z.number(),
  /** When the app read it, in ms since the epoch. */
  readAt: z.number()
})

export type RbGrid = z.output<typeof rbGridSchema>

/** Who made an `rb_grid`: the grid is Rekordbox's, read from its XML. */
export const RB_GRID_SOURCE = 'rekordbox-xml'

// As long as a path may be on macOS, a little over.
const MAX_SHOWN_PATH = 1100

export interface RekordboxImportDependencies {
  db: AppDatabase
  environment: SettingsEnvironment
  listMountedVolumes: () => ReadonlySet<string>
  /** True while files of the library are being changed or scanned: the paths are not final. */
  isBusy: () => boolean
  /** Parses the bytes of an export; in the app, in a worker thread. */
  parseExport?: (bytes: Buffer) => Promise<RekordboxExport>
  now?: () => number
}

/** The first entries of a list, and how many there are; text made fit for one line. */
function shortList<T>(items: readonly T[], shown: (item: T) => T): CheckedList<T> {
  return { count: items.length, items: items.slice(0, MAX_CHECK_ITEMS).map(shown) }
}

const shownTrack = (track: CheckedTrack): CheckedTrack => ({
  trackId: track.trackId,
  path: toOneLine(track.path, MAX_SHOWN_PATH)
})

/**
 * Pairs the tracks of an export with the tracks of the library by their paths, both
 * composed (NFC), and keeps the grid of each pair. A track of the library the export
 * has without a grid loses an older one: the grid is Rekordbox's as it is now.
 */
export function storeExportGrids(
  db: AppDatabase,
  exported: RekordboxExport,
  libraryTracks: readonly { id: number; path: string }[],
  times: { exportedAt: number; readAt: number }
): { matched: number; notInExport: CheckedTrack[]; unanalysed: CheckedTrack[] } {
  const notInExport: CheckedTrack[] = []
  const unanalysed: CheckedTrack[] = []
  let matched = 0
  db.transaction((tx) => {
    for (const track of libraryTracks) {
      const found = exported.tracks.get(track.path.normalize('NFC'))
      if (!found) {
        notInExport.push({ trackId: track.id, path: track.path })
        continue
      }
      matched += 1
      if (found.tempos.length === 0) {
        unanalysed.push({ trackId: track.id, path: track.path })
        deleteAnalysis(tx, track.id, 'rb_grid')
        continue
      }
      const grid: RbGrid = { tempos: found.tempos, ...times }
      saveAnalysis(tx, {
        trackId: track.id,
        type: 'rb_grid',
        result: grid,
        analyzerVersion: RB_GRID_SOURCE
      })
    }
  })
  return { matched, notInExport, unanalysed }
}

/**
 * Which entries of an export point at no file. Only what can be looked at safely: an
 * entry on a drive that is not connected is not missing but unavailable, and one in
 * a network folder is not looked at (macOS would reach out to the host it names).
 */
async function filesOfExport(
  exported: RekordboxExport,
  mounted: ReadonlySet<string>
): Promise<{ missing: string[]; unavailable: number; unchecked: number }> {
  let unavailable = 0
  let unchecked = 0
  const looked: string[] = []
  for (const path of exported.tracks.keys()) {
    const volume = volumeNameOfPath(path)
    if (isNetworkPath(path)) unchecked += 1
    else if (volume !== null && !mounted.has(volume)) unavailable += 1
    else looked.push(path)
  }
  const states = await fileStatesOf(looked)
  const missing: string[] = exported.unplaced.map((track) => track.location)
  for (const [path, state] of states) {
    if (state === 'absent') missing.push(path)
    if (state === 'unknown') unchecked += 1
  }
  return { missing, unavailable, unchecked }
}

/**
 * Reads the newest export in the folder Settings names, keeps the grids of the
 * library's tracks, and says what the wizard is to check. The tracks of the library
 * are the ones the XML of the app holds: none on a drive that is not connected, none
 * missing, no set-aside copy.
 */
export async function readRekordboxExport(
  dependencies: RekordboxImportDependencies
): Promise<Result<RekordboxExportCheck>> {
  const { db } = dependencies
  if (dependencies.isBusy()) return { ok: false, code: 'RUN_ACTIVE' }
  const folder = resolveEffectiveSettings(
    readSettings(db),
    dependencies.environment
  ).exportedXmlFolder

  const file = await findNewestExport(folder).catch((error: unknown) => {
    logger.warn(`The Rekordbox export folder cannot be read: ${describeError(error)}`)
    return null
  })
  if (file === null) return { ok: false, code: 'XML_NOT_FOUND' }
  const parse = dependencies.parseExport ?? (async (bytes) => parseRekordboxBytes(bytes))
  let exported: RekordboxExport
  try {
    exported = await parse(await readExportBytes(file.path))
  } catch (error) {
    logger.warn(`The Rekordbox export cannot be read: ${describeError(error)}`)
    return { ok: false, code: 'XML_UNREADABLE' }
  }
  // The files were read while nothing moved them; a batch since would make the pairs old.
  if (dependencies.isBusy()) return { ok: false, code: 'RUN_ACTIVE' }

  const mounted = dependencies.listMountedVolumes()
  const library = listLibraryTracks(db, mounted).filter(
    (track) => !track.offline && !track.fileMissing && !isSetAsidePath(track.path)
  )
  const readAt = (dependencies.now ?? Date.now)()
  const stored = storeExportGrids(db, exported, library, {
    exportedAt: file.modifiedAt,
    readAt
  })
  const files = await filesOfExport(exported, mounted)
  const check: RekordboxExportCheck = {
    fileName: toOneLine(basename(file.path), 255),
    exportedAt: file.modifiedAt,
    tracks: exported.tracks.size + exported.unplaced.length + exported.skipped,
    skipped: exported.skipped,
    matched: stored.matched,
    notInExport: shortList(stored.notInExport, shownTrack),
    missingFiles: shortList(files.missing, (path) => toOneLine(path, MAX_SHOWN_PATH)),
    unavailable: files.unavailable,
    unchecked: files.unchecked,
    unanalysed: shortList(stored.unanalysed, shownTrack)
  }
  logger.info(
    `Rekordbox export read: ${check.tracks} tracks, ${check.matched} of the library, ` +
      `${check.notInExport.count} not in it, ${check.missingFiles.count} missing, ` +
      `${check.unavailable} unavailable, ${check.unchecked} unchecked, ` +
      `${check.unanalysed.count} not analysed, ${check.skipped} not read`
  )
  return { ok: true, value: check }
}
