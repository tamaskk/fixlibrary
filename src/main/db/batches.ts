import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or
} from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import {
  backups,
  batches,
  batchFiles,
  batchItems,
  jobs,
  type BATCH_MODES,
  type BATCH_STATUSES,
  type PAUSE_REASONS
} from './schema'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { trackErrorSchema, type TrackError } from '@shared/errors'
import { mergeProposal, readProposal, type Proposal } from '@shared/preview'

export type BatchMode = (typeof BATCH_MODES)[number]
export type BatchStatus = (typeof BATCH_STATUSES)[number]
/** Why a batch is paused: by the user, or because the drive of the library went away. */
export type PauseReason = (typeof PAUSE_REASONS)[number]
export type Batch = typeof batches.$inferSelect

/** A batch in one of these states has work left that the app does by itself. */
export const ACTIVE_BATCH_STATUSES = ['computing', 'applying'] as const satisfies BatchStatus[]

// 7 columns per row; this keeps one statement far below SQLite's bound-parameter limit.
const INSERT_CHUNK_SIZE = 500

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
 * never applied, without a backup or a file it created, and with no apply job that
 * was ever started.
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
            .select({ id: batchFiles.id })
            .from(batchFiles)
            .where(eq(batchFiles.batchId, batches.id))
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

const recordSchema = z.record(z.string(), z.unknown())

// One line per track at most would still be thousands for a broken stage.
const logDropped = createLogLimiter((line) => logger.warn(line), { limit: 20, windowMs: 10_000 })

/** An `after` with its fields and warnings replaced; whatever else it holds stays. */
function withProposal(after: unknown, proposal: Proposal): Record<string, unknown> {
  const stored = recordSchema.safeParse(after)
  const next: Record<string, unknown> = { ...(stored.success ? stored.data : {}) }
  delete next['fields']
  delete next['warnings']
  if (Object.keys(proposal.fields ?? {}).length > 0) next['fields'] = proposal.fields
  if ((proposal.warnings ?? []).length > 0) next['warnings'] = proposal.warnings
  return next
}

/**
 * Adds what a stage proposes for a track to the item's `after`. What an earlier
 * stage proposed stays unless this one names it too, and a field the user set by
 * hand stays whatever a stage proposes (`lockedFields`, and the manual edits of this
 * batch). `fields` and `warnings` are what the preview shows; they are stored only
 * as far as they are valid.
 */
export function mergeBatchItemProposal(
  db: AppDatabase,
  batchId: number,
  trackId: number,
  proposal: Record<string, unknown>,
  lockedFields: readonly string[]
): void {
  db.transaction((tx) => {
    const where = and(eq(batchItems.batchId, batchId), eq(batchItems.trackId, trackId))
    const item = tx.select({ after: batchItems.after }).from(batchItems).where(where).get()
    if (!item) throw new Error('The batch has no item for this track')
    const stored = recordSchema.safeParse(item.after)
    const proposed = readProposal(proposal)
    // What a stage proposed and the schema refused is left out, and said once: a
    // stage bug, or metadata from outside that is not fit to show or to write.
    const raw = recordSchema.safeParse(proposal['fields'])
    const dropped = Object.keys(raw.success ? raw.data : {}).filter(
      (field) => !Object.hasOwn(proposed.fields ?? {}, field)
    )
    if (dropped.length > 0) {
      logDropped(
        `Batch ${batchId}, track ${trackId}: ${dropped.length} proposed fields were not valid and are left out`
      )
    }
    const merged = mergeProposal(readProposal(item.after), proposed, lockedFields)
    const after = withProposal({ ...(stored.success ? stored.data : {}), ...proposal }, merged)
    tx.update(batchItems).set({ after }).where(where).run()
  })
}

/**
 * Replaces the fields and warnings proposed for a track. Returns false when the
 * batch has no such item.
 */
