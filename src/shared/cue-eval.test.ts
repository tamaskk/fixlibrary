import { describe, expect, it } from 'vitest'
import { evaluateCues, parseCuesCsv } from './cue-eval'

describe('parseCuesCsv', () => {
  it('reads letters and numbers as slots, and leaves out the header and odd rows', () => {
    // Act
    const rows = parseCuesCsv(
      'file,slot,seconds\n"Bicep - Glue.mp3",D,61.96\nGlue.mp3,1,0\nGlue.mp3,9,3\nGlue.mp3,Z,3\nGlue.mp3,C,abc\n\nGlue.mp3,b,"15,5"\n'
    )

    // Assert
    expect(rows).toEqual([
      { fileName: 'Bicep - Glue.mp3', slot: 4, seconds: 61.96 },
      { fileName: 'Glue.mp3', slot: 1, seconds: 0 },
      { fileName: 'Glue.mp3', slot: 2, seconds: 15.5 }
    ])
  })
})

describe('evaluateCues', () => {
  it('counts a cue within one bar as found, and names the others with their distance', () => {
    // Arrange
    const bar = 1.875
    const placed = new Map([
      [
        'a.mp3',
        {
          cues: new Map([
            [1, 0],
            [4, 60_000],
            [5, 90_000]
          ]),
          barSeconds: () => bar
        }
      ]
    ])

    // Act
    const result = evaluateCues(
      [
        { fileName: 'a.mp3', slot: 1, seconds: 0.5 },
        { fileName: 'a.mp3', slot: 4, seconds: 60 + bar },
        { fileName: 'a.mp3', slot: 5, seconds: 90 + 2 * bar },
        { fileName: 'a.mp3', slot: 3, seconds: 30 },
        { fileName: 'b.mp3', slot: 1, seconds: 0 }
      ],
      (name) => placed.get(name) ?? null
    )

    // Assert
    expect(result).toMatchObject({ compared: 4, found: 2, rate: 0.5, missing: ['b.mp3'] })
    expect(result.misses).toEqual([
      { fileName: 'a.mp3', slot: 5, expectedSeconds: 90 + 2 * bar, foundSeconds: 90, bars: 2 },
      { fileName: 'a.mp3', slot: 3, expectedSeconds: 30, foundSeconds: null, bars: null }
    ])
  })
})
