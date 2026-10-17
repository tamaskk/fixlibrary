import { describe, expect, it } from 'vitest'
import { applyPlanOf, normalizeKindOf, planNormalization, reachedPlan } from './normalize'

describe('normalizeKindOf', () => {
  it.each([
    ['a.mp3', 'lossless', 'mp3gain'],
    ['A.MP3', 'exact', 'reencode'],
    ['a.aiff', 'lossless', 'pcm'],
    ['a.aif', 'exact', 'pcm'],
    ['a.wav', 'lossless', 'pcm'],
    ['a.flac', 'lossless', null]
  ] as const)('normalizes %s in %s mode by %s', (name, method, kind) => {
    // Act
    const found = normalizeKindOf(name, method)

    // Assert
    expect(found).toBe(kind)
  })
})

describe('planNormalization', () => {
  it('raises a quiet track by the exact gain where the peak has room', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -14.3, truePeakDbtp: -6 }, -11, 'reencode')

    // Assert
    expect(plan).toEqual({
      action: 'apply',
      kind: 'reencode',
      gainDb: 3.3,
      expectedLufs: -11,
      expectedTruePeakDbtp: -2.7,
      toleranceLu: 0.2
    })
  })

  it('rounds the gain of mp3gain to whole steps of 1.5 dB', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -14.3, truePeakDbtp: -6 }, -11, 'mp3gain')

    // Assert
    expect(plan).toMatchObject({ action: 'apply', gainDb: 3, expectedLufs: -11.3 })
    expect(plan.action === 'apply' && applyPlanOf(plan)).toEqual({ kind: 'mp3gain', steps: 2 })
  })

  it.each([
    [-8.75, -3, -2],
    [-9.5, -1.5, -1],
    [-12.5, 1.5, 1],
    [-13.25, 3, 2]
  ])('rounds a half step away from zero: %s LUFS gets %s dB', (lufs, gain, steps) => {
    // Act
    const plan = planNormalization({ integratedLufs: lufs, truePeakDbtp: -20 }, -11, 'mp3gain')

    // Assert
    expect(plan).toMatchObject({ action: 'apply', gainDb: gain })
    expect(plan.action === 'apply' && applyPlanOf(plan)).toEqual({ kind: 'mp3gain', steps })
  })

  it('skips a quiet track whose peak is near 0 dBTP, with the gain it needed and could have had', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -16, truePeakDbtp: -0.3 }, -11, 'pcm')

    // Assert
    expect(plan).toEqual({ action: 'skip', kind: 'pcm', neededGainDb: 5, possibleGainDb: 0 })
  })

  it('names the room left in whole steps for mp3gain', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -17, truePeakDbtp: -4.2 }, -11, 'mp3gain')

    // Assert
    expect(plan).toEqual({ action: 'skip', kind: 'mp3gain', neededGainDb: 6, possibleGainDb: 3 })
  })

  it('skips a gain of more than the sidecar applies, with the most it could have had', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -60, truePeakDbtp: -50 }, -5, 'pcm')

    // Assert
    expect(plan).toEqual({ action: 'skip', kind: 'pcm', neededGainDb: 55, possibleGainDb: 39 })
  })

  it('takes a gain that brings the peak to exactly −1 dBTP', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -13, truePeakDbtp: -3 }, -11, 'pcm')

    // Assert
    expect(plan).toMatchObject({ action: 'apply', gainDb: 2, expectedTruePeakDbtp: -1 })
  })

  it('always lowers a loud track, also one whose peak is above −1 dBTP', () => {
    // Act
    const plan = planNormalization({ integratedLufs: -6.5, truePeakDbtp: 0.8 }, -8, 'reencode')

    // Assert
    expect(plan).toMatchObject({ action: 'apply', gainDb: -1.5, expectedTruePeakDbtp: -0.7 })
  })

  it.each([
    ['mp3gain', -11.6],
    ['pcm', -11.05]
  ] as const)('leaves a track at its target alone with %s', (kind, lufs) => {
    // Act
    const plan = planNormalization({ integratedLufs: lufs, truePeakDbtp: -3 }, -11, kind)

    // Assert
    expect(plan).toEqual({ action: 'none', kind })
  })
})

describe('reachedPlan', () => {
  const plan = {
    action: 'apply',
    kind: 'mp3gain',
    gainDb: 3,
    expectedLufs: -11.3,
    expectedTruePeakDbtp: -3,
    toleranceLu: 0.75
  } as const

  it('takes a measure within the tolerance of the method', () => {
    // Act
    const reached = reachedPlan(plan, { integratedLufs: -10.6, truePeakDbtp: -3.1 })

    // Assert
    expect(reached).toBe(true)
  })

  it('refuses a measure farther from the expected loudness', () => {
    // Act
    const reached = reachedPlan(plan, { integratedLufs: -12.2, truePeakDbtp: -3.1 })

    // Assert
    expect(reached).toBe(false)
  })

  it('takes a peak a tenth of a dB above the limit, as near as ffmpeg measures it', () => {
    // Act
    const reached = reachedPlan(plan, { integratedLufs: -11.3, truePeakDbtp: -0.95 })

    // Assert
    expect(reached).toBe(true)
  })

  it('refuses a raised track whose peak went above −1 dBTP', () => {
    // Act
    const reached = reachedPlan(plan, { integratedLufs: -11.3, truePeakDbtp: -0.8 })

    // Assert
    expect(reached).toBe(false)
  })
})
