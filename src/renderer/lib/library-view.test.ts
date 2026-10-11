import { describe, expect, it } from 'vitest'
import type { LibraryTrack } from '@shared/library'
import type { Style } from '@shared/settings'
import { applyView, DEFAULT_VIEW, nextSort, trackState, type LibraryView } from './library-view'

const STYLES: Style[] = [
  { id: 7, name: 'Techno', color: '#ef4444', isHouse: false },
  { id: 3, name: 'House', color: '#22c55e', isHouse: true }
]

let nextId = 1

function track(overrides: Partial<LibraryTrack> = {}): LibraryTrack {
  const id = nextId++
  return {
    id,
    fileName: `${id}.mp3`,
    folder: '/Music',
    format: 'mp3',
    durationMs: 200_000,
    artist: null,
    title: null,
    bpm: null,
    camelotKey: null,
    energy: null,
    styleId: null,
    coverStatus: 'missing',
    stageStatus: { scan: 'done' },
    offline: false,
    fileMissing: false,
    ...overrides
  }
}

function view(overrides: Partial<LibraryView>): LibraryView {
  return { ...DEFAULT_VIEW, ...overrides }
}

function titles(tracks: readonly LibraryTrack[]): (string | null)[] {
  return tracks.map((entry) => entry.title)
}

describe('applyView: search', () => {
  const tracks = [
    track({ artist: 'Előadó', title: 'Tűz' }),
    track({ artist: 'Other', title: 'Water' }),
    track({ fileName: 'untagged tuzes file.mp3' })
  ]

  it('finds a word in the artist, the title or the file name, ignoring case and accents', () => {
    // Act
    const found = applyView(tracks, view({ search: 'TUZ' }), STYLES)

    // Assert
    expect(found.map((entry) => entry.id)).toEqual([tracks[0]?.id, tracks[2]?.id])
  })

  it('needs every word of the search to match', () => {
    // Act
    const found = applyView(tracks, view({ search: 'eloado tuz' }), STYLES)
    const none = applyView(tracks, view({ search: 'eloado water' }), STYLES)

    // Assert
    expect(titles(found)).toEqual(['Tűz'])
    expect(none).toEqual([])
  })

  it('shows every track for an empty search, in library order', () => {
    // Act
    const found = applyView(tracks, view({ search: '   ' }), STYLES)

    // Assert
    expect(found).toEqual(tracks)
  })
})

describe('applyView: filters', () => {
  const tracks = [
    track({ title: 'house', styleId: 3 }),
    track({ title: 'techno', styleId: 7 }),
    track({ title: 'no style' }),
    track({ title: 'offline', offline: true, styleId: 3 }),
    track({ title: 'missing', fileMissing: true }),
    track({ title: 'unreadable', stageStatus: { scan: 'failed' } }),
    track({ title: 'timed out', stageStatus: { scan: 'skipped' } })
  ]

  it('filters by style, and by having no style', () => {
    // Act
    const house = applyView(tracks, view({ style: 3 }), STYLES)
    const none = applyView(tracks, view({ style: 'none' }), STYLES)

    // Assert
    expect(titles(house)).toEqual(['house', 'offline'])
    expect(titles(none)).toEqual(['no style', 'missing', 'unreadable', 'timed out'])
  })

  it('filters by what keeps a track from being worked on', () => {
    // Act
    const byState = (['ok', 'offline', 'missing', 'unreadable'] as const).map((state) =>
      titles(applyView(tracks, view({ state }), STYLES))
    )

    // Assert
    expect(byState).toEqual([
      ['house', 'techno', 'no style'],
      ['offline'],
      ['missing'],
      ['unreadable', 'timed out']
    ])
  })

  it('reports an offline track as offline even when its file is also missing', () => {
    // Act
    const state = trackState(track({ offline: true, fileMissing: true }))

    // Assert
    expect(state).toBe('offline')
  })
})

