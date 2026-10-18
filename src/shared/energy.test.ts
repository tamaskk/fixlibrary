import { describe, expect, it } from 'vitest'
import {
  defaultScores,
  energyByModel,
  energyOf,
  MAX_SAMPLE,
  scoreOf,
  scoreRanges,
  selectCalibrationSample,
  type KeptEnergyModel,
  type ScoredTrack
} from './energy'

let nextId = 1

function style(styleId: number | null, count: number, offset = 0): ScoredTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    trackId: nextId++,
    styleId,
    score: offset + index
  }))
}

describe('selectCalibrationSample', () => {
  it('takes at least 3 tracks of every style of 10 or more, and 30 in all at most', () => {
    // Arrange
    const tracks = [...style(1, 40), ...style(2, 12), ...style(3, 10), ...style(4, 9)]

    // Act
    const sample = selectCalibrationSample(tracks)

    // Assert
    expect(sample.length).toBeLessThanOrEqual(MAX_SAMPLE)
    for (const styleId of [1, 2, 3]) {
      const picked = tracks.filter((t) => t.styleId === styleId && sample.includes(t.trackId))
      expect(picked.length).toBeGreaterThanOrEqual(3)
      expect(picked.length).toBeLessThanOrEqual(5)
    }
  })

  it('spreads the tracks of a style from its lowest score to its highest', () => {
    // Arrange
    const tracks = style(1, 20)

    // Act
    const sample = selectCalibrationSample(tracks)

    // Assert
    const scores = tracks.filter((t) => sample.includes(t.trackId)).map((t) => t.score)
    expect(Math.min(...scores)).toBe(0)
    expect(Math.max(...scores)).toBe(19)
  })

  it('fills the room the large styles leave from the small styles and the tracks without one', () => {
    // Arrange
    const tracks = [...style(1, 4), ...style(2, 3), ...style(null, 5)]

    // Act
    const sample = selectCalibrationSample(tracks)

    // Assert
    expect(sample).toHaveLength(12)
  })

  it('keeps to 30 when there are more than ten large styles, the largest first', () => {
    // Arrange
    const tracks = Array.from({ length: 12 }, (_, index) => style(index + 1, 30 - index)).flat()

    // Act
    const sample = selectCalibrationSample(tracks)

    // Assert
    expect(sample).toHaveLength(30)
    const styles = new Set(tracks.filter((t) => sample.includes(t.trackId)).map((t) => t.styleId))
    expect(styles).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
  })

  it('gives each large style up to 5 when there is room', () => {
    // Arrange
    const tracks = [...style(1, 50), ...style(2, 50)]

    // Act
    const sample = selectCalibrationSample(tracks)

    // Assert
    expect(sample).toHaveLength(10)
  })

  it('is the same for the same tracks', () => {
    // Arrange
    const tracks = [...style(1, 30), ...style(null, 7)]

    // Act
    const first = selectCalibrationSample(tracks)
    const second = selectCalibrationSample([...tracks].reverse())

    // Assert
    expect(new Set(second)).toEqual(new Set(first))
  })
})

describe('the 1–10 scale', () => {
  it('maps the low end of a range to 1, the high end to 10, and clamps beyond', () => {
    // Arrange
    const range = { low: 2, high: 8 }

    // Act
    const values = [0, 2, 5, 8, 12].map((score) => energyOf(score, range))

    // Assert
    expect(values).toEqual([1, 1, 6, 10, 10])
  })

  it('uses the whole scale in every style of 10 tracks or more', () => {
    // Arrange: a calm style and a hard one, each on its own range of raw scores.
    const tracks = [...style(1, 20, 0), ...style(2, 20, 50)]
    const { library, styles } = scoreRanges(tracks)
    const kept: KeptEnergyModel = {
      model: { names: ['s'], means: [0], scales: [1], weights: [1], intercept: 0, looMae: 0 },
      analyzerVersion: 'v',
      library,
      styles,
      ratedCount: 20,
      fittedAt: 0
    }

    // Act
    const values = (styleId: number): number[] =>
      tracks
        .filter((t) => t.styleId === styleId)
        .map((t) => energyByModel(kept, { s: t.score }, styleId) ?? 0)

    // Assert
    for (const styleId of [1, 2]) {
      expect(Math.min(...values(styleId))).toBeLessThanOrEqual(3)
      expect(Math.max(...values(styleId))).toBeGreaterThanOrEqual(8)
    }
  })

  it('scales a small style and a track without one by the library', () => {
    // Arrange
    const tracks = [...style(1, 20, 0), ...style(2, 3, 100)]

    // Act
    const { styles } = scoreRanges(tracks)

    // Assert
    expect(Object.keys(styles)).toEqual(['1'])
  })
})

describe('scoreOf', () => {
  it('is the intercept plus the weighted standardized features', () => {
    // Arrange
    const model = {
      names: ['a', 'b'],
      means: [1, 10],
      scales: [2, 5],
      weights: [1, -2],
      intercept: 5,
      looMae: 0
    }

    // Act
    const score = scoreOf(model, { a: 3, b: 20 })

    // Assert
    expect(score).toBe(5 + 1 - 4)
  })

  it('has no score for a track that lacks a feature', () => {
    // Arrange
    const model = { names: ['a'], means: [0], scales: [1], weights: [1], intercept: 0, looMae: 0 }

    // Act
    const score = scoreOf(model, {})

    // Assert
    expect(score).toBeNull()
  })
})

describe('defaultScores', () => {
  it('scores a louder, harder track above a quiet one', () => {
    // Arrange
    const quiet = {
      rmsDb: -20,
      percussiveRatio: 0.2,
      onsetRate: 1,
      spectralFlux: 0.05,
      lowRatio: 0.1
    }
    const hard = { rmsDb: -8, percussiveRatio: 0.7, onsetRate: 4, spectralFlux: 0.2, lowRatio: 0.4 }

    // Act
    const [a, b] = defaultScores([
      { trackId: 1, styleId: null, features: quiet },
      { trackId: 2, styleId: null, features: hard }
    ])

    // Assert
    expect(b?.score).toBeGreaterThan(a?.score ?? 0)
  })
})
