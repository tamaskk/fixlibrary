import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { jobs, type JOB_PHASES, type JOB_STATUSES } from './schema'
import type { TrackError } from '@shared/errors'

export type JobPhase = (typeof JOB_PHASES)[number]
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
  outcome: { status: 'done' } | { status: 'failed'; error: TrackError } | { status: 'skipped' }
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
