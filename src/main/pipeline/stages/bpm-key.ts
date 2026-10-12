import { randomUUID } from 'crypto'
import { z } from 'zod'
import { getAnalysis, saveAnalysis } from '../../db/analyses'
import type { AppDatabase } from '../../db/connection'
import { describeError } from '../../services/error-text'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { LOW_CONFIDENCE_BELOW } from '@shared/preview'
import { BPM_KEY_ANALYZER_VERSION, bpmKeyResultSchema, type BpmKeyResult } from '@shared/rpc'
import type { Settings } from '@shared/settings'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const BPM_KEY_STAGE = 'bpmKey'

type BpmRange = Settings['analysis']

export interface BpmKeyStageDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
  /** The tempo range of the settings, read for every track. */
  bpmRange: () => BpmRange
}

// What is kept of an analysis: the answer of the sidecar, and the tempo range it was
// asked with, because the tempo in the answer was moved into that range.
const storedAnalysisSchema = z.object({
  range: z.object({ bpmMin: z.number(), bpmMax: z.number() }),
  result: bpmKeyResultSchema
})

// Essentia calls a tempo it is less sure of than this a weak guess.
const WEAK_BPM_CONFIDENCE = 1.5

/**
 * Essentia's confidence of a tempo (0 to 5.32) on the preview's scale of 0 to 1, so
 * that what Essentia calls weak is what the preview flags as uncertain.
 */
export function bpmConfidenceOf(result: BpmKeyResult): number {
  return Math.min(1, (result.bpmConfidence / WEAK_BPM_CONFIDENCE) * LOW_CONFIDENCE_BELOW)
}

function isInside(result: BpmKeyResult, range: BpmRange): boolean {
  return result.bpm >= range.bpmMin && result.bpm <= range.bpmMax
}

/**
 * Measures tempo and key from the audio of a track. The result is kept per track
 * and analyzer version, so a track is analysed once; what it proposes reaches the
 * track's row when the batch is approved.
 */
export function createBpmKeyStage(dependencies: BpmKeyStageDependencies): Stage {
  const { db } = dependencies

  /** The kept result, if it was made by this analyzer for this tempo range. */
  function cached(trackId: number, range: BpmRange): BpmKeyResult | null {
    let stored
    try {
      stored = getAnalysis(db, trackId, 'bpm_key', z.unknown())
    } catch (error) {
      logger.warn(`The kept analysis of track ${trackId} is unreadable: ${describeError(error)}`)
      return null
    }
    if (stored?.analyzerVersion !== BPM_KEY_ANALYZER_VERSION) return null
    const parsed = storedAnalysisSchema.safeParse(stored.result)
    if (!parsed.success) return null
    const { range: asked, result } = parsed.data
    const sameRange = asked.bpmMin === range.bpmMin && asked.bpmMax === range.bpmMax
    return sameRange && isInside(result, range) ? result : null
  }

  return {
    name: BPM_KEY_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.bpmKey,
    run: async ({ signal }, track) => {
      const range = dependencies.bpmRange()
      let result = cached(track.id, range)
      if (!result) {
        const python = dependencies.python()
        if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
        // A new id for every attempt: the sidecar refuses one that is still in use.
        const jobId = randomUUID()
        result = await python.call(
          'analysis.bpm_key',
          { path: track.path, jobId, ...range },
          { timeoutMs: STAGE_TIMEOUTS_MS.bpmKey, job: { id: jobId, signal } }
        )
        // A run that was stopped keeps nothing of an answer that came after all.
        if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
        // Kept only if it is an answer to what was asked: a tempo outside the range
        // would be stored, never shown, and never measured again.
        if (!isInside(result, range)) {
          throw new AppError('PYTHON_ERROR', 'the tempo is outside the range that was asked for')
        }
        saveAnalysis(db, {
          trackId: track.id,
          type: 'bpm_key',
          result: { range, result },
          analyzerVersion: result.analyzerVersion
        })
      }
      return {
        proposal: {
          fields: {
            bpm: {
              value: Math.round(result.bpm),
              source: 'analysis',
              confidence: bpmConfidenceOf(result)
            },
            // Without a confidence: how sure a key is cannot be told from Essentia's
            // strength before it was compared with real tracks.
            key: { value: result.camelot, source: 'analysis' }
          }
        }
      }
    }
  }
}
