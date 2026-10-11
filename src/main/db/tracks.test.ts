import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batches, batchItems, styles, tracks } from './schema'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import {
  MAX_TRACK_PAGE_SIZE,
  countTracks,
  deleteTrack,
  getTrackById,
  getTracksByIds,
  insertTracks,
  listTrackFileStates,
  listTracks,
  setTracksMissing,
  updateTrack,
  updateTracks,
  type NewTrack
} from './tracks'

const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase

function newTrack(path: string, overrides: Partial<NewTrack> = {}): NewTrack {
  return { path, originalPath: path, format: 'mp3', ...overrides }
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('insertTracks', () => {
  it('stores every field and returns it unchanged', () => {
    // Arrange
    const row = newTrack('/Volumes/DJ SSD/House/Tűz.mp3', {
      durationMs: 372_000,
      bitrateKbps: 320,
      sampleRateHz: 44_100,
      artist: 'Előadó feat. Másik',
      title: 'Tűz',
      mix: 'Extended Mix',
      year: 2024,
      bpm: 124.5,
      camelotKey: '8A',
      musicalKey: 'Am',
      energy: 7,
      lufs: -11.2,
      truePeakDbtp: -1.1,
      stageStatus: { metadata: 'done', cover: 'pending' }
    })

    // Act
    const [id] = insertTracks(testDatabase.db, [row])
    const stored = getTrackById(testDatabase.db, id as number, new Set(['DJ SSD']))

    // Assert
    expect(stored).toMatchObject({
      ...row,
      volumeName: 'DJ SSD',
      coverStatus: 'unknown',
      offline: false
    })
    expect(stored?.createdAt).toBeInstanceOf(Date)
  })

  it('inserts a whole library scan and returns ids in input order', () => {
    // Arrange
    const rows = Array.from({ length: 3000 }, (_, index) =>
      newTrack(`/Music/${String(index).padStart(4, '0')}.mp3`)
    )

    // Act
    const ids = insertTracks(testDatabase.db, rows)
    const lastPage = listTracks(testDatabase.db, { limit: 10, offset: 2990 }, NO_VOLUMES)

    // Assert
    expect(ids).toHaveLength(3000)
    expect(new Set(ids).size).toBe(3000)
    expect(lastPage.map((track) => track.path)).toEqual(rows.slice(2990).map((row) => row.path))
    expect(lastPage.at(-1)?.id).toBe(ids.at(-1))
  })

  it('inserts nothing when one row of the batch is invalid', () => {
    // Arrange
    const rows = [newTrack('/Music/a.mp3'), newTrack('/Music/b.mp3'), newTrack('/Music/a.mp3')]

    // Act
    const insert = (): unknown => insertTracks(testDatabase.db, rows)

    // Assert
    expect(insert).toThrow(/UNIQUE/)
    expect(listTracks(testDatabase.db, { limit: 10, offset: 0 }, NO_VOLUMES)).toEqual([])
  })

  it('refuses the same file under a decomposed and a composed spelling', () => {
    // Arrange
    const composed = '/Volumes/Zenék/Tűz.mp3'.normalize('NFC')
    const rows = [newTrack(composed), newTrack(composed.normalize('NFD'))]

    // Act
    const insert = (): unknown => insertTracks(testDatabase.db, rows)

    // Assert
    expect(insert).toThrow(/UNIQUE/)
  })

  it('refuses a relative path', () => {
    // Act
    const insert = (): unknown => insertTracks(testDatabase.db, [newTrack('Music/a.mp3')])

    // Assert
    expect(insert).toThrow(/absolute/)
  })

  it('rejects a format the app does not know', () => {
    // Arrange
    const row = { ...newTrack('/Music/a.flac'), format: 'flac' } as unknown as NewTrack

    // Act
    const insert = (): unknown => insertTracks(testDatabase.db, [row])

    // Assert
    expect(insert).toThrow(/CHECK/)
  })

  it('rejects an energy value outside 1 to 10', () => {
    // Arrange
    const row = newTrack('/Music/a.mp3', { energy: 11 })

    // Act
    const insert = (): unknown => insertTracks(testDatabase.db, [row])

    // Assert
    expect(insert).toThrow(/CHECK/)
  })
})

describe('offline marking', () => {
  it('marks a track offline when its volume is not mounted', () => {
    // Arrange
    const [onDrive, onStartupDisk] = insertTracks(testDatabase.db, [
      newTrack('/Volumes/DJ SSD/a.mp3'),
      newTrack('/Users/dj/Music/b.mp3')
    ])
    const mounted = new Set(['Macintosh HD'])

    // Act
    const driveTrack = getTrackById(testDatabase.db, onDrive as number, mounted)
    const localTrack = getTrackById(testDatabase.db, onStartupDisk as number, mounted)

    // Assert
    expect(driveTrack?.offline).toBe(true)
    expect(localTrack?.offline).toBe(false)
  })

  it('marks the same track online again once the volume is mounted', () => {
    // Arrange
    insertTracks(testDatabase.db, [newTrack('/Volumes/DJ SSD/a.mp3')])

    // Act
    const whileDetached = listTracks(testDatabase.db, { limit: 10, offset: 0 }, NO_VOLUMES)
    const whileAttached = listTracks(testDatabase.db, { limit: 10, offset: 0 }, new Set(['DJ SSD']))

    // Assert
    expect(whileDetached.map((track) => track.offline)).toEqual([true])
    expect(whileAttached.map((track) => track.offline)).toEqual([false])
  })
})

describe('listTracks', () => {
  it('caps the page size and treats a negative limit as an empty page', () => {
    // Arrange
    const rows = Array.from({ length: MAX_TRACK_PAGE_SIZE + 10 }, (_, index) =>
      newTrack(`/Music/${String(index).padStart(4, '0')}.mp3`)
    )
    insertTracks(testDatabase.db, rows)

    // Act
    const huge = listTracks(testDatabase.db, { limit: 1_000_000, offset: 0 }, NO_VOLUMES)
    const negative = listTracks(testDatabase.db, { limit: -1, offset: 0 }, NO_VOLUMES)

    // Assert
    expect(huge).toHaveLength(MAX_TRACK_PAGE_SIZE)
    expect(negative).toEqual([])
  })

  it('still lists the page when one row has an unreadable stage status', () => {
    // Arrange
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const [, corruptId] = insertTracks(testDatabase.db, [
      newTrack('/Music/a.mp3', { stageStatus: { metadata: 'done' } }),
      newTrack('/Music/b.mp3'),
      newTrack('/Music/c.mp3', { stageStatus: { cover: 'failed' } })
    ])
    testDatabase.db
      .update(tracks)
      .set({ stageStatus: { metadata: 'exploded' } })
      .where(eq(tracks.id, corruptId as number))
      .run()

    // Act
    const page = listTracks(testDatabase.db, { limit: 10, offset: 0 }, NO_VOLUMES)

    // Assert
    expect(page.map((track) => track.stageStatus)).toEqual([
      { metadata: 'done' },
      {},
      { cover: 'failed' }
    ])
    expect(logged).toHaveBeenCalledOnce()
  })
})

describe('updateTrack', () => {
  it('moves the track to the volume of its new path', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [newTrack('/Users/dj/Inbox/a.mp3')])

    // Act
    updateTrack(testDatabase.db, id as number, { path: '/Volumes/DJ SSD//House/a.mp3' })
    const track = getTrackById(testDatabase.db, id as number, NO_VOLUMES)

    // Assert
    expect(track).toMatchObject({
      path: '/Volumes/DJ SSD/House/a.mp3',
      originalPath: '/Users/dj/Inbox/a.mp3',
      volumeName: 'DJ SSD',
      offline: true
    })
  })

  it('changes the given fields and moves updatedAt forward', async () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [newTrack('/Music/a.mp3', { title: 'Old' })])
    const before = getTrackById(testDatabase.db, id as number, NO_VOLUMES)
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Act
    const changed = updateTrack(testDatabase.db, id as number, {
      title: 'New',
      path: '/Music/House/a.mp3',
      stageStatus: { metadata: 'done' }
    })
    const after = getTrackById(testDatabase.db, id as number, NO_VOLUMES)

    // Assert
    expect(changed).toBe(true)
    expect(after).toMatchObject({
      title: 'New',
      path: '/Music/House/a.mp3',
      originalPath: '/Music/a.mp3',
      stageStatus: { metadata: 'done' }
    })
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? Infinity)
  })

  it('reports that nothing changed for an unknown id', () => {
    // Act
    const changed = updateTrack(testDatabase.db, 999, { title: 'New' })

    // Assert
    expect(changed).toBe(false)
  })
})

