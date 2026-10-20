import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { getPlaylist } from '../db/playlists'
import { addStyle } from '../db/styles'
import { insertTracks, updateTrack } from '../db/tracks'
import {
  alternativesAt,
  createMixIndex,
  generateList,
  mixesWith,
  parsePrompt,
  saveAsPlaylist,
  stylesAt,
  type GeneratorDependencies,
  type GeneratorTrack,
  type Place
} from './generator'
import { energyAt, type EnergyProfile } from '@shared/energy-curves'
import { DEFAULT_GENERATOR_PARAMS, type GeneratorParams } from '@shared/generator'

const KEYS = Array.from({ length: 12 }, (_, index) => [`${index + 1}A`, `${index + 1}B`]).flat()

/** A seeded library of 300 tracks: 118–126 BPM, every key, energy 1–10, two styles. */
function syntheticLibrary(size = 300, seed = 7): GeneratorTrack[] {
  let state = seed
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  return Array.from({ length: size }, (_, index) => ({
    id: index + 1,
    bpm: 118 + Math.round(random() * 80) / 10,
    camelotKey: KEYS[Math.floor(random() * KEYS.length)] as string,
    energy: 1 + Math.floor(random() * 10),
    durationMs: 300_000 + Math.floor(random() * 120_000),
    primaryStyleId: random() < 0.5 ? 1 : 2,
    secondaryStyleId: null,
    moodTags: null
  }))
}

function params(overrides: Partial<GeneratorParams> = {}): GeneratorParams {
  return { ...DEFAULT_GENERATOR_PARAMS, bpmRange: [118, 126], ...overrides }
}

function tracksOf(places: readonly Place[]): GeneratorTrack[] {
  return places.flatMap((place) => (place.kind === 'track' ? [place.track] : []))
}

/** Every track mixes with the track placed before it, across a gap too. */
function expectMixable(places: readonly Place[], range: [number, number]): void {
  const tracks = tracksOf(places)
  tracks.forEach((track, index) => {
    expect(track.bpm).toBeGreaterThanOrEqual(range[0])
    expect(track.bpm).toBeLessThanOrEqual(range[1])
    const before = tracks[index - 1]
    if (before !== undefined) expect(mixesWith(before, track)).toBe(true)
  })
  expect(new Set(tracks.map((track) => track.id)).size).toBe(tracks.length)
}

function meanDeviation(places: readonly Place[], given: GeneratorParams): number {
  const tracks = places.flatMap((place) => (place.kind === 'track' ? [place] : []))
  return (
    tracks.reduce(
      (sum, place) =>
        sum +
        Math.abs(place.track.energy - energyAt(given.energyProfile, place.t, given.customCurve)),
      0
    ) / tracks.length
  )
}