describe('applyView: sorting', () => {
  it('sorts text the Hungarian way and puts tracks without a value last in both directions', () => {
    // Arrange
    const tracks = [
      track({ title: 'zebra', artist: 'Zed' }),
      track({ title: 'no artist' }),
      track({ title: 'ékezet', artist: 'Ádám' }),
      track({ title: 'b', artist: 'bela' })
    ]

    // Act
    const ascending = applyView(
      tracks,
      view({ sort: { key: 'artist', descending: false } }),
      STYLES
    )
    const descending = applyView(
      tracks,
      view({ sort: { key: 'artist', descending: true } }),
      STYLES
    )

    // Assert
    expect(titles(ascending)).toEqual(['ékezet', 'b', 'zebra', 'no artist'])
    expect(titles(descending)).toEqual(['zebra', 'b', 'ékezet', 'no artist'])
  })

  it('sorts numbers as numbers', () => {
    // Arrange
    const tracks = [
      track({ title: 'a', bpm: 128 }),
      track({ title: 'b', bpm: 99.5 }),
      track({ title: 'c', bpm: 124 })
    ]

    // Act
    const sorted = applyView(tracks, view({ sort: { key: 'bpm', descending: false } }), STYLES)

    // Assert
    expect(titles(sorted)).toEqual(['b', 'c', 'a'])
  })

  it('sorts keys around the Camelot wheel, not as text, and what is not a key last', () => {
    // Arrange
    const tracks = ['10A', '13A', '2B', '1A', '0B', '12B', '2A'].map((camelotKey) =>
      track({ title: camelotKey, camelotKey })
    )

    // Act
    const sorted = applyView(tracks, view({ sort: { key: 'key', descending: false } }), STYLES)

    // Assert
    expect(titles(sorted)).toEqual(['1A', '2A', '2B', '10A', '12B', '13A', '0B'])
  })

  it('sorts styles in the order of the Settings list', () => {
    // Arrange
    const tracks = [track({ title: 'house', styleId: 3 }), track({ title: 'techno', styleId: 7 })]

    // Act
    const sorted = applyView(tracks, view({ sort: { key: 'style', descending: false } }), STYLES)

    // Assert
    expect(titles(sorted)).toEqual(['techno', 'house'])
  })

  it('sorts an untitled track by its file name, and keeps library order among equals', () => {
    // Arrange
    const tracks = [
      track({ fileName: 'b.mp3' }),
      track({ title: 'a', bpm: 120 }),
      track({ title: 'c', bpm: 120 })
    ]

    // Act
    const byTitle = applyView(tracks, view({ sort: { key: 'title', descending: false } }), STYLES)
    const byBpm = applyView(tracks, view({ sort: { key: 'bpm', descending: true } }), STYLES)

    // Assert
    expect(byTitle.map((entry) => entry.title ?? entry.fileName)).toEqual(['a', 'b.mp3', 'c'])
    expect(titles(byBpm)).toEqual(['a', 'c', null])
  })

  it('handles 3000 rows', () => {
    // Arrange
    const tracks = Array.from({ length: 3000 }, (_, index) => track({ bpm: 3000 - index }))

    // Act
    const sorted = applyView(tracks, view({ sort: { key: 'bpm', descending: false } }), STYLES)

    // Assert
    expect(sorted).toHaveLength(3000)
    expect(sorted[0]?.bpm).toBe(1)
  })
})

describe('nextSort', () => {
  it('goes from ascending to descending to no sorting on the same column', () => {
    // Act
    const first = nextSort(null, 'bpm')
    const second = nextSort(first, 'bpm')
    const third = nextSort(second, 'bpm')

    // Assert
    expect([first, second, third]).toEqual([
      { key: 'bpm', descending: false },
      { key: 'bpm', descending: true },
      null
    ])
  })

  it('starts ascending on another column', () => {
    // Act
    const sort = nextSort({ key: 'bpm', descending: true }, 'artist')

    // Assert
    expect(sort).toEqual({ key: 'artist', descending: false })
  })
})
