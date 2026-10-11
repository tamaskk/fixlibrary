import { and, desc, eq, gt, inArray, isNull, notExists } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import {
  backups,
  batches,
  batchItems,
  jobs,
  type BATCH_MODES,
  type BATCH_STATUSES,
  type PAUSE_REASONS
} from './schema'
import { trackErrorSchema, type TrackError } from '@shared/errors'

export type BatchMode = (typeof BATCH_MODES)[number]
export type BatchStatus = (typeof BATCH_STATUSES)[number]
/** Why a batch is paused: by the user, or because the drive of the library went away. */
export type PauseReason = (typeof PAUSE_REASONS)[number]
export type Batch = typeof batches.$inferSelect

/** A batch in one of these states has work left that the app does by itself. */
export const ACTIVE_BATCH_STATUSES = ['computing', 'applying'] as const satisfies BatchStatus[]

// 7 columns per row; this keeps one statement far below SQLite's bound-parameter limit.
const INSERT_CHUNK_SIZE = 500

const proposalSchema = z.record(z.string(), z.unknown())

export interface NewBatch {
  type: string
  mode: BatchMode
  /** One entry per track: what the track looked like before the batch. */
  items: readonly { trackId: number; before: Record<string, unknown> }[]
}

/** Creates the batch and its items, all or none. Returns the id of the batch. */
export function createBatch(db: AppDatabase, batch: NewBatch): number {
  return db.transaction((tx) => {
    const [created] = tx
      .insert(batches)
      .values({ type: batch.type, mode: batch.mode })
      .returning({ id: batches.id })
      .all()
    if (!created) throw new Error('The batch was not created')
    for (let start = 0; start < batch.items.length; start += INSERT_CHUNK_SIZE) {
      const chunk = batch.items.slice(start, start + INSERT_CHUNK_SIZE)
      tx.insert(batchItems)
        .values(chunk.map((item) => ({ ...item, batchId: created.id, after: {} })))
        .run()
    }
    return created.id
  })
}

export function getBatch(db: AppDatabase, id: number): Batch | undefined {
  return db.select().from(batches).where(eq(batches.id, id)).get()
}

/** The batch that is being computed or applied, if there is one. The newest, should there be two. */
export function findActiveBatch(db: AppDatabase): Batch | undefined {
  return db
    .select()
    .from(batches)
    .where(inArray(batches.status, ACTIVE_BATCH_STATUSES))
    .orderBy(desc(batches.id))
    .get()
}

/** Sets the status; `applied` also records when. Returns false when no batch has this id. */
export function setBatchStatus(db: AppDatabase, id: number, status: BatchStatus): boolean {
  const applied = status === 'applied' ? { appliedAt: new Date() } : {}
  return (
    db
      .update(batches)
      .set({ status, ...applied })
      .where(eq(batches.id, id))
      .run().changes > 0
  )
}

/** Pauses the batch for the given reason, or with null takes the pause off. */
export function setBatchPause(db: AppDatabase, id: number, pauseReason: PauseReason | null): void {
  db.update(batches).set({ pauseReason }).where(eq(batches.id, id)).run()
}

/** Every batch that waits for approval becomes `cancelled`: only one batch waits at a time. */
export function cancelPreviewBatches(db: AppDatabase): void {
  db.update(batches).set({ status: 'cancelled' }).where(eq(batches.status, 'preview')).run()
}

/**
 * Deletes the batches that were given up before anything was written: cancelled,
 * never applied, without a backup, and with no apply job that was ever started.
 * Their items and jobs go with them. Returns how many batches were deleted.
 *
 * A batch that got as far as writing a file is never deleted here, cancelled or
 * not: undo and the backups depend on its rows.
 */
export function deleteDiscardedBatches(db: AppDatabase): number {
  return db
    .delete(batches)
    .where(
      and(
        eq(batches.status, 'cancelled'),
        isNull(batches.appliedAt),
        notExists(
          db.select({ id: backups.id }).from(backups).where(eq(backups.batchId, batches.id))
        ),
        notExists(
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.batchId, batches.id), eq(jobs.phase, 'apply'), gt(jobs.attempts, 0)))
        )
      )
    )
    .run().changes
}

/**
 * Adds what a stage proposes for a track to the item's `after`. Fields of an earlier
 * stage stay unless this one names them too.
 */
export function mergeBatchItemProposal(
  db: AppDatabase,
  batchId: number,
  trackId: number,
  proposal: Record<string, unknown>
): void {
  db.transaction((tx) => {
    const where = and(eq(batchItems.batchId, batchId), eq(batchItems.trackId, trackId))
    const item = tx.select({ after: batchItems.after }).from(batchItems).where(where).get()
    if (!item) throw new Error('The batch has no item for this track')
    const current = proposalSchema.safeParse(item.after)
    tx.update(batchItems)
      .set({ after: { ...(current.success ? current.data : {}), ...proposal } })
      .where(where)
      .run()
  })
}

/** Records why a track was skipped. The first error of a track stays: it is the cause. */
export function setBatchItemError(db: AppDatabase, batchId: number, error: TrackError): void {
  db.transaction((tx) => {
    const where = and(eq(batchItems.batchId, batchId), eq(batchItems.trackId, error.trackId))
    const item = tx.select({ error: batchItems.error }).from(batchItems).where(where).get()
    if (!item || trackErrorSchema.safeParse(item.error).success) return
    tx.update(batchItems).set({ error }).where(where).run()
  })
}

export interface BatchItemState {
  trackId: number
  approved: boolean
  excluded: boolean
  /** True when a stage failed for the track; such a track is never written. */
  failed: boolean
}

/** Which tracks of the batch the user approved or took out, and which ones failed. */
export function listBatchItemStates(db: AppDatabase, batchId: number): BatchItemState[] {
  return db
    .select({
      trackId: batchItems.trackId,
      approved: batchItems.approved,
      excluded: batchItems.excluded,
      error: batchItems.error
    })
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .all()
    .map(({ error, ...item }) => ({ ...item, failed: error !== null }))
}
