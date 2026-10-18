// The cue editor (T-030): the tracks it lists, what it shows of one, its waveform, and
// the edits the user makes. An edit is the user's word: the slot it touches is locked
// (`cue:<slot>`), so that no later automatic run places another cue there.
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { z } from 'zod'
import { getAnalysis, listAnalysesOfType } from '../db/analyses'
import type { AppDatabase } from '../db/connection'
import { listAllCues, listTrackCues, setTrackCue } from '../db/cues'
import { listLatestWarningsOfStage } from '../db/jobs'
import { getTrackById, listLibraryTracks, updateTrack, type Track } from '../db/tracks'
import { describeError } from '../services/error-text'
import { logger } from '../services/logger'
import type { PeaksStore } from '../services/peaks-store'
import type { PythonBridge } from '../services/python-bridge'
import { beatsOf, gridDurationSeconds, snapToGrid, type GridMarker } from '@shared/beat-grid'
import {
  type CueEditAction,
  type CueEditorFilter,
  type CueEditorListItem,
  type CueEditorPeaks,
  type CueEditorTrack
} from '@shared/cue-editor'
import { isSetAsidePath } from '@shared/duplicates'
import type { Result } from '@shared/errors'
import { readProposal } from '@shared/preview'
import { PEAKS_RPC_TIMEOUT_MS } from '@shared/timeouts'
import { cueLockOf } from './cues'
import { rbGridSchema } from './rekordbox-import'
import { readSettings } from './settings'
import { CUES_STAGE } from './stages/cues'

export interface CueEditorDependencies {
  db: AppDatabase
  listMountedVolumes: () => ReadonlySet<string>
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
  peaks: Pick<PeaksStore, 'ensure' | 'read'>
}

/** The grids of Rekordbox the app keeps, by track; one that is not readable is no grid. */
function gridsOf(db: AppDatabase): Map<number, GridMarker[]> {
  const grids = new Map<number, GridMarker[]>()
  for (const [trackId, stored] of listAnalysesOfType(db, 'rb_grid')) {
    const parsed = rbGridSchema.safeParse(stored.result)
    if (parsed.success && parsed.data.tempos.length > 0) grids.set(trackId, parsed.data.tempos)
  }
  return grids
}

/** A track the editor works on: in the library, its drive there, its file found. */
function editableTrack(
  dependencies: CueEditorDependencies,
  trackId: number
): { track: Track; grid: GridMarker[] } | null {
  const track = getTrackById(dependencies.db, trackId, dependencies.listMountedVolumes())
  if (!track || track.offline || track.fileMissing || isSetAsidePath(track.path)) return null
  const grid = gridOf(dependencies.db, trackId)
  return grid ? { track, grid } : null
}

/** One track's grid: an edit reads this one row, not the grids of the whole library. */
function gridOf(db: AppDatabase, trackId: number): GridMarker[] | null {
  let stored
  try {
    stored = getAnalysis(db, trackId, 'rb_grid', z.unknown())
  } catch (error) {
    logger.warn(`The grid of track ${trackId} is unreadable: ${describeError(error)}`)
    return null
  }
  const parsed = rbGridSchema.safeParse(stored?.result)
  return parsed.success && parsed.data.tempos.length > 0 ? parsed.data.tempos : null
}

/** The tracks with Rekordbox's grid, by file name, as the filter asks. */
export function listCueEditorTracks(
  dependencies: CueEditorDependencies,
  filter: CueEditorFilter
): CueEditorListItem[] {
  const { db } = dependencies
  const grids = gridsOf(db)
  const counts = new Map<number, number>()
  for (const cue of listAllCues(db)) counts.set(cue.trackId, (counts.get(cue.trackId) ?? 0) + 1)
  const latest = listLatestWarningsOfStage(db, CUES_STAGE)
  return listLibraryTracks(db, dependencies.listMountedVolumes())
    .filter(
      (track) =>
        grids.has(track.id) && !track.offline && !track.fileMissing && !isSetAsidePath(track.path)
    )
    .map((track) => ({
      trackId: track.id,
      fileName: basename(track.path),
      artist: track.artist,
      title: track.title,
      cueCount: counts.get(track.id) ?? 0,
      review:
        readProposal({ warnings: latest.get(track.id) }).warnings?.includes('CUE_REVIEW') ?? false
    }))
    .filter(
      (item) =>
        filter === 'all' ||
        (filter === 'review' && item.review) ||
        (filter === 'noCues' && item.cueCount === 0)
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'hu'))
}

function viewOf(db: AppDatabase, track: Track, grid: GridMarker[]): CueEditorTrack {
  const locked = (slot: number): boolean => track.lockedFields.includes(cueLockOf(slot))
  const placed = listTrackCues(db, track.id)
  const filled = new Set(placed.map((cue) => cue.slot))
  return {
    trackId: track.id,
    fileName: basename(track.path),
    artist: track.artist,
    title: track.title,
    durationMs: track.durationMs ?? 0,
    grid,
    cues: placed.map((cue) => ({
      slot: cue.slot,
      positionMs: cue.positionMs,
      name: cue.name,
      color: cue.color,
      locked: locked(cue.slot)
    })),
    lockedEmpty: [1, 2, 3, 4, 5, 6, 7, 8].filter((slot) => !filled.has(slot) && locked(slot))
  }
}

