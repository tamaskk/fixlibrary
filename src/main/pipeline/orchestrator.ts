// Runs the stages of a batch over its tracks: in dependency order, within the limits
// of each resource, and from the `jobs` table, so a run survives a restart of the app.
import {
  cancelPreviewBatches,
  createBatch,
  findActiveBatch,
  getBatch,
  listBatchItemStates,
  mergeBatchItemProposal,
  setBatchItemError,
  setBatchPaused,
  setBatchStatus,
  type Batch,
  type BatchMode
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import {
  finishJob,
  insertJobs,
  listJobs,
  markJobRunning,
  recoverInterruptedJobs,
  skipJobs,
  type JobStatus,
  type NewJob
} from '../db/jobs'
import { getTrackById, type Track } from '../db/tracks'
import { logger } from '../services/logger'
import { AppError, TRACK_ERROR_MESSAGES, type Result, type TrackError } from '@shared/errors'
import {
  runStartSchema,
  type JobCounts,
  type JobPhase,
  type ResourceLimits,
  type RunProgress
} from '@shared/pipeline'
import { createJobQueue } from './queue'
import { runStage } from './run-stage'
import { withDependencies } from './stages'
import type { Stage } from './stages/stage'

// A job that was running when the app stopped is started again. One that was
// interrupted this often is the likely reason the app stops, and is given up.
const DEFAULT_MAX_ATTEMPTS = 3
// The time left is estimated from the jobs that finished last.
const DURATION_SAMPLES = 50
const MIN_DURATION_SAMPLES = 3

export interface OrchestratorDependencies {
  db: AppDatabase
  /** Must have passed `validateStages`. */
  stages: readonly Stage[]
  /** Read whenever a job could start, so a changed worker count applies at once. */
  limits: () => ResourceLimits
  listMountedVolumes: () => ReadonlySet<string>
  /** In place or clean library, as the settings say when a run starts. */
  mode: () => BatchMode
  onProgress?: (progress: RunProgress) => void
  /** True while jobs run or may start by themselves; the app must not sleep then. */
  onBusyChange?: (busy: boolean) => void
  now?: () => number
  maxAttempts?: number
}

export interface Orchestrator {
  /** Starts the compute phase of a new batch for the given tracks and stages. */
  start: (request: unknown) => Result<{ batchId: number }>
  /** Starts the apply phase of a batch that waits for approval. */
  applyBatch: (batchId: number) => Result<{ batchId: number }>
  /** At startup: goes on with the batch the app was working on when it stopped. */
  recover: () => void
  /** No new job starts; the running ones finish. */
  pause: () => void
  resume: () => void
  /** Stops the running jobs and ends the batch as cancelled. Resolves when it has ended. */
  cancel: () => Promise<void>
  /**
   * For quitting the app: tells the running jobs to stop and records nothing, so the
   * next start finds them interrupted and goes on with the batch.
   */
  shutdown: () => void
  progress: () => RunProgress | null
  /** Resolves when no run is active any more; at once if there is none. */
  whenFinished: () => Promise<void>
}

interface RunJob {
  id: number
  trackId: number
  stage: Stage
  status: JobStatus
}

type AbortReason = 'cancel' | 'shutdown'

interface Run {
  batchId: number
  phase: JobPhase
  /** The jobs of every phase by track and stage name: a stage looks its dependencies up here. */
  byTrack: Map<number, Map<string, RunJob>>
  /** The jobs of the phase that is running. */
  phaseJobs: RunJob[]
  /** Counted as the jobs change, per stage, in the order the stages run. */
  counts: Map<string, JobCounts>
  controllers: Map<number, AbortController>
  pauseReason: 'user' | 'offline' | null
  cancelling: boolean
  startedAt: number
  /** How long the last jobs took, for the estimate. */
  durations: number[]
  /** Jobs of this phase that are running now. */
  running: number
  /** Jobs of this phase that are neither done, failed nor skipped. */
  unfinished: number
}

/** A track as it is stored, for the `before` of a batch item that undo restores from. */
function snapshotOf(track: Track): Record<string, unknown> {
  const before: Record<string, unknown> = { ...track }
  // Not a property of the track: it says whether the drive was connected at that moment.
  delete before['offline']
  return before
}

function emptyCounts(): JobCounts {
  return { total: 0, done: 0, failed: 0, skipped: 0, running: 0 }
}

export function createOrchestrator(dependencies: OrchestratorDependencies): Orchestrator {
  const { db, stages, listMountedVolumes, onProgress, onBusyChange } = dependencies
  const now = dependencies.now ?? Date.now
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const stagesByName = new Map(stages.map((stage) => [stage.name, stage]))

  let run: Run | null = null
  let busy = false
  let finishedWaiters: (() => void)[] = []

  const queue = createJobQueue<RunJob>({
    limits: dependencies.limits,
    resourceOf: (job) => job.stage.resource,
    run: executeJob
  })

  function updateBusy(): void {
    // Paused with nothing running: the Mac may sleep until the user resumes.
    const nowBusy = run !== null && (run.pauseReason === null || run.running > 0)
    if (nowBusy === busy) return
    busy = nowBusy
    onBusyChange?.(busy)
  }

  function snapshot(active: Run, state: RunProgress['state']): RunProgress {
    const total = emptyCounts()
    const perStage = [...active.counts].map(([stage, counts]) => {
      for (const key of Object.keys(total) as (keyof JobCounts)[]) total[key] += counts[key]
      return { stage, ...counts }
    })
    const left = total.total - total.done - total.failed - total.skipped
    const samples = active.durations
    const average = samples.reduce((sum, each) => sum + each, 0) / Math.max(1, samples.length)
    return {
      batchId: active.batchId,
      phase: active.phase,
      state,
      pauseReason: active.pauseReason,
      counts: total,
      stages: perStage,
      startedAt: active.startedAt,
      remainingMs:
        samples.length < MIN_DURATION_SAMPLES
          ? null
          : Math.round((average * left) / Math.max(1, total.running))
    }
  }

  function currentState(active: Run): RunProgress['state'] {
    if (active.cancelling) return 'cancelling'
    return active.pauseReason === null ? 'running' : 'paused'
  }

  function report(): void {
    if (run) onProgress?.(snapshot(run, currentState(run)))
  }

  /** Changes the status of a job in memory and keeps the counts in step. */
  function setStatus(active: Run, job: RunJob, status: JobStatus): void {
    const counts = active.counts.get(job.stage.name)
    if (counts && job.stage.phase === active.phase) {
      if (job.status === 'running') {
        counts.running -= 1
        active.running -= 1
      }
      if (status === 'running') {
        counts.running += 1
        active.running += 1
      }
      if (status === 'done' || status === 'failed' || status === 'skipped') {
        counts[status] += 1
        active.unfinished -= 1
      }
    }
    job.status = status
  }

  function dependentsOf(active: Run, job: RunJob): RunJob[] {
    const ofTrack = active.byTrack.get(job.trackId)
    if (!ofTrack) return []
    return [...ofTrack.values()].filter(
      (other) =>
        other.stage.phase === active.phase && other.stage.dependsOn.includes(job.stage.name)
    )
  }

  /** Marks a job, and every job that waits for it, as not going to run. */
  function skipWithDependents(active: Run, job: RunJob): void {
    const skipped: RunJob[] = []
    const visit = (each: RunJob): void => {
      if (each.status !== 'queued') return
      setStatus(active, each, 'skipped')
      skipped.push(each)
      dependentsOf(active, each).forEach(visit)
    }
    visit(job)
    skipJobs(
      db,
      skipped.map((each) => each.id)
    )
  }

  /** Lines a queued job up if what it depends on is done, or skips it if that failed. */
  function resolve(active: Run, job: RunJob): void {
    if (job.status !== 'queued') return
    const ofTrack = active.byTrack.get(job.trackId)
    // A dependency that is not part of this batch was not asked for: nothing to wait for.
    const waitsFor = job.stage.dependsOn
      .map((name) => ofTrack?.get(name))
      .filter((dependency): dependency is RunJob => dependency !== undefined)
    if (
      waitsFor.some(
        (dependency) => dependency.status === 'failed' || dependency.status === 'skipped'
      )
    ) {
      skipWithDependents(active, job)
    } else if (waitsFor.every((dependency) => dependency.status === 'done')) {
      queue.add(job)
    }
  }

  function fail(active: Run, job: RunJob, error: TrackError): void {
    finishJob(db, job.id, { status: 'failed', error })
    setBatchItemError(db, active.batchId, error)
    setStatus(active, job, 'failed')
    for (const dependent of dependentsOf(active, job)) skipWithDependents(active, dependent)
  }

  function trackError(job: RunJob, code: TrackError['code']): TrackError {
    return {
      trackId: job.trackId,
      stage: job.stage.name,
      code,
      message: TRACK_ERROR_MESSAGES[code]
    }
  }

  function endPhaseIfDone(): void {
    const active = run
    if (!active || active.unfinished > 0) return

    const status = active.cancelling
      ? 'cancelled'
      : active.phase === 'compute'
        ? // The proposals wait for the user's approval; nothing is written before that.
          'preview'
        : 'applied'
    setBatchStatus(db, active.batchId, status)
    setBatchPaused(db, active.batchId, false)
    logger.info(`Batch ${active.batchId}: the ${active.phase} phase ended as ${status}`)
    onProgress?.(snapshot(active, 'finished'))
    run = null
    queue.resume()
    updateBusy()
    const waiters = finishedWaiters
    finishedWaiters = []
    for (const done of waiters) done()
  }

  function pauseBecause(reason: 'user' | 'offline'): void {
    if (!run || run.cancelling || run.pauseReason !== null) return
    run.pauseReason = reason
    queue.pause()
    setBatchPaused(db, run.batchId, true)
    logger.info(`Batch ${run.batchId} paused (${reason})`)
    report()
    updateBusy()
  }

  /** Runs one job. Never rejects: the queue relies on that. */
  async function executeJob(job: RunJob): Promise<void> {
    const active = run
    if (!active || active.cancelling || job.status !== 'queued') return
    try {
      const track = getTrackById(db, job.trackId, listMountedVolumes())
      if (track?.offline) {
        // The drive went away: that is not the track's fault. The run waits for the
        // drive instead of failing every track that is left.
        pauseBecause('offline')
        queue.addFirst(job)
        return
      }
      if (!track || track.fileMissing) {
        fail(active, job, trackError(job, 'FILE_UNREADABLE'))
        return
      }

      const controller = new AbortController()
      active.controllers.set(job.id, controller)
      markJobRunning(db, job.id)
      setStatus(active, job, 'running')
      report()

      const startedAt = now()
      const stopped = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new AppError('UNEXPECTED', 'the run was stopped'))
        )
      })
      // The stage also loses when it does not stop by itself: a cancel must not wait
      // for a stage that ignores its signal.
      const outcome = await runStage(
        { trackId: job.trackId, stage: job.stage.name, timeoutMs: job.stage.timeoutMs },
        (timeout) => {
          // Stopped before the stage got to start: it must not start at all.
          if (controller.signal.aborted) return stopped
          return Promise.race([
            job.stage.run(
              { signal: AbortSignal.any([timeout, controller.signal]), batchId: active.batchId },
              track
            ),
            stopped
          ])
        }
      )
      active.controllers.delete(job.id)

      const reason = controller.signal.aborted ? (controller.signal.reason as AbortReason) : null
      if (reason === 'shutdown') {
        // Left as it is: the next start of the app finds the job interrupted.
        setStatus(active, job, 'queued')
        return
      }
      if (reason === 'cancel') {
        finishJob(db, job.id, { status: 'skipped' })
        setStatus(active, job, 'skipped')
        return
      }
      if (!outcome.ok) {
        fail(active, job, outcome.error)
        return
      }

      const proposal = outcome.value?.proposal
      if (proposal) mergeBatchItemProposal(db, active.batchId, job.trackId, proposal)
      finishJob(db, job.id, { status: 'done' })
      setStatus(active, job, 'done')
      active.durations.push(now() - startedAt)
      if (active.durations.length > DURATION_SAMPLES) active.durations.shift()
      for (const dependent of dependentsOf(active, job)) resolve(active, dependent)
    } catch (error) {
      // The database refused something, or a stage returned what cannot be stored.
      logger.error(`Job ${job.id} (${job.stage.name}) could not be recorded`, error)
      active.controllers.delete(job.id)
      try {
        fail(active, job, trackError(job, 'UNEXPECTED'))
      } catch (secondError) {
        logger.error(`Job ${job.id} could not be marked as failed`, secondError)
        setStatus(active, job, 'failed')
      }
    } finally {
      if (run === active) {
        report()
        updateBusy()
        endPhaseIfDone()
      }
    }
  }

  /** Builds the state of a batch from its jobs and lines up what can run. */
  function begin(batch: Batch, phase: JobPhase, options: { paused: boolean }): void {
    const active: Run = {
      batchId: batch.id,
      phase,
      byTrack: new Map(),
      phaseJobs: [],
      counts: new Map(),
      controllers: new Map(),
      pauseReason: options.paused ? 'user' : null,
      cancelling: false,
      startedAt: now(),
      durations: [],
      running: 0,
      unfinished: 0
    }

    const withoutStage: number[] = []
    for (const row of listJobs(db, batch.id)) {
      const stage = stagesByName.get(row.stage)
      if (!stage) {
        // A stage this version of the app no longer has.
        if (row.status === 'queued' || row.status === 'running') withoutStage.push(row.id)
        continue
      }
      const job: RunJob = { id: row.id, trackId: row.trackId, stage, status: row.status }
      const ofTrack = active.byTrack.get(row.trackId) ?? new Map<string, RunJob>()
      ofTrack.set(stage.name, job)
      active.byTrack.set(row.trackId, ofTrack)
      if (stage.phase !== phase) continue
      active.phaseJobs.push(job)
      const counts = active.counts.get(stage.name) ?? emptyCounts()
      counts.total += 1
      if (job.status === 'done' || job.status === 'failed' || job.status === 'skipped') {
        counts[job.status] += 1
      } else {
        active.unfinished += 1
      }
      active.counts.set(stage.name, counts)
    }
    skipJobs(db, withoutStage)

    run = active
    if (options.paused) queue.pause()

    if (phase === 'apply') {
      // Only what the user approved is written.
      const approved = new Set(
        listBatchItemStates(db, batch.id)
          .filter((item) => item.approved && !item.excluded)
          .map((item) => item.trackId)
      )
      for (const job of active.phaseJobs) {
        if (!approved.has(job.trackId)) skipWithDependents(active, job)
      }
    }
    for (const job of active.phaseJobs) resolve(active, job)

    report()
    updateBusy()
    endPhaseIfDone()
  }

  return {
    start(request) {
      const parsed = runStartSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      if (run !== null || findActiveBatch(db) !== undefined)
        return { ok: false, code: 'RUN_ACTIVE' }

      const selected = withDependencies(stages, parsed.data.stages)
      if (selected === null) return { ok: false, code: 'INVALID_INPUT' }

      // Decided again here, whatever the caller checked: only a track that is in the
      // library, online and has its file is worked on.
      const mounted = listMountedVolumes()
      const tracks: Track[] = []
      for (const id of new Set(parsed.data.trackIds)) {
        const track = getTrackById(db, id, mounted)
        if (track && !track.offline && !track.fileMissing) tracks.push(track)
      }
      if (tracks.length === 0) return { ok: false, code: 'INVALID_INPUT' }

      const batchId = db.transaction((tx) => {
        // Only one batch waits for approval: an older one is given up for the new run.
        cancelPreviewBatches(tx)
        const id = createBatch(tx, {
          type: 'run',
          mode: dependencies.mode(),
          items: tracks.map((track) => ({ trackId: track.id, before: snapshotOf(track) }))
        })
        const jobs: NewJob[] = tracks.flatMap((track) =>
          selected.map((stage) => ({
            batchId: id,
            trackId: track.id,
            stage: stage.name,
            phase: stage.phase
          }))
        )
        insertJobs(tx, jobs)
        return id
      })

      const batch = getBatch(db, batchId)
      if (!batch) throw new Error('The new batch cannot be read back')
      logger.info(
        `Batch ${batchId} started: ${tracks.length} tracks, stages ${selected.map((stage) => stage.name).join(', ')}`
      )
      begin(batch, 'compute', { paused: false })
      return { ok: true, value: { batchId } }
    },

    applyBatch(batchId) {
      if (run !== null || findActiveBatch(db) !== undefined)
        return { ok: false, code: 'RUN_ACTIVE' }
      const batch = getBatch(db, batchId)
      if (!batch || batch.status !== 'preview') return { ok: false, code: 'INVALID_INPUT' }
      setBatchStatus(db, batchId, 'applying')
      logger.info(`Batch ${batchId}: the apply phase started`)
      begin({ ...batch, status: 'applying' }, 'apply', { paused: false })
      return { ok: true, value: { batchId } }
    },

    recover() {
      if (run !== null) return
      const batch = findActiveBatch(db)
      if (!batch) return
      const phase: JobPhase = batch.status === 'applying' ? 'apply' : 'compute'
      for (const job of recoverInterruptedJobs(db, batch.id, maxAttempts)) {
        const error: TrackError = {
          trackId: job.trackId,
          stage: job.stage,
          code: 'UNEXPECTED',
          message: TRACK_ERROR_MESSAGES.UNEXPECTED
        }
        logger.warn(
          `Job ${job.id} (${job.stage}) was interrupted ${job.attempts} times and is given up`
        )
        finishJob(db, job.id, { status: 'failed', error })
        setBatchItemError(db, batch.id, error)
      }
      logger.info(`Batch ${batch.id}: going on with the ${phase} phase after a restart`)
      begin(batch, phase, { paused: batch.paused })
    },

    pause: () => pauseBecause('user'),

    resume() {
      if (!run || run.cancelling || run.pauseReason === null) return
      run.pauseReason = null
      setBatchPaused(db, run.batchId, false)
      logger.info(`Batch ${run.batchId} resumed`)
      queue.resume()
      report()
      updateBusy()
    },

    cancel() {
      const active = run
      if (!active) return Promise.resolve()
      if (!active.cancelling) {
        active.cancelling = true
        active.pauseReason = null
        logger.info(`Batch ${active.batchId}: cancelling`)
        queue.clear()
        // Every job that has not started, of this phase and of the one after it.
        const waiting = [...active.byTrack.values()].flatMap((ofTrack) =>
          [...ofTrack.values()].filter((job) => job.status === 'queued')
        )
        for (const job of waiting) setStatus(active, job, 'skipped')
        skipJobs(
          db,
          waiting.map((job) => job.id)
        )
        for (const controller of active.controllers.values()) {
          controller.abort('cancel' satisfies AbortReason)
        }
        queue.resume()
        report()
        endPhaseIfDone()
      }
      return new Promise<void>((done) => {
        if (run === null) done()
        else finishedWaiters.push(done)
      })
    },

    shutdown() {
      const active = run
      if (!active) return
      queue.pause()
      queue.clear()
      for (const controller of active.controllers.values()) {
        controller.abort('shutdown' satisfies AbortReason)
      }
      // The jobs that were running stay `running` in the database, and the batch
      // stays active: `recover` picks both up at the next start.
      run = null
      updateBusy()
    },

    progress: () => (run ? snapshot(run, currentState(run)) : null),

    whenFinished: () =>
      new Promise<void>((done) => {
        if (run === null) done()
        else finishedWaiters.push(done)
      })
  }
}
