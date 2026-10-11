import { describe, expect, it } from 'vitest'
import { createLogLimiter } from './log-limiter'

describe('createLogLimiter', () => {
  it('passes lines up to the limit and holds back the rest of the window', () => {
    // Arrange
    const written: string[] = []
    const limited = createLogLimiter((line) => written.push(line), {
      limit: 3,
      windowMs: 1000,
      now: () => 0
    })

    // Act
    for (let count = 1; count <= 10; count += 1) limited(`line ${count}`)

    // Assert
    expect(written).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('says how many lines it held back once the next window starts', () => {
    // Arrange
    const written: string[] = []
    let clock = 0
    const limited = createLogLimiter((line) => written.push(line), {
      limit: 2,
      windowMs: 1000,
      now: () => clock
    })
    for (let count = 1; count <= 7; count += 1) limited(`line ${count}`)

    // Act
    clock = 1000
    limited('after the pause')

    // Assert
    expect(written).toEqual(['line 1', 'line 2', '(5 lines suppressed)', 'after the pause'])
  })

  it('adds nothing when a window stayed under the limit', () => {
    // Arrange
    const written: string[] = []
    let clock = 0
    const limited = createLogLimiter((line) => written.push(line), {
      limit: 5,
      windowMs: 1000,
      now: () => clock
    })
    limited('one')

    // Act
    clock = 5000
    limited('two')

    // Assert
    expect(written).toEqual(['one', 'two'])
  })
})
