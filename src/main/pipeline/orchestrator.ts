// Runs the stages of a batch over its tracks: in dependency order, within the limits
// of each resource, and from the `jobs` table, so a run survives a restart of the app.
import {
  cancelPreviewBatches,
  createBatch,
  deleteDiscardedBatches,
  findActiveBatch,
  getBatch,
  listBatchItemStates,
  mergeBatchItemProposal,
  setBatchItemError,
  setBatchPause,
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
  requeueJobs,
  skipJobs,
  type JobStatus,
  type NewJob
} from '../db/jobs'
import { getTrackById, getTracksByIds, type Track } from '../db/tracks'
import { describeError } from '../services/error-text'
import { logger } from '../services/logger'
import { AppError, TRACK_ERROR_MESSAGES, type Result, type TrackError } from '@shared/errors'
import {
  runStartSchema,
  type JobCounts,
  type JobPhase,
  type ResourceLimits,
  type RunProgress
} from '@shared/pipeline'
import type { BatchFiles, UndoSummary } from './batch-files'
import { createJobQueue } from './queue'
import { runStage } from './run-stage'
import { withDependencies } from './stages'
import type { Stage, StageContext } from './stages/stage'

// A job that was running when the app crashed is started again. One that was
// interrupted this often is the likely reason the app crashes, and is given up.
const DEFAULT_MAX_ATTEMPTS = 3
// The time left is estimated per stage, from the jobs of that stage that finished last.
const DURATION_SAMPLES = 50
// Fewer finished jobs than this in all say too little for an estimate.
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
  /** How the apply phase changes files, and how a batch is undone. */
  batchFiles: BatchFiles
  /**
   * True while something else works on the files of the library, such as a scan or
   * the cleanup at startup: no batch is applied or undone then.
   */
  libraryBusy?: () => boolean
  /** May be called very often; whoever passes it on limits how often. */
  onProgress?: (progress: RunProgress) => void
  /** True while jobs run or may start by themselves; the app must not sleep then. */
  onBusyChange?: (busy: boolean) => void
  now?: () => number
  maxAttempts?: number
}

export interface Orchestrator {
  /** Starts the compute phase of a new batch for the given tracks and stages. */
  start: (request: unknown) => Result<{ batchId: number }>
  /**
   * Starts the apply phase of a batch that waits for approval, unless its backups or
   * copies would not fit on their volume (`NOT_ENOUGH_SPACE`).
   */
  applyBatch: (batchId: number) => Promise<Result<{ batchId: number }>>
  /**
   * Puts the files and tracks of the last batch that wrote back to what they were.
   * Refused while a batch is computed or applied.
   */
  undoLast: () => Promise<Result<UndoSummary>>
  /** At startup: goes on with the batch the app was working on when it stopped. */
  recover: () => void
  /** No new job starts; the running ones finish. */
  pause: () => void
  resume: () => void
  /**
   * Ends the batch as cancelled, at once: the running jobs are told to stop, and
   * whatever they still return is thrown away.
   */
  cancel: () => void
  /**
   * For quitting the app, before the database is closed: tells the running jobs to
   * stop and puts them back in line, so the next start goes on with the batch. The
   * orchestrator does nothing after this.
   */
  shutdown: () => void
  progress: () => RunProgress | null
  /** True while files of the library are being changed, or are about to be. */
  changingFiles: () => boolean
  /** Resolves when no run is active any more; at once if there is none. */
  whenFinished: () => Promise<void>
}

interface RunJob {
  id: number
  trackId: number
  stage: Stage
  status: JobStatus
}

interface Run {
  batchId: number
  /** In place or clean library, as it was when the batch was created. */
  mode: BatchMode
  phase: JobPhase
  /** The jobs of every phase by track and stage name: a stage looks its dependencies up here. */
  byTrack: Map<number, Map<string, RunJob>>
  /** The jobs of the phase that is running. */
  phaseJobs: RunJob[]
  /** Counted as the jobs change, per stage, in the order the stages run. */
  counts: Map<string, JobCounts>
  /** How long the last jobs of each stage took, for the estimate. */
  durations: Map<string, number[]>
  controllers: Map<number, AbortController>
  pauseReason: 'user' | 'offline' | null
  /** The tracks that a stage of this phase failed for. */
  failedTracks: Set<number>
  /** How long the phase worked before the last pause, in this session of the app. */
  activeMs: number
  /** Since when it has been working again; null while it is paused. */
  activeSince: number | null
  /** Jobs of this phase that are running now. */
  running: number
  /** Jobs of this phase that are neither done, failed nor skipped. */
  unfinished: number
}

