import { and, asc, eq, inArray, lt, max, sql } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { batchItems, jobs, type JOB_PHASES, type JOB_STATUSES } from './schema'
import type { TrackError } from '@shared/errors'

type JobPhase = (typeof JOB_PHASES)[number]
export type JobStatus = (typeof JOB_STATUSES)[number]
export type Job = typeof jobs.$inferSelect

export interface NewJob {
  batchId: number
  trackId: number
  stage: string
  phase: JobPhase
}

// 5 values per row; this keeps one statement far below SQLite's bound-parameter limit.
const INSERT_CHUNK_SIZE = 1000
// Ids are bound one by one in an `in (…)` list.
const ID_CHUNK_SIZE = 500

/** Inserts all jobs or none. Every job starts `queued`. */
export function insertJobs(db: AppDatabase, rows: readonly NewJob[]): void {
  db.transaction((tx) => {
    for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
      tx.insert(jobs)
        .values(rows.slice(start, start + INSERT_CHUNK_SIZE))
        .run()
    }
  })
}

/** The jobs of a batch in the order they were created, which is the order they run in. */
export function listJobs(db: AppDatabase, batchId: number): Job[] {
  return db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.id)).all()
}

/** Marks a job as started and counts the attempt. */
export function markJobRunning(db: AppDatabase, id: number): void {
  db.update(jobs)
    .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, startedAt: new Date() })
    .where(eq(jobs.id, id))
    .run()
}

export function finishJob(
  db: AppDatabase,
  id: number,
  outcome: { status: 'done' } | { status: 'failed'; error: TrackError }
): void {
  db.update(jobs)
    .set({
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : null,
      finishedAt: new Date()
    })
    .where(eq(jobs.id, id))
    .run()
}

/**
 * Puts started jobs back in line without counting the start, for an app that is
 * closed on purpose: only a start that ended in a crash counts as an attempt.
 */
export function requeueJobs(db: AppDatabase, ids: readonly number[]): void {
  db.transaction((tx) => {
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      tx.update(jobs)
        .set({ status: 'queued', startedAt: null, attempts: sql`max(0, ${jobs.attempts} - 1)` })
        .where(
          and(inArray(jobs.id, ids.slice(start, start + ID_CHUNK_SIZE)), eq(jobs.status, 'running'))
        )
        .run()
    }
  })
}

/** Marks jobs that will not run: a stage they depend on failed, or the run was cancelled. */
export function skipJobs(db: AppDatabase, ids: readonly number[]): void {
  db.transaction((tx) => {
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      tx.update(jobs)
        .set({ status: 'skipped', finishedAt: new Date() })
        .where(inArray(jobs.id, ids.slice(start, start + ID_CHUNK_SIZE)))
        .run()
    }
  })
}

/**
 * After a start of the app: a job that was running when the app stopped has no result.
 * It goes back to `queued`, unless it has been started `maxAttempts` times already;
 * then it is the likely reason the app stopped, and is returned to be recorded as failed.
 */
export function recoverInterruptedJobs(
  db: AppDatabase,
  batchId: number,
  maxAttempts: number
): Job[] {
  return db.transaction((tx) => {
    const interrupted = and(eq(jobs.batchId, batchId), eq(jobs.status, 'running'))
    tx.update(jobs)
      .set({ status: 'queued', startedAt: null })
      .where(and(interrupted, lt(jobs.attempts, maxAttempts)))
      .run()
    return tx.select().from(jobs).where(interrupted).all()
  })
}

/** The names of the stages a batch runs, in no particular order. */
export function listJobStageNames(db: AppDatabase, batchId: number): string[] {
  return db
    .selectDistinct({ stage: jobs.stage })
    .from(jobs)
    .where(eq(jobs.batchId, batchId))
    .all()
    .map((job) => job.stage)
}

/**
 * Per track, the warnings of the latest batch that ran a stage to its end, whatever
 * happened to the batch afterwards. Only that batch's item is read for each track.
 */
export function listLatestWarningsOfStage(db: AppDatabase, stage: string): Map<number, unknown> {
  const latest = db
    .select({ trackId: jobs.trackId, batchId: max(jobs.batchId).as('latest_batch_id') })
    .from(jobs)
    .where(and(eq(jobs.stage, stage), eq(jobs.status, 'done')))
    .groupBy(jobs.trackId)
    .as('latest')
  const rows = db
    .select({
      trackId: batchItems.trackId,
      warnings: sql<string | null>`json_extract(${batchItems.after}, '$.warnings')`
    })
    .from(batchItems)
    .innerJoin(
      latest,
      and(eq(batchItems.trackId, latest.trackId), eq(batchItems.batchId, latest.batchId))
    )
    .all()
  return new Map(
    rows.map((row) => {
      try {
        return [row.trackId, row.warnings === null ? null : JSON.parse(row.warnings)]
      } catch {
        return [row.trackId, null]
      }
    })
  )
}
