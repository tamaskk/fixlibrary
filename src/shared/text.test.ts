import { describe, expect, it } from 'vitest'
import { toOneLine } from './text'

describe('toOneLine', () => {
  it('turns a multi-line tool output into one line', () => {
    // Act
    const line = toOneLine('  decode failed\n\tat frame 12\u0000\r\nstack…  ', 300)

    // Assert
    expect(line).toBe('decode failed at frame 12 stack…')
  })

  it('removes characters that would reverse or hide text', () => {
    // Act
    const line = toOneLine('track‮gnp.exe​ name next', 300)

    // Assert
    expect(line).toBe('track gnp.exe name next')
  })

  it('caps a long text at the given length, ending in an ellipsis', () => {
    // Act
    const line = toOneLine('x'.repeat(5000), 300)

    // Assert
    expect(Array.from(line)).toHaveLength(300)
    expect(line.endsWith('…')).toBe(true)
  })

  it('does not cut a character outside the basic plane in half', () => {
    // Arrange
    const text = '🎧'.repeat(10)

    // Act
    const line = toOneLine(text, 5)

    // Assert
    expect(line).toBe('🎧🎧🎧🎧…')
    expect(line.isWellFormed()).toBe(true)
  })

  it('leaves a short clean text as it is', () => {
    // Act
    const line = toOneLine('Tűz (Extended Mix)', 300)

    // Assert
    expect(line).toBe('Tűz (Extended Mix)')
  })
})
