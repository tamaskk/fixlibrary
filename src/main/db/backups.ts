import { and, eq, lt } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { backups, batchFiles } from './schema'
import { normalizeTrackPath } from './track-paths'

export type Backup = typeof backups.$inferSelect
export type CreatedFile = typeof batchFiles.$inferSelect

/** Records where the untouched original of a track was copied to. */
export function insertBackup(
  db: AppDatabase,
  backup: { batchId: number; trackId: number; originalPath: string; backupPath: string }
): void {
  db.insert(backups).values(backup).run()
}

/** The backup a batch made of a track, if it has made one. */
export function getBackup(db: AppDatabase, batchId: number, trackId: number): Backup | undefined {
  return db
    .select()
    .from(backups)
    .where(and(eq(backups.batchId, batchId), eq(backups.trackId, trackId)))
    .get()
}

export function listBackups(db: AppDatabase, batchId: number): Backup[] {
  return db.select().from(backups).where(eq(backups.batchId, batchId)).all()
}

/**
 * The backups of the batches that came before this one: what is thrown away once it
 * is applied. Never those of a later batch, which may have started in the meantime.
 */
export function listBackupsOfOlderBatches(db: AppDatabase, batchId: number): Backup[] {
  return db.select().from(backups).where(lt(backups.batchId, batchId)).all()
}

/** Removes the record only; the file is the caller's to remove first. */
export function deleteBackup(db: AppDatabase, id: number): void {
  db.delete(backups).where(eq(backups.id, id)).run()
}

/**
 * Writes down that a batch is about to create a file. Called before the file is
 * written. Recording the same path of a batch twice is not an error: the app may
 * have stopped after the first time.
 */
export function recordCreatedFile(
  db: AppDatabase,
  file: { batchId: number; trackId: number; path: string; sha256?: string | null }
): void {
  const sha256 = file.sha256 ?? null
  db.insert(batchFiles)
    // In the one spelling a track's path is stored in: undo knows a file of the
    // batch by comparing the two, and a folder may be spelled otherwise on disk.
    .values({ ...file, sha256, path: normalizeTrackPath(file.path) })
    // The name may have been another track's earlier in the batch: it is this one's
    // now, with what this track's file holds.
    .onConflictDoUpdate({
      target: [batchFiles.batchId, batchFiles.path],
      set: { trackId: file.trackId, sha256 }
    })
    .run()
}

/** What a batch wrote down about the file at a path, if anything. */
export function getCreatedFile(
  db: AppDatabase,
  batchId: number,
  path: string
): CreatedFile | undefined {
  return db
    .select()
    .from(batchFiles)
    .where(and(eq(batchFiles.batchId, batchId), eq(batchFiles.path, normalizeTrackPath(path))))
    .get()
}

export function listCreatedFiles(db: AppDatabase, batchId: number): CreatedFile[] {
  return db.select().from(batchFiles).where(eq(batchFiles.batchId, batchId)).all()
}

/** Forgets what a batch created, once undo has removed the files or can no longer be asked for. */
export function deleteCreatedFiles(db: AppDatabase, batchId: number): void {
  db.delete(batchFiles).where(eq(batchFiles.batchId, batchId)).run()
}

/**
 * Takes back the note about one file: it was not created after all. With a track,
 * only if the note is still that track's: the name may have become another's since.
 */
export function deleteCreatedFile(
  db: AppDatabase,
  batchId: number,
  path: string,
  trackId?: number
): void {
  db.delete(batchFiles)
    .where(
      and(
        eq(batchFiles.batchId, batchId),
        eq(batchFiles.path, normalizeTrackPath(path)),
        trackId === undefined ? undefined : eq(batchFiles.trackId, trackId)
      )
    )
    .run()
}

/** What a batch created for one track. */
export function listCreatedFilesOfTrack(
  db: AppDatabase,
  batchId: number,
  trackId: number
): CreatedFile[] {
  return db
    .select()
    .from(batchFiles)
    .where(and(eq(batchFiles.batchId, batchId), eq(batchFiles.trackId, trackId)))
    .all()
}

/** The batches before this one that still have a note about a file they created. */
export function listOlderBatchesWithCreatedFiles(db: AppDatabase, batchId: number): number[] {
  return db
    .selectDistinct({ batchId: batchFiles.batchId })
    .from(batchFiles)
    .where(lt(batchFiles.batchId, batchId))
    .all()
    .map((row) => row.batchId)
}

/** True while any batch has a backup: the folder they are in must stay where it is. */
export function hasBackups(db: AppDatabase): boolean {
  return db.select({ id: backups.id }).from(backups).limit(1).get() !== undefined
}
