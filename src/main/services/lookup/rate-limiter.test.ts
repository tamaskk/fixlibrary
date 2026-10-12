import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, ServiceBusyError } from './rate-limiter'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Schedules `count` tasks and returns the times, from now, at which each started. */
function startTimes(limiter: ReturnType<typeof createRateLimiter>, count: number): number[] {
  const began = Date.now()
  const times: number[] = []
  for (let index = 0; index < count; index += 1) {
    void limiter.schedule(async () => void times.push(Date.now() - began))
  }
  return times
}

describe('createRateLimiter', () => {
  it('starts one request a second when that is the limit', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000 })

    // Act
    const times = startTimes(limiter, 4)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(times).toEqual([0, 1000, 2000, 3000])
  })

  it('starts three at once and the fourth a second after the first', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 3, intervalMs: 1000 })

    // Act
    const times = startTimes(limiter, 7)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(times).toEqual([0, 0, 0, 1000, 1000, 1000, 2000])
  })

  it('never starts more than the cap within any stretch of the interval', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 3, intervalMs: 1000 })
    const times = startTimes(limiter, 2)
    await vi.advanceTimersByTimeAsync(600)

    // Act
    const later = startTimes(limiter, 3)
    await vi.advanceTimersByTimeAsync(5000)

    // Assert
    expect(times).toEqual([0, 0])
    // The third fits at once; the next two wait until the first two are a second old.
    expect(later).toEqual([0, 400, 400])
  })

  it('counts by when a request started, not by when it ended', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000 })
    const began = Date.now()
    const times: number[] = []
    const slow = (): Promise<void> =>
      new Promise((resolve) => {
        times.push(Date.now() - began)
        setTimeout(resolve, 5000)
      })

    // Act
    void limiter.schedule(slow)
    void limiter.schedule(slow)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(times).toEqual([0, 1000])
  })

  it('starts nothing during a pause, and goes on after it', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000 })
    limiter.pauseFor(3000)

    // Act
    const times = startTimes(limiter, 2)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(times).toEqual([3000, 4000])
  })

  it('refuses a request at once while a pause is longer than it may wait', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000, maxPauseWaitMs: 5000 })
    limiter.pauseFor(60_000)

    // Act
    const refused = limiter.schedule(async () => 'sent')

    // Assert
    await expect(refused).rejects.toBeInstanceOf(ServiceBusyError)
  })

  it('refuses the requests that wait when a long pause begins', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000, maxPauseWaitMs: 5000 })
    void limiter.schedule(async () => 'first')
    const waiting = limiter.schedule(async () => 'second')
    const refused = expect(waiting).rejects.toBeInstanceOf(ServiceBusyError)

    // Act
    limiter.pauseFor(60_000)

    // Assert
    await refused
  })

  it('takes requests again once a long pause is nearly over', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000, maxPauseWaitMs: 5000 })
    limiter.pauseFor(60_000)
    await vi.advanceTimersByTimeAsync(56_000)

    // Act
    const times = startTimes(limiter, 1)
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(times).toEqual([4000])
  })

  it('drops a waiting request that is given up, and gives its turn to the next', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 1, intervalMs: 1000 })
    const controller = new AbortController()
    const started: string[] = []
    void limiter.schedule(async () => void started.push('first'))
    const givenUp = limiter.schedule(async () => void started.push('second'), controller.signal)
    const rejected = expect(givenUp).rejects.toThrow('given up')
    void limiter.schedule(async () => void started.push('third'))

    // Act
    controller.abort()
    await vi.advanceTimersByTimeAsync(1000)

    // Assert
    await rejected
    expect(started).toEqual(['first', 'third'])
  })

  it('passes on what a request returns and what it throws', async () => {
    // Arrange
    const limiter = createRateLimiter({ cap: 5, intervalMs: 1000 })

    // Act
    const answered = limiter.schedule(async () => 42)
    const failed = limiter.schedule(async () => {
      throw new Error('no answer')
    })

    // Assert
    await expect(answered).resolves.toBe(42)
    await expect(failed).rejects.toThrow('no answer')
  })
})
