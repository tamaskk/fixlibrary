import { describe, expect, it } from 'vitest'
import { createTimedCache } from './timed-cache'

describe('createTimedCache', () => {
  it('reads again only after the value is older than the limit', () => {
    // Arrange
    let time = 0
    let reads = 0
    const cached = createTimedCache(
      () => {
        reads += 1
        return { reads }
      },
      1000,
      () => time
    )

    // Act
    const first = cached()
    time = 999
    const second = cached()
    time = 1000
    const third = cached()

    // Assert
    expect(reads).toBe(2)
    expect(second).toBe(first)
    expect(third).toEqual({ reads: 2 })
  })

  it('does not hand out a value when reading it failed', () => {
    // Arrange
    let fail = true
    const cached = createTimedCache(
      () => {
        if (fail) throw new Error('not readable')
        return 'value'
      },
      1000,
      () => 0
    )

    // Act
    const failing = (): unknown => cached()
    const threw = (() => {
      try {
        failing()
        return false
      } catch {
        return true
      }
    })()
    fail = false

    // Assert
    expect(threw).toBe(true)
    expect(cached()).toBe('value')
  })
})
