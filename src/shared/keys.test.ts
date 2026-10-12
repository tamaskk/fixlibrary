import { describe, expect, it } from 'vitest'
import { CAMELOT_KEYS, formatKey, keyOf, keyOfCamelot, KEYS, pitchClassOf } from './keys'

// The table of the product spec, written out once more so a typo in `KEYS` shows.
const SPEC: readonly (readonly [string, string])[] = [
  ['1A', 'Abm'],
  ['2A', 'Ebm'],
  ['3A', 'Bbm'],
  ['4A', 'Fm'],
  ['5A', 'Cm'],
  ['6A', 'Gm'],
  ['7A', 'Dm'],
  ['8A', 'Am'],
  ['9A', 'Em'],
  ['10A', 'Bm'],
  ['11A', 'F#m'],
  ['12A', 'Dbm'],
  ['1B', 'B'],
  ['2B', 'F#'],
  ['3B', 'Db'],
  ['4B', 'Ab'],
  ['5B', 'Eb'],
  ['6B', 'Bb'],
  ['7B', 'F'],
  ['8B', 'C'],
  ['9B', 'G'],
  ['10B', 'D'],
  ['11B', 'A'],
  ['12B', 'E']
]

describe('KEYS', () => {
  it('holds the 24 keys of the spec', () => {
    expect(KEYS.map((key) => [key.camelot, key.musical])).toEqual(SPEC)
    expect(CAMELOT_KEYS).toHaveLength(24)
  })

  it.each(SPEC)('maps %s to %s by its tonic and scale', (camelot, musical) => {
    const minor = musical.endsWith('m')
    const tonic = minor ? musical.slice(0, -1) : musical

    const key = keyOf(tonic, minor ? 'minor' : 'major')

    expect(key).toMatchObject({ camelot, musical })
  })

  it('moves a fifth up with every step of the wheel', () => {
    for (const key of KEYS) {
      const number = Number.parseInt(key.camelot, 10)
      const first = key.scale === 'minor' ? 8 : 11

      expect(key.pitchClass).toBe((first + 7 * (number - 1)) % 12)
    }
  })

  it('gives a minor key the number of its relative major', () => {
    for (const minor of KEYS.filter((key) => key.scale === 'minor')) {
      const major = keyOfCamelot(minor.camelot.replace('A', 'B'))

      expect(major?.pitchClass).toBe((minor.pitchClass + 3) % 12)
    }
  })
})

describe('pitchClassOf', () => {
  it.each([
    ['C', 0],
    ['C#', 1],
    ['Db', 1],
    ['D♭', 1],
    ['F♯', 6],
    ['Gb', 6],
    ['B', 11],
    ['Cb', 11],
    ['B#', 0],
    [' a ', 9]
  ])('reads %s as %i', (note, pitchClass) => {
    expect(pitchClassOf(note)).toBe(pitchClass)
  })

  it.each(['', 'H', 'C##', 'Am', '8A'])('refuses %j', (note) => {
    expect(pitchClassOf(note)).toBeNull()
  })
})

describe('keyOf', () => {
  it.each([
    ['C#', 'Db', 'major', '3B'],
    ['C#', 'Db', 'minor', '12A'],
    ['G#', 'Ab', 'minor', '1A'],
    ['D#', 'Eb', 'minor', '2A'],
    ['A#', 'Bb', 'major', '6B'],
    ['Gb', 'F#', 'major', '2B']
  ] as const)('gives %s and %s %s the same code', (sharp, flat, scale, camelot) => {
    expect(keyOf(sharp, scale)?.camelot).toBe(camelot)
    expect(keyOf(flat, scale)?.camelot).toBe(camelot)
  })

  it('returns null for a tonic that is no note', () => {
    expect(keyOf('X', 'major')).toBeNull()
  })
})

describe('formatKey', () => {
  it('shows both notations', () => {
    expect(formatKey('8A')).toBe('8A Am')
    expect(formatKey('11a')).toBe('11A F#m')
  })

  it('returns null for a code that names no key', () => {
    expect(formatKey('13A')).toBeNull()
    expect(formatKey('8C')).toBeNull()
  })
})
