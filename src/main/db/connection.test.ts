import { appendFileSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from './connection'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import { saveAnalysis } from './analyses'
import { analyses, backups, batches, batchItems } from './schema'
import { getTrackById, insertTracks } from './tracks'

const EXPECTED_TABLES = [
  'analyses',
  'backups',
  'batch_files',
  'batch_items',
  'batches',
  'cues',
  'energy_calibration',
  'jobs',
  'lookup_cache',
  'playlist_tracks',
  'playlists',
  'settings',
  'styles',
  'tracks'
]

let testDatabase: TestDatabase

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

/** Adds one more migration to the test's private copy, the way drizzle-kit would. */
function addMigration(tag: string, statement: string): void {
  const journalPath = join(testDatabase.migrationsFolder, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  const last = journal.entries[journal.entries.length - 1]
  if (!last) throw new Error('the migrations journal is empty')
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag })
  writeFileSync(journalPath, JSON.stringify(journal))
  writeFileSync(join(testDatabase.migrationsFolder, `${tag}.sql`), statement)
}

describe('openDatabase', () => {
  it('creates every table on a fresh database', () => {
    // Act
    const tables = testDatabase.db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`)
      .map((row) => row.name)
      // SQLite's own tables and Drizzle's migration bookkeeping are not part of the schema.
      .filter((name) => !name.startsWith('sqlite_') && !name.startsWith('__'))

    // Assert
    expect(tables).toEqual(EXPECTED_TABLES)
  })

  it('runs in WAL mode with foreign keys enforced', () => {
    // Act
    const journalMode = testDatabase.db.get<{ journal_mode: string }>(sql`pragma journal_mode`)
    const foreignKeys = testDatabase.db.get<{ foreign_keys: number }>(sql`pragma foreign_keys`)

    // Assert
    expect(journalMode.journal_mode).toBe('wal')
    expect(foreignKeys.foreign_keys).toBe(1)
  })

  it('keeps a written record after the database is closed and opened again', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3', title: 'Árvíz' }
    ])

    // Act
    const reopened = testDatabase.reopen()
    const track = getTrackById(reopened, id as number, new Set())

    // Assert
    expect(track).toMatchObject({ path: '/Music/a.mp3', title: 'Árvíz' })
  })

  it('applies a new migration to an existing database without losing data', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3', bpm: 124 }
    ])
    addMigration('0001_test_note', 'ALTER TABLE `tracks` ADD `test_note` text;')

    // Act
    const upgraded = testDatabase.reopen()
    const track = getTrackById(upgraded, id as number, new Set())
    const columns = upgraded
      .all<{ name: string }>(sql`pragma table_info(tracks)`)
      .map((column) => column.name)

    // Assert
    expect(columns).toContain('test_note')
    expect(track).toMatchObject({ path: '/Music/a.mp3', bpm: 124 })
  })

  it('keeps the rows of child tables when a migration rebuilds their parent', () => {
    // Arrange
    const [trackId] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
    ])
    const [batch] = testDatabase.db
      .insert(batches)
      .values({ type: 'full_run', mode: 'in_place' })
      .returning()
      .all()
    const link = { batchId: batch?.id as number, trackId: trackId as number }
    testDatabase.db
      .insert(batchItems)
      .values({ ...link, before: {}, after: {} })
      .run()
    testDatabase.db
      .insert(backups)
      .values({ ...link, originalPath: '/Music/a.mp3', backupPath: '/Backups/a.mp3' })
      .run()
    // The shape drizzle-kit emits when SQLite cannot alter a table in place.
    addMigration(
      '0001_rebuild_batches',
      [
        'PRAGMA foreign_keys=OFF;',
        "CREATE TABLE `__new_batches` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `type` text NOT NULL, `mode` text NOT NULL, `status` text DEFAULT 'computing' NOT NULL, `created_at` integer NOT NULL, `applied_at` integer, `note` text);",
        'INSERT INTO `__new_batches`(`id`, `type`, `mode`, `status`, `created_at`, `applied_at`) SELECT `id`, `type`, `mode`, `status`, `created_at`, `applied_at` FROM `batches`;',
        'DROP TABLE `batches`;',
        'ALTER TABLE `__new_batches` RENAME TO `batches`;',
        'PRAGMA foreign_keys=ON;'
      ].join('\n--> statement-breakpoint\n')
    )

    // Act
    const upgraded = testDatabase.reopen()

    // Assert
    expect(upgraded.select().from(batchItems).all()).toHaveLength(1)
    expect(upgraded.select().from(backups).all()).toHaveLength(1)
    expect(upgraded.get<{ foreign_keys: number }>(sql`pragma foreign_keys`).foreign_keys).toBe(1)
  })

  it('keeps every analysis when the table is rebuilt for a new type, and takes rb_grid', () => {
    // Arrange
    const [trackId] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
    ])
    saveAnalysis(testDatabase.db, {
      trackId: trackId as number,
      type: 'bpm_key',
      result: { bpm: 124 },
      analyzerVersion: '1'
    })
    // The rebuild of migration 0007 once more, on a table that holds a row.
    addMigration(
      '0099_rebuild_analyses_again',
      readFileSync(join(testDatabase.migrationsFolder, '0007_analyses_rb_grid.sql'), 'utf8')
    )

    // Act
    const upgraded = testDatabase.reopen()
    saveAnalysis(upgraded, {
      trackId: trackId as number,
      type: 'rb_grid',
      result: { tempos: [] },
      analyzerVersion: 'rekordbox-xml'
    })
    const unknown = (): unknown =>
      upgraded.run(
        sql`insert into analyses (track_id, type, result, analyzer_version, created_at) values (${trackId}, 'nonsense', '{}', '1', 0)`
      )

    // Assert
    expect(
      upgraded
        .select()
        .from(analyses)
        .all()
        .map((row) => row.type)
        .sort()
    ).toEqual(['bpm_key', 'rb_grid'])
    expect(unknown).toThrow()
  })

  it('refuses a migration that leaves a broken reference behind', () => {
    // Arrange
    addMigration(
      '0001_orphan',
      "INSERT INTO `analyses` (`track_id`, `type`, `result`, `analyzer_version`, `created_at`) VALUES (999, 'bpm_key', '{}', '1', 0);"
    )

    // Act
    const open = (): unknown => openDatabase(testDatabase.filePath, testDatabase.migrationsFolder)

    // Assert
    expect(open).toThrow(/foreign key/)
  })

  it('refuses a database that a newer version of the app has migrated', () => {
    // Arrange
    const sqlite = new Database(testDatabase.filePath)
    sqlite
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run('hash-of-a-migration-this-app-does-not-have', Date.now() + 1_000_000)
    sqlite.close()

    // Act
    const open = (): unknown => openDatabase(testDatabase.filePath, testDatabase.migrationsFolder)

    // Assert
    expect(open).toThrow(/does not match this version/)
  })

  it('creates the folder of the database on a first start', () => {
    // Arrange
    const nestedPath = join(testDatabase.migrationsFolder, 'fresh/profile/fixlibrary.db')

    // Act
    const connection = openDatabase(nestedPath, testDatabase.migrationsFolder)
    connection.close()

    // Assert
    expect(statSync(nestedPath).isFile()).toBe(true)
  })

  it('keeps the database and its write-ahead log private to the user', () => {
    // Arrange
    insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
    ])

    // Act
    const modes = ['', '-wal', '-shm'].map(
      (suffix) => statSync(testDatabase.filePath + suffix).mode & 0o777
    )

    // Assert
    expect(modes).toEqual([0o600, 0o600, 0o600])
  })

  it('does not apply a migration twice', () => {
    // Arrange
    addMigration('0001_test_note', 'ALTER TABLE `tracks` ADD `test_note` text;')
    testDatabase.reopen()

    // Act
    const openAgain = (): unknown => testDatabase.reopen()

    // Assert
    expect(openAgain).not.toThrow()
  })

  it('rolls a failing migration back and reports it', () => {
    // Arrange
    addMigration(
      '0001_broken',
      'ALTER TABLE `tracks` ADD `half_done` text;\n--> statement-breakpoint\nALTER TABLE `missing_table` ADD `x` text;'
    )

    // Act
    const open = (): unknown => openDatabase(testDatabase.filePath, testDatabase.migrationsFolder)
    expect(open).toThrow()
    const sqlite = new Database(testDatabase.filePath, { readonly: true })
    const columns = (sqlite.pragma('table_info(tracks)') as { name: string }[]).map(
      (column) => column.name
    )
    sqlite.close()

    // Assert
    expect(columns).not.toContain('half_done')
  })

  it('fails on a file that is not a database, without replacing it', () => {
    // Arrange
    const notADatabase = join(testDatabase.migrationsFolder, 'notes.txt')
    appendFileSync(notADatabase, 'this is not SQLite '.repeat(200))

    // Act
    const open = (): unknown => openDatabase(notADatabase, testDatabase.migrationsFolder)

    // Assert
    expect(open).toThrow()
    expect(readFileSync(notADatabase, 'utf8')).toContain('this is not SQLite')
  })
})
