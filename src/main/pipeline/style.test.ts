import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLES, type Style } from '@shared/settings'
import {
  decideStyle,
  findStyle,
  isHouseName,
  newStyleColor,
  nextStyleColor,
  styleKey
} from './style'

const STYLES: Style[] = [
  ...DEFAULT_STYLES.map((style, index) => ({ ...style, id: index + 1 })),
  { id: 10, name: 'Hip Hop', color: '#22c55e', isHouse: false }
]
const TECH = 4
// What the track's own tag and its release say of it.
const GENRES = ['Electronic', 'House', 'Tech House']
const UNSORTED = 6

function answer(
  primary: string,
  confidence = 90,
  isNewStyle = false,
  secondary: string | null = null
): { primary: string; secondary: string | null; confidence: number; isNewStyle: boolean } {
  return { primary, secondary, confidence, isNewStyle }
}

describe('styleKey and findStyle', () => {
  it.each(['Tech-House', 'tech house', 'TECH_HOUSE', ' Tech  House '])(
    'take %s for the one style Tech House',
    (name) => {
      // Act
      const found = findStyle(name, STYLES)

      // Assert
      expect(found?.id).toBe(TECH)
      expect(styleKey(name)).toBe('techhouse')
    }
  )

  it('tells Hip Hop, Hip-Hop and HipHop for one style', () => {
    // Act
    const found = ['Hip Hop', 'Hip-Hop', 'HipHop'].map((name) => findStyle(name, STYLES)?.id)

    // Assert
    expect(found).toEqual([10, 10, 10])
  })
})

describe('decideStyle', () => {
  it('takes a style of the list, and a second one other than the first', () => {
    // Act
    const decision = decideStyle(answer('Tech-House', 85, false, 'Afro House'), STYLES, GENRES)

    // Assert
    expect(decision).toEqual({
      primary: { id: TECH },
      secondary: { id: 1 },
      confidence: 0.85,
      unsorted: false
    })
  })

  it.each([
    ['less than 70% sure', answer('Tech House', 69), GENRES],
    ['without any genre to go by', answer('Tech House', 99), []],
    ['Unsorted by Claude', answer('Unsorted', 90), GENRES],
    ['a name it says is no new style but is not in the list', answer('Polka', 90, false), GENRES],
    ['a new house style', answer('Jackin House', 90, true), ['Jackin House']],
    ['a new style no genre of the track names', answer('Hardstyle', 90, true), GENRES],
    ['a new style named like a folder of the app', answer('Inbox', 90, true), ['Inbox']],
    ['a new style of letters a folder must not have', answer('Hip*Hop?', 90, true), ['Hip*Hop?']],
    ['a new style in letters that only look like others', answer('Тrap', 90, true), ['Тrap']],
    ['no answer at all', null, GENRES]
  ])('makes a track Unsorted for %s', (_why, given, genres) => {
    // Act
    const decision = decideStyle(given, STYLES, genres)

    // Assert
    expect(decision.primary).toEqual({ id: UNSORTED })
    expect(decision.unsorted).toBe(true)
  })

  it('proposes a new style for a track that is no house', () => {
    // Act
    const decision = decideStyle(answer(' Drum & Bass ', 80, true), STYLES, [
      'Electronic',
      'Jungle/Drum & Bass'
    ])

    // Assert
    expect(decision.primary).toEqual({ newName: 'Drum & Bass' })
  })

  it('takes the style of the list where Claude calls a known one new', () => {
    // Act
    const decision = decideStyle(answer('HipHop', 80, true), STYLES, GENRES)

    // Assert
    expect(decision.primary).toEqual({ id: 10 })
  })

  it('keeps no second style that is the first, Unsorted or not in the list', () => {
    // Act
    const same = decideStyle(answer('Tech House', 90, false, 'tech-house'), STYLES, GENRES)
    const unsorted = decideStyle(answer('Tech House', 90, false, 'Unsorted'), STYLES, GENRES)
    const unknown = decideStyle(answer('Tech House', 90, false, 'Polka'), STYLES, GENRES)

    // Assert
    expect([same.secondary, unsorted.secondary, unknown.secondary]).toEqual([null, null, null])
  })
})

describe('nextStyleColor', () => {
  it('gives the first color of the palette no style has', () => {
    // Act
    const color = nextStyleColor(STYLES)

    // Assert
    expect(color).toBe('#22d3ee')
  })
})

describe('isHouseName', () => {
  it.each(['Jackin House', 'Techhouse', 'Tech H0use', 'Afro Hous', 'HOUSE'])(
    'takes %s for a house style',
    (name) => {
      // Act
      const house = isHouseName(name)

      // Assert
      expect(house).toBe(true)
    }
  )

  it.each(['Hip Hop', 'Drum & Bass', 'Hardcore', 'Dubstep'])(
    'takes %s for no house style',
    (name) => {
      // Act
      const house = isHouseName(name)

      // Assert
      expect(house).toBe(false)
    }
  )
})

describe('newStyleColor', () => {
  it('gives one name one color, of those no style has', () => {
    // Act
    const first = newStyleColor('Hip Hop', STYLES)
    const again = newStyleColor('hip-hop', STYLES)

    // Assert
    expect(first).toBe(again)
    expect(STYLES.map((style) => style.color)).not.toContain(first)
  })

  it('gives different names different colors, mostly', () => {
    // Act
    const colors = new Set(
      ['Hip Hop', 'Drum & Bass', 'Trap', 'Dubstep', 'Garage', 'Jungle'].map((name) =>
        newStyleColor(name, STYLES)
      )
    )

    // Assert
    expect(colors.size).toBeGreaterThan(1)
  })
})
