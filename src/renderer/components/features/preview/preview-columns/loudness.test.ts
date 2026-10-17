import { describe, expect, it } from 'vitest'
import { normalizationState, signedGain } from './loudness'

describe('signedGain', () => {
  it.each([
    [3, '+3,0'],
    [-1.5, '−1,5'],
    [0, '0,0'],
    [0.004, '0,0'],
    [-0.004, '0,0']
  ])('shows %s dB as %s', (value, text) => {
    // Act
    const shown = signedGain(value)

    // Assert
    expect(shown).toBe(text)
  })
})

describe('normalizationState', () => {
  it('says what a skipped track needed and could have had', () => {
    // Act
    const state = normalizationState({
      kind: 'pcm',
      action: 'skip',
      neededGainDb: 5,
      possibleGainDb: 0.7
    })

    // Assert
    expect(state).toBe('Kimarad: +5,0 dB kellene, legfeljebb +0,7 dB fér bele')
  })

  it('says nothing for a row the batch does not normalize', () => {
    // Act
    const state = normalizationState(null)

    // Assert
    expect(state).toBeNull()
  })
})
