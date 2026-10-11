import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { styles } from '../db/schema'
import { insertTracks, setTracksMissing, type NewTrack } from '../db/tracks'
import { listLibraryPage, resolveRunTargets } from './library'

const MOUNTED: ReadonlySet<string> = new Set(['DJ SSD'])

let testDatabase: TestDatabase

function newTrack(path: string, overrides: Partial<NewTrack> = {}): NewTrack {
  return { path, originalPath: path, format: 'mp3', ...overrides }
}

function addTracks(count: number, folder = '/Volumes/DJ SSD/Music'): number[] {
  return insertTracks(
    testDatabase.db,
    Array.from({ length: count }, (_, index) =>
      newTrack(`${folder}/${String(index).padStart(4, '0')}.mp3`)
    )
  )
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('listLibraryPage', () => {
  it('returns what the table shows of a track, and the size of the library', () => {
    // Arrange
    const [style] = testDatabase.db
      .insert(styles)
      .values({ name: 'House', color: '#22c55e' })
      .returning({ id: styles.id })
      .all()
    insertTracks(testDatabase.db, [
      newTrack('/Volumes/DJ SSD/Music/House/Tűz.mp3', {
        artist: 'Előadó',
        title: 'Tűz',
        durationMs: 372_000,
        bpm: 124,
        camelotKey: '8A',
        energy: 7,
        primaryStyleId: style?.id,
        coverStatus: 'embedded',
        stageStatus: { scan: 'done' }
      }),
      newTrack('/Volumes/Gone/b.wav', { format: 'wav' })
    ])

    // Act
    const page = listLibraryPage(testDatabase.db, { limit: 1, offset: 0 }, MOUNTED)

    // Assert
    expect(page).toEqual({
      ok: true,
      value: {
        total: 2,
        tracks: [
          {
            id: expect.any(Number),
            fileName: 'Tűz.mp3',
            folder: '/Volumes/DJ SSD/Music/House',
            format: 'mp3',
            durationMs: 372_000,
            artist: 'Előadó',
            title: 'Tűz',
            bpm: 124,
            camelotKey: '8A',
            energy: 7,
            styleId: style?.id,
            coverStatus: 'embedded',
            stageStatus: { scan: 'done' },
            offline: false,
            fileMissing: false
          }
        ]
      }
    })
  })

  it('shows a file name as one line without characters that reverse the reading direction', () => {
    // Arrange
    insertTracks(testDatabase.db, [newTrack('/Volumes/DJ SSD/Mu\nsic/track\u202egpj.mp3')])

    // Act
    const page = listLibraryPage(testDatabase.db, { limit: 10, offset: 0 }, MOUNTED)

    // Assert
    expect(page).toMatchObject({
      ok: true,
      value: { tracks: [{ fileName: 'track gpj.mp3', folder: '/Volumes/DJ SSD/Mu sic' }] }
    })
  })

  it('marks a track offline whose drive is not connected', () => {
    // Arrange
    insertTracks(testDatabase.db, [newTrack('/Volumes/Gone/b.wav', { format: 'wav' })])

    // Act
    const page = listLibraryPage(testDatabase.db, { limit: 10, offset: 0 }, MOUNTED)

    // Assert
    expect(page).toMatchObject({ ok: true, value: { tracks: [{ offline: true }] } })
  })

  it('pages through a library of 3000 tracks without a gap or a repeat', () => {
    // Arrange
    const ids = addTracks(3000)

    // Act
    const seen: number[] = []
    for (let offset = 0; offset < 3000; offset += 500) {
      const page = listLibraryPage(testDatabase.db, { limit: 500, offset }, MOUNTED)
      if (page.ok) seen.push(...page.value.tracks.map((track) => track.id))
    }

    // Assert
    expect(seen).toEqual(ids)
  })

  it.each([
    ['a page larger than the limit', { limit: 501, offset: 0 }],
    ['a negative offset', { limit: 10, offset: -1 }],
    ['an extra field', { limit: 10, offset: 0, where: '1=1' }],
    ['no request', undefined]
  ])('refuses %s', (_name, request) => {
    // Act
    const page = listLibraryPage(testDatabase.db, request, MOUNTED)

    // Assert
    expect(page).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('resolveRunTargets', () => {
  it('runs on exactly the 20 selected tracks, in the order they were selected', () => {
    // Arrange
    const ids = addTracks(200)
    const selected = ids.filter((_, index) => index % 10 === 3).reverse()

    // Act
    const targets = resolveRunTargets(
      testDatabase.db,
      { scope: 'selection', trackIds: selected },
      MOUNTED
    )

    // Assert
    expect(selected).toHaveLength(20)
    expect(targets).toEqual({ ok: true, value: { trackIds: selected, skipped: 0 } })
  })

  it('runs on every track of the library, in library order', () => {
    // Arrange
    const ids = addTracks(50)

    // Act
    const targets = resolveRunTargets(testDatabase.db, { scope: 'library' }, MOUNTED)

    // Assert
    expect(targets).toEqual({ ok: true, value: { trackIds: ids, skipped: 0 } })
  })

  it('leaves out tracks that are offline, without a file, or not in the library', () => {
    // Arrange
    const [online, missing] = addTracks(2) as [number, number]
    const [offline] = addTracks(1, '/Volumes/Gone/Music') as [number]
    setTracksMissing(testDatabase.db, [missing], true)

    // Act
    const selection = resolveRunTargets(
      testDatabase.db,
      { scope: 'selection', trackIds: [offline, online, missing, 999_999] },
      MOUNTED
    )
    const library = resolveRunTargets(testDatabase.db, { scope: 'library' }, MOUNTED)

    // Assert
    expect(selection).toEqual({ ok: true, value: { trackIds: [online], skipped: 3 } })
    expect(library).toEqual({ ok: true, value: { trackIds: [online], skipped: 2 } })
  })

  it('counts a track once that was named twice', () => {
    // Arrange
    const [id] = addTracks(1) as [number]

    // Act
    const targets = resolveRunTargets(
      testDatabase.db,
      { scope: 'selection', trackIds: [id, id, id] },
      MOUNTED
    )

    // Assert
    expect(targets).toEqual({ ok: true, value: { trackIds: [id], skipped: 0 } })
  })

  it.each([
    ['an empty selection', { scope: 'selection', trackIds: [] }],
    ['an id that is not a number', { scope: 'selection', trackIds: ['1'] }],
    ['a path in place of an id', { scope: 'selection', trackIds: ['/etc/passwd'] }],
    ['an unknown scope', { scope: 'everything' }],
    ['ids with the library scope', { scope: 'library', trackIds: [1] }],
    [
      'more ids than a library can hold',
      { scope: 'selection', trackIds: new Array(20_001).fill(1) }
    ],
    ['no request', null]
  ])('refuses %s', (_name, request) => {
    // Act
    const targets = resolveRunTargets(testDatabase.db, request, MOUNTED)

    // Assert
    expect(targets).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})