describe('deleteTrack', () => {
  it('removes the row', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [newTrack('/Music/a.mp3')])

    // Act
    const deleted = deleteTrack(testDatabase.db, id as number)

    // Assert
    expect(deleted).toBe(true)
    expect(getTrackById(testDatabase.db, id as number, NO_VOLUMES)).toBeUndefined()
  })

  it('refuses to remove a track that a batch still refers to', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [newTrack('/Music/a.mp3')])
    const [batch] = testDatabase.db
      .insert(batches)
      .values({ type: 'full_run', mode: 'in_place' })
      .returning()
      .all()
    testDatabase.db
      .insert(batchItems)
      .values({ batchId: batch?.id as number, trackId: id as number, before: {}, after: {} })
      .run()

    // Act
    const remove = (): unknown => deleteTrack(testDatabase.db, id as number)

    // Assert
    expect(remove).toThrow(/FOREIGN KEY/)
    expect(getTrackById(testDatabase.db, id as number, NO_VOLUMES)).toBeDefined()
    expect(testDatabase.db.select().from(batchItems).all()).toHaveLength(1)
  })
})

describe('reading a track', () => {
  it('keeps the track and clears its style when the style is deleted', () => {
    // Arrange
    const [style] = testDatabase.db
      .insert(styles)
      .values({ name: 'Tech House', color: '#000000', isHouse: true })
      .returning()
      .all()
    const [id] = insertTracks(testDatabase.db, [
      newTrack('/Music/a.mp3', { primaryStyleId: style?.id })
    ])

    // Act
    testDatabase.db.delete(styles).run()
    const track = getTrackById(testDatabase.db, id as number, NO_VOLUMES)

    // Assert
    expect(track?.primaryStyleId).toBeNull()
  })
})

