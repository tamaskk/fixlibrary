import { asc, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import { AUDIO_FORMATS, COVER_STATUSES, styles, tracks } from './schema'
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

function readStageStatus(id: number, stored: unknown): StageStatus {
  const stageStatus = stageStatusSchema.safeParse(stored)
  if (stageStatus.success) return stageStatus.data
  // One unreadable row must not hide the rest of the library: it reads as "nothing done yet".
  logger.error(`Track ${id} has an unreadable stage status; treating it as empty`)
  return {}
}

function toTrack(row: TrackRow, mountedVolumes: ReadonlySet<string>): Track {
  return {
    ...row,
    stageStatus: readStageStatus(row.id, row.stageStatus),
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
  /** Where the file was first found. In clean library mode the original stays there. */
  originalPath: string
  fileSizeBytes: number | null
  fileMtimeMs: number | null
  fileMissing: boolean
  stageStatus: StageStatus
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

/** The tracks with these ids, in no particular order. An id without a track is left out. */
export function getTracksByIds(
  db: AppDatabase,
  ids: readonly number[],
  mountedVolumes: ReadonlySet<string>
): Track[] {
  const found: Track[] = []
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    const rows = db
      .select()
      .from(tracks)
      .where(inArray(tracks.id, ids.slice(start, start + ID_CHUNK_SIZE)))
      .all()
    found.push(...rows.map((row) => toTrack(row, mountedVolumes)))
  }
  return found
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
      originalPath: tracks.originalPath,
      fileSizeBytes: tracks.fileSizeBytes,
      fileMtimeMs: tracks.fileMtimeMs,
      fileMissing: tracks.fileMissing,
      stageStatus: tracks.stageStatus
    })
    .from(tracks)
    .all()
    .map((row) => ({ ...row, stageStatus: readStageStatus(row.id, row.stageStatus) }))
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

/** Whether a track can be worked on right now. */
export interface TrackAvailability {
  id: number
  offline: boolean
  fileMissing: boolean
}

/** Every track in library order (by path), with what keeps it from being processed. */
export function listTrackAvailability(
  db: AppDatabase,
  mountedVolumes: ReadonlySet<string>
): TrackAvailability[] {
  return db
    .select({ id: tracks.id, volumeName: tracks.volumeName, fileMissing: tracks.fileMissing })
    .from(tracks)
    .orderBy(asc(tracks.path))
    .all()
    .map(({ id, volumeName, fileMissing }) => ({
      id,
      offline: volumeName !== null && !mountedVolumes.has(volumeName),
      fileMissing
    }))
}

// Tag text in a snapshot is no longer than this, whatever wrote the snapshot.
const MAX_SNAPSHOT_TEXT = 1000
const text = z.string().max(MAX_SNAPSHOT_TEXT).nullable()
const size = z.number().int().min(0).nullable()

// What undo puts back: everything a batch may have changed about a track. Not the id,
// not where the file was first found, and not when the row was created. Every field
// may be missing: a snapshot written by an older version of the app has fewer.
const restorableTrackSchema = z
  .object({
    format: z.enum(AUDIO_FORMATS),
    durationMs: size,
    bitrateKbps: size,
    sampleRateHz: size,
    fileSizeBytes: size,
    fileMtimeMs: size,
    fileMissing: z.boolean(),
    artist: text,
    title: text,
    mix: text,
    album: text,
    label: text,
    year: z.number().int().nullable(),
    bpm: z.number().nullable(),
    camelotKey: text,
    musicalKey: text,
    energy: z.number().int().min(1).max(10).nullable(),
    primaryStyleId: z.number().int().nullable(),
    secondaryStyleId: z.number().int().nullable(),
    coverStatus: z.enum(COVER_STATUSES),
    lufs: z.number().nullable(),
    truePeakDbtp: z.number().nullable(),
    acoustId: text,
    musicbrainzRecordingId: text,
    stageStatus: stageStatusSchema
  })
  .partial()

export type TrackSnapshot = z.output<typeof restorableTrackSchema>

/** The fields undo can put back from a `before` snapshot, or null if it is not one. */
export function parseTrackSnapshot(before: unknown): TrackSnapshot | null {
  const parsed = restorableTrackSchema.safeParse(before)
  return parsed.success ? parsed.data : null
}

/** The path a `before` snapshot of a batch item holds, or null if it holds none. */
export function pathOfSnapshot(before: unknown): string | null {
  const parsed = z.object({ path: z.string().min(1) }).safeParse(before)
  return parsed.success ? parsed.data.path : null
}

/** The track that has this path, if any. */
export function findTrackIdByPath(db: AppDatabase, path: string): number | undefined {
  return db
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.path, normalizeTrackPath(path)))
    .get()?.id
}

/**
 * Puts a track back to what a snapshot holds. The path is not taken from the
 * snapshot: the caller says where the file really is now. A style that was deleted
 * since is left out, because the track can no longer point at it.
 */
export function restoreTrack(
  db: AppDatabase,
  id: number,
  snapshot: TrackSnapshot,
  path: string
): boolean {
  const styleIds = new Set(
    db
      .select({ id: styles.id })
      .from(styles)
      .all()
      .map((style) => style.id)
  )
  const known = (styleId: number | null | undefined): number | null | undefined =>
    typeof styleId === 'number' && !styleIds.has(styleId) ? null : styleId
  return updateTrack(db, id, {
    ...snapshot,
    primaryStyleId: known(snapshot.primaryStyleId),
    secondaryStyleId: known(snapshot.secondaryStyleId),
    path
  })
}
