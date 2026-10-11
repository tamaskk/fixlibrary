import { and, eq, ne } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { backups, batchFiles } from './schema'

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

/** The backups of every batch but this one: what is thrown away once it is applied. */
export function listBackupsOfOtherBatches(db: AppDatabase, keepBatchId: number): Backup[] {
  return db.select().from(backups).where(ne(backups.batchId, keepBatchId)).all()
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
  file: { batchId: number; trackId: number; path: string }
): void {
  db.insert(batchFiles).values(file).onConflictDoNothing().run()
}

export function listCreatedFiles(db: AppDatabase, batchId: number): CreatedFile[] {
  return db.select().from(batchFiles).where(eq(batchFiles.batchId, batchId)).all()
}

/** Forgets what a batch created, once undo has removed the files or can no longer be asked for. */
export function deleteCreatedFiles(db: AppDatabase, batchId: number): void {
  db.delete(batchFiles).where(eq(batchFiles.batchId, batchId)).run()
}

/** Forgets what every batch but this one created; they cannot be undone any more. */
export function deleteCreatedFilesOfOtherBatches(db: AppDatabase, keepBatchId: number): void {
  db.delete(batchFiles).where(ne(batchFiles.batchId, keepBatchId)).run()
}
