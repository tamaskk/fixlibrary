import type { Track } from '../../db/tracks'
import type { TrackFiles } from '../batch-files'
import type { JobPhase, Resource } from '@shared/pipeline'
import type { PreviewField, PreviewValue, PreviewWarning, Proposal } from '@shared/preview'

export interface StageContext {
  /**
   * Aborted when the stage runs out of time or the run is cancelled. A stage that
   * writes a file must stop on it and never rename a temp file into place afterwards.
   */
  signal: AbortSignal
  batchId: number
  /**
   * The only way a stage can change the file of its track: backed up or copied
   * first, written in one step. Null in the compute phase, which changes no file.
   */
  files: TrackFiles | null
  /**
   * What the batch holds for the track when the stage starts: the proposals of the
   * stages before it, with what the user changed in the preview.
   */
  proposal: Proposal & Record<string, unknown>
  /**
   * True when the user asked for this track to be looked at afresh: a stage that
   * keeps answers of an online service asks the service again.
   */
  refresh?: boolean
}

export interface StageResult {
  /**
   * What the stage proposes for the track. It is merged into the item of the batch.
   * `fields` and `warnings` are what the batch preview shows; anything else is the
   * stage's own, for its apply stage to read.
   */
  proposal?: Proposal & Record<string, unknown>
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
  /**
   * Stages of the same phase that must be done for the same track first when they
   * are part of the batch, and are not brought into it otherwise. For two stages
   * that change one file: their steps must not be mixed, whichever was asked for.
   * If such a stage fails for a track, this one does not run for it.
   */
  after?: readonly string[]
  /** True for a stage the user can ask for by itself in the function chooser. */
  selectable: boolean
  timeoutMs: number
  run: (context: StageContext, track: Track) => Promise<StageResult | void>
  /**
   * For a compute stage whose proposal follows from other fields, such as a file
   * name: proposes again after the user changed a field in the preview. `values` are
   * the fields as the preview shows them now. It must be quick and touch nothing: no
   * file, no network, no database.
   */
  recompute?: (track: Track, values: Record<PreviewField, PreviewValue>) => Proposal | void
  /**
   * For a compute stage that looks at the tracks of a batch together, such as the
   * search for duplicates: called once every track of the batch is computed, and
   * again whenever the user changed a row in the preview. It reads and writes the
   * items of the batch only, and must give the same result when it is called twice.
   * Returns true when it changed anything about the batch.
   */
  regroup?: (batchId: number) => boolean
  /**
   * True for a stage whose result the user can ask for again from the preview, for
   * one track: it is then run once more with `context.refresh` set.
   */
  refreshable?: boolean
  /**
   * The fields a refreshable stage proposes. When it is asked again, what it proposed
   * for them before is dropped first, so a row never mixes two answers; a field the
   * user set by hand stays.
   */
  proposes?: readonly PreviewField[]
  /**
   * The warnings this stage reports. When it proposes again after an edit, those are
   * replaced by what it reports then; the warnings of other stages stay.
   */
  warnings?: readonly PreviewWarning[]
}
