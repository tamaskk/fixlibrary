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
  /** Gives up a batch that waits for approval; false when the preview refused it just now. */
  discardBatch: (batchId: number) => boolean
  /** True when a batch proposes any change: such a batch is never given up for the user. */
  hasProposals: (batchId: number) => boolean
  /** Ends the batch that computes, if it is this one. */
  cancelBatch: (batchId: number) => void
  /** The batch that waits for approval, if any. */
  previewBatchId: () => number | null
  /** True while a batch is computed or applied. */
  runBusy: () => boolean
  /** How the main batch came out, for the summary. */
  batchCounts: (batchId: number) => { total: number; excluded: number; failed: number }
  /** Every function but the stems, the cues and the moods, as an Inbox batch runs. */
  computeStages: () => string[]
  hasEnergyModel: () => boolean
  wizardState: () => WizardState
  /** Phase A of the wizard from its start, the setup kept; false when it was refused. */
  restartWizard: () => Promise<boolean>
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

function viewOf(state: FullRunState, waitingFor: FullRunView['waitingFor']): FullRunView {
  return {
    waitingFor,
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
  let unreadableLogged = false
  // What the step waited for at the last look; not kept, it is looked at again.
  let waitingFor: FullRunView['waitingFor'] = null

  function read(): FullRunState | null {
    try {
      return getSetting(db, STATE_KEY, stateSchema) ?? null
    } catch {
      if (!unreadableLogged) {
        logger.warn('The state of the full run could not be read; no full run goes on')
        unreadableLogged = true
      }
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

  /**
   * Starts a batch: its id, `wait` while another batch is in the way (tried again at
   * the next look), or `refused` when it cannot start at all, such as with no track left.
   */
  function startBatch(state: FullRunState, stages: string[]): number | 'wait' | 'refused' {
    // A start gives up the batch that waits for approval: never one of the user's.
    const waiting = dependencies.previewBatchId()
    if (waiting !== null && waiting !== state.batchId && waiting !== state.stemsBatchId) {
      waitingFor = 'preview'
      return 'wait'
    }
    // Asked before the tracks are read, which for a whole library is not nothing.
    if (dependencies.runBusy()) {
      waitingFor = 'run'
      return 'wait'
    }
    const started = dependencies.startBatch({ trackIds: tracksOf(state), stages })
    if (!started.ok && started.code === 'RUN_ACTIVE') waitingFor = 'run'
    if (started.ok) return started.value.batchId
    if (started.code === 'RUN_ACTIVE') return 'wait'
    logger.warn(`Full run: a batch of ${stages.join(', ')} did not start: ${started.code}`)
    return 'refused'
  }

  /** The batch of the step: started, waited for, or the end of the run when refused. */
  function begin(
    state: FullRunState,
    stages: string[],
    place: (batchId: number) => FullRunState
  ): FullRunState {
    const started = startBatch(state, stages)
    if (started === 'wait') return state
    return started === 'refused' ? ended(state, 'failed') : place(started)
  }

  /**
   * Gives up a batch that waits for approval and proposes nothing. False while it
   * cannot be given up now, or proposes something: then it is the user's to approve.
   */
  function giveUp(batchId: number): boolean {
    if (dependencies.hasProposals(batchId)) return false
    return dependencies.discardBatch(batchId)
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
      const started = startBatch(state, [STEMS_STAGE])
      if (started === 'wait') return state
      // Without stems the cues take what stems there are; the run goes on.
      return started === 'refused'
        ? { ...state, stemsDone: true }
        : { ...state, stemsBatchId: started }
    }
    const status = dependencies.batchStatus(state.stemsBatchId)
    if (status === 'computing' || status === 'applying') return state
    if (status === 'preview' && !giveUp(state.stemsBatchId)) return state
    // Given up, cancelled or failed: the cues take what stems there are.
    return { ...state, stemsDone: true }
  }

  function summaryOf(state: FullRunState): FullRunSummary | null {
    if (state.mainBatchId === null) return null
    const counts = dependencies.batchCounts(state.mainBatchId)
    return {
      // A row both left out and failed is counted in both: never below nothing.
      processed: Math.max(0, counts.total - counts.excluded - counts.failed),
      skipped: Math.max(0, state.requested - counts.total) + counts.excluded,
      failed: counts.failed
    }
  }

  /** One step forward, if its condition holds; the state as it is otherwise. */
  async function advance(state: FullRunState): Promise<FullRunState> {
    const status = state.batchId === null ? undefined : dependencies.batchStatus(state.batchId)
    // Undone after it was written: what follows would work on files put back.
    const afterApply = ['rekordboxA', 'cues', 'rekordboxB'].includes(state.step)
    if (
      afterApply &&
      state.mainBatchId !== null &&
      dependencies.batchStatus(state.mainBatchId) === 'undone'
    ) {
      return ended(state, 'cancelled')
    }
    switch (state.step) {
      case 'features': {
        // Only measures: what the calibration rates. Given up once computed.
        if (state.batchId === null) {
          return begin(state, [ENERGY_FEATURES_STAGE], (batchId) => ({ ...state, batchId }))
        }
        if (status === 'computing' || status === 'applying') return state
        if (status === 'preview' && !giveUp(state.batchId)) return state
        // Approved by hand, it wrote nothing: the measures are kept all the same.
        if (status === 'preview' || status === 'applied') return enter(state, 'calibration')
        return ended(state, stopFor(status))
      }
      case 'calibration':
        return dependencies.hasEnergyModel() ? enter(state, 'compute') : state
      case 'compute': {
        if (state.batchId === null) {
          return begin(state, dependencies.computeStages(), (batchId) => ({
            ...state,
            batchId,
            mainBatchId: batchId
          }))
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
          // Phase A again from its start for these files, also when an earlier run
          // left it half done: an XML written before this apply must not count.
          if (dependencies.wizardState().setupDone && !(await dependencies.restartWizard())) {
            return ended(state, 'failed')
          }
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
          return begin(withStems, [CUES_STAGE], (batchId) => ({ ...withStems, batchId }))
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
      waitingFor = null
      logger.info(`Full run started for ${requested} tracks at ${state.step}`)
      return { ok: true, value: viewOf(state, null) }
    },

    stop() {
      const state = read()
      if (!isActive(state)) return
      // The stems are the run's own and propose nothing: they do not go on without it.
      if (state.stemsBatchId !== null && !state.stemsDone) {
        const status = dependencies.batchStatus(state.stemsBatchId)
        if (status === 'computing') dependencies.cancelBatch(state.stemsBatchId)
        if (status === 'preview') giveUp(state.stemsBatchId)
      }
      write(ended(state, 'stopped'))
    },

    view() {
      const state = read()
      return state === null ? null : viewOf(state, isActive(state) ? waitingFor : null)
    },

    active: () => isActive(read()),

    async tick() {
      if (ticking || !dependencies.ready()) return
      ticking = true
      try {
        let state = read()
        waitingFor = null
        // As many steps as are done already: after a restart, several may be.
        for (let guard = 0; isActive(state) && guard < FULL_RUN_STEPS.length; guard += 1) {
          const next = await advance(state)
          if (JSON.stringify(next) === JSON.stringify(state)) break
          // A stop or a new start that came while this step waited wins.
          const stored = read()
          if (stored?.startedAt !== state.startedAt || stored.stop !== null) break
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
