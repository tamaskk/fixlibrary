import { describe, expect, it } from 'vitest'
import { createProgressThrottle, createRateGate } from './progress'

describe('createProgressThrottle', () => {
  it('passes on at most four values per second', () => {
    // Arrange
    let time = 1000
    const sent: number[] = []
    const report = createProgressThrottle<number>(
      (value) => sent.push(value),
      () => time
    )

    // Act
    for (let step = 0; step < 100; step += 1) {
      report(step)
      time += 20
    }

    // Assert
    expect(sent).toEqual([0, 13, 26, 39, 52, 65, 78, 91])
  })

  it('passes the first value on at once', () => {
    // Arrange
    const sent: string[] = []
    const report = createProgressThrottle<string>(
      (value) => sent.push(value),
      () => 0
    )

    // Act
    report('first')
    report('second')

    // Assert
    expect(sent).toEqual(['first'])
  })
})

describe('createRateGate', () => {
  it('lets a call through only when the last one it let through is long enough ago', () => {
    // Arrange
    let time = 0
    const mayPass = createRateGate(2000, () => time)

    // Act
    const passed: boolean[] = []
    for (const at of [0, 500, 1999, 2000, 2100, 4000]) {
      time = at
      passed.push(mayPass())
    }

    // Assert
    expect(passed).toEqual([true, false, false, true, false, true])
  })
})