describe('file state for rescans', () => {
  it('lists what the last scan saw of every track', () => {
    // Arrange
    const [scanned, neverScanned] = insertTracks(testDatabase.db, [
      newTrack('/Music/a.mp3', {
        fileSizeBytes: 8_000_000,
        fileMtimeMs: 1_790_000_000_000,
        stageStatus: { scan: 'done' }
      }),
      newTrack('/Music/b.mp3')
    ])

    // Act
    const states = listTrackFileStates(testDatabase.db)

    // Assert
    expect(states).toEqual([
      {
        id: scanned,
        path: '/Music/a.mp3',
        originalPath: '/Music/a.mp3',
        fileSizeBytes: 8_000_000,
        fileMtimeMs: 1_790_000_000_000,
        fileMissing: false,
        stageStatus: { scan: 'done' }
      },
      {
        id: neverScanned,
        path: '/Music/b.mp3',
        originalPath: '/Music/b.mp3',
        fileSizeBytes: null,
        fileMtimeMs: null,
        fileMissing: false,
        stageStatus: {}
      }
    ])
  })

  it('marks a whole library missing and found again, keeping the rows', () => {
    // Arrange
    const ids = insertTracks(
      testDatabase.db,
      Array.from({ length: 1200 }, (_, index) => newTrack(`/Music/${index}.mp3`))
    )

    // Act
    setTracksMissing(testDatabase.db, ids, true)
    const missing = listTrackFileStates(testDatabase.db).filter((state) => state.fileMissing)
    setTracksMissing(testDatabase.db, ids.slice(0, 700), false)
    const stillMissing = listTrackFileStates(testDatabase.db).filter((state) => state.fileMissing)

    // Assert
    expect(missing).toHaveLength(1200)
    expect(stillMissing).toHaveLength(500)
    expect(countTracks(testDatabase.db)).toBe(1200)
  })
})

describe('updateTracks', () => {
  it('changes several tracks at once', () => {
    // Arrange
    const [first, second] = insertTracks(testDatabase.db, [
      newTrack('/Music/a.mp3'),
      newTrack('/Music/b.mp3')
    ]) as [number, number]

    // Act
    updateTracks(testDatabase.db, [
      { id: first, changes: { title: 'Első', fileSizeBytes: 10 } },
      { id: second, changes: { title: 'Második', fileSizeBytes: 20 } }
    ])

    // Assert
    expect(getTrackById(testDatabase.db, first, NO_VOLUMES)).toMatchObject({
      title: 'Első',
      fileSizeBytes: 10
    })
    expect(getTrackById(testDatabase.db, second, NO_VOLUMES)).toMatchObject({
      title: 'Második',
      fileSizeBytes: 20
    })
  })

  it('changes nothing when one of the changes is invalid', () => {
    // Arrange
    const [first, second] = insertTracks(testDatabase.db, [
      newTrack('/Music/a.mp3'),
      newTrack('/Music/b.mp3')
    ]) as [number, number]

    // Act
    const update = (): unknown =>
      updateTracks(testDatabase.db, [
        { id: first, changes: { title: 'Első' } },
        { id: second, changes: { energy: 11 } }
      ])

    // Assert
    expect(update).toThrow()
    expect(getTrackById(testDatabase.db, first, NO_VOLUMES)?.title).toBeNull()
  })
})

describe('getTracksByIds', () => {
  it('reads many tracks at once and leaves out an id without a track', () => {
    // Arrange
    const ids = insertTracks(
      testDatabase.db,
      Array.from({ length: 1200 }, (_, index) => newTrack(`/Volumes/DJ SSD/${index}.mp3`))
    )

    // Act
    const found = getTracksByIds(testDatabase.db, [...ids, 999_999], new Set())

    // Assert
    expect(found.map((track) => track.id).sort((a, b) => a - b)).toEqual(ids)
    expect(found.every((track) => track.offline)).toBe(true)
  })
})