describe('generateList', () => {
  it.each(['warmUp', 'peakTime', 'sunset', 'closing'] as EnergyProfile[])(
    'keeps the rules and follows the %s curve within 1.5',
    (energyProfile) => {
      // Arrange
      const given = params({ energyProfile, length: { unit: 'tracks', value: 20 } })

      // Act
      const places = generateList(syntheticLibrary(), given)

      // Assert
      expect(places).toHaveLength(20)
      expectMixable(places, given.bpmRange)
      expect(meanDeviation(places, given)).toBeLessThanOrEqual(1.5)
    }
  )

  it('follows a drawn curve within 1.5', () => {
    // Arrange
    const given = params({
      energyProfile: 'custom',
      customCurve: [
        { t: 0, energy: 2 },
        { t: 0.25, energy: 8 },
        { t: 0.5, energy: 4 },
        { t: 0.75, energy: 9 },
        { t: 1, energy: 3 }
      ],
      length: { unit: 'tracks', value: 20 }
    })

    // Act
    const places = generateList(syntheticLibrary(), given)

    // Assert
    expectMixable(places, given.bpmRange)
    expect(meanDeviation(places, given)).toBeLessThanOrEqual(1.5)
  })

  it('ends a set given in minutes within one track of its length', () => {
    // Arrange
    const given = params({ length: { unit: 'minutes', value: 120 } })

    // Act
    const tracks = tracksOf(generateList(syntheticLibrary(), given))

    // Assert
    const total = tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)
    const last = tracks.at(-1)?.durationMs ?? 0
    expect(total).toBeGreaterThanOrEqual(120 * 60_000)
    expect(total - 120 * 60_000).toBeLessThan(last)
  })

  it('moves from the first style to the second over the set', () => {
    // Arrange
    const given = params({ styleIds: [1, 2], length: { unit: 'tracks', value: 20 } })

    // Act
    const tracks = tracksOf(generateList(syntheticLibrary(), given))

    // Assert
    expect(tracks.slice(0, 8).every((track) => track.primaryStyleId === 1)).toBe(true)
    expect(tracks.slice(12).every((track) => track.primaryStyleId === 2)).toBe(true)
  })

  it('marks a place no track can take as a gap and goes on from the track before it', () => {
    // Arrange
    const library: GeneratorTrack[] = [
      { ...syntheticLibrary(1)[0]!, id: 1, bpm: 120, camelotKey: '8A' },
      { ...syntheticLibrary(1)[0]!, id: 2, bpm: 121, camelotKey: '9A' }
    ]
    const given = params({ length: { unit: 'tracks', value: 4 } })

    // Act
    const places = generateList(library, given)

    // Assert
    expect(places).toHaveLength(4)
    expect(places.filter((place) => place.kind === 'gap')).toHaveLength(2)
    const gap = places.find((place) => place.kind === 'gap')
    expect(gap?.kind === 'gap' && gap.target.bpm).toBeGreaterThanOrEqual(120)
    expectMixable(places, given.bpmRange)
  })
})

describe('the edges', () => {
  it('gives only gaps for an empty library, and ends', () => {
    // Act
    const places = generateList([], params({ length: { unit: 'minutes', value: 30 } }))

    // Assert
    expect(places.length).toBeGreaterThan(0)
    expect(places.every((place) => place.kind === 'gap')).toBe(true)
  })

  it.each([
    [{ bpm: 120, camelotKey: '8A' }, { bpm: 123, camelotKey: '8A' }, true],
    [{ bpm: 120, camelotKey: '8A' }, { bpm: 123.1, camelotKey: '8A' }, false],
    [{ bpm: 120, camelotKey: '8A' }, { bpm: 120, camelotKey: '8B' }, true],
    [{ bpm: 120, camelotKey: '12A' }, { bpm: 120, camelotKey: '1A' }, true],
    [{ bpm: 120, camelotKey: '8A' }, { bpm: 120, camelotKey: '10A' }, false]
  ])('%o and %o mix: %s', (a, b, expected) => {
    // Act
    const mixes = mixesWith(a, b)

    // Assert
    expect(mixes).toBe(expected)
  })

  it('places the same tracks with the key index as by walking the library', () => {
    // Arrange
    const library = syntheticLibrary()
    const last = library[0] as GeneratorTrack

    // Act
    const indexed = [...createMixIndex(library).after(last)].map((track) => track.id).sort()

    // Assert
    expect(indexed).toEqual(
      library
        .filter((track) => mixesWith(last, track))
        .map((track) => track.id)
        .sort()
    )
  })
})

describe('stylesAt', () => {
  it.each([
    [0.1, [1]],
    [0.5, [1, 2]],
    [0.9, [2]]
  ])('at %f takes %o', (t, expected) => {
    // Act
    const styles = stylesAt([1, 2], t)

    // Assert
    expect(styles.sort()).toEqual(expected)
  })
})

describe('alternativesAt', () => {
  it('offers five tracks that keep the list mixable when swapped in', () => {
    // Arrange
    const library = syntheticLibrary()
    const given = params({ length: { unit: 'tracks', value: 10 } })
    const list = tracksOf(generateList(library, given)).map((track) => track.id)

    // Act
    const offered = alternativesAt(library, library, given, list, 4)

    // Assert
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.length).toBeLessThanOrEqual(5)
    const byId = new Map(library.map((track) => [track.id, track]))
    for (const track of offered) {
      const swapped = [...list]
      swapped[4] = track.id
      const places: Place[] = swapped.map((id) => ({
        kind: 'track',
        track: byId.get(id) as GeneratorTrack,
        t: 0
      }))
      expectMixable(places, given.bpmRange)
    }
  })
})

