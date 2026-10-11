import { describe, expect, it } from 'vitest'
import { formatCount, formatDecimal, formatElapsed, formatRemaining, parseDecimal } from './format'

describe('formatDecimal', () => {
  it.each([
    [-11, '−11,0'],
    [-8.5, '−8,5'],
    [0, '0,0'],
    [-9.55, '−9,55'],
    [7.256, '7,26']
  ])('formats %d as %s', (value, expected) => {
    // Act
    const text = formatDecimal(value)

    // Assert
    expect(text).toBe(expected)
  })
})

describe('parseDecimal', () => {
  it.each([
    ['−11,5', -11.5],
    ['-11.5', -11.5],
    [' -9 ', -9],
    ['8', 8]
  ])('reads %j as %d', (text, expected) => {
    // Act
    const value = parseDecimal(text)

    // Assert
    expect(value).toBe(expected)
  })

  it.each(['', 'abc', '1,2,3', '--5', '5 LUFS'])('rejects %j', (text) => {
    // Act
    const value = parseDecimal(text)

    // Assert
    expect(value).toBeNull()
  })
})

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [984, '984'],
    [12_984, '12\u00a0984']
  ])('formats %d as %s', (value, expected) => {
    // Act
    const text = formatCount(value)

    // Assert
    expect(text).toBe(expected)
  })
})

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [125_000, '2:05'],
    [3_725_000, '1:02:05'],
    [-5, '0:00']
  ])('formats %d ms as %s', (ms, expected) => {
    // Act
    const text = formatElapsed(ms)

    // Assert
    expect(text).toBe(expected)
  })
})

describe('formatRemaining', () => {
  it.each([
    [20_000, 'kevesebb mint 1 perc'],
    [60_000, 'kb. 1 perc'],
    [12 * 60_000, 'kb. 12 perc'],
    [60 * 60_000, 'kb. 1 óra'],
    [97 * 60_000, 'kb. 1 óra 35 perc'],
    [119 * 60_000, 'kb. 2 óra'],
    [38 * 60 * 60_000, 'kb. 38 óra']
  ])('formats %d ms as %s', (ms, expected) => {
    // Act
    const text = formatRemaining(ms)

    // Assert
    expect(text).toBe(expected)
  })
})
