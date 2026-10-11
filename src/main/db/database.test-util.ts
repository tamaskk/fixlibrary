// Test helper: a real database file in a temp folder, built by the real migrations.
import { cpSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, type AppDatabase, type DatabaseConnection } from './connection'

export const MIGRATIONS_FOLDER = join(import.meta.dirname, 'migrations')

export interface TestDatabase {
  db: AppDatabase
  filePath: string
  /** A private copy of the migrations, so a test can add one. */
  migrationsFolder: string
  reopen: () => AppDatabase
  cleanup: () => void
}

export function createTestDatabase(): TestDatabase {
  const folder = mkdtempSync(join(tmpdir(), 'fixlibrary-db-'))
  const filePath = join(folder, 'fixlibrary.db')
  const migrationsFolder = join(folder, 'migrations')
  cpSync(MIGRATIONS_FOLDER, migrationsFolder, { recursive: true })

  let connection: DatabaseConnection = openDatabase(filePath, migrationsFolder)
  const testDatabase: TestDatabase = {
    db: connection.db,
    filePath,
    migrationsFolder,
    reopen: () => {
      connection.close()
      connection = openDatabase(filePath, migrationsFolder)
      testDatabase.db = connection.db
      return connection.db
    },
    cleanup: () => {
      connection.close()
      rmSync(folder, { recursive: true, force: true })
    }
  }
  return testDatabase
}
