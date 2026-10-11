import { describe, expect, it } from 'vitest'
import { createLineReader } from './line-reader'

function collect(maxLineLength: number): {
  push: (text: string | Buffer) => void
  lines: string[]
  overflows: () => number
} {
  const lines: string[] = []
  let overflowCount = 0
  const read = createLineReader({
    maxLineLength,
    onLine: (line) => lines.push(line),
    onOverflow: () => (overflowCount += 1)
  })
  return {
    push: (text) => read(typeof text === 'string' ? Buffer.from(text) : text),
    lines,
    overflows: () => overflowCount
  }
}

describe('createLineReader', () => {
  it('joins a line that arrives in several chunks', () => {
    // Arrange
    const reader = collect(100)

    // Act
    reader.push('{"id":')
    reader.push('1}\n{"id":2}\n{"id"')
    reader.push(':3}\n')

    // Assert
    expect(reader.lines).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  it('keeps a multi-byte character that is split across chunks', () => {
    // Arrange
    const reader = collect(100)
    const bytes = Buffer.from('tűz\n')

    // Act
    reader.push(bytes.subarray(0, 2))
    reader.push(bytes.subarray(2))

    // Assert
    expect(reader.lines).toEqual(['tűz'])
  })

  it('drops a line longer than the limit and keeps reading after it', () => {
    // Arrange
    const reader = collect(10)

    // Act
    reader.push('short\n')
    reader.push('x'.repeat(8))
    reader.push('x'.repeat(8))
    reader.push('x'.repeat(8) + '\nnext\n')

    // Assert
    expect(reader.lines).toEqual(['short', 'next'])
    expect(reader.overflows()).toBe(1)
  })

  it('delivers a line of exactly the limit', () => {
    // Arrange
    const reader = collect(5)

    // Act
    reader.push('12345\n')

    // Assert
    expect(reader.lines).toEqual(['12345'])
    expect(reader.overflows()).toBe(0)
  })
})
