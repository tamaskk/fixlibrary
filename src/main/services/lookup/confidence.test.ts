import { describe, expect, it } from 'vitest'
import {
  fingerprintConfidence,
  knownArtistTitle,
  lengthMatch,
  levenshtein,
  normalizeForComparison,
  similarity,
  textConfidence,
  textSimilarity
} from './confidence'

describe('levenshtein', () => {
  it.each([
    ['', '', 0],
    ['abc', 'abc', 0],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2]
  ])('counts the edits between %j and %j as %i', (a, b, edits) => {
    expect(levenshtein(a, b)).toBe(edits)
    expect(levenshtein(b, a)).toBe(edits)
  })
})

describe('similarity', () => {
  it('ignores case, accents and punctuation', () => {
    expect(similarity('Âme - Rej (Original Mix)', 'ame rej original mix')).toBe(1)
    expect(normalizeForComparison('  Beyoncé & JAY-Z  ')).toBe('beyonce jay z')
  })

  it('is the share of the longer text that needs no edit', () => {
    expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7)
  })

  it('is 0 when a text is empty', () => {
    expect(similarity('', 'anything')).toBe(0)
    expect(similarity('---', 'anything')).toBe(0)
  })
})

describe('textSimilarity', () => {
  it('compares artist and title together', () => {
    const known = { artist: 'Daft Punk', title: 'Around the World' }

    expect(textSimilarity(known, { artist: 'Daft Punk', title: 'Around the World' })).toBe(1)
    expect(textSimilarity(known, { artist: 'Daft Punk', title: 'Da Funk' })).toBeLessThan(0.7)
  })

  it('compares titles only when no artist is known', () => {
    const known = { artist: null, title: 'Around the World' }

    expect(textSimilarity(known, { artist: 'Daft Punk', title: 'Around the World' })).toBe(1)
  })
})

describe('lengthMatch', () => {
  it.each([
    [226, 226.9, 1],
    [226, 229, 1],
    [226, 229.1, 0],
    [null, 226, 0],
    [226, null, 0]
  ])('of %s s and %s s is %i', (a, b, expected) => {
    expect(lengthMatch(a, b)).toBe(expected)
  })
})

describe('the confidence of a candidate', () => {
  it('found by fingerprint is 0.6 score + 0.3 text + 0.1 length', () => {
    expect(fingerprintConfidence(1, 1, 1)).toBeCloseTo(1)
    expect(fingerprintConfidence(0.9, 0.5, 1)).toBeCloseTo(0.54 + 0.15 + 0.1)
    expect(fingerprintConfidence(0.98, 0, 0)).toBeCloseTo(0.588)
  })

  it('found by text is 0.75 text + 0.25 length', () => {
    expect(textConfidence(1, 1)).toBeCloseTo(1)
    expect(textConfidence(0.8, 0)).toBeCloseTo(0.6)
    expect(textConfidence(0.6, 1)).toBeCloseTo(0.7)
  })

  it('of a perfect fingerprint with nothing else known stays below what is taken', () => {
    expect(fingerprintConfidence(1, 0, 0)).toBeLessThan(0.7)
  })
})

describe('knownArtistTitle', () => {
  it('takes the tags when there is a title', () => {
    const known = knownArtistTitle({ artist: 'Âme', title: 'Rej', fileName: 'x.mp3' })

    expect(known).toEqual({ artist: 'Âme', title: 'Rej' })
  })

  it('reads artist and title from a file name without tags', () => {
    const known = knownArtistTitle({
      artist: null,
      title: null,
      fileName: 'Daft_Punk - Around the World.mp3'
    })

    expect(known).toEqual({ artist: 'Daft Punk', title: 'Around the World' })
  })

  it('takes a name without a dash as the title', () => {
    const known = knownArtistTitle({ artist: null, title: null, fileName: 'track_07.wav' })

    expect(known).toEqual({ artist: null, title: 'track 07' })
  })

  it('keeps a tagged artist over the one in the file name', () => {
    const known = knownArtistTitle({ artist: 'Tagged', title: null, fileName: 'Other - Song.mp3' })

    expect(known).toEqual({ artist: 'Tagged', title: 'Song' })
  })
})
