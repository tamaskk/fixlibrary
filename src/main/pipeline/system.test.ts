import { describe, expect, it } from 'vitest'
import type { ToolCheck } from '@shared/tools'
import { createToolChecker } from './system'

const locations = { bundledDir: '/bin', pythonPath: null }
const result: ToolCheck[] = [{ name: 'ffmpeg', ok: true, version: '9.0.2' }]

describe('createToolChecker', () => {
  it('runs one check for calls that overlap, and keeps the result', async () => {
    // Arrange
    let runs = 0
    const checker = createToolChecker(locations, async () => {
      runs += 1
      return result
    })

    // Act
    const [first, second] = await Promise.all([checker.check(false), checker.check(true)])
    const later = await checker.check(false)

    // Assert
    expect(runs).toBe(1)
    expect([first, second, later]).toEqual([result, result, result])
  })

  it('checks again when asked to, but not within five seconds of the last check', async () => {
    // Arrange
    let runs = 0
    let clock = 0
    const checker = createToolChecker(
      locations,
      async () => {
        runs += 1
        return result
      },
      () => clock
    )
    await checker.check(false)

    // Act
    clock = 4000
    await checker.check(true)
    const runsTooSoon = runs
    clock = 6000
    await checker.check(true)

    // Assert
    expect(runsTooSoon).toBe(1)
    expect(runs).toBe(2)
  })
})
