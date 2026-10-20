// The one-button full run (T-040): a state machine over the batches of the library.
// Its state is a setting, so a run goes on from the same step after a restart; the
// batches themselves are the orchestrator's, which goes on with them as always. It
// moves on by looking every two seconds whether its step is done.
import { z } from 'zod'
import type { BatchStatus } from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { getSetting, setSetting } from '../db/settings'
import { logger } from '../services/logger'
import { CUES_STAGE } from './stages/cues'
import { ENERGY_FEATURES_STAGE } from './stages/energy'
import { STEMS_STAGE } from './stages/stems'
import type { Result } from '@shared/errors'
import {
  FULL_RUN_STEPS,
  FULL_RUN_STOPS,
  fullRunStartSchema,
  type FullRunStep,
  type FullRunSummary,
  type FullRunView
} from '@shared/full-run'
import { PHASE_B_STEPS, type WizardState } from '@shared/rekordbox-wizard'

const STATE_KEY = 'fullRun'
export const FULL_RUN_TICK_MS = 2000

const stateSchema = z.object({
  step: z.enum(FULL_RUN_STEPS),
  stop: z.enum(FULL_RUN_STOPS).nullable(),
  calibrates: z.boolean(),
  /** Null for the whole library, read again for every batch. */
  trackIds: z.array(z.number().int()).nullable(),
  /** How many tracks were asked for when it started. */
  requested: z.number().int(),
  startedAt: z.number(),
  stepStartedAt: z.number(),
  /** The batch of the step, once it was started. */
  batchId: z.number().int().nullable(),
  /** The batch of all functions, for the summary. */
  mainBatchId: z.number().int().nullable(),
  stemsBatchId: z.number().int().nullable(),
  stemsDone: z.boolean(),
  summary: z.object({ processed: z.number(), skipped: z.number(), failed: z.number() }).nullable()
})
export type FullRunState = z.output<typeof stateSchema>

export interface FullRunDependencies {
  db: AppDatabase
  /** The tracks of the whole library, as a run would take them. */
  libraryTrackIds: () => number[]
  /** Starts a batch; RUN_ACTIVE while another one runs or waits, which is waited out. */
  startBatch: (request: { trackIds: number[]; stages: string[] }) => Result<{ batchId: number }>
  batchStatus: (batchId: number) => BatchStatus | undefined
  /** Gives up a batch that waits for approval; for the batches that propose nothing. */
  discardBatch: (batchId: number) => void
  /** How the main batch came out, for the summary. */
  batchCounts: (batchId: number) => { total: number; excluded: number; failed: number }
  /** Every function but the stems, the cues and the moods, as an Inbox batch runs. */
  computeStages: () => string[]
  hasEnergyModel: () => boolean
  wizardState: () => WizardState
  /** Phase A of the wizard from its start, the setup kept. */
  restartWizard: () => Promise<void>
  /** False until the app has recovered what it was doing at startup. */
  ready: () => boolean
  now?: () => number
}

export interface FullRun {
  start: (request: unknown) => Result<FullRunView>
  /** Ends the full run where it is; the batch of its step is left as it is. */
  stop: () => void
  view: () => FullRunView | null
  /** True while a full run goes on: the Inbox waits meanwhile. */
  active: () => boolean
  /** Looks whether the step is done and moves on; called every two seconds. */
  tick: () => Promise<void>
}

/** True once the wizard is past the check of phase A. */
export function phaseADone(state: WizardState): boolean {
  return (
    state.step === 'doneA' ||
    state.step === 'doneB' ||
    (PHASE_B_STEPS as readonly string[]).includes(state.step)
  )
}

function viewOf(state: FullRunState): FullRunView {
  return {
    step: state.step,
    stop: state.stop,
    calibrates: state.calibrates,
    startedAt: state.startedAt,
    stepStartedAt: state.stepStartedAt,
    stemsRunning: state.stemsBatchId !== null && !state.stemsDone,
    summary: state.summary
  }
}

