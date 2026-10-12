import { randomUUID } from 'crypto'
import type { Track } from '../../db/tracks'
import { describeError } from '../../services/error-text'
import type { LookupCache } from '../../services/lookup/cache'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { fingerprintResultSchema, type Fingerprint } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const FINGERPRINT_STAGE = 'fingerprint'
const CACHE_SOURCE = 'fingerprint'

export interface FingerprintStageDependencies {
  cache: LookupCache
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
  /** False while no AcoustID key is set: a fingerprint would be of no use then. */
  wanted: () => boolean
}

// A fingerprint belongs to the audio of a file, so it is kept for the file as the
// last scan saw it: a file that changed is fingerprinted again.
function cacheKey(track: Track): string {
  return `${track.id}:${track.fileSizeBytes ?? '?'}:${track.fileMtimeMs ?? '?'}`
}

/** The fingerprint that was kept for the file of a track, if any. */
export function keptFingerprint(cache: LookupCache, track: Track): Fingerprint | null {
  return cache.get(CACHE_SOURCE, cacheKey(track), fingerprintResultSchema) ?? null
}

/**
 * Makes the AcoustID fingerprint of a track and keeps it for the lookup. A file that
 * cannot be fingerprinted (too short, or not readable as audio) does not fail its
 * track: the lookup then searches by the names it has.
 */
export function createFingerprintStage(dependencies: FingerprintStageDependencies): Stage {
  const { cache } = dependencies
  return {
    name: FINGERPRINT_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.fingerprint,
    run: async ({ signal }, track) => {
      if (!dependencies.wanted() || keptFingerprint(cache, track)) return
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      // A new id for every attempt: the sidecar refuses one that is still in use.
      const jobId = randomUUID()
      let fingerprint: Fingerprint
      try {
        fingerprint = await python.call(
          'fingerprint.compute',
          { path: track.path, jobId },
          { timeoutMs: STAGE_TIMEOUTS_MS.fingerprint, job: { id: jobId, signal } }
        )
      } catch (error) {
        // Only what the sidecar says about this file. A sidecar that died, or a run
        // that was stopped, is not the file's doing.
        if (!(error instanceof AppError) || error.code !== 'PYTHON_ERROR' || signal.aborted) {
          throw error
        }
        logger.warn(`Track ${track.id} has no fingerprint: ${describeError(error)}`)
        return
      }
      if (!signal.aborted) cache.put(CACHE_SOURCE, cacheKey(track), fingerprint)
    }
  }
}
