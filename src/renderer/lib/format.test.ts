import { describe, expect, it } from 'vitest'
import { formatDecimal, parseDecimal } from './format'

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
