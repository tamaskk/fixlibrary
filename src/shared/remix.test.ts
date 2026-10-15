import { describe, expect, it } from 'vitest'
import { isRemixMix, remixerOf, titleWithRemix } from './remix'

describe('remixerOf', () => {
  it.each([
    ['Bicep Remix', 'Bicep'],
    ['Ben Böhmer Edit', 'Ben Böhmer'],
    ['Âme Rework', 'Âme'],
    ["Bicep's Remix", 'Bicep'],
    ['VIP Edit', null],
    ['Radio Edit', null],
    ['Extended Remix', null],
    ['Club Edit', null],
    ['Extended Mix', null],
    ['Original Mix', null],
    ['Remix', null],
    [null, null]
  ])('names who made %s: %s', (mix, remixer) => {
    // Act
    const name = remixerOf(mix)

    // Assert
    expect(name).toBe(remixer)
  })
})

describe('isRemixMix', () => {
  it('tells a version of its own from a length or a vocal', () => {
    // Act
    const taken = ['Bicep Remix', 'Radio Edit', 'Some Rework'].map(isRemixMix)
    const left = ['Extended Mix', 'Original Mix', 'Dub', null].map(isRemixMix)

    // Assert
    expect(taken).toEqual([true, true, true])
    expect(left).toEqual([false, false, false, false])
  })
})

describe('titleWithRemix', () => {
  it('puts the mix in brackets once', () => {
    // Act
    const added = titleWithRemix('Glue', 'Bicep Remix')
    const kept = titleWithRemix('Glue (Bicep Remix)', 'Bicep Remix')

    // Assert
    expect([added, kept]).toEqual(['Glue (Bicep Remix)', 'Glue (Bicep Remix)'])
  })
})
