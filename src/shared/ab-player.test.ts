import { describe, expect, it } from 'vitest'
import { abGainsOf, decibelsOf, rmsOf } from './ab-player'
import { planNormalization } from './normalize'

describe('abGainsOf', () => {
  it('plays B by the gain the plan applies, in steps of mp3gain for a lossless MP3', () => {
    // Arrange: −14,3 LUFS to −11 needs +3,3 dB, two steps give +3,0.
    const plan = planNormalization({ integratedLufs: -14.3, truePeakDbtp: -6 }, -11, 'mp3gain')
    const gain = plan.action === 'apply' ? plan.gainDb : null

    // Act
    const gains = abGainsOf(gain)

    // Assert
    expect(gains.a).toBe(1)
    expect(decibelsOf(gains.b)).toBeCloseTo(3, 9)
  })

  it('plays B by the exact gain when the track is encoded again', () => {
    // Arrange
    const plan = planNormalization({ integratedLufs: -14.3, truePeakDbtp: -6 }, -11, 'reencode')
    const gain = plan.action === 'apply' ? plan.gainDb : null

    // Act
    const gains = abGainsOf(gain)

    // Assert
    expect(decibelsOf(gains.b)).toBeCloseTo(3.3, 9)
  })

  it('plays B as A for a track the normalization leaves alone', () => {
    // Act
    const gains = abGainsOf(null)

    // Assert
    expect(gains).toEqual({ a: 1, b: 1 })
  })
})

describe('rmsOf', () => {
  it('gives a sine of amplitude 1 a level of −3 dB', () => {
    // Arrange
    const samples = Array.from({ length: 4410 }, (_, index) =>
      Math.sin((2 * Math.PI * index) / 441)
    )

    // Act
    const level = decibelsOf(rmsOf(samples))

    // Assert
    expect(level).toBeCloseTo(-3.01, 1)
  })

  it('gives silence no level', () => {
    // Act
    const level = decibelsOf(rmsOf(new Float32Array(16)))

    // Assert
    expect(level).toBe(Number.NEGATIVE_INFINITY)
  })
})