/** What the editor shows of one track, or `INVALID_INPUT` for one it does not edit. */
export function cueEditorTrack(
  dependencies: CueEditorDependencies,
  trackId: number
): Result<CueEditorTrack> {
  const found = editableTrack(dependencies, trackId)
  if (!found) return { ok: false, code: 'INVALID_INPUT' }
  return { ok: true, value: viewOf(dependencies.db, found.track, found.grid) }
}

/** The kept waveform of a track, while it was made of the file as the track's row has it. */
export async function keptCueEditorPeaks(
  dependencies: CueEditorDependencies,
  trackId: number
): Promise<CueEditorPeaks | null> {
  const found = editableTrack(dependencies, trackId)
  if (!found) return null
  const { track } = found
  // The folder is checked before anything in it is read.
  await dependencies.peaks.ensure(() => libraryTrackIds(dependencies.db))
  const stored = await dependencies.peaks.read(track.id)
  // A row that knows no time of its file is matched by its size alone.
  const fresh =
    stored !== null &&
    stored.fileSizeBytes !== null &&
    stored.fileSizeBytes === track.fileSizeBytes &&
    stored.fileMtimeMs === track.fileMtimeMs
  if (!stored || !fresh) return null
  return {
    peaksPerSecond: stored.peaksPerSecond,
    durationSeconds: stored.durationSeconds,
    truncated: stored.truncated,
    peaks: stored.peaks
  }
}

function libraryTrackIds(db: AppDatabase): ReadonlySet<number> {
  return new Set(listLibraryTracks(db, new Set()).map((each) => each.id))
}

/**
 * The waveform of a track: the kept one, or made again by the sidecar. `signal` stops
 * the making when the page has gone on to another track.
 */
export async function cueEditorPeaks(
  dependencies: CueEditorDependencies,
  trackId: number,
  signal: AbortSignal = new AbortController().signal
): Promise<Result<CueEditorPeaks>> {
  const found = editableTrack(dependencies, trackId)
  if (!found) return { ok: false, code: 'INVALID_INPUT' }
  const { track } = found
  try {
    const kept = await keptCueEditorPeaks(dependencies, trackId)
    if (kept) return { ok: true, value: kept }
    const python = dependencies.python()
    if (!python) return { ok: false, code: 'PYTHON_CRASHED' }
    if (signal.aborted) return { ok: false, code: 'UNEXPECTED' }
    const jobId = randomUUID()
    await python.call(
      'analysis.peaks',
      {
        path: track.path,
        trackId: track.id,
        jobId,
        fileSizeBytes: track.fileSizeBytes,
        fileMtimeMs: track.fileMtimeMs
      },
      { timeoutMs: PEAKS_RPC_TIMEOUT_MS, job: { id: jobId, signal } }
    )
  } catch (error) {
    if (signal.aborted) return { ok: false, code: 'UNEXPECTED' }
    logger.warn(`The waveform of track ${track.id} was not made: ${describeError(error)}`)
    return { ok: false, code: 'FILE_UNREADABLE' }
  }
  const made = await keptCueEditorPeaks(dependencies, trackId)
  return made ? { ok: true, value: made } : { ok: false, code: 'FILE_UNREADABLE' }
}

/**
 * Carries out an edit of the page and returns the track as it is then. A cue that is
 * placed lands on the beat (or the bar) of the grid nearest to where it was let go,
 * as the main process counts the grid; the slot is locked. A deleted slot is locked
 * empty. A released slot is the automatic run's again; its cue stays until that run.
 */
export function applyCueEdit(
  dependencies: CueEditorDependencies,
  action: CueEditAction
): Result<CueEditorTrack> {
  const found = editableTrack(dependencies, action.trackId)
  if (!found) return { ok: false, code: 'INVALID_INPUT' }
  const { db } = dependencies
  const { track, grid } = found
  const durationSeconds = gridDurationSeconds(track.durationMs)
  let positionMs: number | null = null
  if (action.type === 'place') {
    if (action.atMs > durationSeconds * 1000) return { ok: false, code: 'INVALID_INPUT' }
    const snapped = snapToGrid(beatsOf(grid, durationSeconds), action.atMs / 1000, action.snap)
    if (snapped === null) return { ok: false, code: 'INVALID_INPUT' }
    positionMs = Math.round(snapped * 1000)
  }
  const scheme = readSettings(db).hotCues[action.slot - 1]
  if (!scheme) return { ok: false, code: 'INVALID_INPUT' }
  const lock = cueLockOf(action.slot)
  db.transaction((tx) => {
    const now = getTrackById(tx, track.id, new Set())
    if (!now) return
    const others = now.lockedFields.filter((field) => field !== lock)
    if (action.type === 'release') {
      updateTrack(tx, track.id, { lockedFields: others })
      return
    }
    setTrackCue(
      tx,
      track.id,
      action.slot,
      positionMs !== null ? { positionMs, name: scheme.name, color: scheme.color } : null
    )
    updateTrack(tx, track.id, { lockedFields: [...others, lock] })
  })
  const updated = getTrackById(db, track.id, dependencies.listMountedVolumes()) ?? track
  return { ok: true, value: viewOf(db, updated, grid) }
}
