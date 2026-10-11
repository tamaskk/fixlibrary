import { asc, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import { tracks } from './schema'
import { normalizeTrackPath, volumeNameOfPath } from './track-paths'
import { logger } from '../services/logger'

export const STAGE_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const
export const MAX_TRACK_PAGE_SIZE = 500

const stageStatusSchema = z.record(z.string(), z.enum(STAGE_STATUSES))

type TrackRow = typeof tracks.$inferSelect
type TrackInsert = typeof tracks.$inferInsert

export type StageStatus = z.output<typeof stageStatusSchema>
/** The volume is derived from the path, so it cannot be set on its own. */
export type NewTrack = Omit<TrackInsert, 'stageStatus' | 'volumeName'> & {
  stageStatus?: StageStatus
}
/** `originalPath` is where the file was first found; it never changes. */
export type TrackChanges = Partial<
  Omit<NewTrack, 'id' | 'originalPath' | 'createdAt' | 'updatedAt'>
>
export type Track = Omit<TrackRow, 'stageStatus'> & {
  stageStatus: StageStatus
  /** True while the track's volume is not mounted; such a track must not be processed. */
  offline: boolean
}

// 31 columns per row; this keeps one statement far below SQLite's bound-parameter limit.
const INSERT_CHUNK_SIZE = 500
// Ids are bound one by one in an `in (…)` list.
const ID_CHUNK_SIZE = 500

function toTrack(row: TrackRow, mountedVolumes: ReadonlySet<string>): Track {
  const stageStatus = stageStatusSchema.safeParse(row.stageStatus)
  if (!stageStatus.success) {
    // One unreadable row must not hide the rest of the library: it reads as "nothing done yet".
    logger.error(`Track ${row.id} has an unreadable stage status; treating it as empty`)
  }
  return {
    ...row,
    stageStatus: stageStatus.success ? stageStatus.data : {},
    offline: row.volumeName !== null && !mountedVolumes.has(row.volumeName)
  }
}

function toInsert(row: NewTrack): TrackInsert {
  const path = normalizeTrackPath(row.path)
  return {
    ...row,
    path,
    originalPath: normalizeTrackPath(row.originalPath),
    volumeName: volumeNameOfPath(path)
  }
}

/** What a rescan compares a file on disk with. */
export interface TrackFileState {
  id: number
  path: string
  fileSizeBytes: number | null
  fileMtimeMs: number | null
  fileMissing: boolean
}

/** Inserts all rows or none. Returns the new ids in input order. */
export function insertTracks(db: AppDatabase, rows: readonly NewTrack[]): number[] {
  const values = rows.map(toInsert)
  return db.transaction((tx) => {
    const ids: number[] = []
    for (let start = 0; start < values.length; start += INSERT_CHUNK_SIZE) {
      const chunk = values.slice(start, start + INSERT_CHUNK_SIZE)
      const inserted = tx.insert(tracks).values(chunk).returning({ id: tracks.id }).all()
      ids.push(...inserted.map((row) => row.id))
    }
    return ids
  })
}

export function getTrackById(
  db: AppDatabase,
  id: number,
  mountedVolumes: ReadonlySet<string>
): Track | undefined {
  const row = db.select().from(tracks).where(eq(tracks.id, id)).get()
  return row && toTrack(row, mountedVolumes)
}

/** One page of tracks ordered by path. The page size is capped at MAX_TRACK_PAGE_SIZE. */
export function listTracks(
  db: AppDatabase,
  page: { limit: number; offset: number },
  mountedVolumes: ReadonlySet<string>
): Track[] {
  // SQLite reads a negative limit as "no limit".
  const limit = Math.min(Math.max(0, Math.trunc(page.limit)), MAX_TRACK_PAGE_SIZE)
  const offset = Math.max(0, Math.trunc(page.offset))
  return db
    .select()
    .from(tracks)
    .orderBy(asc(tracks.path))
    .limit(limit)
    .offset(offset)
    .all()
    .map((row) => toTrack(row, mountedVolumes))
}

/** Returns false when no track has this id. */
export function updateTrack(db: AppDatabase, id: number, changes: TrackChanges): boolean {
  const moved =
    changes.path === undefined
      ? {}
      : (() => {
          const path = normalizeTrackPath(changes.path)
          return { path, volumeName: volumeNameOfPath(path) }
        })()
  const result = db
    .update(tracks)
    .set({ ...changes, ...moved, updatedAt: new Date() })
    .where(eq(tracks.id, id))
    .run()
  return result.changes > 0
}

/**
 * Removes the database row only; the audio file is never touched from here.
 * Throws while a batch still refers to the track, because undo needs that record.
 */
export function deleteTrack(db: AppDatabase, id: number): boolean {
  return db.delete(tracks).where(eq(tracks.id, id)).run().changes > 0
}

/** The stored file state of every track, for a rescan to compare the disk with. */
export function listTrackFileStates(db: AppDatabase): TrackFileState[] {
  return db
    .select({
      id: tracks.id,
      path: tracks.path,
      fileSizeBytes: tracks.fileSizeBytes,
      fileMtimeMs: tracks.fileMtimeMs,
      fileMissing: tracks.fileMissing
    })
    .from(tracks)
    .all()
}

/** Applies all changes or none. A change for an id that does not exist is ignored. */
export function updateTracks(
  db: AppDatabase,
  updates: readonly { id: number; changes: TrackChanges }[]
): void {
  db.transaction((tx) => {
    for (const { id, changes } of updates) updateTrack(tx, id, changes)
  })
}

/** Marks tracks whose file a scan did or did not find. The rows themselves always stay. */
export function setTracksMissing(db: AppDatabase, ids: readonly number[], missing: boolean): void {
  db.transaction((tx) => {
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      tx.update(tracks)
        .set({ fileMissing: missing, updatedAt: new Date() })
        .where(inArray(tracks.id, ids.slice(start, start + ID_CHUNK_SIZE)))
        .run()
    }
  })
}

export function countTracks(db: AppDatabase): number {
  return db.select({ total: count() }).from(tracks).get()?.total ?? 0
}
