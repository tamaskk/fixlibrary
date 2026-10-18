import { describe, expect, it } from 'vitest'
import {
  bpmScore,
  buildProfile,
  energyScore,
  keyScore,
  moodScore,
  profileParts,
  profileSimilarity,
  styleScore,
  trackSimilarity,
  weightedScore,
  type SimilarityTrack
} from './similarity'

function track(overrides: Partial<SimilarityTrack> = {}): SimilarityTrack {
  return {
    primaryStyleId: 1,
    secondaryStyleId: null,
    bpm: 124,
    camelotKey: '8A',
    energy: 6,
    moodTags: null,
    ...overrides
  }
}

describe('the parts of the similarity', () => {
  it.each([
    [{ primaryStyleId: 1, secondaryStyleId: null }, { primaryStyleId: 1, secondaryStyleId: 2 }, 1],
    [
      { primaryStyleId: 1, secondaryStyleId: null },
      { primaryStyleId: 2, secondaryStyleId: 1 },
      0.6
    ],
    [
      { primaryStyleId: 2, secondaryStyleId: 1 },
      { primaryStyleId: 1, secondaryStyleId: null },
      0.6
    ],
    [{ primaryStyleId: 1, secondaryStyleId: 3 }, { primaryStyleId: 2, secondaryStyleId: 3 }, 0],
    [
      { primaryStyleId: null, secondaryStyleId: null },
      { primaryStyleId: null, secondaryStyleId: null },
      0
    ]
  ])('style %o and %o score %f', (a, b, expected) => {
    // Act
    const score = styleScore(a, b)

    // Assert
    expect(score).toBe(expected)
  })

  it.each([
    [124, 124, 1],
    [124, 127, 1],
    [124, 120.5, 0.9],
    [124, 129.5, 0.5],
    [124, 132, 0],
    [124, 140, 0],
    [null, 124, 0]
  ])('tempo %s and %s score %f', (a, b, expected) => {
    // Act
    const score = bpmScore(a, b)

    // Assert
    expect(score).toBeCloseTo(expected, 10)
  })

  it.each([
    ['8A', '8A', 1],
    ['8A', '9A', 0.8],
    ['8A', '7A', 0.8],
    ['8A', '8B', 0.8],
    ['12A', '1A', 0.8],
    ['1B', '12B', 0.8],
    ['8A', '9B', 0],
    ['8A', '10A', 0],
    ['12A', '1B', 0],
    [null, '8A', 0],
    ['13A', '1A', 0]
  ])('key %s and %s score %f', (a, b, expected) => {
    // Act
    const score = keyScore(a, b)

    // Assert
    expect(score).toBe(expected)
  })

  it.each([
    [5, 5, 1],
    [1, 10, 0],
    [4, 7, 1 - 3 / 9],
    [null, 5, 0]
  ])('energy %s and %s score %f', (a, b, expected) => {
    // Act
    const score = energyScore(a, b)

    // Assert
    expect(score).toBeCloseTo(expected, 10)
  })

  it('compares moods by their Jaccard similarity', () => {
    // Act
    const scores = [
      moodScore(['deep', 'groovy'], ['deep', 'groovy']),
      moodScore(['deep', 'groovy'], ['deep', 'dark']),
      moodScore(['deep'], ['uplifting']),
      moodScore(null, ['deep']),
      moodScore([], [])
    ]

    // Assert
    expect(scores).toEqual([1, 1 / 3, 0, 0, 0])
  })

  it('weighs style, tempo, key, energy and mood 0.35, 0.25, 0.20, 0.12 and 0.08', () => {
    // Act
    const each = (['style', 'bpm', 'key', 'energy', 'mood'] as const).map((part) =>
      weightedScore({ style: 0, bpm: 0, key: 0, energy: 0, mood: 0, [part]: 1 })
    )

    // Assert
    expect(each).toEqual([0.35, 0.25, 0.2, 0.12, 0.08])
  })
})

