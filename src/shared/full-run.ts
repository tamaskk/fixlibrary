// The one-button full run (T-040): every function in order, with the steps the user
// takes in between (calibration, approval, Rekordbox), as one process that goes on
// after a restart. Main keeps its state; the page shows it.
import { z } from 'zod'

/**
 * The steps in order. `features` and `calibration` come only while there is no energy
 * model. The stems are made after the apply, from the final files, while the user
 * works through phase A in Rekordbox.
 */
export const FULL_RUN_STEPS = [
  'features',
  'calibration',
  'compute',
  'preview',
  'apply',
  'rekordboxA',
  'cues',
  'rekordboxB',
  'done'
] as const
export type FullRunStep = (typeof FULL_RUN_STEPS)[number]

/** Why a full run ended before its end: a batch was given up, cancelled or failed. */
export const FULL_RUN_STOPS = ['cancelled', 'failed', 'stopped'] as const
export type FullRunStop = (typeof FULL_RUN_STOPS)[number]

export interface FullRunSummary {
  /** The tracks written by the batch of all functions. */
  processed: number
  /** Asked for but left out: not available when it started, or excluded in the preview. */
  skipped: number
  /** Tracks a function failed for. */
  failed: number
}

export interface FullRunView {
  step: FullRunStep
  /**
   * What the step waits for at the moment: a batch that waits for the user's approval
   * (which a new batch would give up), or another batch that is computed or applied.
   */
  waitingFor: 'preview' | 'run' | null
  /** Set when the run ended before `done`. */
  stop: FullRunStop | null
  /** True when the run measures and calibrates the energy first. */
  calibrates: boolean
  /** In ms since the epoch. */
  startedAt: number
  stepStartedAt: number
  /** True while the stems are still being made in the background. */
  stemsRunning: boolean
  /** Set once the run is done. */
  summary: FullRunSummary | null
}

/** What starts a full run: the selected tracks, or none for the whole library. */
export const fullRunStartSchema = z.strictObject({
  trackIds: z.array(z.number().int().positive()).max(100_000).nullable()
})
export type FullRunStart = z.input<typeof fullRunStartSchema>
