import { describe, expect, it } from 'vitest'
import { evaluateStyles, parseStylesCsv, repeatedNames } from './style-eval'

describe('parseStylesCsv', () => {
  it('reads file names and styles, with a header, quotes and semicolons', () => {
    // Act
    const rows = parseStylesCsv(
      'file,style\n"Bicep - Glue, Remix.mp3",Melodic House\r\nÁme - Rej.aiff;Afro House\n\n'
    )

    // Assert
    expect([...rows]).toEqual([
      ['Bicep - Glue, Remix.mp3', 'Melodic House'],
      ['Áme - Rej.aiff', 'Afro House']
    ])
  })
})

describe('evaluateStyles', () => {
  it('counts the matches as the app compares names, and lists what differs or is missing', () => {
    // Arrange
    const expected = new Map([
      ['a.mp3', 'Tech House'],
      ['b.mp3', 'Afro House'],
      ['c.mp3', 'Hip Hop'],
      ['d.mp3', 'Unsorted']
    ])
    const actual = new Map<string, string | null>([
      ['a.mp3', 'tech-house'],
      ['b.mp3', 'Organic House'],
      ['c.mp3', null]
    ])

    // Act
    const result = evaluateStyles(expected, actual)

    // Assert
    expect(result).toEqual({
      compared: 3,
      matched: 1,
      rate: 1 / 3,
      mismatches: [
        { fileName: 'b.mp3', expected: 'Afro House', actual: 'Organic House' },
        { fileName: 'c.mp3', expected: 'Hip Hop', actual: null }
      ],
      missing: ['d.mp3']
    })
  })
})

describe('repeatedNames', () => {
  it('names the files the library has twice, so the owner knows they were compared as one', () => {
    // Act
    const repeated = repeatedNames(['a.mp3', 'b.mp3', 'a.mp3', 'c.mp3', 'a.mp3'])

    // Assert
    expect(repeated).toEqual(['a.mp3'])
  })
})
