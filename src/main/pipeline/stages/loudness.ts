import { randomUUID } from 'crypto'
import { z } from 'zod'
import { getAnalysis, saveAnalysis } from '../../db/analyses'
import type { AppDatabase } from '../../db/connection'
import { updateTrack, type Track } from '../../db/tracks'
import { describeError } from '../../services/error-text'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import type { MeasuredLoudness } from '@shared/normalize'
import { LOUDNESS_ANALYZER_VERSION } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const LOUDNESS_STAGE = 'loudness'

export interface LoudnessStageDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

// What is kept of a measure: the values, and the file as it was then, so that a
// file that changed is measured again.
const storedLoudnessSchema = z.object({
  integratedLufs: z.number(),
  truePeakDbtp: z.number(),
  lra: z.number(),
  fileSizeBytes: z.number().nullable(),
  fileMtimeMs: z.number().nullable()
})

/** The kept measure of a track, if it was made by this measure for the file as it is. */
export function keptLoudness(db: AppDatabase, track: Track): MeasuredLoudness | null {
  let stored
  try {
    stored = getAnalysis(db, track.id, 'loudness', z.unknown())
  } catch (error) {
    logger.warn(`The kept loudness of track ${track.id} is unreadable: ${describeError(error)}`)
    return null
  }
  if (stored?.analyzerVersion !== LOUDNESS_ANALYZER_VERSION) return null
  const parsed = storedLoudnessSchema.safeParse(stored.result)
  if (!parsed.success) return null
  // A measure kept without the time of its file is never taken for one that is.
  const same =
    parsed.data.fileMtimeMs !== null &&
    parsed.data.fileSizeBytes === track.fileSizeBytes &&
    parsed.data.fileMtimeMs === track.fileMtimeMs
  return same ? parsed.data : null
}

/**
 * Measures the file at `path` for a track, and keeps the measure with the track: as
 * an analysis for the file as the track's row has it, and in the row's own columns.
 * A silent file, or one ffmpeg cannot read, is `FILE_UNREADABLE`.
 *
 * `reusable` is false for a file the app has just written: its row keeps the time of
 * the file before, and mp3gain keeps its size, so the measure could be taken for the
 * original's after an undo. It is kept without the time, and never reused.
 */
export async function measureLoudness(
  dependencies: LoudnessStageDependencies,
  track: Pick<Track, 'id' | 'fileSizeBytes' | 'fileMtimeMs'>,
  path: string,
  signal: AbortSignal,
  reusable = true
): Promise<MeasuredLoudness> {
  const python = dependencies.python()
  if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
  // A new id for every attempt: the sidecar refuses one that is still in use.
  const jobId = randomUUID()
  const result = await python.call(
    'analysis.loudness',
    { path, jobId },
    { timeoutMs: STAGE_TIMEOUTS_MS.loudness, job: { id: jobId, signal } }
  )
  // A run that was stopped keeps nothing of an answer that came after all.
  if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
  if (result.status === 'unreadable') {
    throw new AppError('FILE_UNREADABLE', `the loudness cannot be measured (${result.reason})`)
  }
  const { integratedLufs, truePeakDbtp, lra } = result
  dependencies.db.transaction((tx) => {
    saveAnalysis(tx, {
      trackId: track.id,
      type: 'loudness',
      result: {
        integratedLufs,
        truePeakDbtp,
        lra,
        fileSizeBytes: track.fileSizeBytes,
        fileMtimeMs: reusable ? track.fileMtimeMs : null
      },
      analyzerVersion: LOUDNESS_ANALYZER_VERSION
    })
    updateTrack(tx, track.id, { lufs: integratedLufs, truePeakDbtp })
  })
  return { integratedLufs, truePeakDbtp }
}

/**
 * Measures the integrated loudness, the true peak and the loudness range of a track
 * by EBU R128 (T-031), for the normalization to plan from. A track whose file did not
 * change since it was measured is not measured again. It proposes nothing itself.
 */
export function createLoudnessStage(dependencies: LoudnessStageDependencies): Stage {
  return {
    name: LOUDNESS_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    // Asked for with the normalization, which plans from it.
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.loudness,
    run: async ({ signal }, track) => {
      if (keptLoudness(dependencies.db, track)) return
      await measureLoudness(dependencies, track, track.path, signal)
    }
  }
}
