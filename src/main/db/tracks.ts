import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import { tracks } from './schema'
import { normalizeTrackPath, volumeNameOfPath } from './track-paths'

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

// 28 columns per row; this keeps one statement far below SQLite's bound-parameter limit.
const INSERT_CHUNK_SIZE = 500

function toTrack(row: TrackRow, mountedVolumes: ReadonlySet<string>): Track {
  const stageStatus = stageStatusSchema.safeParse(row.stageStatus)
  if (!stageStatus.success) {
    // One unreadable row must not hide the rest of the library: it reads as "nothing done yet".
    console.error(`Track ${row.id} has an unreadable stage status; treating it as empty`)
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
