import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, trackErrorSchema } from '@shared/errors'
import { runStage, type StageOutcome } from './run-stage'

const run = { trackId: 7, stage: 'bpmKey', timeoutMs: 1000 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runStage', () => {
  it('returns the value of a stage that succeeds', async () => {
    // Act
    const outcome = await runStage(run, async () => ({ bpm: 124 }))

    // Assert
    expect(outcome).toEqual({ ok: true, value: { bpm: 124 } })
  })

  it('turns a failing stage into a track error instead of throwing', async () => {
    // Arrange
    const failing = async (): Promise<never> => {
      throw new AppError('FILE_UNREADABLE', 'The file is empty')
    }

    // Act
    const outcome = await runStage(run, failing)

    // Assert
    expect(outcome).toEqual({
      ok: false,
      error: {
        trackId: 7,
        stage: 'bpmKey',
        code: 'FILE_UNREADABLE',
        message: 'The file could not be read'
      }
    })
  })

  it('keeps a batch going past the track that fails', async () => {
    // Arrange
    const tracks = [1, 2, 3]
    const stage = async (trackId: number): Promise<string> => {
      if (trackId === 2) throw new AppError('FILE_UNREADABLE', 'The file is empty')
      return `analysed ${trackId}`
    }

    // Act
    const outcomes: StageOutcome<string>[] = []
    for (const trackId of tracks) {
      outcomes.push(await runStage({ ...run, trackId }, () => stage(trackId)))
    }

    // Assert
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true])
    expect(outcomes[2]).toEqual({ ok: true, value: 'analysed 3' })
  })

  it('reports a stage that takes too long as TIMEOUT and tells it to stop', async () => {
    // Arrange
    let stopped = false
    const stuck = (signal: AbortSignal): Promise<never> => {
      signal.addEventListener('abort', () => (stopped = true))
      return new Promise(() => {})
    }

    // Act
    const pending = runStage(run, stuck)
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await pending

    // Assert
    expect(outcome).toEqual({
      ok: false,
      error: { trackId: 7, stage: 'bpmKey', code: 'TIMEOUT', message: 'No result within 1 s' }
    })
    expect(stopped).toBe(true)
  })

  it('does not time out a stage that finishes just in time', async () => {
    // Arrange
    const slow = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve('done'), 999))

    // Act
    const pending = runStage(run, slow)
    await vi.advanceTimersByTimeAsync(999)
    const outcome = await pending

    // Assert
    expect(outcome).toEqual({ ok: true, value: 'done' })
  })

  it('keeps the detail of an unexpected error out of the message shown to the user', async () => {
    // Arrange
    const crashing = async (): Promise<never> => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'bpm')\n    at analyse (x.ts:1)"
      )
    }

    // Act
    const outcome = await runStage(run, crashing)

    // Assert
    expect(outcome).toEqual({
      ok: false,
      error: { trackId: 7, stage: 'bpmKey', code: 'UNEXPECTED', message: 'Unexpected error' }
    })
  })

  it('catches a stage that throws before it returns a promise', async () => {
    // Arrange
    const throwing = (): Promise<never> => {
      throw new AppError('WRITE_FAILED', 'No space left')
    }

    // Act
    const outcome = await runStage(run, throwing)

    // Assert
    expect(outcome.ok === false && outcome.error.code).toBe('WRITE_FAILED')
  })

  it('never passes on what the sidecar or a tool said, only the kind of failure', async () => {
    // Arrange
    const fromSidecar = async (): Promise<never> => {
      throw new AppError(
        'PYTHON_ERROR',
        "FileNotFoundError: /Volumes/DJ SSD/Private/track.mp3\nffmpeg -i 'x' -af volume=2"
      )
    }

    // Act
    const outcome = await runStage(run, fromSidecar)

    // Assert
    expect(outcome).toEqual({
      ok: false,
      error: {
        trackId: 7,
        stage: 'bpmKey',
        code: 'PYTHON_ERROR',
        message: 'The audio engine reported an error'
      }
    })
    expect(trackErrorSchema.safeParse(outcome.ok ? null : outcome.error).success).toBe(true)
  })

  it('reports work that fails because it was told to stop as TIMEOUT', async () => {
    // Arrange
    const stopsOnAbort = (signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('child process killed')))
      })

    // Act
    const pending = runStage(run, stopsOnAbort)
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await pending

    // Assert
    expect(outcome.ok === false && outcome.error.code).toBe('TIMEOUT')
  })

  it('never states a limit of zero seconds', async () => {
    // Act
    const pending = runStage({ ...run, timeoutMs: 300 }, () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(300)
    const outcome = await pending

    // Assert
    expect(outcome.ok === false && outcome.error.message).toBe('No result within 1 s')
  })

  it('leaves no timer behind after a stage that succeeds', async () => {
    // Act
    await runStage(run, async () => 'done')

    // Assert
    expect(vi.getTimerCount()).toBe(0)
  })
})
