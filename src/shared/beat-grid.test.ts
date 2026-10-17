import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { beatsOf, snapToGrid, type GridBeat, type GridMarker } from './beat-grid'

// 120 BPM: a beat every half second, a bar every two seconds.
const GRID = [{ inizio: 0.5, bpm: 120, metro: '4/4', battito: 1 }]

describe('beatsOf', () => {
  it('counts beats, bars and phrases of eight bars from the first downbeat', () => {
    // Act
    const beats = beatsOf(GRID, 40)

    // Assert
    expect(beats[0]).toEqual({ time: 0.5, level: 'phrase' })
    expect(beats[1]).toEqual({ time: 1, level: 'beat' })
    expect(beats[4]).toEqual({ time: 2.5, level: 'bar' })
    expect(beats[32]).toEqual({ time: 16.5, level: 'phrase' })
    expect(beats.at(-1)?.time).toBe(39.5)
  })

  it('counts the bar from the beat the marker is on', () => {
    // Act: the marker is on the third beat of its bar.
    const beats = beatsOf([{ inizio: 0, bpm: 120, metro: '4/4', battito: 3 }], 4)

    // Assert
    expect(beats.map((beat) => beat.level)).toEqual([
      'beat',
      'beat',
      'phrase',
      'beat',
      'beat',
      'beat',
      'bar',
      'beat'
    ])
  })

  it('goes on with the tempo of the next marker from its time', () => {
    // Act
    const beats = beatsOf(
      [
        { inizio: 0, bpm: 120, metro: '4/4', battito: 1 },
        { inizio: 2, bpm: 60, metro: '4/4', battito: 1 }
      ],
      6
    )

    // Assert
    expect(beats.map((beat) => beat.time)).toEqual([0, 0.5, 1, 1.5, 2, 3, 4, 5])
  })

  it('takes the beats of a bar from the meter', () => {
    // Act
    const beats = beatsOf([{ inizio: 0, bpm: 60, metro: '3/4', battito: 1 }], 7)

    // Assert
    expect(beats.filter((beat) => beat.level !== 'beat').map((beat) => beat.time)).toEqual([
      0, 3, 6
    ])
  })
})

describe('snapToGrid', () => {
  const beats = beatsOf(GRID, 40)

  it.each([
    [0.74, 0.5],
    [0.76, 1],
    [20.1, 20]
  ])('puts a cue let go at %s s onto the beat at %s s', (at, beat) => {
    // Act
    const snapped = snapToGrid(beats, at, 'beat')

    // Assert
    expect(snapped).toBe(beat)
  })

  it.each([
    [1.4, 0.5],
    [1.6, 2.5],
    [16.3, 16.5]
  ])('puts a cue let go with Shift at %s s onto the bar starting at %s s', (at, bar) => {
    // Act
    const snapped = snapToGrid(beats, at, 'bar')

    // Assert
    expect(snapped).toBe(bar)
  })

  it('has no beat to give on an empty grid', () => {
    // Act
    const snapped = snapToGrid([], 3, 'beat')

    // Assert
    expect(snapped).toBeNull()
  })
})

describe('the counting the structure of the sidecar shares', () => {
  it('gives the beats and downbeats of tests/fixtures/grids/golden-grid.json', () => {
    // Arrange: the same file is read by python/tests/test_structure.py.
    const golden = JSON.parse(
      readFileSync(join(__dirname, '../../tests/fixtures/grids/golden-grid.json'), 'utf8')
    ) as { durationSeconds: number; grid: GridMarker[]; beats: GridBeat[] }

    // Act
    const beats = beatsOf(golden.grid, golden.durationSeconds)

    // Assert
    expect(beats.map((beat) => beat.level)).toEqual(golden.beats.map((beat) => beat.level))
    beats.forEach((beat, index) =>
      expect(beat.time).toBeCloseTo(golden.beats[index]?.time ?? -1, 9)
    )
  })
})