function isOver(status: JobStatus): status is 'done' | 'failed' | 'skipped' {
  return status === 'done' || status === 'failed' || status === 'skipped'
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
  const { db, stages, listMountedVolumes } = dependencies
  const now = dependencies.now ?? Date.now
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const stagesByName = new Map(stages.map((stage) => [stage.name, stage]))

  let run: Run | null = null
  let busy = false
  let shutDown = false
  let finishedWaiters: (() => void)[] = []

  const queue = createJobQueue<RunJob>({
    limits: dependencies.limits,
    resourceOf: (job) => job.stage.resource,
    run: executeJob
  })

  // What listens may fail (a window that is gone); a run must not depend on it.
  function tellProgress(progress: RunProgress): void {
    try {
      dependencies.onProgress?.(progress)
    } catch (error) {
      logger.error('The progress of the run could not be reported', error)
    }
  }

  function updateBusy(): void {
    // Paused with nothing running: the Mac may sleep until the user resumes.
    const nowBusy = run !== null && (run.pauseReason === null || run.running > 0)
    if (nowBusy === busy) return
    busy = nowBusy
    try {
      dependencies.onBusyChange?.(busy)
    } catch (error) {
      logger.error('The change of the run could not be reported', error)
    }
  }

  /**
   * The time the jobs that are left will take: per stage, how long its last jobs
   * took, times the jobs left, over how many of them run at once. Null while a stage
   * with jobs left has not finished one yet, or too little has finished at all.
   */
  function estimate(active: Run): number | null {
    const limits = dependencies.limits()
    let samples = 0
    let remainingMs = 0
    for (const [name, counts] of active.counts) {
      const durations = active.durations.get(name) ?? []
      samples += durations.length
      const left = counts.total - counts.done - counts.failed - counts.skipped
      if (left === 0) continue
      if (durations.length === 0) return null
      const average = durations.reduce((sum, each) => sum + each, 0) / durations.length
      const limit = limits[stagesByName.get(name)?.resource ?? 'cpu']
      const atOnce = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1
      remainingMs += (average * left) / Math.min(atOnce, left)
    }
    return samples < MIN_DURATION_SAMPLES ? null : Math.round(remainingMs)
  }

  function snapshot(
    active: Run,
    state: RunProgress['state'],
    outcome: RunProgress['outcome'] = null
  ): RunProgress {
    const total = emptyCounts()
    const perStage = [...active.counts].map(([stage, counts]) => {
      for (const key of Object.keys(total) as (keyof JobCounts)[]) total[key] += counts[key]
      return { stage, ...counts }
    })
    return {
      batchId: active.batchId,
      phase: active.phase,
      state,
      outcome,
      pauseReason: active.pauseReason,
      counts: total,
      stages: perStage,
      tracks: { total: active.byTrack.size, failed: active.failedTracks.size },
      elapsedMs: active.activeMs + (active.activeSince === null ? 0 : now() - active.activeSince),
      remainingMs: state === 'finished' ? null : estimate(active)
    }
  }

  function currentState(active: Run): RunProgress['state'] {
    return active.pauseReason === null ? 'running' : 'paused'
  }

  function report(): void {
    if (run) tellProgress(snapshot(run, currentState(run)))
  }

  /** Changes the status of a job in memory and keeps the counts in step. */
  function setStatus(active: Run, job: RunJob, status: JobStatus): void {
    // A job that is over stays as it ended: counting it again would end the phase early.
    if (isOver(job.status) || job.status === status) return
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
      if (isOver(status)) {
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
    // Together: a failed job without its error on the item would never be explained.
    db.transaction((tx) => {
      finishJob(tx, job.id, { status: 'failed', error })
      setBatchItemError(tx, active.batchId, error)
    })
    setStatus(active, job, 'failed')
    active.failedTracks.add(job.trackId)
    for (const dependent of dependentsOf(active, job)) skipWithDependents(active, dependent)
  }

  /**
   * Lets the jobs that waited for a finished one go on. If that cannot be stored,
   * they are taken off the run in memory, so the run still comes to an end; the
   * rows stay `queued`, and the batch is the place to look.
   */
  function releaseDependents(active: Run, job: RunJob): void {
    const dependents = dependentsOf(active, job)
    try {
      for (const dependent of dependents) resolve(active, dependent)
    } catch (error) {
      logger.error(`The jobs that wait for job ${job.id} could not be released`, error)
      const drop = (each: RunJob): void => {
        if (each.status !== 'queued') return
        setStatus(active, each, 'skipped')
        dependentsOf(active, each).forEach(drop)
      }
      dependents.forEach(drop)
    }
  }

  function trackError(job: RunJob, code: TrackError['code']): TrackError {
    return {
      trackId: job.trackId,
      stage: job.stage.name,
      code,
      message: TRACK_ERROR_MESSAGES[code]
    }
  }

  /** Forgets the run and tells whoever waits for its end. */
  function leave(active: Run, outcome: NonNullable<RunProgress['outcome']>): void {
    // The run is over before anyone is told: a listener that reacts by cancelling or
    // pausing finds no run to act on.
    const last = snapshot(active, 'finished', outcome)
    run = null
    queue.resume()
    const waiters = finishedWaiters
    finishedWaiters = []
    tellProgress(last)
    updateBusy()
    for (const done of waiters) done()
  }

  // True while the apply phase is being prepared, a batch is being undone or old
  // backups are being deleted: each takes time, and nothing else may start in between.
  let busyWithFiles = false
  // The deleting of older backups that is going on, or null.
  let pruning: Promise<void> | null = null

  function endPhaseIfDone(): void {
    const active = run
    if (!active || active.unfinished > 0) return
    // The proposals wait for the user's approval; nothing is written before that.
    const status = active.phase === 'compute' ? 'preview' : 'applied'
    db.transaction((tx) => {
      setBatchStatus(tx, active.batchId, status)
      setBatchPause(tx, active.batchId, null)
    })
    logger.info(`Batch ${active.batchId}: the ${active.phase} phase ended as ${status}`)
    leave(active, status)
    if (status === 'applied') {
      // Only the last batch can be undone: the backups of the ones before it go.
      // An apply or an undo that is asked for meanwhile waits for this to end.
      pruning = dependencies.batchFiles
        .pruneOlderBackups(active.batchId)
        .catch((error: unknown) =>
          logger.error(`Older backups could not be deleted: ${describeError(error)}`)
        )
        .finally(() => {
          pruning = null
        })
    }
  }

  function pauseBecause(reason: 'user' | 'offline'): void {
    if (!run || run.pauseReason !== null) return
    run.pauseReason = reason
    if (run.activeSince !== null) run.activeMs += now() - run.activeSince
    run.activeSince = null
    queue.pause()
    setBatchPause(db, run.batchId, reason)
    logger.info(`Batch ${run.batchId} paused (${reason})`)
    report()
    updateBusy()
  }

  function stageContext(active: Run, job: RunJob, signal: AbortSignal): StageContext {
    return {
      signal,
      batchId: active.batchId,
      // Only an apply stage gets a way to change the file of its track.
      files:
        job.stage.phase === 'apply'
          ? dependencies.batchFiles.forTrack(
              { id: active.batchId, mode: active.mode },
              job.trackId,
              signal
            )
          : null
    }
  }

  /** Runs one job. Never rejects: the queue relies on that. */
  async function executeJob(job: RunJob): Promise<void> {
    const active = run
    if (!active || job.status !== 'queued') return
    // False once the run was cancelled, shut down, or this job was taken off it.
    const stillOurs = (): boolean => run === active && job.status === 'running'
    try {
      const track = getTrackById(db, job.trackId, listMountedVolumes())
      if (track?.offline) {
        // The drive went away: that is not the track's fault. The run waits for the
        // drive instead of failing every track that is left.
        pauseBecause('offline')
        // Unless what listens to the pause has cancelled the run.
        if (run === active && job.status === 'queued') queue.addFirst(job)
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
      // What listens to the report may have cancelled the run: the stage must not start.
      if (!stillOurs()) return

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
              stageContext(active, job, AbortSignal.any([timeout, controller.signal])),
              track
            ),
            stopped
          ])
        }
      )
      active.controllers.delete(job.id)
      // The run went on without this job: nothing it returns is recorded, and the
      // database may be closed by now.
      if (!stillOurs()) return

      if (!outcome.ok) {
        fail(active, job, outcome.error)
        return
      }
      const proposal = outcome.value?.proposal
      // The proposal first: a job recorded as done must have left its result behind.
      if (proposal) mergeBatchItemProposal(db, active.batchId, job.trackId, proposal)
      finishJob(db, job.id, { status: 'done' })
      setStatus(active, job, 'done')

      const durations = active.durations.get(job.stage.name) ?? []
      durations.push(now() - startedAt)
      if (durations.length > DURATION_SAMPLES) durations.shift()
      active.durations.set(job.stage.name, durations)
      releaseDependents(active, job)
    } catch (error) {
      // The database refused something, or a stage returned what cannot be stored.
      logger.error(`Job ${job.id} (${job.stage.name}) could not be recorded`, error)
      active.controllers.delete(job.id)
      if (run === active && !isOver(job.status)) {
        try {
          fail(active, job, trackError(job, 'UNEXPECTED'))
        } catch (secondError) {
          logger.error(`Job ${job.id} could not be marked as failed`, secondError)
          setStatus(active, job, 'failed')
        }
      }
    } finally {
      if (run === active) {
        try {
          // Ending the phase comes first and does not depend on the reports.
          endPhaseIfDone()
        } catch (error) {
          // The queue would swallow this, and the run would stand still without a word.
          logger.error(`Batch ${active.batchId}: the end of the phase could not be stored`, error)
        }
        report()
        updateBusy()
      }
    }
  }

  /** Builds the state of a batch from its jobs and lines up what can run. */
  function begin(batch: Batch, phase: JobPhase, pauseReason: Run['pauseReason']): void {
    const active: Run = {
      batchId: batch.id,
      mode: batch.mode,
      phase,
      byTrack: new Map(),
      phaseJobs: [],
      counts: new Map(),
      durations: new Map(),
      controllers: new Map(),
      pauseReason,
      failedTracks: new Set(),
      activeMs: 0,
      activeSince: pauseReason === null ? now() : null,
      running: 0,
      unfinished: 0
    }

    const withoutStage: number[] = []
    for (const row of listJobs(db, batch.id)) {
      const stage = stagesByName.get(row.stage)
      if (!stage) {
        // A stage this version of the app no longer has. No stage of this version
        // can depend on it (`validateStages`), so nothing waits for these jobs.
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
      if (isOver(job.status)) counts[job.status] += 1
      else active.unfinished += 1
      if (job.status === 'failed') active.failedTracks.add(job.trackId)
      active.counts.set(stage.name, counts)
    }
    skipJobs(db, withoutStage)

    run = active
    if (pauseReason !== null) queue.pause()

    if (phase === 'apply') {
      // Only what the user approved is written, and never a track that a stage failed
      // for: what was proposed for it is incomplete.
      const writable = new Set(
        listBatchItemStates(db, batch.id)
          .filter((item) => item.approved && !item.excluded && !item.failed)
          .map((item) => item.trackId)
      )
      for (const job of active.phaseJobs) {
        if (!writable.has(job.trackId)) skipWithDependents(active, job)
      }
    }
    for (const job of active.phaseJobs) resolve(active, job)

    endPhaseIfDone()
    report()
    updateBusy()
  }

  const libraryBusy = (): boolean => dependencies.libraryBusy?.() ?? false

  function isActive(): boolean {
    return run !== null || busyWithFiles || findActiveBatch(db) !== undefined
  }

  return {
    start(request) {
      const parsed = runStartSchema.safeParse(request)
      if (!parsed.success || shutDown) return { ok: false, code: 'INVALID_INPUT' }
      if (isActive()) return { ok: false, code: 'RUN_ACTIVE' }

      const selected = withDependencies(stages, parsed.data.stages)
      if (selected === null) return { ok: false, code: 'INVALID_INPUT' }

      // Decided again here, whatever the caller checked: only a track that is in the
      // library, online and has its file is worked on.
      const mounted = listMountedVolumes()
      const wanted = [...new Set(parsed.data.trackIds)]
      // Read together and put back in the order that was asked for.
      const found = new Map(getTracksByIds(db, wanted, mounted).map((track) => [track.id, track]))
      const tracks: Track[] = []
      for (const id of wanted) {
        const track = found.get(id)
        if (track && !track.offline && !track.fileMissing) tracks.push(track)
      }
      if (tracks.length === 0) return { ok: false, code: 'INVALID_INPUT' }

      const batchId = db.transaction((tx) => {
        // Only one batch waits for approval: an older one is given up for the new run.
        cancelPreviewBatches(tx)
        // What was given up before anything was written is of no use to undo, and
        // would otherwise pile up: a row per track and job for every run ever started.
        const discarded = deleteDiscardedBatches(tx)
        if (discarded > 0) logger.info(`Deleted ${discarded} batches that were given up unwritten`)
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
      begin(batch, 'compute', null)
      return { ok: true, value: { batchId } }
    },

    async applyBatch(batchId) {
      await pruning
      await dependencies.batchFiles.settled()
      if (shutDown) return { ok: false, code: 'INVALID_INPUT' }
      if (isActive() || libraryBusy()) return { ok: false, code: 'RUN_ACTIVE' }
      const batch = getBatch(db, batchId)
      if (!batch || batch.status !== 'preview') return { ok: false, code: 'INVALID_INPUT' }

      busyWithFiles = true
      try {
        // Before anything is written: a batch that runs out of room halfway would
        // leave part of the library changed and part not.
        const space = await dependencies.batchFiles.checkSpace(batchId)
        if (!space.enough) {
          logger.warn(
            `Batch ${batchId} not applied: it needs ${space.neededBytes} bytes, ${space.freeBytes} are free`
          )
          return { ok: false, code: 'NOT_ENOUGH_SPACE' }
        }
      } finally {
        busyWithFiles = false
      }
      if (shutDown) return { ok: false, code: 'INVALID_INPUT' }
      // A scan may have started while the room was measured.
      if (libraryBusy()) return { ok: false, code: 'RUN_ACTIVE' }

      setBatchStatus(db, batchId, 'applying')
      logger.info(`Batch ${batchId}: the apply phase started`)
      begin({ ...batch, status: 'applying' }, 'apply', null)
      return { ok: true, value: { batchId } }
    },

    async undoLast() {
      await pruning
      // A stage of a cancelled batch may still be finishing a copy or a rename.
      await dependencies.batchFiles.settled()
      if (shutDown) return { ok: false, code: 'INVALID_INPUT' }
      // Never while a batch is being worked on: its files are changing.
      if (isActive() || libraryBusy()) return { ok: false, code: 'RUN_ACTIVE' }
      busyWithFiles = true
      try {
        return await dependencies.batchFiles.undoLast()
      } finally {
        busyWithFiles = false
      }
    },

    recover() {
      if (run !== null || shutDown) return
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
        db.transaction((tx) => {
          finishJob(tx, job.id, { status: 'failed', error })
          setBatchItemError(tx, batch.id, error)
        })
      }
      logger.info(`Batch ${batch.id}: going on with the ${phase} phase after a restart`)
      // A pause by the user stays. One for a missing drive is taken off: if the drive
      // is still away, the first job that needs it pauses the run again.
      const pauseReason = batch.pauseReason === 'user' ? 'user' : null
      if (batch.pauseReason !== pauseReason) setBatchPause(db, batch.id, pauseReason)
      begin(batch, phase, pauseReason)
    },

    pause: () => pauseBecause('user'),

    resume() {
      if (!run || run.pauseReason === null) return
      run.pauseReason = null
      run.activeSince = now()
      setBatchPause(db, run.batchId, null)
      logger.info(`Batch ${run.batchId} resumed`)
      queue.resume()
      report()
      updateBusy()
    },

    cancel() {
      const active = run
      if (!active) return
      // Every job that is not over, of this phase and of the one after it. The
      // running ones too: what they still return is not recorded.
      const open = [...active.byTrack.values()].flatMap((ofTrack) =>
        [...ofTrack.values()].filter((job) => !isOver(job.status))
      )
      // Stored at once and together, so that a cancelled batch can never be taken
      // up again, whatever happens to the app next. Nothing in memory changes before
      // this has worked: if it fails, the run goes on and can be cancelled again.
      db.transaction((tx) => {
        setBatchStatus(tx, active.batchId, 'cancelled')
        setBatchPause(tx, active.batchId, null)
        skipJobs(
          tx,
          open.map((job) => job.id)
        )
      })
      queue.clear()
      for (const job of open) setStatus(active, job, 'skipped')
      active.pauseReason = null
      const controllers = [...active.controllers.values()]
      active.controllers.clear()
      logger.info(`Batch ${active.batchId} cancelled`)
      leave(active, 'cancelled')
      for (const controller of controllers) controller.abort()
    },

    shutdown() {
      shutDown = true
      const active = run
      queue.pause()
      queue.clear()
      if (!active) return
      // Back in line, and not counted as an attempt: the app is closed on purpose.
      // The batch stays active, and `recover` goes on with it at the next start.
      const interrupted = active.phaseJobs.filter((job) => job.status === 'running')
      requeueJobs(
        db,
        interrupted.map((job) => job.id)
      )
      for (const controller of active.controllers.values()) controller.abort()
      active.controllers.clear()
      run = null
      updateBusy()
      const waiters = finishedWaiters
      finishedWaiters = []
      for (const done of waiters) done()
    },

    changingFiles: () =>
      busyWithFiles || pruning !== null || run?.phase === 'apply' || dependencies.batchFiles.busy(),
    progress: () => (run ? snapshot(run, currentState(run)) : null),

    whenFinished: () =>
      new Promise<void>((done) => {
        if (run === null) done()
        else finishedWaiters.push(done)
      })
  }
}