export function createFullRun(dependencies: FullRunDependencies): FullRun {
  const { db } = dependencies
  const now = dependencies.now ?? Date.now
  let ticking = false

  function read(): FullRunState | null {
    try {
      return getSetting(db, STATE_KEY, stateSchema) ?? null
    } catch {
      logger.warn('The state of the full run could not be read; no full run goes on')
      return null
    }
  }

  function write(state: FullRunState): void {
    setSetting(db, STATE_KEY, state)
  }

  const isActive = (state: FullRunState | null): state is FullRunState =>
    state !== null && state.step !== 'done' && state.stop === null

  function enter(state: FullRunState, step: FullRunStep): FullRunState {
    logger.info(`Full run: ${state.step} -> ${step}`)
    return { ...state, step, stepStartedAt: now(), batchId: null }
  }

  function ended(state: FullRunState, stop: FullRunState['stop']): FullRunState {
    logger.info(`Full run stopped at ${state.step}: ${stop}`)
    return { ...state, stop, stepStartedAt: now() }
  }

  function tracksOf(state: FullRunState): number[] {
    return state.trackIds ?? dependencies.libraryTrackIds()
  }

  /** Starts the batch of a step; null while another batch is in the way. */
  function startBatch(state: FullRunState, stages: string[]): number | null {
    const started = dependencies.startBatch({ trackIds: tracksOf(state), stages })
    if (started.ok) return started.value.batchId
    if (started.code !== 'RUN_ACTIVE')
      logger.warn(`Full run: a batch did not start: ${started.code}`)
    return null
  }

  /** What a batch that ended against the run's will means for it. */
  function stopFor(status: BatchStatus | undefined): FullRunState['stop'] {
    return status === 'failed' ? 'failed' : 'cancelled'
  }

  /**
   * The stems of the tracks, made in a batch of their own that proposes nothing: it is
   * given up once computed. Runs beside phase A and is waited for before the cues.
   */
  function advanceStems(state: FullRunState): FullRunState {
    if (state.stemsDone) return state
    if (state.stemsBatchId === null) {
      const batchId = startBatch(state, [STEMS_STAGE])
      return batchId === null ? state : { ...state, stemsBatchId: batchId }
    }
    const status = dependencies.batchStatus(state.stemsBatchId)
    if (status === 'computing') return state
    if (status === 'preview') dependencies.discardBatch(state.stemsBatchId)
    // Given up, cancelled or failed: the cues take what stems there are.
    return { ...state, stemsDone: true }
  }

  function summaryOf(state: FullRunState): FullRunSummary | null {
    if (state.mainBatchId === null) return null
    const counts = dependencies.batchCounts(state.mainBatchId)
    return {
      processed: counts.total - counts.excluded - counts.failed,
      skipped: Math.max(0, state.requested - counts.total) + counts.excluded,
      failed: counts.failed
    }
  }

  /** One step forward, if its condition holds; the state as it is otherwise. */
  async function advance(state: FullRunState): Promise<FullRunState> {
    const status = state.batchId === null ? undefined : dependencies.batchStatus(state.batchId)
    switch (state.step) {
      case 'features': {
        // Only measures: what the calibration rates. Given up once computed.
        if (state.batchId === null) {
          const batchId = startBatch(state, [ENERGY_FEATURES_STAGE])
          return batchId === null ? state : { ...state, batchId }
        }
        if (status === 'computing') return state
        if (status === 'preview') dependencies.discardBatch(state.batchId)
        // Approved by hand, it wrote nothing: the measures are kept all the same.
        if (status === 'preview' || status === 'applied') return enter(state, 'calibration')
        return ended(state, stopFor(status))
      }
      case 'calibration':
        return dependencies.hasEnergyModel() ? enter(state, 'compute') : state
      case 'compute': {
        if (state.batchId === null) {
          const batchId = startBatch(state, dependencies.computeStages())
          return batchId === null ? state : { ...state, batchId, mainBatchId: batchId }
        }
        if (status === 'computing') return state
        // Approved between two looks, it may be past its preview already.
        if (status === 'preview' || status === 'applying' || status === 'applied') {
          return { ...enter(state, 'preview'), batchId: state.batchId }
        }
        return ended(state, stopFor(status))
      }
      case 'preview':
      case 'apply': {
        if (status === 'preview') return state
        if (status === 'applying') {
          return state.step === 'apply'
            ? state
            : { ...enter(state, 'apply'), batchId: state.batchId }
        }
        if (status === 'applied') {
          // A wizard done in an earlier run goes through phase A again for these files.
          if (phaseADone(dependencies.wizardState())) await dependencies.restartWizard()
          return advanceStems(enter(state, 'rekordboxA'))
        }
        return ended(state, stopFor(status))
      }
      case 'rekordboxA': {
        const next = advanceStems(state)
        return phaseADone(dependencies.wizardState()) ? enter(next, 'cues') : next
      }
      case 'cues': {
        const withStems = advanceStems(state)
        if (!withStems.stemsDone) return withStems
        if (withStems.batchId === null) {
          const batchId = startBatch(withStems, [CUES_STAGE])
          return batchId === null ? withStems : { ...withStems, batchId }
        }
        if (status === 'computing' || status === 'preview' || status === 'applying') {
          return withStems
        }
        if (status === 'applied') return enter(withStems, 'rekordboxB')
        return ended(withStems, stopFor(status))
      }
      case 'rekordboxB':
        return dependencies.wizardState().step === 'doneB'
          ? { ...enter(state, 'done'), summary: summaryOf(state) }
          : state
      case 'done':
        return state
    }
  }

  return {
    start(request) {
      const parsed = fullRunStartSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      if (isActive(read())) return { ok: false, code: 'RUN_ACTIVE' }
      const trackIds = parsed.data.trackIds
      const requested = trackIds?.length ?? dependencies.libraryTrackIds().length
      if (requested === 0) return { ok: false, code: 'INVALID_INPUT' }
      const calibrates = !dependencies.hasEnergyModel()
      const at = now()
      const state: FullRunState = {
        step: calibrates ? 'features' : 'compute',
        stop: null,
        calibrates,
        trackIds,
        requested,
        startedAt: at,
        stepStartedAt: at,
        batchId: null,
        mainBatchId: null,
        stemsBatchId: null,
        stemsDone: false,
        summary: null
      }
      write(state)
      logger.info(`Full run started for ${requested} tracks at ${state.step}`)
      return { ok: true, value: viewOf(state) }
    },

    stop() {
      const state = read()
      if (isActive(state)) write(ended(state, 'stopped'))
    },

    view() {
      const state = read()
      return state === null ? null : viewOf(state)
    },

    active: () => isActive(read()),

    async tick() {
      if (ticking || !dependencies.ready()) return
      ticking = true
      try {
        let state = read()
        // As many steps as are done already: after a restart, several may be.
        for (let guard = 0; isActive(state) && guard < FULL_RUN_STEPS.length; guard += 1) {
          const next = await advance(state)
          if (JSON.stringify(next) === JSON.stringify(state)) break
          write(next)
          state = next
        }
      } catch (error) {
        logger.error('The full run could not move on', error)
      } finally {
        ticking = false
      }
    }
  }
}
