import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from './logger'
import { createSleepBlocker } from './power'

describe('createSleepBlocker', () => {
  let calls: string[]
  let nextId: number
  const blocker = {
    start: (type: string): number => {
      calls.push(`start ${type}`)
      return nextId++
    },
    stop: (id: number): void => {
      calls.push(`stop ${id}`)
    }
  }

  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    calls = []
    nextId = 7
  })

  it('holds sleep off while the app is busy and allows it again afterwards', () => {
    // Arrange
    const setBusy = createSleepBlocker(blocker)

    // Act
    setBusy(true)
    setBusy(false)

    // Assert
    expect(calls).toEqual(['start prevent-app-suspension', 'stop 7'])
  })

  it('asks only once, however often it is told the same', () => {
    // Arrange
    const setBusy = createSleepBlocker(blocker)

    // Act
    setBusy(false)
    setBusy(true)
    setBusy(true)
    setBusy(false)
    setBusy(false)
    setBusy(true)

    // Assert
    expect(calls).toEqual([
      'start prevent-app-suspension',
      'stop 7',
      'start prevent-app-suspension'
    ])
  })
})
