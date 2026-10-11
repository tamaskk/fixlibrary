import type { Track } from '../../db/tracks'
import type { JobPhase, Resource } from '@shared/pipeline'

export interface StageContext {
  /**
   * Aborted when the stage runs out of time or the run is cancelled. A stage that
   * writes a file must stop on it and never rename a temp file into place afterwards.
   */
  signal: AbortSignal
  batchId: number
}

export interface StageResult {
  /** What the stage proposes for the track. It is merged into the item of the batch. */
  proposal?: Record<string, unknown>
}

/**
 * One step of the pipeline for one track. A compute stage reads and proposes and
 * never changes a library file; an apply stage writes, through `services/file-ops.ts`,
 * and runs only for tracks the user approved.
 */
export interface Stage {
  /** Also the name in `jobs.stage` and on the "Hibák" tab. Never change it once used. */
  name: string
  phase: JobPhase
  resource: Resource
  /** Stages that must be done for the same track first. */
  dependsOn: readonly string[]
  timeoutMs: number
  run: (context: StageContext, track: Track) => Promise<StageResult | void>
}
