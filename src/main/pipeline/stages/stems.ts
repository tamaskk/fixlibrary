import { randomUUID } from 'crypto'
import { z } from 'zod'
import { getAnalysis, saveAnalysis } from '../../db/analyses'
import type { AppDatabase } from '../../db/connection'
import { listTrackFileStates, type Track } from '../../db/tracks'
import { describeError } from '../../services/error-text'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import type { StemsStore } from '../../services/stems-store'
import { AppError } from '@shared/errors'
import { STEMS_ANALYZER_VERSION, stemsResultSchema } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const STEMS_STAGE = 'stems'
const BRIDGE_MARGIN_MS = 30_000

export interface StemsStageDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
  stems: Pick<StemsStore, 'ensure' | 'has'>
  /** False while the model is not installed (scripts/fetch-demucs-weights.sh, T-041). */
  modelInstalled: () => Promise<boolean>
}

// What is kept of a separation: the answer, and the file as it was then, so a file
// that changed is separated again.
const storedStemsSchema = z.object({
  result: stemsResultSchema,
  fileSizeBytes: z.number().nullable(),
  fileMtimeMs: z.number().nullable()
})

export type StoredStems = z.output<typeof storedStemsSchema>

/** The kept separation of a track, if it was made by this model for the file as it is. */
export function keptStems(db: AppDatabase, track: Track): StoredStems | null {
  let stored
  try {
    stored = getAnalysis(db, track.id, 'stems', z.unknown())
  } catch (error) {
    logger.warn(`The kept stems of track ${track.id} are unreadable: ${describeError(error)}`)
    return null
  }
  if (stored?.analyzerVersion !== STEMS_ANALYZER_VERSION) return null
  const parsed = storedStemsSchema.safeParse(stored.result)
  if (!parsed.success) return null
  const same =
    parsed.data.fileSizeBytes === track.fileSizeBytes &&
    parsed.data.fileMtimeMs === track.fileMtimeMs
  return same ? parsed.data : null
}

/**
 * Separates a track into drums, bass, other and vocals with Demucs and keeps the
 * loudness of each in 100 ms windows (T-028), for the cues of T-029. One track at a
 * time on the `gpu` resource. A track whose file did not change since its stems were
 * made, and whose envelopes are there, is not separated again, so a run that was
 * stopped goes on with the next track. It proposes nothing for the preview.
 */
export function createStemsStage(dependencies: StemsStageDependencies): Stage {
  const { db } = dependencies
  // Said once: a run on the library would otherwise log it for every track.
  let missingModelLogged = false
  return {
    name: STEMS_STAGE,
    phase: 'compute',
    resource: 'gpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.demucs,
    run: async ({ signal }, track) => {
      if (keptStems(db, track) && (await dependencies.stems.has(track.id))) return
      if (!(await dependencies.modelInstalled())) {
        if (!missingModelLogged) {
          missingModelLogged = true
          logger.warn(
            'Stem analysis is off: run scripts/fetch-demucs-weights.sh to install the model'
          )
        }
        throw new AppError('PYTHON_ERROR', 'the stem model is not installed')
      }
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      await dependencies.stems.ensure(
        () => new Set(listTrackFileStates(db).map((state) => state.id))
      )
      // A new id for every attempt: the sidecar refuses one that is still in use.
      const jobId = randomUUID()
      const result = await python.call(
        'analysis.stems',
        { path: track.path, trackId: track.id, jobId },
        // Longer than the stage's own limit: when that ends the job, the sidecar is told
        // to stop (job.cancel); the bridge's limit would only stop waiting.
        { timeoutMs: STAGE_TIMEOUTS_MS.demucs + BRIDGE_MARGIN_MS, job: { id: jobId, signal } }
      )
      // A run that was stopped keeps nothing of an answer that came after all.
      if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
      if (result.file !== `${track.id}.npz`) {
        throw new AppError('PYTHON_ERROR', 'the stems were kept under another name')
      }
      const stored: StoredStems = {
        result,
        fileSizeBytes: track.fileSizeBytes,
        fileMtimeMs: track.fileMtimeMs
      }
      saveAnalysis(db, {
        trackId: track.id,
        type: 'stems',
        result: stored,
        analyzerVersion: result.analyzerVersion
      })
    }
  }
}
