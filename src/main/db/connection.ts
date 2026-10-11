import { createHash } from 'crypto'
import { chmodSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { z } from 'zod'
import * as schema from './schema'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface DatabaseConnection {
  db: AppDatabase
  close: () => void
}

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })).min(1)
})

let connection: DatabaseConnection | null = null

/** Drizzle records each applied migration by the SHA-256 of its SQL file. */
function newestMigrationHash(migrationsFolder: string): string {
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
  )
  const newest = journal.entries[journal.entries.length - 1]
  if (!newest) throw new Error('The migrations journal is empty')
  const migrationSql = readFileSync(join(migrationsFolder, `${newest.tag}.sql`), 'utf8')
  return createHash('sha256').update(migrationSql).digest('hex')
}

function assertSchemaMatchesApp(sqlite: Database.Database, migrationsFolder: string): void {
  // The migrator only looks at timestamps: a database written by a newer app has
  // nothing pending and would open with a schema this code does not know.
  const applied = sqlite
    .prepare('select hash from __drizzle_migrations order by created_at desc limit 1')
    .get() as { hash: string } | undefined
  if (applied?.hash !== newestMigrationHash(migrationsFolder)) {
    throw new Error('The database schema does not match this version of the app')
  }
}

/**
 * Opens the database file, creating it if needed, and applies every pending migration.
 * Throws if the file cannot be opened or a migration fails; nothing is half-applied,
 * because the migrator runs in one transaction.
 */
export function openDatabase(filePath: string, migrationsFolder: string): DatabaseConnection {
  mkdirSync(dirname(filePath), { recursive: true })
  const sqlite = new Database(filePath, { timeout: 5000 })
  try {
    // Before WAL is switched on, so the -wal and -shm files inherit the mode.
    chmodSync(filePath, 0o600)
    sqlite.pragma('journal_mode = WAL')
    // A backup row must not be lost to a power cut after its file was changed.
    sqlite.pragma('synchronous = FULL')
    sqlite.pragma('trusted_schema = OFF')

    // A migration that rebuilds a table drops the old one. With foreign keys on,
    // that drop would cascade into the child tables, and the migration cannot
    // switch them off itself: the pragma is ignored inside the migrator's transaction.
    sqlite.pragma('foreign_keys = OFF')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder })
    const violations = sqlite.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      throw new Error(`Migration left ${violations.length} broken foreign key reference(s)`)
    }
    assertSchemaMatchesApp(sqlite, migrationsFolder)
    // SQLite ignores foreign keys unless each connection turns them on.
    sqlite.pragma('foreign_keys = ON')

    return { db, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

/** Opens the app's single connection. Call once, at startup. */
export function initDatabase(filePath: string, migrationsFolder: string): void {
  if (connection) throw new Error('The database is already open')
  connection = openDatabase(filePath, migrationsFolder)
}

export function getDatabase(): AppDatabase {
  if (!connection) throw new Error('The database is not open')
  return connection.db
}

export function closeDatabase(): void {
  connection?.close()
  connection = null
}
