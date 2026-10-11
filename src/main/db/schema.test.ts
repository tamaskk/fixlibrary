import { asc, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backups,
  batches,
  batchItems,
  cues,
  energyCalibration,
  playlists,
  playlistTracks
} from './schema'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import { deleteTrack, insertTracks } from './tracks'

let testDatabase: TestDatabase
let trackId: number

beforeEach(() => {
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
  ])
  trackId = id as number
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('cues', () => {
  const cue = { name: 'Drop', color: '#ff0000', positionMs: 64_000 }

  it('allows one cue per slot of a track', () => {
    // Arrange
    testDatabase.db
      .insert(cues)
      .values({ ...cue, trackId, slot: 4 })
      .run()

    // Act
    const insertSameSlot = (): unknown =>
      testDatabase.db
        .insert(cues)
        .values({ ...cue, trackId, slot: 4 })
        .run()

    // Assert
    expect(insertSameSlot).toThrow(/UNIQUE/)
  })

  it.each([0, 9])('rejects slot %i, outside 1 to 8', (slot) => {
    // Act
    const insert = (): unknown =>
      testDatabase.db
        .insert(cues)
        .values({ ...cue, trackId, slot })
        .run()

    // Assert
    expect(insert).toThrow(/CHECK/)
  })

  it('rejects a negative position', () => {
    // Act
    const insert = (): unknown =>
      testDatabase.db
        .insert(cues)
        .values({ ...cue, trackId, slot: 1, positionMs: -1 })
        .run()

    // Assert
    expect(insert).toThrow(/CHECK/)
  })
})

describe('batches', () => {
  function insertBatch(): number {
    const [batch] = testDatabase.db
      .insert(batches)
      .values({ type: 'full_run', mode: 'in_place' })
      .returning()
      .all()
    return batch?.id as number
  }

  it('starts a batch in the computing state, not yet applied', () => {
    // Act
    const [batch] = testDatabase.db
      .insert(batches)
      .values({ type: 'full_run', mode: 'clean_library' })
      .returning()
      .all()

    // Assert
    expect(batch).toMatchObject({ status: 'computing', appliedAt: null })
  })

  it('rejects a status the app does not know', () => {
    // Arrange
    const batch = { type: 'full_run', mode: 'in_place', status: 'half-applied' }

    // Act
    const insert = (): unknown =>
      testDatabase.db
        .insert(batches)
        .values(batch as unknown as typeof batches.$inferInsert)
        .run()

    // Assert
    expect(insert).toThrow(/CHECK/)
  })

  it('removes the items of a deleted batch', () => {
    // Arrange
    const batchId = insertBatch()
    testDatabase.db
      .insert(batchItems)
      .values({ batchId, trackId, before: { title: 'a' }, after: { title: 'A' } })
      .run()

    // Act
    testDatabase.db.delete(batches).run()

    // Assert
    expect(testDatabase.db.select().from(batchItems).all()).toEqual([])
  })

  it('holds a track once per batch, unapproved and included by default', () => {
    // Arrange
    const item = { batchId: insertBatch(), trackId, before: {}, after: {} }

    // Act
    const [stored] = testDatabase.db.insert(batchItems).values(item).returning().all()
    const insertAgain = (): unknown => testDatabase.db.insert(batchItems).values(item).run()

    // Assert
    expect(stored).toMatchObject({ approved: false, excluded: false, error: null })
    expect(insertAgain).toThrow(/UNIQUE/)
  })
})

describe('backups', () => {
  const paths = { originalPath: '/Music/a.mp3', backupPath: '/Backups/a.mp3' }

  function insertBatchWithBackup(): number {
    const [batch] = testDatabase.db
      .insert(batches)
      .values({ type: 'full_run', mode: 'in_place' })
      .returning()
      .all()
    const batchId = batch?.id as number
    testDatabase.db
      .insert(backups)
      .values({ batchId, trackId, ...paths })
      .run()
    return batchId
  }

  it('refuses to delete a batch that still has backups', () => {
    // Arrange
    insertBatchWithBackup()

    // Act
    const remove = (): unknown => testDatabase.db.delete(batches).run()

    // Assert
    expect(remove).toThrow(/FOREIGN KEY/)
    expect(testDatabase.db.select().from(backups).all()).toHaveLength(1)
  })

  it('keeps the backup record, with both paths, when its track is deleted', () => {
    // Arrange
    insertBatchWithBackup()

    // Act
    deleteTrack(testDatabase.db, trackId)
    const [backup] = testDatabase.db.select().from(backups).all()

    // Assert
    expect(backup).toMatchObject({ ...paths, trackId: null })
  })
})

describe('playlists', () => {
  function insertPlaylist(): number {
    const [playlist] = testDatabase.db
      .insert(playlists)
      .values({ name: 'Warm up' })
      .returning()
      .all()
    return playlist?.id as number
  }

  it('shifts every position in one statement when a track is inserted at the front', () => {
    // Arrange
    const playlistId = insertPlaylist()
    testDatabase.db
      .insert(playlistTracks)
      .values([0, 1, 2].map((position) => ({ playlistId, trackId, position })))
      .run()

    // Act
    testDatabase.db
      .update(playlistTracks)
      .set({ position: sql`${playlistTracks.position} + 1` })
      .where(eq(playlistTracks.playlistId, playlistId))
      .run()
    const positions = testDatabase.db
      .select({ position: playlistTracks.position })
      .from(playlistTracks)
      .orderBy(asc(playlistTracks.position))
      .all()

    // Assert
    expect(positions.map((row) => row.position)).toEqual([1, 2, 3])
  })

  it('drops the entries of a deleted track', () => {
    // Arrange
    testDatabase.db
      .insert(playlistTracks)
      .values({ playlistId: insertPlaylist(), trackId, position: 0 })
      .run()

    // Act
    deleteTrack(testDatabase.db, trackId)

    // Assert
    expect(testDatabase.db.select().from(playlistTracks).all()).toEqual([])
  })
})

describe('energy calibration', () => {
  it.each([0, 11])('rejects rating %i, outside 1 to 10', (rating) => {
    // Act
    const insert = (): unknown =>
      testDatabase.db
        .insert(energyCalibration)
        .values({ trackId, rating, ratedAt: new Date() })
        .run()

    // Assert
    expect(insert).toThrow(/CHECK/)
  })

  it('keeps one rating per track', () => {
    // Arrange
    const rating = { trackId, rating: 7, ratedAt: new Date() }
    testDatabase.db.insert(energyCalibration).values(rating).run()

    // Act
    const insertAgain = (): unknown =>
      testDatabase.db.insert(energyCalibration).values(rating).run()

    // Assert
    expect(insertAgain).toThrow(/UNIQUE|PRIMARY/)
  })
})
