import { z } from 'zod'
import { getAnalysis } from '../../db/analyses'
import type { AppDatabase } from '../../db/connection'
import { listTrackCues } from '../../db/cues'
import type { Track } from '../../db/tracks'
import { describeError } from '../../services/error-text'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { cueLettersOf } from '@shared/cues'
import { AppError } from '@shared/errors'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { CuesEntry } from '../cues'
import { rbGridSchema } from '../rekordbox-import'
import type { Stage } from './stage'
import { keptStems, STEMS_STAGE } from './stems'

export const CUES_STAGE = 'cues'

export interface CuesStageDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

/** The grid Rekordbox analysed for the track, read from its export (T-026), or null. */
function gridOf(db: AppDatabase, trackId: number): z.output<typeof rbGridSchema> | null {
  try {
    const stored = getAnalysis(db, trackId, 'rb_grid', z.unknown())
    const parsed = rbGridSchema.safeParse(stored?.result)
    return parsed.success && parsed.data.tempos.length > 0 ? parsed.data : null
  } catch (error) {
    logger.warn(`The grid of track ${trackId} is unreadable: ${describeError(error)}`)
    return null
  }
}

/**
 * Places the eight hot cues of a track (T-029) by the rules of the sidecar, from its
 * stem envelopes (T-028) and the grid Rekordbox analysed: A Start, B Bassline, C Vocal,
 * D Drop 1, E Breakdown, F Drop 2, G Outro, H Drop 3, each on a beat of that grid. A
 * track without the grid gets none and the warning `NO_GRID`, one where the structure
 * finds no cue keeps its cues and warns `NO_CUES`; a slot emptied because it
 * broke the order of the scheme brings `CUE_REVIEW`. The cues become the track's when
 * the batch is approved.
 */
export function createCuesStage(dependencies: CuesStageDependencies): Stage {
  const { db } = dependencies
  return {
    name: CUES_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [STEMS_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.cues,
    run: async ({ signal }, track: Track) => {
      const grid = gridOf(db, track.id)
      if (!grid) return { proposal: { warnings: ['NO_GRID'] } }
      const stems = keptStems(db, track)
      if (!stems) throw new AppError('PYTHON_ERROR', 'the track has no stems')
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      const durationSeconds =
        track.durationMs !== null && track.durationMs > 0
          ? track.durationMs / 1000
          : stems.result.durationSeconds
      const result = await python.call(
        'analysis.structure',
        { trackId: track.id, grid: grid.tempos, durationSeconds },
        { timeoutMs: STAGE_TIMEOUTS_MS.cues }
      )
      if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
      // Approving an empty proposal would empty every slot not placed by hand.
      if (result.cues.length === 0) return { proposal: { warnings: ['NO_CUES'] } }
      const entry: CuesEntry = {
        slots: result.cues.map(({ slot, timeSec }) => ({
          slot,
          positionMs: Math.round(timeSec * 1000)
        })),
        before: cueLettersOf(listTrackCues(db, track.id))
      }
      return {
        proposal: {
          fields: { cues: { value: cueLettersOf(entry.slots), source: 'analysis' } },
          ...(result.review ? { warnings: ['CUE_REVIEW'] } : {}),
          cues: entry
        }
      }
    }
  }
}