describe('trackSimilarity', () => {
  it('scores two tracks of one style, 124 BPM, 8A and the same energy at least 0.92', () => {
    // Act
    const score = trackSimilarity(track(), track())

    // Assert
    expect(score).toBeGreaterThanOrEqual(0.92)
  })

  it('puts a candidate of another style below one of the same style 5 BPM away', () => {
    // Arrange
    const seed = track()

    // Act
    const otherStyle = trackSimilarity(seed, track({ primaryStyleId: 2 }))
    const fiveBpmAway = trackSimilarity(seed, track({ bpm: 129 }))

    // Assert
    expect(otherStyle).toBeLessThan(fiveBpmAway)
  })

  it('follows the order of style, tempo, key, energy and mood', () => {
    // Arrange: each candidate differs from the seed in one part only.
    const seed = track({ moodTags: ['deep'] })
    const candidates = [
      track({ moodTags: ['deep'], primaryStyleId: 2 }),
      track({ moodTags: ['deep'], bpm: 140 }),
      track({ moodTags: ['deep'], camelotKey: '2B' }),
      track({ moodTags: ['deep'], energy: null }),
      track({ moodTags: ['dark'] })
    ]

    // Act
    const scores = candidates.map((candidate) => trackSimilarity(seed, candidate))

    // Assert: the more weighty the part that differs, the lower the score.
    expect([...scores].sort((a, b) => a - b)).toEqual(scores)
  })
})

describe('buildProfile', () => {
  it('holds the share of each style, the median tempo, the keys, the mean energy and the top moods', () => {
    // Arrange
    const tracks = [
      track({ bpm: 120, energy: 4, moodTags: ['deep', 'groovy'] }),
      track({ bpm: 124, energy: 6, moodTags: ['deep'] }),
      track({ primaryStyleId: 2, bpm: 128, camelotKey: '9A', energy: 8, moodTags: ['dark'] }),
      track({ bpm: null, energy: null, camelotKey: null, moodTags: null })
    ]

    // Act
    const profile = buildProfile(tracks)

    // Assert
    expect(profile).toEqual({
      styles: [
        { primaryStyleId: 1, secondaryStyleId: null, share: 0.75 },
        { primaryStyleId: 2, secondaryStyleId: null, share: 0.25 }
      ],
      bpm: 124,
      keys: ['8A', '9A'],
      energy: 6,
      moods: ['deep', 'dark', 'groovy']
    })
  })

  it('knows nothing of an empty playlist', () => {
    // Act
    const profile = buildProfile([])

    // Assert
    expect(profile).toEqual({ styles: [], bpm: null, keys: [], energy: null, moods: [] })
  })
})

describe('profileSimilarity', () => {
  it('weighs the style by the share of the playlist that has it', () => {
    // Arrange
    const profile = buildProfile([track(), track(), track(), track({ primaryStyleId: 2 })])

    // Act
    const parts = profileParts(profile, track({ primaryStyleId: 2 }))

    // Assert
    expect(parts.style).toBeCloseTo(0.25, 10)
  })

  it('takes the key of the playlist that fits the candidate best', () => {
    // Arrange
    const profile = buildProfile([track({ camelotKey: '3B' }), track({ camelotKey: '8A' })])

    // Act
    const parts = profileParts(profile, track({ camelotKey: '9A' }))

    // Assert
    expect(parts.key).toBe(0.8)
  })

  it('scores a track that fits the playlist above one that does not', () => {
    // Arrange
    const profile = buildProfile([track(), track({ bpm: 125, camelotKey: '9A' })])

    // Act
    const fits = profileSimilarity(profile, track({ bpm: 124 }))
    const misfit = profileSimilarity(profile, track({ primaryStyleId: 3, bpm: 100, energy: 1 }))

    // Assert
    expect(fits).toBeGreaterThan(misfit)
    expect(fits).toBeGreaterThanOrEqual(0.92)
  })
})