describe('alternatives across a gap and out of range', () => {
  it('judges a place against the nearest track over a gap, and keeps only tracks in range', () => {
    // Arrange
    const base = syntheticLibrary(1)[0] as GeneratorTrack
    const known: GeneratorTrack[] = [
      { ...base, id: 1, bpm: 120, camelotKey: '8A' },
      { ...base, id: 2, bpm: 140, camelotKey: '8A' },
      { ...base, id: 3, bpm: 121, camelotKey: '8A' },
      { ...base, id: 4, bpm: 121, camelotKey: '3B' }
    ]
    const inRange = known.filter((track) => track.bpm <= 126)

    // Act
    const offered = alternativesAt(inRange, known, params(), [1, null, 99], 1)

    // Assert
    expect(offered.map((track) => track.id)).toEqual([3])
  })
})

describe('with the database', () => {
  let testDatabase: TestDatabase
  let dependencies: GeneratorDependencies

  beforeEach(() => {
    testDatabase = createTestDatabase()
    dependencies = {
      db: testDatabase.db,
      listMountedVolumes: () => new Set(),
      claude: () => null,
      onlineRecs: () => null
    }
  })

  afterEach(() => {
    testDatabase.cleanup()
  })

  it('reads the sunset prompt into its fields', async () => {
    // Arrange
    const organic = addStyle(testDatabase.db, 'Organic House', '#ffffff')?.id
    const afro = addStyle(testDatabase.db, 'Afro House', '#000000')?.id
    const ask = vi.fn(async () => ({
      styles: ['Organic House', 'Afro House', 'Polka'],
      minutes: 120,
      tracks: null,
      bpmMin: 118,
      bpmMax: 124,
      energyProfile: 'sunset',
      moods: []
    }))
    dependencies.claude = () => ({ ask }) as never

    // Act
    const result = await parsePrompt(
      dependencies,
      '2 órás sunset set, Organic House-ból Afro House-ba, 118–124 BPM'
    )

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        params: {
          styleIds: [organic, afro],
          length: { unit: 'minutes', value: 120 },
          bpmRange: [118, 124],
          energyProfile: 'sunset'
        },
        unknownStyles: ['Polka']
      }
    })
  })

  it('says Claude failed when it is not set up', async () => {
    // Act
    const result = await parsePrompt(dependencies, 'peak time')

    // Assert
    expect(result).toEqual({ ok: false, code: 'CLAUDE_FAILED' })
  })

  it('reads one prompt at a time, and takes five styles at most', async () => {
    // Arrange
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map(
      (name, index) => addStyle(testDatabase.db, name, `#00000${index}`)?.id
    )
    let answer: () => void = () => undefined
    const ask = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              styles: ['A', 'B', 'C', 'D', 'E', 'F'],
              minutes: null,
              tracks: null,
              bpmMin: null,
              bpmMax: null,
              energyProfile: null,
              moods: []
            })
        })
    )
    dependencies.claude = () => ({ ask }) as never

    // Act
    const first = parsePrompt(dependencies, 'a')
    const second = await parsePrompt(dependencies, 'b')
    answer()
    const result = await first

    // Assert
    expect(second).toEqual({ ok: false, code: 'GENERATOR_BUSY' })
    expect(result.ok && result.value.params.styleIds).toEqual(ids.slice(0, 5))
  })

  it('saves the tracks as a playlist in their order', () => {
    // Arrange
    const ids = insertTracks(
      testDatabase.db,
      ['/Music/a.mp3', '/Music/b.mp3'].map((path) => ({
        path,
        originalPath: path,
        format: 'mp3' as const
      }))
    )
    updateTrack(testDatabase.db, ids[0] as number, { bpm: 120 })

    // Act
    const result = saveAsPlaylist(dependencies, { name: 'Sunset', trackIds: [...ids].reverse() })

    // Assert
    expect(result.ok).toBe(true)
    const playlistId = result.ok ? result.value.playlistId : -1
    expect(getPlaylist(testDatabase.db, playlistId)?.trackIds).toEqual([...ids].reverse())
  })
})
