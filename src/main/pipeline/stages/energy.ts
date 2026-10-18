import { randomUUID } from 'crypto'
import { z } from 'zod'
import { getAnalysis, saveAnalysis, type StoredAnalysis } from '../../db/analyses'
import type { AppDatabase } from '../../db/connection'
import type { Track } from '../../db/tracks'
import { describeError } from '../../services/error-text'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import {
  ENERGY_ANALYZER_VERSION,
  energyFeaturesResultSchema,
  type EnergyFeaturesResult
} from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const ENERGY_FEATURES_STAGE = 'energyFeatures'

export interface EnergyStageDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

// What is kept: the features, and the file as it was then, so that a file that
// changed (a normalization changes its loudness) is analysed again.
const storedFeaturesSchema = z.object({
  features: energyFeaturesResultSchema.shape.features,
  fileSizeBytes: z.number().nullable(),
  fileMtimeMs: z.number().nullable()
})

/** The features kept in `stored`, if this analyzer made them for the file as it is. */
export function currentEnergyFeatures(
  stored: StoredAnalysis<unknown> | undefined,
  track: Pick<Track, 'fileSizeBytes' | 'fileMtimeMs'>
): EnergyFeaturesResult['features'] | null {
  if (stored?.analyzerVersion !== ENERGY_ANALYZER_VERSION) return null
  const parsed = storedFeaturesSchema.safeParse(stored.result)
  if (!parsed.success) return null
  // Features kept without the time of their file are never taken for one that is.
  const same =
    parsed.data.fileMtimeMs !== null &&
    parsed.data.fileSizeBytes === track.fileSizeBytes &&
    parsed.data.fileMtimeMs === track.fileMtimeMs
  return same ? parsed.data.features : null
}

/** The kept features of a track, if this analyzer made them for the file as it is. */
export function keptEnergyFeatures(
  db: AppDatabase,
  track: Pick<Track, 'id' | 'fileSizeBytes' | 'fileMtimeMs'>
): EnergyFeaturesResult['features'] | null {
  try {
    return currentEnergyFeatures(getAnalysis(db, track.id, 'energy_features', z.unknown()), track)
  } catch (error) {
    logger.warn(
      `The kept energy features of track ${track.id} are unreadable: ${describeError(error)}`
    )
    return null
  }
}

/**
 * Measures the features the energy of a track is computed from (T-023), and keeps
 * them with the track. A track whose file did not change since is not analysed
 * again. It proposes nothing itself: the 1–10 value is T-024's.
 */
export function createEnergyStage(dependencies: EnergyStageDependencies): Stage {
  const { db } = dependencies
  return {
    name: ENERGY_FEATURES_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.energy,
    run: async ({ signal }, track) => {
      if (keptEnergyFeatures(db, track)) return
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      // A new id for every attempt: the sidecar refuses one that is still in use.
      const jobId = randomUUID()
      const result = await python.call(
        'analysis.energy_features',
        { path: track.path, jobId },
        { timeoutMs: STAGE_TIMEOUTS_MS.energy, job: { id: jobId, signal } }
      )
      // A run that was stopped keeps nothing of an answer that came after all.
      if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
      saveAnalysis(db, {
        trackId: track.id,
        type: 'energy_features',
        result: {
          features: result.features,
          fileSizeBytes: track.fileSizeBytes,
          fileMtimeMs: track.fileMtimeMs
        },
        analyzerVersion: result.analyzerVersion
      })
    }
  }
}