export function setBatchItemProposal(
  db: AppDatabase,
  batchId: number,
  trackId: number,
  proposal: Proposal
): boolean {
  return db.transaction((tx) => {
    const where = and(eq(batchItems.batchId, batchId), eq(batchItems.trackId, trackId))
    const item = tx.select({ after: batchItems.after }).from(batchItems).where(where).get()
    if (!item) return false
    tx.update(batchItems)
      .set({ after: withProposal(item.after, proposal) })
      .where(where)
      .run()
    return true
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

/**
 * The newest batch that changed files and has not been undone, whatever became of
 * it: applied, cancelled halfway, or still marked as applying after a crash. Only
 * this one can be undone; the backups of older ones are gone.
 */
export function findLastWrittenBatch(db: AppDatabase): Batch | undefined {
  return db
    .select()
    .from(batches)
    .where(
      and(
        ne(batches.status, 'undone'),
        or(
          exists(
            db.select({ id: backups.id }).from(backups).where(eq(backups.batchId, batches.id))
          ),
          exists(
            db
              .select({ id: batchFiles.id })
              .from(batchFiles)
              .where(eq(batchFiles.batchId, batches.id))
          )
        )
      )
    )
    .orderBy(desc(batches.id))
    .get()
}

export interface BatchItemBefore {
  trackId: number
  /** The track as it was before the batch. Validated by whoever restores from it. */
  before: unknown
}

/** What every track of the batch looked like before it. */
export function listBatchItemsBefore(db: AppDatabase, batchId: number): BatchItemBefore[] {
  return db
    .select({ trackId: batchItems.trackId, before: batchItems.before })
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .all()
}

/** The batch that waits for the user's approval, if there is one. */
export function findPreviewBatch(db: AppDatabase): Batch | undefined {
  return db
    .select()
    .from(batches)
    .where(eq(batches.status, 'preview'))
    .orderBy(desc(batches.id))
    .get()
}

export type BatchItem = typeof batchItems.$inferSelect

/** One item of a batch, or undefined. */
export function getBatchItem(
  db: AppDatabase,
  batchId: number,
  trackId: number
): BatchItem | undefined {
  return db
    .select()
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batchId), eq(batchItems.trackId, trackId)))
    .get()
}

/** A page of the items of a batch, in the order they were added. */
export function listBatchItems(
  db: AppDatabase,
  batchId: number,
  page: { offset: number; limit: number }
): BatchItem[] {
  return db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(asc(batchItems.id))
    .limit(page.limit)
    .offset(page.offset)
    .all()
}

export interface BatchItemCounts {
  total: number
  excluded: number
  failed: number
}

export function countBatchItems(db: AppDatabase, batchId: number): BatchItemCounts {
  const of = (...conditions: Parameters<typeof and>): number =>
    db
      .select({ total: count() })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), ...conditions))
      .get()?.total ?? 0
  return {
    total: of(),
    excluded: of(eq(batchItems.excluded, true)),
    failed: of(isNotNull(batchItems.error))
  }
}

// Ids are bound one by one in an `in (…)` list.
const ID_CHUNK_SIZE = 500

/** Takes tracks out of a batch, or back in. Returns how many items changed. */
export function setBatchItemsExcluded(
  db: AppDatabase,
  batchId: number,
  trackIds: readonly number[],
  excluded: boolean
): number {
  return db.transaction((tx) => {
    let changed = 0
    for (let start = 0; start < trackIds.length; start += ID_CHUNK_SIZE) {
      changed += tx
        .update(batchItems)
        .set({ excluded })
        .where(
          and(
            eq(batchItems.batchId, batchId),
            inArray(batchItems.trackId, trackIds.slice(start, start + ID_CHUNK_SIZE))
          )
        )
        .run().changes
    }
    return changed
  })
}

/**
 * Marks as approved every item the user left in and no stage failed for, and every
 * other item as not approved. Only approved items are written by the apply phase.
 */
export function approveBatchItems(db: AppDatabase, batchId: number): void {
  db.transaction((tx) => {
    tx.update(batchItems).set({ approved: false }).where(eq(batchItems.batchId, batchId)).run()
    tx.update(batchItems)
      .set({ approved: true })
      .where(
        and(
          eq(batchItems.batchId, batchId),
          eq(batchItems.excluded, false),
          isNull(batchItems.error)
        )
      )
      .run()
  })
}

/** How many items of a batch the apply phase will write. */
export function countApprovedBatchItems(db: AppDatabase, batchId: number): number {
  return (
    db
      .select({ total: count() })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.approved, true)))
      .get()?.total ?? 0
  )
}
